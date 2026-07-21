#!/usr/bin/env node
/**
 * Gate for `platform.yaml` — the tenant declaration this repo applies to a
 * cluster before ArgoCD reconciles the chart.
 *
 * The manifest is applied by hand (or by a bootstrap job), so nothing between
 * writing it and `kubectl apply` reads it. Without a gate, a typo'd field name
 * or a Platform pointing at a Tenant that doesn't exist reaches the cluster
 * before anyone notices. This runs in CI so the mistake fails a pull request
 * instead.
 *
 *   node scripts/validate-platform.mjs [path/to/platform.yaml]
 *
 * Exit codes are distinct on purpose:
 *   0  every document valid
 *   1  validation failures (reported per document, with paths)
 *   2  the schemas could not be loaded
 *
 * Exit 2 matters as much as exit 1. A gate that passes when it can't find its
 * schema is worse than no gate — it reports success while checking nothing.
 * Every path that fails to produce a usable schema exits 2 with the reason.
 *
 * ── What gets checked ────────────────────────────────────────────────────────
 *
 * 1. Structure, against the CRD schemas vendored in `schemas/crd/`
 *    (`scripts/sync-crd-schemas.mjs` keeps them in step with
 *    `nanohype/eks-agent-platform`). The walker is strict about unknown
 *    fields, which plain JSON Schema validation would not be: `controller-gen`
 *    emits no `additionalProperties: false`, so an invented field like
 *    `spec.tenantName` validates clean against the generated schema and is
 *    then dropped on the floor by the API server. Unknown properties are
 *    errors here, with a nearest-match hint.
 *
 * 2. Scope. `Tenant` is cluster-scoped and must carry no `metadata.namespace`;
 *    `Platform` and `BudgetPolicy` are namespaced and must carry one. A
 *    namespaced Tenant is accepted by `kubectl apply` (the namespace is simply
 *    ignored) and reads as correct in review, which is exactly the class of
 *    mistake worth catching mechanically.
 *
 * 3. Cross-document consistency, which no single-document schema can express:
 *      - `Platform.spec.tenant` names a `Tenant` declared in this file
 *      - `Platform.spec.budget.name` names a `BudgetPolicy` in the same namespace
 *      - `BudgetPolicy.spec.platformRef.name` names that Platform back
 *      - namespaced objects live in `tenants-<tenant>`, per the
 *        platform-tenant contract
 *
 * 4. The chart's OTel resource attributes. `agents.tenant` and
 *    `agents.platform` are how every trace, metric and dashboard attributes
 *    cost and ownership; if they drift from the CRs, telemetry is filed under
 *    a tenant that doesn't exist. Every `chart/values*.yaml` is checked
 *    against the names declared here.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const SCHEMA_DIR = join(ROOT, "schemas", "crd");
const CHART_DIR = join(ROOT, "chart");
// An explicit path argument is resolved against the caller's cwd, so a copy of
// the manifest anywhere on disk can be checked against this repo's schemas.
const MANIFEST = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "platform.yaml");

/** Kinds `platform.yaml` is expected to declare — absence of a schema is fatal. */
const REQUIRED_KINDS = ["Tenant", "Platform", "BudgetPolicy"];

/** Top-level keys a source manifest may carry. `status` is operator-owned. */
const ALLOWED_TOP_LEVEL = new Set(["apiVersion", "kind", "metadata", "spec"]);

/**
 * ObjectMeta subset a checked-in CR may set. The CRDs declare `metadata` as a
 * bare `type: object` with no properties, so validating against them would
 * accept any key at all; this is the real constraint.
 */
const DNS_1123_SUBDOMAIN = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$";
const DNS_1123_LABEL = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";
const METADATA_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", pattern: DNS_1123_SUBDOMAIN, maxLength: 253 },
    namespace: { type: "string", pattern: DNS_1123_LABEL, maxLength: 63 },
    labels: { type: "object", additionalProperties: { type: "string" } },
    annotations: { type: "object", additionalProperties: { type: "string" } },
  },
};

/** Abort with the reason the schema could not be obtained. */
function unusable(message) {
  console.error(`platform.yaml gate: ${message}`);
  console.error("Refusing to report success without a schema to check against.");
  process.exit(2);
}

const IS_TYPE = {
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number",
};

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Levenshtein distance, for "did you mean" hints on unknown fields. */
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/** `" (did you mean `x`?)"` when a known property is close enough to be a typo. */
function hint(key, known) {
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const score = distance(key.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(key.length / 3))
    ? ` (did you mean \`${best}\`?)`
    : "";
}

/**
 * Strict structural walk over a controller-gen OpenAPI v3 schema.
 * Unknown properties are errors unless the schema opts out via
 * `additionalProperties` or `x-kubernetes-preserve-unknown-fields`.
 */
function walk(schema, value, path, errors) {
  if (schema.type && !IS_TYPE[schema.type]?.(value)) {
    errors.push(`${path}: expected ${schema.type}, got ${describe(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below minimum ${schema.minimum}`);
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      walk(schema.items, item, `${path}[${i}]`, errors);
    });
    return;
  }

  if (schema.type !== "object" || !IS_TYPE.object(value)) return;

  const properties = schema.properties ?? {};
  for (const required of schema.required ?? []) {
    if (!(required in value)) errors.push(`${path}: missing required field \`${required}\``);
  }

  const preserveUnknown = schema["x-kubernetes-preserve-unknown-fields"] === true;
  const additional = schema.additionalProperties;
  for (const [key, child] of Object.entries(value)) {
    if (key in properties) {
      walk(properties[key], child, `${path}.${key}`, errors);
    } else if (IS_TYPE.object(additional)) {
      walk(additional, child, `${path}.${key}`, errors);
    } else if (!preserveUnknown && additional !== true) {
      errors.push(`${path}: unknown field \`${key}\`${hint(key, Object.keys(properties))}`);
    }
  }
}

/** Load the vendored CRDs into a `group/version#Kind` → {scope, spec schema} map. */
async function loadSchemas() {
  let files;
  try {
    files = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".yaml")).sort();
  } catch {
    unusable(
      `CRD schema directory not found at ${SCHEMA_DIR}. ` +
        "Run `npm run sync:crd` against an eks-agent-platform checkout.",
    );
  }
  if (files.length === 0) unusable(`no CRD schemas in ${SCHEMA_DIR}`);

  const registry = new Map();
  for (const file of files) {
    let crd;
    try {
      crd = parse(await readFile(join(SCHEMA_DIR, file), "utf8"));
    } catch (e) {
      unusable(`schemas/crd/${file} is not parseable YAML: ${e.message}`);
    }
    if (crd?.kind !== "CustomResourceDefinition") {
      unusable(`schemas/crd/${file} is not a CustomResourceDefinition`);
    }
    const { group, names, scope, versions } = crd.spec ?? {};
    if (!group || !names?.kind || !scope || !Array.isArray(versions)) {
      unusable(
        `schemas/crd/${file} is missing spec.group / spec.names.kind / spec.scope / versions`,
      );
    }
    for (const version of versions) {
      if (version.served === false) continue;
      const root = version.schema?.openAPIV3Schema;
      if (!root?.properties?.spec) {
        unusable(`schemas/crd/${file} version ${version.name} carries no spec schema`);
      }
      registry.set(`${group}/${version.name}#${names.kind}`, {
        scope,
        spec: root.properties.spec,
        file,
      });
    }
  }

  for (const kind of REQUIRED_KINDS) {
    if (![...registry.keys()].some((k) => k.endsWith(`#${kind}`))) {
      unusable(`no served CRD schema for kind ${kind} in ${SCHEMA_DIR}`);
    }
  }
  return registry;
}

/** Validate one document; returns {kind, name, namespace, spec} or null. */
function validateDocument(doc, index, registry, errors) {
  const at = `doc[${index}]`;
  if (!IS_TYPE.object(doc)) {
    errors.push(`${at}: expected a mapping, got ${describe(doc)}`);
    return null;
  }
  const { apiVersion, kind } = doc;
  if (typeof apiVersion !== "string" || typeof kind !== "string") {
    errors.push(`${at}: apiVersion and kind are required strings`);
    return null;
  }

  const entry = registry.get(`${apiVersion}#${kind}`);
  if (!entry) {
    errors.push(
      `${at}: no served CRD schema for ${apiVersion} ${kind} — ` +
        `known: ${[...registry.keys()].sort().join(", ")}`,
    );
    return null;
  }

  const label = `${kind}/${doc.metadata?.name ?? "<unnamed>"}`;
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      errors.push(
        `${label}: unexpected top-level key \`${key}\`` +
          (key === "status" ? " — status is written by the operator, not declared here" : ""),
      );
    }
  }

  const metadata = doc.metadata;
  if (!IS_TYPE.object(metadata)) {
    errors.push(`${label}: metadata is required`);
    return null;
  }
  walk(METADATA_SCHEMA, metadata, `${label}.metadata`, errors);

  if (entry.scope === "Cluster" && metadata.namespace !== undefined) {
    errors.push(
      `${label}: ${kind} is cluster-scoped (${entry.file}) but sets ` +
        `metadata.namespace: ${metadata.namespace}`,
    );
  }
  if (entry.scope === "Namespaced" && metadata.namespace === undefined) {
    errors.push(`${label}: ${kind} is namespaced (${entry.file}) but sets no metadata.namespace`);
  }

  if (doc.spec === undefined) {
    errors.push(`${label}: spec is required`);
    return null;
  }
  walk(entry.spec, doc.spec, `${label}.spec`, errors);

  return { kind, name: metadata.name, namespace: metadata.namespace, spec: doc.spec };
}

/** Checks no single-document schema can express. */
function checkConsistency(objects, errors) {
  const tenants = objects.filter((o) => o.kind === "Tenant");
  const platforms = objects.filter((o) => o.kind === "Platform");
  const budgets = objects.filter((o) => o.kind === "BudgetPolicy");

  if (tenants.length !== 1) {
    errors.push(`expected exactly one Tenant, found ${tenants.length}`);
  }
  if (platforms.length !== 1) {
    errors.push(`expected exactly one Platform, found ${platforms.length}`);
  }

  for (const platform of platforms) {
    const tenantName = platform.spec?.tenant;
    if (tenantName !== undefined && !tenants.some((t) => t.name === tenantName)) {
      errors.push(
        `Platform/${platform.name}: spec.tenant \`${tenantName}\` names no Tenant declared here ` +
          `(declared: ${tenants.map((t) => t.name).join(", ") || "none"})`,
      );
    }
    if (typeof tenantName === "string") {
      const expected = `tenants-${tenantName}`;
      if (platform.namespace !== expected) {
        errors.push(
          `Platform/${platform.name}: namespace \`${platform.namespace}\` should be ` +
            `\`${expected}\` — the tenant's management namespace`,
        );
      }
    }

    const budgetName = platform.spec?.budget?.name;
    const budget = budgets.find((b) => b.name === budgetName);
    if (budgetName !== undefined && !budget) {
      errors.push(
        `Platform/${platform.name}: spec.budget.name \`${budgetName}\` names no BudgetPolicy declared here`,
      );
    } else if (budget && budget.namespace !== platform.namespace) {
      errors.push(
        `Platform/${platform.name}: BudgetPolicy \`${budgetName}\` is in ` +
          `\`${budget.namespace}\`, not the Platform's \`${platform.namespace}\` — ` +
          "spec.budget resolves in the Platform's own namespace",
      );
    }
  }

  for (const budget of budgets) {
    const ref = budget.spec?.platformRef?.name;
    if (ref !== undefined && !platforms.some((p) => p.name === ref)) {
      errors.push(
        `BudgetPolicy/${budget.name}: spec.platformRef.name \`${ref}\` names no Platform declared here`,
      );
    }
  }

  return { tenant: tenants[0]?.name, platform: platforms[0]?.name };
}

/** Parse `k=v,k=v` into a map. */
function parseResourceAttributes(raw) {
  const out = new Map();
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

/** `agents.tenant` / `agents.platform` in every chart values file must match the CRs. */
async function checkChartAttributes(names, errors) {
  let files;
  try {
    files = (await readdir(CHART_DIR))
      .filter((f) => f === "values.yaml" || (f.startsWith("values-") && f.endsWith(".yaml")))
      .sort();
  } catch {
    unusable(`chart directory not found at ${CHART_DIR}`);
  }
  if (files.length === 0) unusable(`no values files in ${CHART_DIR}`);

  for (const file of files) {
    const values = parse(await readFile(join(CHART_DIR, file), "utf8"));
    const raw = values?.env?.OTEL_RESOURCE_ATTRIBUTES;
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      errors.push(`chart/${file}: env.OTEL_RESOURCE_ATTRIBUTES must be a string`);
      continue;
    }
    const attrs = parseResourceAttributes(raw);
    for (const [key, expected] of [
      ["agents.tenant", names.tenant],
      ["agents.platform", names.platform],
    ]) {
      const actual = attrs.get(key);
      if (actual === undefined) {
        errors.push(
          `chart/${file}: env.OTEL_RESOURCE_ATTRIBUTES is missing \`${key}\` — ` +
            "required by the platform-tenant contract",
        );
      } else if (expected !== undefined && actual !== expected) {
        errors.push(
          `chart/${file}: \`${key}=${actual}\` does not match platform.yaml (\`${expected}\`)`,
        );
      }
    }
  }
}

async function main() {
  const registry = await loadSchemas();

  let source;
  try {
    source = await readFile(MANIFEST, "utf8");
  } catch {
    console.error(`platform.yaml gate: manifest not found at ${MANIFEST}`);
    process.exit(2);
  }

  const errors = [];
  const documents = parseAllDocuments(source);
  const objects = [];
  documents.forEach((document, i) => {
    for (const problem of document.errors) {
      errors.push(`doc[${i}]: YAML parse error — ${problem.message}`);
    }
    if (document.errors.length > 0) return;
    const value = document.toJS();
    if (value === null) return; // an empty document between separators
    const object = validateDocument(value, i, registry, errors);
    if (object) objects.push(object);
  });

  if (objects.length === 0 && errors.length === 0) {
    errors.push(`${MANIFEST} declares no documents`);
  }

  const names = checkConsistency(objects, errors);
  await checkChartAttributes(names, errors);

  if (errors.length > 0) {
    console.error(`platform.yaml gate: ${errors.length} problem(s)\n`);
    for (const error of errors) console.error(`  ✗ ${error}`);
    console.error("");
    process.exit(1);
  }

  const summary = objects.map((o) => `${o.kind}/${o.name}`).join(", ");
  console.log(`platform.yaml gate: ok — ${summary}`);
  console.log(
    `  schemas: ${[...new Set([...registry.values()].map((v) => v.file))].sort().join(", ")}`,
  );
  console.log(`  tenant=${names.tenant} platform=${names.platform}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
