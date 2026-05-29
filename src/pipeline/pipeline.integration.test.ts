/**
 * Integration test: source items → piiFilter → dedupe → rank → pre-gen
 * PII assertion. No mocks of mocks, no external calls — exercises the real
 * implementations of every module in the chain except Bedrock (which is
 * simulated by building the same user prompt the generator would send).
 */

import { describe, it, expect } from 'vitest';
import { piiFilter, sanitizeSourceItem, assertNoPii } from './filters/pii.js';
import { deduplicateItems, rankAndSection } from './ai/ranker.js';
import type { SanitizedSourceItem, SourceItem } from './types.js';

function makeItem(overrides: Partial<SourceItem> = {}): SanitizedSourceItem {
  return sanitizeSourceItem({
    id: overrides.id ?? 'src-1',
    source: overrides.source ?? 'github',
    section: overrides.section ?? 'what_shipped',
    title: overrides.title ?? 'Shipped billing migration',
    description: overrides.description,
    url: overrides.url,
    author: overrides.author,
    publishedAt: overrides.publishedAt ?? new Date('2026-04-10T00:00:00Z'),
    rawSignals: overrides.rawSignals ?? {},
  });
}

// Bypass sanitizer to simulate a regression where an aggregator
// forgets to call sanitizeSourceItem before pushing.
function makeRawItem(overrides: Partial<SourceItem> = {}): SanitizedSourceItem {
  return {
    id: overrides.id ?? 'src-raw',
    source: overrides.source ?? 'github',
    section: overrides.section ?? 'what_shipped',
    title: overrides.title ?? 'Shipped billing migration',
    description: overrides.description,
    url: overrides.url,
    author: overrides.author,
    publishedAt: overrides.publishedAt ?? new Date('2026-04-10T00:00:00Z'),
    rawSignals: overrides.rawSignals ?? {},
  } as SanitizedSourceItem;
}

function fakeGeneratorPrompt(sections: ReturnType<typeof rankAndSection>): string {
  return sections
    .flatMap((s) => s.items)
    .map((i) => `${i.title}\n${i.description ?? ''}`)
    .join('\n\n');
}

describe('pipeline integration', () => {
  it('produces PII-free sections when aggregators apply piiFilter first', () => {
    const rawText = 'Please contact sarah@example.com about the launch';
    const items = [
      makeItem({ id: 'a', title: 'Launched billing migration', description: piiFilter(rawText) }),
      makeItem({ id: 'b', title: 'Hired new VP Engineering', section: 'new_joiners' }),
    ];

    const deduped = deduplicateItems(items);
    const sections = rankAndSection(deduped);
    const prompt = fakeGeneratorPrompt(sections);

    expect(sections).toHaveLength(5);
    expect(prompt).not.toContain('sarah@example.com');
    expect(() => assertNoPii(prompt, 'integration-run')).not.toThrow();
  });

  it('pre-generation assertion fires if an aggregator bug leaks PII', () => {
    // Simulate a regression where the aggregator skipped sanitizeSourceItem.
    const items = [makeRawItem({ description: 'Reach me at leak@example.com for details' })];
    const sections = rankAndSection(deduplicateItems(items));
    const prompt = fakeGeneratorPrompt(sections);

    expect(() => assertNoPii(prompt, 'regression-run')).toThrow(/PII detected/);
  });

  it('collapses near-duplicate items before the ranker sees them', () => {
    const items = [
      makeItem({ id: 'a', title: 'Launched dashboard' }),
      makeItem({ id: 'b', title: 'Launched dashboard!' }),
      makeItem({ id: 'c', title: 'Hired CTO', section: 'new_joiners' }),
    ];
    const deduped = deduplicateItems(items);
    expect(deduped).toHaveLength(2);
    const sections = rankAndSection(deduped);
    const totalItems = sections.reduce((n, s) => n + s.items.length, 0);
    expect(totalItems).toBe(2);
  });
});
