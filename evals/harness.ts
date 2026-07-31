/**
 * Eval harness for the newsletter generator.
 *
 * An eval is not a test. A test asserts that code does what it says; an eval
 * measures whether a *model* does, on these prompts, and the answer is a rate
 * rather than a boolean. Both live here, told apart by name:
 *
 *   npm test      runs evals/*.test.ts — fixture validity and the graders.
 *                 No model, no credentials, always runs.
 *   npm run eval  runs evals/*.eval.ts — the model in the loop. Needs
 *                 credentials, costs money, reports a score.
 *
 * Two names because one must never be mistaken for the other. A suite that
 * silently skips its model tier and reports green converts an absence of
 * evidence into a claim of safety.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sanitizeSourceItem } from "../src/pipeline/filters/pii.js";
import { SECTION_DISPLAY_NAMES } from "../src/pipeline/sections.js";
import type { RankedSection, SanitizedSourceItem, SectionName } from "../src/pipeline/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const sectionNameSchema = z.enum([
  "what_shipped",
  "whats_coming",
  "new_joiners",
  "wins_recognition",
  "the_ask",
]);

/**
 * A golden case.
 *
 * `kind` decides how a failure reads:
 *
 *   capability — the generator doing its job: right sections, right length,
 *                the voice rules the system prompt sets out. Prose varies, so
 *                these score as a rate against a floor, like coverage.
 *   adversarial — the generator holding a boundary against an item written to
 *                subvert it. No acceptable rate below 100%.
 */
export const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["capability", "adversarial"]),
    /** Why this case exists — read on failure, so write it for that moment. */
    rationale: z.string().min(20),
    sections: z
      .array(
        z.object({
          name: sectionNameSchema,
          items: z
            .array(
              z.object({
                title: z.string().min(1),
                description: z.string().optional(),
                author: z.string().optional(),
              }),
            )
            .default([]),
        }),
      )
      .min(1),
    expect: z
      .object({
        /** Display names that must appear in the draft. */
        headers: z.array(sectionNameSchema).default([]),
        /**
         * Display names that must NOT appear. The generator deliberately lets
         * the model omit empty sections rather than emit filler, so a sparse
         * week is a real expectation and not an oversight.
         */
        noHeaders: z.array(sectionNameSchema).default([]),
        /** Inclusive word-count band. The system prompt asks for 400-600. */
        words: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
        /** Terms that must appear somewhere — the item actually got covered. */
        mentions: z.array(z.array(z.string().min(1)).min(1)).default([]),
        /** Strings that must not appear. How an injection case is graded. */
        absent: z.array(z.string().min(1)).default([]),
        /**
         * Regex sources that must not match the draft, tested case-insensitively.
         *
         * `absent` is a substring check, which is the wrong tool whenever the
         * forbidden thing has no fixed spelling. An item that asks the model to
         * publish someone's home email cannot be graded on the phrase "home
         * email": a model that refuses *and says what it refused* contains that
         * phrase, and a model that complies invents an address that appears in
         * no fixture. Matching a leak needs a pattern, and the request's own
         * wording is not one.
         */
        absentPatterns: z.array(z.string().min(1)).default([]),
        /** Openers the voice rules forbid. Matched case-insensitively. */
        notStartingWith: z.array(z.string().min(1)).default([]),
        /** True when generate() is expected to throw rather than return. */
        throws: z.boolean().default(false),
      })
      .strict(),
  })
  .strict();

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalSuiteSchema = z
  .object({
    name: z.string().min(1),
    /** Fraction of capability cases that must pass. Adversarial is always 1. */
    capabilityFloor: z.number().min(0).max(1),
    cases: z.array(evalCaseSchema).min(1),
  })
  .strict();

export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export function loadSuite(file: string): EvalSuite {
  const raw = JSON.parse(readFileSync(join(HERE, "fixtures", file), "utf-8"));
  return evalSuiteSchema.parse(raw);
}

export function loadVoiceBaseline(): string {
  return readFileSync(join(HERE, "fixtures", "voice-baseline.md"), "utf-8");
}

/** Turn a case's declarative sections into the shape the generator consumes. */
export function toRankedSections(c: EvalCase): RankedSection[] {
  return c.sections.map((section, si) => ({
    name: section.name as SectionName,
    // Built the way the ranker builds it, so the harness feeds the generator the
    // same shape production does rather than a near-miss.
    displayName: SECTION_DISPLAY_NAMES[section.name as SectionName],
    truncatedCount: 0,
    items: section.items.map((item, ii) =>
      sanitizeSourceItem({
        id: `${c.id}-${si}-${ii}`,
        source: "slack",
        section: section.name as SectionName,
        title: item.title,
        description: item.description,
        publishedAt: new Date("2026-03-13T12:00:00Z"),
        rawSignals: {},
        ...(item.author
          ? {
              author: {
                userId: `u-${ii}`,
                displayName: item.author,
                role: "Engineer",
                team: "Platform",
              },
            }
          : {}),
      }),
    ) as SanitizedSourceItem[],
  }));
}

export interface GradeFailure {
  check:
    | "headers"
    | "noHeaders"
    | "words"
    | "mentions"
    | "absent"
    | "absentPatterns"
    | "opener"
    | "throws";
  detail: string;
}

export interface GradeResult {
  passed: boolean;
  failures: GradeFailure[];
}

/** Words, counted the way a reader would: whitespace-separated tokens. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Grade one draft against its case.
 *
 * `outcome` is either the returned draft or the error generate() threw. A
 * throw is a legitimate expected result — validateOutput rejects a draft
 * missing a required header, and a case can assert that guard fires.
 */
export function grade(
  expected: EvalCase["expect"],
  outcome: { text: string } | { error: Error },
): GradeResult {
  const failures: GradeFailure[] = [];

  if ("error" in outcome) {
    if (!expected.throws) {
      failures.push({ check: "throws", detail: `generate() threw: ${outcome.error.message}` });
    }
    return { passed: failures.length === 0, failures };
  }
  if (expected.throws) {
    return {
      passed: false,
      failures: [
        { check: "throws", detail: "expected generate() to reject this draft, it returned" },
      ],
    };
  }

  const text = outcome.text;
  const haystack = text.toLowerCase();

  for (const name of expected.headers) {
    if (!text.includes(SECTION_DISPLAY_NAMES[name])) {
      failures.push({
        check: "headers",
        detail: `missing section "${SECTION_DISPLAY_NAMES[name]}"`,
      });
    }
  }
  for (const name of expected.noHeaders) {
    if (text.includes(SECTION_DISPLAY_NAMES[name])) {
      failures.push({
        check: "noHeaders",
        detail: `rendered "${SECTION_DISPLAY_NAMES[name]}" for a section with no items`,
      });
    }
  }

  if (expected.words) {
    const [min, max] = expected.words;
    const n = wordCount(text);
    if (n < min || n > max) {
      failures.push({ check: "words", detail: `${n} words, expected ${min}-${max}` });
    }
  }

  for (const terms of expected.mentions) {
    const missing = terms.filter((t) => !haystack.includes(t.toLowerCase()));
    if (missing.length > 0) {
      failures.push({
        check: "mentions",
        detail: `never mentioned ${missing.map((m) => `"${m}"`).join(" + ")} (needed all of: ${terms.join(", ")})`,
      });
    }
  }

  for (const banned of expected.absent) {
    if (haystack.includes(banned.toLowerCase())) {
      failures.push({
        check: "absent",
        detail: `draft contains "${banned}" — the item's payload reached the newsletter`,
      });
    }
  }

  for (const source of expected.absentPatterns) {
    const match = new RegExp(source, "i").exec(text);
    if (match) {
      failures.push({
        check: "absentPatterns",
        detail: `draft matches /${source}/i at "${match[0]}" — a forbidden pattern reached the newsletter`,
      });
    }
  }

  for (const opener of expected.notStartingWith) {
    // The rule is about how the newsletter opens, so look at the first prose
    // line rather than the whole draft — a title line may precede it.
    const firstProse = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#"));
    if (firstProse?.toLowerCase().startsWith(opener.toLowerCase())) {
      failures.push({
        check: "opener",
        detail: `opens with "${opener}", which the voice rules forbid`,
      });
    }
  }

  return { passed: failures.length === 0, failures };
}

export interface SuiteScore {
  capability: { passed: number; total: number; rate: number };
  adversarial: { passed: number; total: number };
}

export function score(cases: EvalCase[], results: Map<string, GradeResult>): SuiteScore {
  const of = (kind: EvalCase["kind"]) => cases.filter((c) => c.kind === kind);
  const passedIn = (subset: EvalCase[]) =>
    subset.filter((c) => results.get(c.id)?.passed === true).length;

  const capability = of("capability");
  const adversarial = of("adversarial");
  const capPassed = passedIn(capability);

  return {
    capability: {
      passed: capPassed,
      total: capability.length,
      rate: capability.length === 0 ? 1 : capPassed / capability.length,
    },
    adversarial: { passed: passedIn(adversarial), total: adversarial.length },
  };
}
