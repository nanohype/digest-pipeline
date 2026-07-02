/**
 * PII Filter — strips blocked content before LLM generation.
 *
 * The pattern policy is the vendored @nanohype/runtime redaction catalog
 * (src/runtime/pii.ts): one org-wide PII definition covering secrets and
 * tokens, SSN and cards, compensation, performance/HR, health, DOB,
 * contact info, AWS account ids, and customer/infrastructure identifiers.
 * Replacements are typed per label ([EMAIL], [COMPENSATION], …) so
 * redacted text stays debuggable without exposing the value.
 *
 * PERMITTED: employee name, role, title, team/department (from directory sync only)
 * BLOCKED: everything in the catalog above
 *
 * The app-side wiring is unchanged: `sanitizeSourceItem` stamps the
 * `SanitizedSourceItem` brand at the aggregator boundary, and
 * `assertNoPii` runs at two checkpoints — on the assembled prompt before
 * the Bedrock call and on the LLM output.
 */

import { redact, scan, assertNoPii as assertNoPiiAgainstCatalog, type PiiFinding } from '../../runtime/pii.js';
import type { SourceItem, SanitizedSourceItem } from '../types.js';

/** Replace every match of the org-wide catalog with its typed token. */
export function piiFilter(text: string): string {
  return redact(text);
}

/** Report which catalog patterns match, without modifying the text. */
export function piiScan(text: string): PiiFinding[] {
  return scan(text);
}

/** Checkpoint guard — throws (message carries the run id) on any finding. */
export function assertNoPii(draftText: string, runId: string): void {
  assertNoPiiAgainstCatalog(draftText, runId);
}

export function sanitizeSourceItem(item: SourceItem): SanitizedSourceItem {
  return {
    ...item,
    title: piiFilter(item.title),
    description: item.description ? piiFilter(item.description) : undefined,
  } as SanitizedSourceItem;
}
