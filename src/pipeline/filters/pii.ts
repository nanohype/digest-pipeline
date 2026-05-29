/**
 * PII Filter — strips blocked content before LLM generation
 * Agent: eng-ai + qa-security
 *
 * PERMITTED: employee name, role, title, team/department (from directory sync only)
 * BLOCKED: personal contact info, compensation, PIP signals, health, HR cases, SSN, credit card, DOB
 */

import type { SourceItem, SanitizedSourceItem } from '../types.js';

const COMPENSATION_PATTERNS: RegExp[] = [
  /\$[\d,]+(?:\.\d{2})?(?:\s*(?:k|K|thousand|million))?\s*(?:salary|compensation|pay|bonus|equity|raise|offer)/gi,
  /(?:salary|compensation|pay|bonus|equity|raise|offer)\s*(?:of|is|was|at)?\s*\$[\d,]+/gi,
  /\b(?:annual|base|total)\s+(?:comp|compensation|salary|pay)\b/gi,
];

const PERFORMANCE_PATTERNS: RegExp[] = [
  /\bPIP\b/g,
  /performance\s+(?:improvement|management|plan|review|warning)/gi,
  /disciplinary\s+(?:action|proceeding|process)/gi,
  /written\s+warning/gi,
  /termination\s+notice/gi,
  /performance\s+corrective/gi,
];

const CONTACT_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /(?:\+1[\s-]?)?\(?[0-9]{3}\)?[\s\-.][0-9]{3}[\s\-.][0-9]{4}/g,
  /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Court|Ct|Place|Pl)\b/gi,
];

const HEALTH_PATTERNS: RegExp[] = [/\b(?:medical|health|diagnosis|disability|leave|FMLA|accommodation)\b/gi];

const HR_CASE_PATTERNS: RegExp[] = [/HR-\d+/gi, /case\s+#?\d+/gi, /ticket\s+#?[A-Z0-9]+/gi];

const FINANCIAL_ID_PATTERNS: RegExp[] = [/\b\d{3}-\d{2}-\d{4}\b/g, /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g];

const DOB_PATTERNS: RegExp[] = [
  /\b(?:date of birth|dob|born on)\s*:?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
  /\bDOB\s*:?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi,
];

const ALL_BLOCKED_PATTERNS: RegExp[] = [
  ...COMPENSATION_PATTERNS,
  ...PERFORMANCE_PATTERNS,
  ...CONTACT_PATTERNS,
  ...HEALTH_PATTERNS,
  ...HR_CASE_PATTERNS,
  ...FINANCIAL_ID_PATTERNS,
  ...DOB_PATTERNS,
];

export function piiFilter(text: string): string {
  let result = text;
  for (const pattern of ALL_BLOCKED_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

export function piiScan(text: string): { pattern: string; matches: string[] }[] {
  const findings: { pattern: string; matches: string[] }[] = [];
  for (const pattern of ALL_BLOCKED_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, pattern.flags)) ?? [];
    if (matches.length > 0) findings.push({ pattern: pattern.source, matches });
  }
  return findings;
}

export function assertNoPii(draftText: string, runId: string): void {
  const findings = piiScan(draftText);
  if (findings.length > 0) {
    throw new Error(`[${runId}] PII detected in LLM output: ${findings.map((f) => f.pattern).join(', ')}`);
  }
}

export function sanitizeSourceItem(item: SourceItem): SanitizedSourceItem {
  return {
    ...item,
    title: piiFilter(item.title),
    description: item.description ? piiFilter(item.description) : undefined,
  } as SanitizedSourceItem;
}
