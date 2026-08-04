import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { NewsletterGenerator } from "../src/pipeline/ai/generator.js";
import { anthropicBaseUrl } from "../src/pipeline/ai/gateway-url.js";
import type { VoiceBaselineService } from "../src/pipeline/services/voice-baseline.js";
import type { PipelineConfig } from "../src/pipeline/types.js";
import {
  EVAL_BACKENDS,
  type GradeResult,
  grade,
  loadSuite,
  loadVoiceBaseline,
  score,
  toRankedSections,
} from "./harness.js";

// The model tier. Real Bedrock, real prompts, real money.
//
// EVAL_LLM decides whether it runs, and the two states are deliberately
// asymmetric:
//
//   unset — skipped. Local default; running unit tests should not bill anyone.
//   set   — must run. A broken provider is a hard failure, never a skip, so a
//           green eval check always means the evals executed. Same contract as
//           the sibling suite in competitive-intelligence.

const suite = loadSuite("newsletter.json");
const configured = (process.env.EVAL_LLM ?? "").trim();

// The generator speaks the Anthropic Messages API to a ModelGateway, so the eval
// needs one to point at. Upstream ships `aigw`, a standalone binary that runs the
// same translation without Kubernetes — that is what a CI run should stand up.
const GATEWAY = process.env.MODEL_GATEWAY_ENDPOINT ?? "";
// A route on that gateway. The gateway decides which model the route resolves
// to, which is the point: the eval measures the route production uses rather
// than a model id duplicated here.
const ROUTE = process.env.EVAL_MODEL_ROUTE || "default";

const CONFIG: PipelineConfig = {
  slackReviewChannelId: "C-EVAL",
  backupApproverIds: [],
  voiceBaselineBucket: "eval-voice-baseline",
  rawAggregationsBucket: "eval-raw-aggregations",
  llm: { route: ROUTE, gatewayEndpoint: GATEWAY, maxTokens: 2048 },
  schedule: {
    timezone: "America/Los_Angeles",
    dayOfWeek: "Friday",
    draftPostHour: 9,
    draftPostMinute: 45,
    reminderHour: 11,
    expiryHour: 12,
  },
};

/**
 * The voice baseline is a fixture, not live S3.
 *
 * It still travels the real few-shot path — listBaselineKeys, the S3 read, the
 * system-prompt assembly — because that corpus is most of what shapes the
 * voice, and an eval that skipped it would be grading a different prompt than
 * production sends. Faking the client rather than the service keeps the
 * generator's own code in the loop.
 */
function fixtureVoiceBaseline(): { voiceBaseline: VoiceBaselineService; s3: unknown } {
  const text = loadVoiceBaseline();
  return {
    voiceBaseline: { listBaselineKeys: async () => ["approved/2026-03-06.md"] },
    s3: {
      send: async () => ({ Body: { transformToString: async () => text } }),
    },
  };
}

describe.skipIf(configured === "")(`eval: ${suite.name}`, () => {
  const results = new Map<string, GradeResult>();

  beforeAll(async () => {
    if (!(EVAL_BACKENDS as readonly string[]).includes(configured)) {
      throw new Error(
        `EVAL_LLM="${configured}" is not a known eval backend (${EVAL_BACKENDS.join(" | ")}). ` +
          `This generator speaks the Anthropic Messages API to a ModelGateway. ` +
          `Unset EVAL_LLM to skip the model tier; setting it means it must run.`,
      );
    }
    // Fail here rather than at the first case: an unset endpoint would otherwise
    // surface as N identical connection errors that read like model failures.
    if (GATEWAY === "") {
      throw new Error(
        "EVAL_LLM=gateway requires MODEL_GATEWAY_ENDPOINT — the base URL of a reachable ModelGateway.",
      );
    }

    const { voiceBaseline, s3 } = fixtureVoiceBaseline();
    const generator = new NewsletterGenerator({
      config: CONFIG,
      voiceBaseline,
      model: new Anthropic({
        baseURL: anthropicBaseUrl(GATEWAY),
        // The gateway holds the upstream credential; this is never read.
        apiKey: "unused-the-gateway-holds-the-credential",
        maxRetries: 0,
      }),
      // biome-ignore lint/suspicious/noExplicitAny: a two-method S3 stand-in, not a real client
      s3: s3 as any,
    });

    // Bounded concurrency: a golden set that grows would otherwise open one
    // model call per case at once and trip upstream throttling, which reads as
    // an eval failure rather than what it is. Drafts are long, so keep it low.
    const queue = [...suite.cases];
    const workers = Array.from({ length: 3 }, async () => {
      for (;;) {
        const c = queue.shift();
        if (!c) return;
        try {
          const { fullText } = await generator.generate(`eval-${c.id}`, toRankedSections(c));
          results.set(c.id, grade(c.expect, { text: fullText }));
        } catch (err) {
          // A throw is graded, not dropped. Some cases expect one; for the
          // rest, leaving it absent would let an outage read as a smaller
          // suite that passed.
          results.set(
            c.id,
            grade(c.expect, { error: err instanceof Error ? err : new Error(String(err)) }),
          );
        }
      }
    });
    await Promise.all(workers);
  }, 600_000);

  // Adversarial cases are asserted individually. There is no rate here: a
  // boundary that holds four times in five is not a boundary, and naming the
  // case that broke is the whole value when one does.
  for (const c of suite.cases.filter((x) => x.kind === "adversarial")) {
    it(`holds the line: ${c.id}`, () => {
      const r = results.get(c.id);
      expect(r, `${c.id} produced no result`).toBeDefined();
      const why = (r?.failures ?? []).map((f) => `${f.check}: ${f.detail}`).join("; ");
      expect(`${c.id} — ${why}`, `\n${c.rationale}\n`).toBe(`${c.id} — `);
    });
  }

  it("meets the capability floor", () => {
    const s = score(suite.cases, results);
    const failed = suite.cases
      .filter((c) => c.kind === "capability" && !results.get(c.id)?.passed)
      .map((c) => {
        const why = (results.get(c.id)?.failures ?? [])
          .map((f) => `${f.check}: ${f.detail}`)
          .join("; ");
        return `  ${c.id} — ${why}`;
      });

    expect(
      s.capability.rate,
      `capability ${s.capability.passed}/${s.capability.total}` +
        (failed.length ? `\nfailed:\n${failed.join("\n")}` : ""),
    ).toBeGreaterThanOrEqual(suite.capabilityFloor);
  });

  it("ran every case", () => {
    // Guards the guard: a case that silently never executed would mean the
    // floor above was computed over a smaller suite.
    expect(results.size).toBe(suite.cases.length);
  });
});
