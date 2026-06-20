/**
 * PII Filter — strips blocked content before LLM generation
 * Agent: eng-ai + qa-security
 *
 * PERMITTED: employee name, role, title, team/department (from directory sync only)
 * BLOCKED: personal contact info, compensation, PIP signals, health, HR cases, SSN, credit card, DOB
 */

import type { SourceItem, SanitizedSourceItem } from '../types.js';

// Comp keywords reused across the currency-agnostic patterns below.
const COMP_KEYWORD = '(?:salary|compensation|comp|pay|bonus|equity|RSUs?|raise|offer|base|stipend)';
// A monetary amount: optional currency symbol (£/€/$/¥ etc.) or none, with an
// optional k/K/thousand/million/per annum/annually/k-per-year magnitude suffix.
const MONEY_AMOUNT =
  '(?:[$£€¥₹]\\s?)?[\\d,]+(?:\\.\\d{1,2})?(?:\\s*(?:k|K|thousand|million|m|/\\s*year|/\\s*yr|per\\s+annum|annually))?';

const COMPENSATION_PATTERNS: RegExp[] = [
  // Currency-symbol amount adjacent (either side) to a comp keyword:
  // "$150,000 base salary", "salary of £80,000", "€90k bonus".
  new RegExp(`[$£€¥₹]\\s?[\\d,]+(?:\\.\\d{1,2})?(?:\\s*(?:k|K|thousand|million|m))?\\s*${COMP_KEYWORD}`, 'gi'),
  new RegExp(`${COMP_KEYWORD}\\s*(?:of|is|was|at|:)?\\s*[$£€¥₹]\\s?[\\d,]+`, 'gi'),
  // Bare-number amount adjacent to a comp keyword (currency-agnostic):
  // "base 95k", "salary of 80,000", "bonus 12000".
  new RegExp(`${COMP_KEYWORD}\\s*(?:of|is|was|at|:)?\\s*${MONEY_AMOUNT}`, 'gi'),
  new RegExp(`${MONEY_AMOUNT}\\s*${COMP_KEYWORD}`, 'gi'),
  // Magnitude-suffixed amount with annual cadence regardless of keyword:
  // "120k annually", "95k per annum", "£80,000 per year".
  /(?:[$£€¥₹]\s?)?[\d,]+(?:\.\d{1,2})?\s*[kKmM]?\s*(?:per\s+annum|annually|\/\s*year|\/\s*yr|per\s+year|a\s+year)\b/gi,
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
  // US/NANP formats with separators or parens: "(415) 555-1234", "415-555-1234",
  // "+1 415 555 1234". Kept distinct from the international branch below so the
  // existing US fixtures stay covered exactly.
  /(?:\+1[\s\-.]?)?\(?[0-9]{3}\)?[\s\-.][0-9]{3}[\s\-.][0-9]{4}\b/g,
  // E.164 / international: a leading "+" country code followed by 7-14 more
  // digits, allowing space/dash/dot grouping. Catches "+44 20 7946 0958",
  // "+1-415-555-1234", "+919876543210". Requires the leading "+" so it never
  // matches the bare 9-digit SSN or 16-digit card runs handled separately.
  /\+\d{1,3}(?:[\s\-.]?\d){7,14}\b/g,
  /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Court|Ct|Place|Pl)\b/gi,
];

const HEALTH_PATTERNS: RegExp[] = [
  // Strong standalone signals — unambiguous on their own.
  /\bFMLA\b/gi,
  /\bdiagnos(?:is|ed|es)\b/gi,
  // Multi-word HR/medical phrasing. Tightened to phrases so common bare words
  // ("leave", "health", "medical") no longer trip on benign newsletter text.
  /\bmedical\s+(?:leave|condition|emergency|appointment|record|history|note)\b/gi,
  /\bmental\s+health\b/gi,
  /\bhealth\s+(?:condition|issue|concern|record|emergency)\b/gi,
  /\b(?:short|long)[\s-]term\s+disability\b/gi,
  /\bdisability\s+(?:accommodation|leave|claim|benefits?|status)\b/gi,
  /\b(?:reasonable\s+)?accommodation\s+(?:request|for)\b/gi,
  /\b(?:sick|medical|maternity|paternity|parental|bereavement)\s+leave\b/gi,
  /\bleave\s+of\s+absence\b/gi,
  /\bworkers?[''\s]?\s*comp(?:ensation)?\s+(?:claim|case|injury)\b/gi,
  /\b(?:treatment|therapy|prescription|hospitaliz(?:ed|ation)|surgery)\s+for\b/gi,
];

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
