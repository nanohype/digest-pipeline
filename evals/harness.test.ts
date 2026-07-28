import { describe, expect, it } from "vitest";
import { SECTION_DISPLAY_NAMES } from "../src/pipeline/sections.js";
import {
  type EvalCase,
  grade,
  loadSuite,
  loadVoiceBaseline,
  score,
  toRankedSections,
  wordCount,
} from "./harness.js";

// The offline half of the eval tier. No model, no credentials, runs in
// `npm test` on every PR. It answers two questions the model tier cannot: is
// the golden set still a golden set, and does the grader grade?
//
// This matters because the model tier is the one that can be skipped. If
// fixture rot only surfaced when someone ran evals with credentials, a
// degenerate suite could sit green for months.

const suite = loadSuite("newsletter.json");

describe("the golden set", () => {
  it("parses", () => {
    expect(suite.cases.length).toBeGreaterThan(0);
  });

  it("has unique case ids", () => {
    // Results are keyed by id — a duplicate silently drops a case from the
    // score while still looking like coverage in the file.
    const ids = suite.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers both kinds", () => {
    const kinds = new Set(suite.cases.map((c) => c.kind));
    expect(kinds).toContain("capability");
    expect(kinds).toContain("adversarial");
  });

  it("exercises both a full week and a sparse one", () => {
    // A capability set of only full weeks never tests the omit-empty-sections
    // behaviour, which is the branch a real company hits most often.
    const hasEmptySections = suite.cases.some(
      (c) => c.kind === "capability" && c.sections.some((s) => s.items.length === 0),
    );
    const hasFullWeek = suite.cases.some(
      (c) => c.kind === "capability" && c.sections.every((s) => s.items.length > 0),
    );
    expect(hasEmptySections).toBe(true);
    expect(hasFullWeek).toBe(true);
  });

  it("gives every adversarial case something falsifiable", () => {
    // An adversarial case with nothing in `absent` and no header expectation
    // cannot fail. It would pass forever while reading as a control.
    for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
      const constrained =
        c.expect.absent.length > 0 ||
        c.expect.absentPatterns.length > 0 ||
        c.expect.headers.length > 0 ||
        c.expect.noHeaders.length > 0;
      expect(constrained, `${c.id} can never fail`).toBe(true);
    }
  });

  it("keeps every case within the generator's five-item cap", () => {
    // MAX_ITEMS_PER_SECTION is 5; a fixture over the cap would be silently
    // truncated and the case would be grading a different input than it reads.
    for (const c of suite.cases) {
      for (const s of c.sections) {
        expect(s.items.length, `${c.id}/${s.name}`).toBeLessThanOrEqual(5);
      }
    }
  });

  it("sets a capability floor that demands most cases pass", () => {
    expect(suite.capabilityFloor).toBeGreaterThanOrEqual(0.5);
    expect(suite.capabilityFloor).toBeLessThanOrEqual(1);
  });
});

describe("the voice baseline fixture", () => {
  it("shows the model every section it is asked to produce", () => {
    // The few-shot corpus is most of what shapes the voice. One missing
    // section header and the example teaches the opposite of the rule.
    const text = loadVoiceBaseline();
    for (const header of Object.values(SECTION_DISPLAY_NAMES)) {
      expect(text, `baseline is missing ${header}`).toContain(header);
    }
  });

  it("obeys the voice rules it is teaching", () => {
    const text = loadVoiceBaseline();
    const firstLine = text.trim().split("\n")[0];
    expect(firstLine.toLowerCase().startsWith("this week")).toBe(false);
  });

  it("is itself the length the system prompt asks for", () => {
    // A few-shot example outranks a stated rule. The system prompt says
    // "Total: 400-600 words", and a 240-word baseline teaches the model to
    // ignore that — the first draft of this fixture was exactly that mistake,
    // and the model dutifully produced 197 words. The corpus has to model the
    // constraint, not just the tone.
    const n = wordCount(loadVoiceBaseline());
    expect(
      n,
      `baseline is ${n} words; the system prompt asks drafts for 400-600`,
    ).toBeGreaterThanOrEqual(400);
    expect(n).toBeLessThanOrEqual(600);
  });
});

describe("toRankedSections", () => {
  it("produces the shape the generator consumes", () => {
    const c = suite.cases[0];
    const sections = toRankedSections(c);
    expect(sections).toHaveLength(c.sections.length);
    expect(sections[0].items[0].title).toBe(c.sections[0].items[0].title);
    expect(sections[0].truncatedCount).toBe(0);
  });

  it("gives every item a distinct id", () => {
    const ids = toRankedSections(suite.cases[0]).flatMap((s) => s.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("wordCount", () => {
  it("counts whitespace-separated tokens", () => {
    expect(wordCount("  one   two\nthree  ")).toBe(3);
    expect(wordCount("")).toBe(0);
  });
});

describe("grade", () => {
  const shipped = SECTION_DISPLAY_NAMES.what_shipped;
  const coming = SECTION_DISPLAY_NAMES.whats_coming;
  const base = {
    headers: ["what_shipped" as const],
    noHeaders: [],
    mentions: [],
    absent: [],
    absentPatterns: [],
    notStartingWith: [],
    throws: false,
  };
  const draft = `${shipped}\n\n**Search** — faster now. _Priya_`;

  it("passes a well-formed draft", () => {
    expect(grade(base, { text: draft }).passed).toBe(true);
  });

  it("fails a missing required header", () => {
    const r = grade({ ...base, headers: ["what_shipped", "the_ask"] }, { text: draft });
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("headers");
  });

  it("fails a header that should have been omitted", () => {
    const r = grade({ ...base, noHeaders: ["whats_coming"] }, { text: `${draft}\n\n${coming}` });
    expect(r.failures.some((f) => f.check === "noHeaders")).toBe(true);
  });

  it("enforces the word band on both sides", () => {
    expect(grade({ ...base, words: [1000, 2000] }, { text: draft }).failures[0].check).toBe(
      "words",
    );
    expect(grade({ ...base, words: [1, 2] }, { text: draft }).failures[0].check).toBe("words");
    expect(grade({ ...base, words: [1, 100] }, { text: draft }).passed).toBe(true);
  });

  it("catches a banned string anywhere in the draft", () => {
    const r = grade({ ...base, absent: ["PWNED"] }, { text: `${draft}\npwned` });
    expect(r.failures.some((f) => f.check === "absent")).toBe(true);
  });

  it("checks the opener against the first prose line, not the title", () => {
    // A markdown heading may precede the opening sentence; the voice rule is
    // about the sentence.
    const withHeading = `# Weekly\n\nThis week we shipped a lot.`;
    const r = grade(
      { ...base, headers: [], notStartingWith: ["This week"] },
      { text: withHeading },
    );
    expect(r.failures.some((f) => f.check === "opener")).toBe(true);

    const ok = `# Weekly\n\nMorning, everyone.`;
    expect(
      grade({ ...base, headers: [], notStartingWith: ["This week"] }, { text: ok }).passed,
    ).toBe(true);
  });

  it("treats an unexpected throw as a failure", () => {
    const r = grade(base, { error: new Error("bedrock exploded") });
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("throws");
    expect(r.failures[0].detail).toContain("bedrock exploded");
  });

  it("treats an expected throw as a pass", () => {
    // validateOutput rejecting a malformed draft is a control working, and a
    // case is allowed to assert it fires.
    expect(grade({ ...base, throws: true }, { error: new Error("missing sections") }).passed).toBe(
      true,
    );
  });

  it("fails when a draft was expected to be rejected and was not", () => {
    const r = grade({ ...base, throws: true }, { text: draft });
    expect(r.passed).toBe(false);
    expect(r.failures[0].check).toBe("throws");
  });

  it("reports every failure, not just the first", () => {
    const r = grade(
      { ...base, headers: ["the_ask"], absent: ["oops"], words: [500, 600] },
      { text: "oops" },
    );
    expect(r.failures.map((f) => f.check).sort()).toEqual(["absent", "headers", "words"]);
  });
});

describe("score", () => {
  const cases: EvalCase[] = [
    { kind: "capability", id: "a" },
    { kind: "capability", id: "b" },
    { kind: "capability", id: "c" },
    { kind: "capability", id: "d" },
    { kind: "adversarial", id: "x" },
    { kind: "adversarial", id: "y" },
  ].map(
    (c) => ({ ...c, rationale: "x".repeat(25), sections: [], expect: {} }) as unknown as EvalCase,
  );

  const results = (passing: string[]) =>
    new Map(cases.map((c) => [c.id, { passed: passing.includes(c.id), failures: [] }]));

  it("scores capability as a rate", () => {
    expect(score(cases, results(["a", "b", "c", "x", "y"])).capability).toEqual({
      passed: 3,
      total: 4,
      rate: 0.75,
    });
  });

  it("counts adversarial separately", () => {
    expect(score(cases, results(["a", "b", "c", "d", "x"])).adversarial).toEqual({
      passed: 1,
      total: 2,
    });
  });

  it("treats a missing result as a failure", () => {
    // A case whose run threw before grading has no entry. Absent must never
    // read as passed.
    const s = score(cases, new Map());
    expect(s.capability.passed).toBe(0);
    expect(s.adversarial.passed).toBe(0);
  });
});

describe("absentPatterns", () => {
  it("fails a draft that leaks a fabricated contact detail", () => {
    const r = grade(
      {
        headers: [],
        noHeaders: [],
        mentions: [],
        absent: [],
        absentPatterns: ["[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"],
        notStartingWith: [],
        throws: false,
      },
      { text: "## The Ask\n\nReach the on-call at ines.delacroix@example.com any time." },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0]?.check).toBe("absentPatterns");
  });

  it("passes a refusal that names what it refused", () => {
    // The exact false positive a substring check on the request's wording
    // produced: a correct refusal that says the words back.
    const r = grade(
      {
        headers: [],
        noHeaders: [],
        mentions: [],
        absent: [],
        absentPatterns: ["[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"],
        notStartingWith: [],
        throws: false,
      },
      {
        text: "## The Ask\n\nI have not included anyone's home email or personal mobile number here.",
      },
    );
    expect(r.passed).toBe(true);
  });
});
