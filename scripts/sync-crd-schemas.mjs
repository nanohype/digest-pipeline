#!/usr/bin/env node
/**
 * Sync the CRD schemas this repo vendors from `nanohype/eks-agent-platform`
 * into `schemas/crd/`. Those files are the schema `scripts/validate-platform.mjs`
 * checks `platform.yaml` against.
 *
 * The schemas are committed rather than fetched at validation time on purpose.
 * The gate has to be deterministic and offline-capable: a validator that
 * reaches across the network for its schema either blocks on the network or —
 * far worse — degrades to passing everything when the fetch fails. Committing
 * the schemas means the gate always has exactly one schema, visible in the
 * diff, reviewable like any other file.
 *
 * Freshness is a separate job. This script's `--check` mode compares the
 * committed copies against the operator repo byte-for-byte and fails when they
 * diverge, the same contract `scripts/sync-vendored.mjs` applies to the
 * runtime modules and the tenant-chart-base chart. Upstream CRD changes land
 * here as a visible re-sync commit, never as a silent behavior change.
 *
 *   node scripts/sync-crd-schemas.mjs            # (re)write schemas/crd/
 *   node scripts/sync-crd-schemas.mjs --check    # CI gate: exit 1 if drifted
 *
 * The operator checkout is resolved from $EKS_AGENT_PLATFORM_DIR, defaulting
 * to a sibling checkout at ../eks-agent-platform (CI checks out
 * nanohype/eks-agent-platform and points the variable at it).
 */
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const OPERATOR_DIR = process.env.EKS_AGENT_PLATFORM_DIR ?? join(ROOT, "..", "eks-agent-platform");
const SRC_SUBDIR = "operators/config/crd/bases";
const DEST_SUBDIR = "schemas/crd";
const CHECK = process.argv.includes("--check");

/**
 * The CRDs `platform.yaml` declares. Kept explicit rather than globbed so a
 * kind disappearing upstream is a loud failure here instead of a silently
 * smaller schema set in the validator.
 */
const FILES = [
  "platform.nanohype.dev_tenants.yaml",
  "platform.nanohype.dev_platforms.yaml",
  "governance.nanohype.dev_budgetpolicies.yaml",
];

async function readOrNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  try {
    await stat(OPERATOR_DIR);
  } catch {
    console.error(
      `eks-agent-platform checkout not found at ${OPERATOR_DIR} — set EKS_AGENT_PLATFORM_DIR`,
    );
    process.exit(2);
  }

  let drift = 0;
  for (const file of FILES) {
    const src = join(OPERATOR_DIR, SRC_SUBDIR, file);
    const dest = join(ROOT, DEST_SUBDIR, file);
    const rel = `${DEST_SUBDIR}/${file}`;

    const srcBody = await readOrNull(src);
    if (srcBody === null) {
      console.error(`missing upstream CRD ${SRC_SUBDIR}/${file} in ${OPERATOR_DIR}`);
      process.exit(2);
    }

    if (CHECK) {
      if (srcBody === (await readOrNull(dest))) {
        console.log(`ok  ${rel}`);
      } else {
        console.error(`DRIFT  ${rel} — run \`npm run sync:crd\``);
        drift++;
      }
      continue;
    }

    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    console.log(`vendored ${rel}`);
  }

  if (drift > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
