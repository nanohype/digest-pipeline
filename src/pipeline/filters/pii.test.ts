import { describe, it, expect } from 'vitest';
import { piiFilter, piiScan, assertNoPii } from './pii.js';

describe('piiFilter', () => {
  it('redacts compensation phrasing', () => {
    expect(piiFilter('Offer of $150,000 base salary')).toContain('[REDACTED]');
    expect(piiFilter('annual comp is confidential')).toContain('[REDACTED]');
  });

  it('redacts performance-management vocabulary', () => {
    expect(piiFilter('Placed on PIP last quarter')).toContain('[REDACTED]');
    expect(piiFilter('Sent written warning to the team')).toContain('[REDACTED]');
    expect(piiFilter('Performance improvement plan initiated')).toContain('[REDACTED]');
  });

  it('redacts contact info (email, phone, street address)', () => {
    expect(piiFilter('Ping sarah.doe+dispatch@example.com later')).not.toContain('sarah.doe');
    expect(piiFilter('Call (415) 555-1234 if needed')).toContain('[REDACTED]');
    expect(piiFilter('Mail to 1600 Pennsylvania Ave today')).toContain('[REDACTED]');
  });

  it('redacts health/FMLA references', () => {
    expect(piiFilter('Approved FMLA leave extension')).toContain('[REDACTED]');
    expect(piiFilter('Shared a new diagnosis with HR')).toContain('[REDACTED]');
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
