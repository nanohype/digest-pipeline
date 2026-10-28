#!/usr/bin/env node
/**
 * Gate: every container the chart renders names the repository
 * `.github/workflows/release.yml` publishes for its workload, at a
 * release-version tag.
 *
 *   node scripts/check-chart-images.mjs             # the gate
 *   node scripts/check-chart-images.mjs --self-test # prove it rejects
 *
 * Exit codes:
 *   0  every rendered container names its workload's published repository at
 *      a release-version tag
 *   1  at least one does not, or the chart does not render — a finding about
 *      the branch
 *   2  release.yml or Chart.yaml could not be read, the gate could not
 *      establish what release.yml publishes, helm is not on PATH or did not
 *      finish a render within HELM_TIMEOUT_MS, or the chart rendered nothing —
 *      nothing was checked, which says nothing about the branch
 *
 * `--self-test` exits 0 when every case holds, 1 when one does not, and 2 when
 * release.yml or Chart.yaml could not be read, or helm is not on PATH or did
 * not finish a render within HELM_TIMEOUT_MS.
 *
 * The chart names its images and the release workflow names the images it
 * pushes, in two files nothing else ties together. `helm lint`, `helm template`
 * and Kubernetes schema validation all accept a reference no registry holds,
 * so a mismatch reaches a cluster and surfaces there as ImagePullBackOff on
 * every pod.
 *
 * The gate checks the shape of each reference, not that a registry holds it.
 * A chart whose appVersion names a version with no `v<appVersion>` git tag, or
 * one whose release.yml run failed for some workload, passes here; on a
 * cluster, each workload whose image that release did not publish sits in
 * ImagePullBackOff. The registry is outside the commit under test, and a
 * verdict that read it would change without a commit here.
 *
 * ── What release.yml publishes ──────────────────────────────────────────────
 *
 * Read from the workflow in the commit under test, not from a registry, so the
 * verdict is about this commit and needs no network. The job whose
 * docker/build-push-action step has `push: true` names its image in
 * `env.IMAGE`, and each line of that step's `tags:` is expanded once per
 * build-matrix entry. A tag of `${{ steps.<id>.outputs.version }}` counts as a
 * release version only while step `<id>` derives it from a `v*` git tag by
 * stripping the `v`. Anything else is a workflow shape this gate does not
 * model, and it exits 2 rather than guess.
 *
 * ── What gets checked ───────────────────────────────────────────────────────
 *
 * The chart is rendered with values.yaml alone and with each values-<env>.yaml
 * layered on it. Environment files are found by listing chart/, so one added
 * later is checked without editing this script. In every render, each
 * container of each pod template must:
 *
 *   - run the repository published for its workload. The pod template's
 *     `digest-pipeline.io/service` label names the workload, and the build
 *     matrix entry of the same name names its image. The migrate hook runs the
 *     api image: the migrations it applies before a rollout must be the ones
 *     the api it gates was built with.
 *   - carry a release-version tag, `<major>.<minor>.<patch>[-<prerelease>]`.
 *     The shape is this gate's rule, not one release.yml enforces: release.yml
 *     runs on any `v*` git tag, so a `vstaging` tag would push `staging`.
 *     Requiring a version keeps the manifest naming one build, so an
 *     environment name, a branch or `latest` is refused. release.yml does push
 *     `latest`, but it names whichever release ran last, so a manifest using it
 *     does not say what it runs and a re-pull changes it silently.
 *   - report that tag as `service.version` in OTEL_RESOURCE_ATTRIBUTES, so
 *     telemetry names the build that emitted it.
 *
 * Across all renders, every repository release.yml publishes must be run by
 * some workload. A build-matrix entry the chart never deploys is either a
 * build no environment uses or a workload the chart is missing.
 *
 * Chart.yaml's `appVersion` must itself be a release version, because it is
 * the tag every workload runs unless its values pin another.
 *
 * ── Self-test ───────────────────────────────────────────────────────────────
 *
 * `--self-test` runs the gate on inputs broken one way per case — values
 * overlays, mutated copies of release.yml and of the rendered manifests, chart
 * copies with no appVersion or with an added environment file — and fails
 * unless each broken input is rejected with the finding its case names. A rule
 * or refusal added to the gate needs a case here that breaks it: without one,
 * deleting the rule leaves both the gate and the self-test passing.
 *
 * It also asserts what must pass — the chart as committed, and a `push: true`
 * input on an action other than docker/build-push-action — and the chart's
 * defaulting: an empty tag resolves to appVersion, one service's tag moves that
 * service (and the migrate hook with the api) and nothing else, and a missing
 * repository or appVersion fails the render instead of producing a reference
 * with an empty part. A helm that is missing or runs past HELM_TIMEOUT_MS
 * fails every render case alike, so it ends the self-test with exit 2 rather
 * than counting as each case's verdict.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHART_DIR = join(ROOT, "chart");
const RELEASE_WORKFLOW = join(ROOT, ".github", "workflows", "release.yml");
const RELEASE_NAME = "digest-pipeline";
const SERVICE_LABEL = "digest-pipeline.io/service";
const SELF_TEST = process.argv.includes("--self-test");

/**
 * How long one `helm template` may run. Past it, the gate ends with exit 2 as
 * it does for a missing helm, rather than holding the CI job until the job's
 * own timeout.
 */
const HELM_TIMEOUT_MS = 60_000;

/** Workloads that run another workload's image, keyed to whose. */
const RUNS_IMAGE_OF = { migrate: "api" };

/** The tag shape this gate accepts: what `${GITHUB_REF#refs/tags/v}` yields for a semver git tag. */
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/**
 * `<repository>[:<tag>][@<digest>]`. Only the registry host may carry a colon
 * (its port), so a colon anywhere after the first `/` starts the tag.
 */
const IMAGE_REF =
  /^(?<repository>(?:[^\s/@:]+(?::\d+)?\/)?[^\s@:]+)(?::(?<tag>\w[\w.-]{0,127}))?(?:@(?<digest>sha256:[0-9a-f]{64}))?$/;

const POD_TEMPLATE = {
  Pod: (doc) => doc,
  Deployment: (doc) => doc.spec?.template,
  StatefulSet: (doc) => doc.spec?.template,
  DaemonSet: (doc) => doc.spec?.template,
  ReplicaSet: (doc) => doc.spec?.template,
  Job: (doc) => doc.spec?.template,
  CronJob: (doc) => doc.spec?.jobTemplate?.spec?.template,
};

/** The gate could not establish what to check against, or checked nothing. */
class Unusable extends Error {}

/**
 * helm produced no render: it is not on PATH, or it ran past HELM_TIMEOUT_MS.
 * Neither is a verdict on the chart, so it ends the gate and the self-test
 * with exit 2 rather than counting as one render's result.
 */
class HelmUnavailable extends Unusable {}

/** `helm template` itself failed. */
class RenderFailed extends Error {}

const out = (line) => process.stdout.write(`${line}\n`);

// ─── What release.yml publishes ──────────────────────────────────────────────

const expression = (name) =>
  new RegExp(`\\$\\{\\{\\s*${name.replaceAll(".", "\\.")}\\s*\\}\\}`, "g");
const VERSION_OUTPUT = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.version\s*\}\}$/;
const STRIPS_V_FROM_GIT_TAG = /version=\$\{GITHUB_REF#refs\/tags\/v\}/;

/**
 * Map of repository → `{ component, version, literals }`: the build-matrix
 * entry that pushes it, whether it is tagged with the release version, and
 * any fixed tags pushed alongside.
 */
function readPublished(workflow) {
  const triggers = workflow?.on?.push?.tags;
  const published = new Map();

  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (!String(step?.uses ?? "").startsWith("docker/build-push-action@")) continue;
      if (String(step.with?.push) !== "true") continue;

      const where = `release.yml jobs.${jobId}`;
      const image = job.env?.IMAGE;
      if (typeof image !== "string" || image === "") {
        throw new Unusable(`${where}: the job that pushes sets no env.IMAGE`);
      }
      const entries = job.strategy?.matrix?.include;
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Unusable(`${where}: no strategy.matrix.include to expand env.IMAGE over`);
      }
      const tagLines = String(step.with?.tags ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (tagLines.length === 0) throw new Unusable(`${where}: the push step lists no tags`);

      for (const entry of entries) {
        const component = entry?.name;
        if (typeof component !== "string" || component === "") {
          throw new Unusable(`${where}: a matrix entry has no name`);
        }
        for (const line of tagLines) {
          const expanded = line
            .replace(expression("env.IMAGE"), image)
            .replace(expression("matrix.name"), component);
          const colon = expanded.lastIndexOf(":");
          const repository = expanded.slice(0, colon);
          const tag = expanded.slice(colon + 1);
          if (colon <= 0 || repository.includes("${{")) {
            throw new Unusable(`${where}: cannot resolve an image repository from \`${line}\``);
          }
          const record = published.get(repository) ?? {
            component,
            version: false,
            literals: new Set(),
          };
          const versionStep = VERSION_OUTPUT.exec(tag)?.[1];
          if (versionStep) {
            assertVersionFromGitTag(where, job, versionStep, triggers);
            record.version = true;
          } else if (tag.includes("${{")) {
            throw new Unusable(
              `${where}: tag \`${tag}\` is an expression this gate does not model`,
            );
          } else {
            record.literals.add(tag);
          }
          published.set(repository, record);
        }
      }
    }
  }

  if (published.size === 0) {
    throw new Unusable("release.yml has no docker/build-push-action step with `push: true`");
  }
  for (const [repository, { version }] of published) {
    if (!version)
      throw new Unusable(`release.yml pushes ${repository} with no release-version tag`);
  }
  return published;
}

function assertVersionFromGitTag(where, job, stepId, triggers) {
  const step = (job.steps ?? []).find((s) => s?.id === stepId);
  if (!step || !STRIPS_V_FROM_GIT_TAG.test(String(step.run ?? ""))) {
    throw new Unusable(
      `${where}: step \`${stepId}\` does not derive the version as \${GITHUB_REF#refs/tags/v}, ` +
        "so the gate cannot tell which tags it pushes",
    );
  }
  if (!Array.isArray(triggers) || triggers.length === 0 || !triggers.every((t) => /^v/.test(t))) {
    throw new Unusable(
      "release.yml: on.push.tags must list only `v`-prefixed patterns for the version to be " +
        "the git tag without its `v`",
    );
  }
}

// ─── What the chart renders ──────────────────────────────────────────────────

function environmentFiles(chartDir) {
  return readdirSync(chartDir)
    .filter((f) => /^values-[\w-]+\.yaml$/.test(f))
    .sort();
}

/** Run `helm template` and parse the manifests; values.yaml always applies. */
function render(label, valueFiles = [], chartDir = CHART_DIR, timeout = HELM_TIMEOUT_MS) {
  let manifest;
  try {
    manifest = execFileSync(
      "helm",
      ["template", RELEASE_NAME, chartDir, ...valueFiles.flatMap((f) => ["-f", f])],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
        timeout,
      },
    );
  } catch (error) {
    if (error.code === "ENOENT") throw new HelmUnavailable("helm is not on PATH");
    if (error.code === "ETIMEDOUT") {
      throw new HelmUnavailable(`${label}: helm template did not finish within ${timeout / 1000}s`);
    }
    // Helm closes every failure with a hint about --debug; the line before it is the reason.
    const reason = String(error.stderr ?? error.message)
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("Use --debug"))
      .join(" ");
    throw new RenderFailed(`${label}: helm template failed — ${reason}`);
  }
  const docs = parseAllDocuments(manifest)
    .map((d) => d.toJS())
    .filter((d) => d && typeof d === "object");
  return { label, docs };
}

function renderAll(chartDir = CHART_DIR) {
  return [
    render("values.yaml", [], chartDir),
    ...environmentFiles(chartDir).map((f) => render(f, [join(chartDir, f)], chartDir)),
  ];
}

function* containers(docs) {
  for (const doc of docs) {
    const template = POD_TEMPLATE[doc.kind]?.(doc);
    if (!template) continue;
    const service = template.metadata?.labels?.[SERVICE_LABEL];
    const spec = template.spec ?? {};
    // ephemeralContainers is left out: the API server refuses it in a pod
    // template and on Pod create, so no manifest that applies carries one.
    for (const container of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
      yield { owner: `${doc.kind}/${doc.metadata?.name}`, service, container };
    }
  }
}

function serviceVersions(container) {
  const attrs = (container.env ?? []).find((e) => e?.name === "OTEL_RESOURCE_ATTRIBUTES")?.value;
  return String(attrs ?? "")
    .split(",")
    .map((pair) => pair.split("="))
    .filter(([key]) => key?.trim() === "service.version")
    .map(([, value]) => (value ?? "").trim());
}

// ─── The rules ───────────────────────────────────────────────────────────────

function check(published, renders, appVersion) {
  const problems = [];
  if (!RELEASE_VERSION.test(String(appVersion ?? ""))) {
    problems.push(
      `chart/Chart.yaml: appVersion \`${appVersion}\` is not a release version — it is the ` +
        "tag every service runs unless its values pin another",
    );
  }

  const repositoryOf = new Map([...published].map(([repo, { component }]) => [component, repo]));
  const components = [...repositoryOf.keys()].join(", ");
  const run = new Set();
  let checked = 0;

  for (const { label, docs } of renders) {
    for (const { owner, service, container } of containers(docs)) {
      checked += 1;
      const at = `${label}: ${owner} container \`${container.name}\``;
      const ref = IMAGE_REF.exec(String(container.image ?? ""))?.groups;
      if (!ref) {
        problems.push(`${at}: \`${container.image}\` is not an image reference`);
        continue;
      }
      run.add(ref.repository);

      if (!service) {
        problems.push(
          `${at}: its pod template has no ${SERVICE_LABEL} label, so nothing names the ` +
            "published image it should run",
        );
      } else {
        const component = RUNS_IMAGE_OF[service] ?? service;
        const expected = repositoryOf.get(component);
        const owns = published.get(ref.repository)?.component;
        const whose = component === service ? "" : ` (the ${component} image)`;
        if (!expected) {
          problems.push(
            `${at}: workload \`${service}\` runs ${ref.repository}${whose}, but release.yml ` +
              `builds no \`${component}\` image (matrix: ${components})`,
          );
        } else if (ref.repository !== expected) {
          problems.push(
            owns
              ? `${at}: runs ${ref.repository}, which release.yml publishes for \`${owns}\`; ` +
                  `workload \`${service}\` runs ${expected}${whose}`
              : `${at}: runs ${ref.repository}, which release.yml does not publish; ` +
                  `workload \`${service}\` runs ${expected}${whose}`,
          );
        }
      }

      if (ref.tag === undefined) {
        problems.push(`${at}: \`${container.image}\` carries no tag`);
        continue;
      }
      if (published.get(ref.repository)?.literals.has(ref.tag)) {
        problems.push(
          `${at}: tag \`${ref.tag}\` is one release.yml moves on every release, so the ` +
            "manifest does not say which build runs; use a release version",
        );
      } else if (!RELEASE_VERSION.test(ref.tag)) {
        problems.push(
          `${at}: tag \`${ref.tag}\` is not a release version — this gate accepts only ` +
            "<major>.<minor>.<patch>[-<prerelease>], the tag release.yml pushes for a semver " +
            "v<version> git tag",
        );
      }

      const versions = serviceVersions(container);
      if (versions.length !== 1 || versions[0] !== ref.tag) {
        problems.push(
          `${at}: OTEL_RESOURCE_ATTRIBUTES reports service.version=` +
            `${versions.join(",") || "(unset)"} for an image tagged \`${ref.tag}\``,
        );
      }
    }
  }

  if (checked === 0) {
    throw new Unusable("the chart rendered no containers, so there was nothing to check");
  }
  for (const [repository, { component }] of published) {
    if (!run.has(repository)) {
      problems.push(
        `release.yml publishes ${repository} (matrix \`${component}\`) and no workload in any ` +
          "render runs it",
      );
    }
  }
  return { problems, checked };
}

// ─── Self-test ───────────────────────────────────────────────────────────────

/** Containers of a render keyed by the workload their pod template names. */
function byService(docs) {
  const found = new Map();
  for (const { service, container } of containers(docs)) found.set(service, container);
  return found;
}

/** The release.yml job that builds the image matrix. */
const imageJob = (workflow) =>
  Object.values(workflow.jobs).find((job) => job.strategy?.matrix?.include);

/** That job's docker/build-push-action step. */
const pushStep = (job) =>
  job.steps.find((step) => String(step.uses).startsWith("docker/build-push-action@"));

/** The GitHub Actions expression `${{ <inner> }}`, as release.yml writes one. */
const workflowExpression = (inner) => `\${{ ${inner} }}`;

/** A container's OTEL_RESOURCE_ATTRIBUTES env entry. */
const otelAttributes = (container) =>
  container.env.find((entry) => entry.name === "OTEL_RESOURCE_ATTRIBUTES");

/**
 * The case runners and input builders every case group uses. Overlays and
 * chart copies are written under `scratch`; `failures` collects the names of
 * cases that did not hold.
 */
function harness(workflow, appVersion, scratch) {
  const failures = [];
  let overlays = 0;

  /** A values file in the scratch directory, layered after values.yaml. */
  const overlay = (text) => {
    overlays += 1;
    const file = join(scratch, `overlay-${overlays}.yaml`);
    writeFileSync(file, text);
    return file;
  };
  /** A copy of the chart in the scratch directory, to edit files the gate lists. */
  const chartCopy = (name) => {
    const chart = join(scratch, name);
    cpSync(CHART_DIR, chart, { recursive: true });
    return chart;
  };
  const published = () => readPublished(structuredClone(workflow));

  /**
   * Run one case. A gate or render failure is the case's verdict, by class and
   * message. A HelmUnavailable propagates, because it fails every render case
   * alike and says nothing about any one of them; any other exception is a
   * defect in the self-test and propagates too.
   */
  const verdict = (run) => {
    try {
      return run();
    } catch (error) {
      if (error instanceof HelmUnavailable) throw error;
      if (!(error instanceof Unusable || error instanceof RenderFailed)) throw error;
      return [`${error.constructor.name}: ${error.message}`];
    }
  };
  const rejects = (name, run, expect) => {
    const problems = verdict(run);
    const matched = problems.find((p) => expect.test(p));
    out(`  ${matched ? "PASS" : "FAIL"}  rejects: ${name}`);
    out(`          → ${matched ?? `gate reported: ${problems.join("; ") || "no problems"}`}`);
    if (!matched) failures.push(`rejects: ${name}`);
  };
  const holds = (name, run) => {
    const problems = verdict(run);
    out(`  ${problems.length === 0 ? "PASS" : "FAIL"}  ${name}`);
    for (const problem of problems) out(`          → ${problem}`);
    if (problems.length > 0) failures.push(name);
  };

  /** The gate's findings with `text` layered on values.yaml. */
  const withOverlay = (text) => () =>
    check(published(), [render("overlay", [overlay(text)])], appVersion).problems;
  /** The gate's findings on values.yaml against a release.yml copy `mutate(copy, imageJob)` edits. */
  const withWorkflow = (mutate) => () => {
    const copy = structuredClone(workflow);
    mutate(copy, imageJob(copy));
    return check(readPublished(copy), [render("values.yaml")], appVersion).problems;
  };
  /** The gate's findings on a values.yaml render `mutate(docs, byService(docs))` edits. */
  const withRendered = (mutate) => () => {
    const rendered = render("values.yaml");
    mutate(rendered.docs, byService(rendered.docs));
    return check(published(), [rendered], appVersion).problems;
  };

  return {
    appVersion,
    scratch,
    failures,
    overlay,
    chartCopy,
    published,
    verdict,
    rejects,
    holds,
    withOverlay,
    withWorkflow,
    withRendered,
  };
}

/** Each per-container rule, broken in the values a deploy sets or in the rendered manifest. */
function containerCases({ rejects, withOverlay, withRendered }) {
  const overlays = [
    [
      "an environment name as a service's tag",
      "api:\n  image:\n    tag: production\n",
      /tag `production` is not a release version/,
    ],
    [
      "the `latest` tag release.yml moves on every release",
      "web:\n  image:\n    tag: latest\n",
      /tag `latest` is one release\.yml moves on every release/,
    ],
    [
      // YAML reads 1.10 as the float 1.1, so the rendered tag is not the
      // version that was typed.
      "an unquoted version YAML reads as a number",
      "pipeline:\n  image:\n    tag: 1.10\n",
      /tag `1\.1` is not a release version/,
    ],
    [
      // The chart appends `:<tag>` to the repository, so a tag written into
      // the repository value renders a reference with two.
      "a repository value that carries its own tag",
      "api:\n  image:\n    repository: ghcr.io/nanohype/digest-pipeline-api:0.1.0\n",
      /`ghcr\.io\/nanohype\/digest-pipeline-api:0\.1\.0:\S+` is not an image reference/,
    ],
    [
      "a repository release.yml does not publish",
      "pipeline:\n  image:\n    repository: ghcr.io/nanohype/digest-pipeline\n",
      /runs ghcr\.io\/nanohype\/digest-pipeline, which release\.yml does not publish/,
    ],
    [
      // The registry port's colon belongs to the repository, not the tag.
      "a mirror registry with a port",
      "api:\n  image:\n    repository: registry.local:5000/nanohype/digest-pipeline-api\n",
      /runs registry\.local:5000\/nanohype\/digest-pipeline-api, which release\.yml does not publish/,
    ],
    [
      "two services' published repositories swapped",
      "api:\n  image:\n    repository: ghcr.io/nanohype/digest-pipeline-web\n" +
        "web:\n  image:\n    repository: ghcr.io/nanohype/digest-pipeline-api\n",
      /which release\.yml publishes for `web`; workload `api`/,
    ],
    [
      "a service with no repository",
      "web:\n  image:\n    repository: ''\n",
      /RenderFailed: .*web\.image\.repository is required/,
    ],
    [
      "service.version set by hand in env",
      "env:\n  OTEL_RESOURCE_ATTRIBUTES: " +
        "'agents.tenant=growth,agents.platform=digest-pipeline,service.version=0.0.1'\n",
      /RenderFailed: .*OTEL_RESOURCE_ATTRIBUTES sets service\.version/,
    ],
  ];
  for (const [name, text, expect] of overlays) rejects(name, withOverlay(text), expect);

  const manifests = [
    [
      "an image with no tag",
      (_, services) => {
        const api = services.get("api");
        api.image = api.image.slice(0, api.image.lastIndexOf(":"));
      },
      /container `api`: `ghcr\.io\/nanohype\/digest-pipeline-api` carries no tag/,
    ],
    [
      "the migrate hook running an image other than the api's",
      (_, services) => {
        const migrate = services.get("migrate");
        migrate.image = migrate.image.replace("-api:", "-pipeline:");
      },
      /container `migrate`: runs \S+-pipeline, which release\.yml publishes for `pipeline`; workload `migrate` runs \S+-api \(the api image\)/,
    ],
    [
      "an init container running an image release.yml does not publish",
      (docs) => {
        const api = docs.find((d) => d.kind === "Deployment" && d.metadata.name.endsWith("-api"));
        api.spec.template.spec.initContainers = [{ name: "wait-for-db", image: "busybox:1.37" }];
      },
      /container `wait-for-db`: runs busybox, which release\.yml does not publish/,
    ],
    [
      "a pod template with no service label",
      (docs) => {
        const web = docs.find((d) => d.kind === "Deployment" && d.metadata.name.endsWith("-web"));
        delete web.spec.template.metadata.labels[SERVICE_LABEL];
      },
      /has no digest-pipeline\.io\/service label/,
    ],
    [
      "service.version disagreeing with the image tag",
      (_, services) => {
        const attrs = otelAttributes(services.get("api"));
        attrs.value = attrs.value.replace(/service\.version=[^,]*/, "service.version=9.9.9");
      },
      /reports service\.version=9\.9\.9 for an image tagged/,
    ],
    [
      "no service.version in OTEL_RESOURCE_ATTRIBUTES",
      (_, services) => {
        const attrs = otelAttributes(services.get("api"));
        attrs.value = attrs.value.replace(/,?service\.version=[^,]*/, "");
      },
      /container `api`: OTEL_RESOURCE_ATTRIBUTES reports service\.version=\(unset\)/,
    ],
    [
      "service.version reported twice",
      (_, services) => {
        const attrs = otelAttributes(services.get("api"));
        attrs.value += `,${/service\.version=[^,]*/.exec(attrs.value)[0]}`;
      },
      /reports service\.version=([^,\s]+),\1 for an image tagged/,
    ],
  ];
  for (const [name, mutate, expect] of manifests) rejects(name, withRendered(mutate), expect);
}

/** What release.yml publishes, and each workflow shape the gate refuses to guess at. */
function releaseWorkflowCases({ rejects, holds, withWorkflow }) {
  // `${GITHUB_REF#refs/tags/v}` strips the `v` only from a ref that starts
  // with refs/tags/v; any other ref passes through whole as the "version".
  const vPrefixedTriggers = /Unusable: release\.yml: on\.push\.tags must list only `v`-prefixed/;
  const cases = [
    [
      "a workload whose image release.yml stopped building",
      (_, job) => {
        job.strategy.matrix.include = job.strategy.matrix.include.filter((e) => e.name !== "web");
      },
      /workload `web` runs \S+, but release\.yml builds no `web` image/,
    ],
    [
      "a build-matrix entry no workload runs",
      (_, job) => {
        job.strategy.matrix.include.push({ name: "worker" });
      },
      /publishes ghcr\.io\/nanohype\/digest-pipeline-worker .* no workload in any render runs it/,
    ],
    [
      "a repository pushed with no release-version tag",
      (_, job) => {
        pushStep(job).with.tags = `${workflowExpression("env.IMAGE")}:latest\n`;
      },
      /Unusable: release\.yml pushes ghcr\.io\/nanohype\/digest-pipeline-\S+ with no release-version tag/,
    ],
    [
      "a version step that does not derive the version from the git tag",
      (_, job) => {
        const ver = job.steps.find((s) => s.id === "ver");
        ver.run = ver.run.replace("GITHUB_REF#refs/tags/v", "GITHUB_SHA");
      },
      /Unusable: .*step `ver` does not derive the version/,
    ],
    [
      "a version tag naming a step the job does not have",
      (_, job) => {
        job.steps.find((s) => s.id === "ver").id = "version";
      },
      /Unusable: .*step `ver` does not derive the version/,
    ],
    [
      "a release that runs on any git tag",
      (copy) => {
        copy.on.push.tags = ["*"];
      },
      vPrefixedTriggers,
    ],
    [
      "a tag trigger without the `v` prefix beside one with it",
      (copy) => {
        copy.on.push.tags = ["v*", "nightly-v*"];
      },
      vPrefixedTriggers,
    ],
    [
      "a release that runs on branch pushes instead of tags",
      (copy) => {
        copy.on.push = { branches: ["main"] };
      },
      vPrefixedTriggers,
    ],
    [
      "an empty tag trigger list",
      (copy) => {
        copy.on.push.tags = [];
      },
      vPrefixedTriggers,
    ],
    [
      "a release workflow that pushes nothing",
      (_, job) => {
        pushStep(job).with.push = false;
      },
      /Unusable: release\.yml has no docker\/build-push-action step with `push: true`/,
    ],
    [
      "a push job with no env.IMAGE",
      (_, job) => {
        delete job.env.IMAGE;
      },
      /Unusable: .*the job that pushes sets no env\.IMAGE/,
    ],
    [
      "a push job with no build matrix",
      (_, job) => {
        delete job.strategy;
      },
      /Unusable: .*no strategy\.matrix\.include to expand env\.IMAGE over/,
    ],
    [
      "a build-matrix entry with no name",
      (_, job) => {
        delete job.strategy.matrix.include[0].name;
      },
      /Unusable: .*a matrix entry has no name/,
    ],
    [
      "a push step with no tags",
      (_, job) => {
        pushStep(job).with.tags = "";
      },
      /Unusable: .*the push step lists no tags/,
    ],
    [
      "a repository built from an expression the gate does not expand",
      (_, job) => {
        const [registry, name, version] = [
          "env.REGISTRY",
          "matrix.name",
          "steps.ver.outputs.version",
        ].map(workflowExpression);
        pushStep(job).with.tags = `${registry}/digest-pipeline-${name}:${version}`;
      },
      /Unusable: .*cannot resolve an image repository/,
    ],
    [
      "a tag built from an expression the gate does not model",
      (_, job) => {
        pushStep(job).with.tags +=
          `\n${workflowExpression("env.IMAGE")}:${workflowExpression("github.sha")}`;
      },
      /Unusable: .*tag `\$\{\{ github\.sha \}\}` is an expression this gate does not model/,
    ],
  ];
  for (const [name, mutate, expect] of cases) rejects(name, withWorkflow(mutate), expect);

  holds(
    "accepts: a `push: true` input on another action, which publishes no image",
    withWorkflow((_, job) => {
      job.steps.push({ uses: "EndBug/add-and-commit@v9", with: { push: true } });
    }),
  );
}

/** appVersion, the renders the gate takes, and the defaulting the chart promises. */
function chartCases({ rejects, holds, overlay, chartCopy, published, appVersion }) {
  rejects(
    "an appVersion that is not a release version",
    () => check(published(), [render("values.yaml")], "staging").problems,
    /appVersion `staging` is not a release version/,
  );
  rejects(
    "a render with no containers in it",
    () => check(published(), [{ label: "empty", docs: [] }], appVersion).problems,
    /Unusable: the chart rendered no containers/,
  );
  rejects(
    "an empty tag with no appVersion to default to",
    () => {
      const chart = chartCopy("chart-no-app-version");
      const chartYaml = join(chart, "Chart.yaml");
      writeFileSync(chartYaml, readFileSync(chartYaml, "utf8").replace(/^appVersion:.*\n/m, ""));
      return check(published(), [render("no appVersion", [], chart)], "").problems;
    },
    /RenderFailed: .*image\.tag is empty and Chart\.yaml sets no appVersion/,
  );
  rejects(
    "a bad tag in an environment file found by listing the chart directory",
    () => {
      const chart = chartCopy("chart-extra-environment");
      writeFileSync(join(chart, "values-canary.yaml"), "api:\n  image:\n    tag: canary\n");
      return check(published(), renderAll(chart), appVersion).problems;
    },
    /^values-canary\.yaml: .* container `api`: tag `canary` is not a release version/,
  );

  // The defaulting the chart promises, asserted on the rendered references
  // rather than on the values meant to produce them.
  const blank = overlay(
    "pipeline:\n  image:\n    tag: ''\napi:\n  image:\n    tag: ''\nweb:\n  image:\n    tag: ''\n",
  );
  holds(`renders: every empty tag as appVersion ${appVersion}`, () => {
    const rendered = render("empty tags", [blank]);
    const wrong = [...containers(rendered.docs)]
      .filter(({ container }) => !container.image.endsWith(`:${appVersion}`))
      .map(({ owner, container }) => `${owner} runs ${container.image}`);
    return [...wrong, ...check(published(), [rendered], appVersion).problems];
  });
  holds("renders: one service's tag moving that service and the migrate hook, nothing else", () => {
    const pin = overlay("api:\n  image:\n    tag: 0.2.0-rc.1\n");
    const rendered = render("api pinned", [blank, pin]);
    const services = byService(rendered.docs);
    const expected = {
      api: ["ghcr.io/nanohype/digest-pipeline-api", "0.2.0-rc.1"],
      migrate: ["ghcr.io/nanohype/digest-pipeline-api", "0.2.0-rc.1"],
      web: ["ghcr.io/nanohype/digest-pipeline-web", appVersion],
      pipeline: ["ghcr.io/nanohype/digest-pipeline-pipeline", appVersion],
    };
    const wrong = [];
    for (const [service, [repository, tag]] of Object.entries(expected)) {
      const container = services.get(service);
      if (container?.image !== `${repository}:${tag}`) {
        wrong.push(`${service} runs ${container?.image}, expected ${repository}:${tag}`);
      }
      const versions = serviceVersions(container ?? {}).join(",");
      if (versions !== tag) wrong.push(`${service} reports service.version=${versions}`);
    }
    return [...wrong, ...check(published(), [rendered], appVersion).problems];
  });
  holds(
    "accepts: the chart as committed",
    () => check(published(), renderAll(), appVersion).problems,
  );
}

/**
 * A helm that produces no render is a fact about the machine, not about the
 * chart: the gate exits 2 on it, and the self-test stops on it rather than
 * recording it as each render case's verdict.
 */
function helmCases({ holds, verdict, published, appVersion, scratch }) {
  // The scratch directory holds no helm, so it stands in for a PATH without one.
  holds("the gate exits 2 when helm is not on PATH", () => {
    const gate = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: "utf8",
      env: { ...process.env, PATH: scratch },
    });
    return gate.status === 2 && gate.stderr.includes("chart images gate: helm is not on PATH")
      ? []
      : [`the gate exited ${gate.status}: ${String(gate.stderr).trim() || "(no stderr)"}`];
  });

  // A helm that never exits, run under a timeout short enough for a test.
  const slow = join(scratch, "slow-helm");
  mkdirSync(slow);
  writeFileSync(join(slow, "helm"), "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
  const stops = [
    ["helm is not on PATH", scratch, HELM_TIMEOUT_MS, /^helm is not on PATH$/],
    ["helm runs past its timeout", slow, 300, /helm template did not finish within 0\.3s$/],
  ];
  for (const [name, path, timeout, expect] of stops) {
    holds(`the self-test stops, rather than failing a case, when ${name}`, () => {
      const saved = process.env.PATH;
      process.env.PATH = path;
      try {
        const problems = verdict(
          () => check(published(), [render(name, [], CHART_DIR, timeout)], appVersion).problems,
        );
        return [`${name} was recorded as a case's verdict: ${problems.join("; ")}`];
      } catch (error) {
        if (!(error instanceof HelmUnavailable)) throw error;
        return expect.test(error.message) ? [] : [`stopped on: ${error.message}`];
      } finally {
        if (saved === undefined) delete process.env.PATH;
        else process.env.PATH = saved;
      }
    });
  }
}

/** Run every case group; returns the names of cases that did not hold. */
function selfTest(workflow, appVersion) {
  const scratch = mkdtempSync(join(tmpdir(), "chart-images-"));
  const cases = harness(workflow, appVersion, scratch);
  try {
    containerCases(cases);
    releaseWorkflowCases(cases);
    chartCases(cases);
    helmCases(cases);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return cases.failures;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  let workflow;
  let appVersion;
  try {
    workflow = parse(readFileSync(RELEASE_WORKFLOW, "utf8"));
    appVersion = parse(readFileSync(join(CHART_DIR, "Chart.yaml"), "utf8"))?.appVersion;
  } catch (error) {
    console.error(`chart images gate: ${error.message}`);
    process.exit(2);
  }

  if (SELF_TEST) {
    out("chart images gate — self-test");
    const failures = selfTest(workflow, String(appVersion ?? ""));
    if (failures.length > 0) {
      console.error(`\ngate self-test failed:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`);
      process.exit(1);
    }
    out("gate self-test passed");
    return;
  }

  const published = readPublished(workflow);
  let renders;
  try {
    renders = renderAll();
  } catch (error) {
    if (!(error instanceof RenderFailed)) throw error;
    console.error(`chart images gate: ${error.message}`);
    process.exit(1);
  }
  const { problems, checked } = check(published, renders, String(appVersion ?? ""));
  if (problems.length > 0) {
    console.error(`chart images gate: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error("");
    process.exit(1);
  }

  out(`chart images gate: ok — ${checked} containers across ${renders.length} renders`);
  for (const { label, docs } of renders) {
    const images = [...new Set([...containers(docs)].map(({ container }) => container.image))];
    out(`  ${label}: ${images.sort().join(", ")}`);
  }
  out(`  published by release.yml: ${[...published.keys()].sort().join(", ")}`);
}

try {
  main();
} catch (error) {
  if (!(error instanceof Unusable)) throw error;
  console.error(`chart images gate: ${error.message}`);
  console.error("Refusing to report success without knowing what to check against.");
  process.exit(2);
}
