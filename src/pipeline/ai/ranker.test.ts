import { describe, expect, it } from "vitest";
import { sanitizeSourceItem } from "../filters/pii.js";
import type { SanitizedSourceItem, SourceItem } from "../types.js";
import { deduplicateItems, rankAndSection } from "./ranker.js";

function makeItem(overrides: Partial<SourceItem> = {}): SanitizedSourceItem {
  return sanitizeSourceItem({
    id: overrides.id ?? "item-1",
    source: overrides.source ?? "github",
    section: overrides.section ?? "what_shipped",
    title: overrides.title ?? "Shipped the billing migration",
    description: overrides.description,
    url: overrides.url,
    author: overrides.author,
    publishedAt: overrides.publishedAt ?? new Date("2026-04-10T00:00:00Z"),
    rawSignals: overrides.rawSignals ?? {},
  });
}

describe("rankAndSection", () => {
  const now = new Date("2026-04-11T00:00:00Z");

  it("emits the five canonical sections in canonical order", () => {
    const result = rankAndSection([], now);
    const names = result.map((s) => s.name);
    expect(names).toEqual([
      "what_shipped",
      "whats_coming",
      "new_joiners",
      "wins_recognition",
      "the_ask",
    ]);
  });

  it("routes items to their declared section", () => {
    const items = [
      makeItem({ id: "a", section: "whats_coming" }),
      makeItem({ id: "b", section: "new_joiners" }),
    ];
    const result = rankAndSection(items, now);
    expect(result.find((s) => s.name === "whats_coming")?.items.map((i) => i.id)).toEqual(["a"]);
    expect(result.find((s) => s.name === "new_joiners")?.items.map((i) => i.id)).toEqual(["b"]);
  });

  it("sorts items within a section by score (most engagement first)", () => {
    const items = [
      makeItem({ id: "low", rawSignals: { reactionCount: 0, threadReplies: 0 } }),
      makeItem({ id: "high", rawSignals: { reactionCount: 20, threadReplies: 5 } }),
    ];
    const result = rankAndSection(items, now);
    const shipped = result.find((s) => s.name === "what_shipped");
    expect(shipped?.items[0].id).toBe("high");
    expect(shipped?.items[1].id).toBe("low");
  });

  it("boosts items with metadata (author/description/url)", () => {
    const base = { rawSignals: { reactionCount: 5 } };
    const bare = makeItem({ id: "bare", ...base });
    const enriched = makeItem({
      id: "enriched",
      description: "Details here",
      url: "https://example.com",
      author: { userId: "1", displayName: "N", role: "R", team: "T" },
      ...base,
    });
    const result = rankAndSection([bare, enriched], now);
    const shipped = result.find((s) => s.name === "what_shipped");
    expect(shipped?.items[0].id).toBe("enriched");
  });
});

describe("deduplicateItems", () => {
  it("keeps distinct items", () => {
    const items = [
      makeItem({ id: "a", title: "Launched auth revamp" }),
      makeItem({ id: "b", title: "Hired new CTO" }),
    ];
    expect(deduplicateItems(items)).toHaveLength(2);
  });

  it("collapses near-duplicate titles (edit-distance similarity > 0.85)", () => {
    const items = [
      makeItem({ id: "a", title: "Shipped billing migration" }),
      makeItem({ id: "b", title: "shipped billing migration!" }),
      makeItem({ id: "c", title: "Shipped-billing-migration" }),
    ];
    const result = deduplicateItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("preserves order of first-seen items", () => {
    const items = [
      makeItem({ id: "first", title: "Alpha release" }),
      makeItem({ id: "second", title: "Beta release" }),
    ];
    const result = deduplicateItems(items);
    expect(result.map((i) => i.id)).toEqual(["first", "second"]);
  });
});
