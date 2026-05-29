import { describe, it, expect } from 'vitest';
import { levenshteinDistance } from './diff.js';

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('returns the length of the other string when one is empty', () => {
    expect(levenshteinDistance('', 'hello')).toBe(5);
    expect(levenshteinDistance('world', '')).toBe(5);
  });

  it('counts single-character edits accurately', () => {
    expect(levenshteinDistance('kitten', 'sitten')).toBe(1); // substitution
    expect(levenshteinDistance('kitten', 'kittens')).toBe(1); // insertion
    expect(levenshteinDistance('kitten', 'kittn')).toBe(1); // deletion
  });

  it('computes a sensible distance on a classic pair', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('uses approximate sampling on long inputs without crashing', () => {
    const base = 'a'.repeat(6000);
    const modified = base.slice(0, 3000) + 'b'.repeat(10) + base.slice(3010);
    const distance = levenshteinDistance(base, modified);
    expect(distance).toBeGreaterThanOrEqual(0);
    expect(distance).toBeLessThanOrEqual(modified.length);
  });
});
