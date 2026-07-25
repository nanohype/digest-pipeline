#!/usr/bin/env node
/**
 * Assert the rendered chart supplies every environment variable the app requires
 * to start.
 *
 * Why this exists: `helm template` proving the YAML parses says nothing about
 * whether the pod it describes can boot. Every entrypoint validates its
 * environment with Zod at startup, and a `z.string().min(1)` with no default is a
 * crash — not a degraded mode — when the chart does not supply it. The chart
 * shipped without eight such variables, and CI was green the whole time, because
 * nothing compared the two sides.
 *
 * A variable counts as supplied if it is rendered as a container `env` entry, or
 * if the ExternalSecret's `target.template.data` maps it — those land in the pod
 * through `envFrom` and are equally real.
 *
 * Run per environment; a missing variable fails the build with the file that
 * declares it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCHEMA_FILES = ["src/api/config.ts", "src/api/entrypoint.ts", "src/pipeline/entrypoint.ts"];
const EXTERNAL_SECRET = "chart/templates/externalsecret.yaml";
const ENVIRONMENTS = ["development", "staging", "production"];

/**
 * Required keys are `NAME: z.<something>` with neither `.optional()` nor
 * `.default(...)` on the same line. Anything with a default cannot crash the
 * pod, so it is out of scope here.
 */
function requiredKeys(file) {
  const src = readFileSync(file, "utf8");
  const found = new Map();
  for (const line of src.split("\n")) {
    const m = /^\s+([A-Z][A-Z0-9_]*):\s*z\./.exec(line);
    if (!m) continue;
    if (line.includes(".optional(") || line.includes(".default(")) continue;
    found.set(m[1], file);
  }
  return found;
}

function suppliedByRender(environment) {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      "digest-pipeline",
      "chart",
      "-f",
      "chart/values.yaml",
      "-f",
      `chart/values-${environment}.yaml`,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const names = new Set();
  for (const m of rendered.matchAll(/- name:\s*([A-Z][A-Z0-9_]*)\s*\n\s+value/g)) names.add(m[1]);
  return names;
}

/** Keys the ExternalSecret composes into the envFrom Secret. */
function suppliedBySecret() {
  const src = readFileSync(EXTERNAL_SECRET, "utf8");
  const start = src.indexOf("template:");
  // The terminator is the spec-level `data:` list, which must be matched at
  // exactly two spaces of indent — `indexOf('  data:')` also matches the nested
  // `      data:` inside `template:` and silently yields an empty slice.
  const rest = src.slice(start);
  const endMatch = /^ {2}data:/m.exec(rest);
  const body = endMatch ? rest.slice(0, endMatch.index) : rest;
  return new Set([...body.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*"/gm)].map((m) => m[1]));
}

/**
 * Every `property:` the ExternalSecret reads must exist in the secret shape
 * seed-secrets.sh writes. The two drifted during this fix — the chart asked for
 * `newsletterRecipientList` where the template writes `newsletterRecipients` —
 * and nothing would have caught it: the env var is mapped, so the check above
 * passes, and the failure only appears as an ExternalSecret that never syncs.
 */
function checkRemoteProperties() {
  const src = readFileSync(EXTERNAL_SECRET, "utf8");
  const template = JSON.parse(readFileSync("secrets.template.json", "utf8"));
  const problems = [];

  // `key: {{ .Values.externalSecret.<name>Secret }}` then `property: <prop>`.
  for (const m of src.matchAll(
    /key:\s*\{\{\s*\.Values\.externalSecret\.(\w+)\s*\}\}\s*\n\s*property:\s*(\w+)/g,
  )) {
    const [, valuesKey, property] = m;
    // externalSecret.workosSecret → workos-directory, runtimeConfigSecret →
    // runtime-config: the values key is the camelCase of the entry name.
    const entry = valuesKey
      .replace(/Secret$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
    const known = Object.keys(template).find((k) => k === entry || k.startsWith(`${entry}-`));
    // db-credentials is substrate-owned and deliberately absent from the template.
    if (!known) continue;
    if (!Object.hasOwn(template[known], property)) {
      problems.push(
        `    ${known}.${property} — not a key seed-secrets.sh writes (has: ${Object.keys(template[known]).join(", ")})`,
      );
    }
  }
  return problems;
}

const required = new Map();
for (const f of SCHEMA_FILES) for (const [k, v] of requiredKeys(f)) required.set(k, v);

const fromSecret = suppliedBySecret();
let failed = false;

for (const environment of ENVIRONMENTS) {
  const supplied = new Set([...suppliedByRender(environment), ...fromSecret]);
  const missing = [...required.keys()].filter((k) => !supplied.has(k)).sort();

  if (missing.length === 0) {
    console.log(`✓ ${environment}: all ${required.size} required variables supplied`);
    continue;
  }

  failed = true;
  console.error(`\n✗ ${environment}: the rendered chart cannot start the app.`);
  console.error(
    "  These are required with no default, so the pod fails Zod validation at startup:",
  );
  for (const k of missing) console.error(`    ${k}  (declared in ${required.get(k)})`);
  console.error(
    "\n  Supply each as chart env, or project it through the ExternalSecret if it is\n" +
      "  deployment-specific and cannot be known at chart-authoring time.",
  );
}

const propertyProblems = checkRemoteProperties();
if (propertyProblems.length > 0) {
  failed = true;
  console.error("\n\u2717 ExternalSecret reads properties the seeded secrets do not contain:");
  for (const p of propertyProblems) console.error(p);
  console.error(
    "\n  These sync-fail at runtime, not at render: the env var is mapped, so the\n" +
      "  coverage check above still passes.",
  );
} else {
  console.log("\u2713 every ExternalSecret property exists in secrets.template.json");
}

if (failed) process.exit(1);
