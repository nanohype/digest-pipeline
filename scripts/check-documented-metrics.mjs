#!/usr/bin/env node
/**
 * Assert the metric-reference table in README.md is the set of metrics the code
 * actually emits.
 *
 * Why this exists: the docs claimed `digest-pipeline.run.duration_ms{status}`
 * long after the instrument was renamed to `run.duration_seconds` — the rename
 * that made the p95 alert able to fire at all. They also claimed
 * `draft.edit_rate{run_id}` and `email.sent{run_id}`, two labels the code
 * deliberately does not emit. The alerts and the dashboard queried the real
 * names the whole time, so nothing went red; only the written contract was
 * wrong. CLAUDE.md is what an agent reads before touching this repo, which makes
 * a stale metric name there worse than a stale comment: the next reader's most
 * likely "fix" is to add the label the doc promises.
 *
 * The drift had two causes, and both are closed rather than just corrected. The
 * list lived in two files, so a rename had to be made twice and was made once.
 * And it was written as nested brace shorthand inside a prose sentence
 * (`bedrock.{tokens{kind,model},fallback}`), which no reader could diff against
 * reality and no gate could parse without guessing. It is now one table, in one
 * file, in a shape both a human and this script can read.
 *
 * Three properties are checked:
 *
 *   1. Every metric in the table resolves to a declared instrument.
 *   2. Every declared instrument appears in the table. An undocumented metric is
 *      as much a defect as a documented one that does not exist.
 *   3. No row claims a per-run label (`run_id`, `draft_id`). Those are kept off
 *      labels so the series count stays bounded, and a table that promises one
 *      invites the regression back in.
 *
 * Label sets beyond that invariant are not compared against call sites: doing it
 * honestly means resolving every attribute object, and a regex that guessed
 * would fail open on exactly the cases worth catching. What is checked here is
 * checked properly; the rest is left to review rather than faked.
 */

import { readFileSync } from "node:fs";

const METRICS_FILE = "src/common/metrics.ts";
const DOC_FILE = "README.md";
const NAMESPACE = "digest-pipeline";

/** Labels that must never appear on a documented metric. */
const FORBIDDEN_LABELS = ["run_id", "draft_id"];

/** Instrument names declared in metrics.ts, e.g. `run.duration_seconds`. */
function declaredInstruments(source) {
  const names = new Set();
  for (const match of source.matchAll(/(?:counter|histogram|gauge)Instrument\(\s*"([^"]+)"/g)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * Rows of the metric-reference table: a Markdown row whose first cell is a
 * backticked `digest-pipeline.<name>`. Any other table in the file is ignored,
 * so the gate does not depend on where in README the section sits.
 */
function tableRows(text) {
  const rows = [];
  text.split("\n").forEach((line, index) => {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|([^|]*)\|/);
    if (!match) return;
    const [, name, labelCell] = match;
    if (!name.startsWith(`${NAMESPACE}.`)) return;
    const labels = [...labelCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    rows.push({ name: name.slice(NAMESPACE.length + 1), labels, line: index + 1 });
  });
  return rows;
}

const declared = declaredInstruments(readFileSync(METRICS_FILE, "utf8"));
if (declared.size === 0) {
  console.error(`${METRICS_FILE}: no instruments found — the extraction pattern is stale.`);
  process.exit(1);
}

const rows = tableRows(readFileSync(DOC_FILE, "utf8"));
if (rows.length === 0) {
  console.error(
    `${DOC_FILE}: no metric-reference table found. It is the authoritative list — ` +
      `a row per instrument, first cell a backticked \`${NAMESPACE}.<name>\`.`,
  );
  process.exit(1);
}

const errors = [];
const documented = new Set();

for (const { name, labels, line } of rows) {
  documented.add(name);
  if (!declared.has(name)) {
    errors.push(
      `${DOC_FILE}:${line}: documents \`${NAMESPACE}.${name}\` — no such instrument in ${METRICS_FILE}.`,
    );
  }
  for (const label of labels.filter((l) => FORBIDDEN_LABELS.includes(l))) {
    errors.push(
      `${DOC_FILE}:${line}: \`${NAMESPACE}.${name}\` claims a \`${label}\` label. Per-run ` +
        `identifiers are kept off metric labels so the series count stays bounded — they ` +
        `belong on the trace and in audit_events.`,
    );
  }
}

for (const name of [...declared].sort()) {
  if (!documented.has(name)) {
    errors.push(
      `${METRICS_FILE}: \`${NAMESPACE}.${name}\` is emitted but has no row in the ` +
        `${DOC_FILE} metric-reference table.`,
    );
  }
}

if (errors.length > 0) {
  console.error("Documented metrics do not match the emitted ones:\n");
  for (const error of errors) console.error(`- ${error}`);
  console.error(`\ndeclared in ${METRICS_FILE}: ${[...declared].sort().join(", ")}`);
  process.exit(1);
}

console.log(
  `Metric reference matches ${METRICS_FILE}: ${declared.size} instruments documented, ` +
    `no per-run labels claimed.`,
);
