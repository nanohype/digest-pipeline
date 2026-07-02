#!/usr/bin/env node
/**
 * Vendor the @nanohype/runtime modules this app consumes into src/runtime/.
 *
 * Same consumption model as the chart: `chart/charts/tenant-chart-base` is a
 * byte-identical copy of the library chart in nanohype/templates, and
 * src/runtime/ is a byte-identical copy of the runtime modules in
 * nanohype/library/runtime/src. The library is the single source of truth —
 * behavior changes land there first (with their tests), then re-sync here.
 * A copy that drifts from the source is the defect.
 *
 *   node scripts/sync-runtime.mjs            # copy the modules from the source of truth
 *   node scripts/sync-runtime.mjs --check    # CI gate: exit 1 if any copy drifted
 *
 * Source resolution: $NANOHYPE_RUNTIME_SRC if set, else a sibling checkout at
 * ../nanohype/library/runtime/src. CI checks out nanohype/nanohype and points
 * NANOHYPE_RUNTIME_SRC at it.
 */
import { readdir, readFile, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC =
  process.env.NANOHYPE_RUNTIME_SRC ?? join(ROOT, '..', 'nanohype', 'library', 'runtime', 'src');
const DEST = join(ROOT, 'src', 'runtime');

// The modules this app consumes. Tests stay upstream with the library —
// this repo tests its own wiring, not library internals.
const MODULES = ['metrics.ts', 'pii.ts', 'registry.ts', 'resilience.ts', 'workos-directory.ts'];

// Org-canonical configs carried the same way: byte-identical, drift-gated.
// Resolved relative to the runtime source (library/runtime/src → library/config).
const CONFIGS = [
  {
    src: join(SRC, '..', '..', 'config', 'prettierrc.json'),
    dest: join(ROOT, '.prettierrc.json'),
    name: '.prettierrc.json',
  },
];

const CHECK = process.argv.includes('--check');

async function main() {
  let drift = 0;

  if (CHECK) {
    for (const module of MODULES) {
      const [source, copy] = await Promise.all([
        readFile(join(SRC, module), 'utf8'),
        readFile(join(DEST, module), 'utf8').catch(() => null),
      ]);
      if (copy === source) {
        console.log(`ok  src/runtime/${module}`);
      } else {
        console.error(`DRIFT  src/runtime/${module} — run \`npm run sync:runtime\``);
        drift++;
      }
    }
    // A stray file under src/runtime/ is drift too — the directory holds
    // vendored modules only, so provenance stays greppable per file.
    const present = (await readdir(DEST).catch(() => [])).sort();
    for (const file of present) {
      if (!MODULES.includes(file)) {
        console.error(`DRIFT  src/runtime/${file} — not a vendored @nanohype/runtime module`);
        drift++;
      }
    }
    for (const cfg of CONFIGS) {
      const [source, copy] = await Promise.all([
        readFile(cfg.src, 'utf8'),
        readFile(cfg.dest, 'utf8').catch(() => null),
      ]);
      if (copy === source) {
        console.log(`ok  ${cfg.name}`);
      } else {
        console.error(`DRIFT  ${cfg.name} — run \`npm run sync:runtime\``);
        drift++;
      }
    }
    if (drift > 0) process.exit(1);
    return;
  }

  await mkdir(DEST, { recursive: true });
  for (const module of MODULES) {
    await copyFile(join(SRC, module), join(DEST, module));
    console.log(`vendored ${module} -> src/runtime/${module}`);
  }
  for (const cfg of CONFIGS) {
    await copyFile(cfg.src, cfg.dest);
    console.log(`vendored ${cfg.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
