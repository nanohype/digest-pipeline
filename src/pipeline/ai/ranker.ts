/**
 * Section grouping & significance ranking
 * Groups items into their pre-assigned canonical sections and scores by significance
 * Agent: eng-ai
 */

import { levenshteinDistance } from "../../common/string.js";
import { SECTION_DISPLAY_NAMES, SECTION_ORDER } from "../sections.js";
import type { RankedSection, SanitizedSourceItem, SectionName } from "../types.js";

export function rankAndSection(
  allItems: SanitizedSourceItem[],
  now: Date = new Date(),
): RankedSection[] {
  const grouped = new Map<SectionName, SanitizedSourceItem[]>();
  for (const section of SECTION_ORDER) grouped.set(section, []);
  for (const item of allItems) {
    const target = grouped.get(item.section);
    if (target) target.push(item);
    else grouped.get("what_shipped")!.push(item);
  }
  return SECTION_ORDER.map((sectionName) => {
    const items = grouped.get(sectionName) ?? [];
    const scored = items
      .map((item) => ({ item, score: scoreItem(item, now) }))
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
    return {
      name: sectionName,
      displayName: SECTION_DISPLAY_NAMES[sectionName],
      items: scored,
      truncatedCount: 0,
    };
  });
}

function scoreItem(item: SanitizedSourceItem, now: Date): number {
  let score = 0;
  const ageHours = (now.getTime() - item.publishedAt.getTime()) / (1000 * 60 * 60);
  score += Math.max(0, 40 - ageHours * 0.5);
  const signals = item.rawSignals;
  if (typeof signals.reactionCount === "number") score += Math.min(30, signals.reactionCount * 3);
  if (typeof signals.threadReplies === "number") score += Math.min(15, signals.threadReplies * 2);
  if (typeof signals.priority === "number") score += Math.max(0, (5 - signals.priority) * 5);
  if (item.author) score += 5;
  if (item.description) score += 5;
  if (item.url) score += 5;
  return score;
}

export function deduplicateItems(items: SanitizedSourceItem[]): SanitizedSourceItem[] {
  const seen: string[] = [];
  return items.filter((item) => {
    const normalized = item.title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim();
    const isDuplicate = seen.some((s) => similarity(s, normalized) > 0.85);
    if (!isDuplicate) seen.push(normalized);
    return !isDuplicate;
  });
}

function similarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1.0;
  return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
}
