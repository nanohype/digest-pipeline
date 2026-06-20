import { describe, it, expect } from 'vitest';
import { piiFilter, piiScan, assertNoPii } from './pii.js';

describe('piiFilter', () => {
  it('redacts compensation phrasing', () => {
    expect(piiFilter('Offer of $150,000 base salary')).toContain('[REDACTED]');
    expect(piiFilter('annual comp is confidential')).toContain('[REDACTED]');
  });

  it('redacts non-USD and bare-number compensation', () => {
    expect(piiFilter('£80,000 salary for the new hire')).toContain('[REDACTED]');
    expect(piiFilter('salary of £80,000 confirmed')).toContain('[REDACTED]');
    expect(piiFilter('Moved them to base 95k this cycle')).toContain('[REDACTED]');
    expect(piiFilter('Offer is 120k annually')).toContain('[REDACTED]');
    expect(piiFilter('€90k bonus approved')).toContain('[REDACTED]');
  });

  it('redacts performance-management vocabulary', () => {
    expect(piiFilter('Placed on PIP last quarter')).toContain('[REDACTED]');
    expect(piiFilter('Sent written warning to the team')).toContain('[REDACTED]');
    expect(piiFilter('Performance improvement plan initiated')).toContain('[REDACTED]');
  });

  it('redacts contact info (email, phone, street address)', () => {
    expect(piiFilter('Ping sarah.doe+digest-pipeline@example.com later')).not.toContain('sarah.doe');
    expect(piiFilter('Call (415) 555-1234 if needed')).toContain('[REDACTED]');
    expect(piiFilter('Mail to 1600 Pennsylvania Ave today')).toContain('[REDACTED]');
  });

  it('redacts international / E.164 phone numbers', () => {
    expect(piiFilter('Reach the London office on +44 20 7946 0958')).not.toContain('7946');
    expect(piiFilter('Reach the London office on +44 20 7946 0958')).toContain('[REDACTED]');
    expect(piiFilter('Direct line +1-415-555-1234 works too')).toContain('[REDACTED]');
    expect(piiFilter('Mobile +919876543210 on file')).toContain('[REDACTED]');
  });

  it('redacts health/FMLA references', () => {
    expect(piiFilter('Approved FMLA leave extension')).toContain('[REDACTED]');
    expect(piiFilter('Shared a new diagnosis with HR')).toContain('[REDACTED]');
  });

  it('redacts paraphrased medical / HR-health phrasing', () => {
    expect(piiFilter('She is on medical leave this month')).toContain('[REDACTED]');
    expect(piiFilter('Discussing mental health resources with the team')).toContain('[REDACTED]');
    expect(piiFilter('Filed a disability accommodation request')).toContain('[REDACTED]');
    expect(piiFilter('Approved a leave of absence starting Monday')).toContain('[REDACTED]');
  });

  it('does not redact benign uses of common health/comp words', () => {
    expect(piiFilter('The team is in good health and morale is high.')).not.toContain('[REDACTED]');
    expect(piiFilter('Base your decision on the data.')).not.toContain('[REDACTED]');
    expect(piiFilter('We are taking the lead on this project.')).not.toContain('[REDACTED]');
  });

  it('redacts HR case and ticket IDs', () => {
    expect(piiFilter('Tracking HR-2034 through resolution')).toContain('[REDACTED]');
    expect(piiFilter('Resolved ticket #ABC999 yesterday')).toContain('[REDACTED]');
  });

  it('redacts SSN, credit card, DOB', () => {
    expect(piiFilter('SSN 123-45-6789 appeared in the log')).not.toContain('123-45-6789');
    expect(piiFilter('Card 4242 4242 4242 4242 seen in diff')).not.toMatch(/4242 4242 4242 4242/);
    expect(piiFilter('DOB: 04/11/1986 from the spreadsheet')).toContain('[REDACTED]');
  });

  it('leaves clean text untouched', () => {
    const clean = 'We shipped the new dashboard on Tuesday.';
    expect(piiFilter(clean)).toBe(clean);
  });
});

describe('piiScan', () => {
  it('returns every pattern that matched', () => {
    const findings = piiScan('Email sarah@example.com and SSN 123-45-6789');
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array on clean input', () => {
    expect(piiScan('Nothing to see here')).toEqual([]);
  });
});

describe('assertNoPii', () => {
  it('throws when PII is present, including the run id in the message', () => {
    expect(() => assertNoPii('Email: john@example.com', 'run-123')).toThrow(/run-123/);
  });

  it('does not throw on clean text', () => {
    expect(() => assertNoPii('The quarterly newsletter is ready.', 'run-xyz')).not.toThrow();
  });
});
