/**
 * NewsletterGenerator tests.
 *
 * Port-injected: the generator takes a `BedrockRuntimeClient`, an `S3Client`,
 * and a `VoiceBaselineService` as deps, so we hand it fakes and inspect the
 * outgoing `InvokeModelCommand` body. No `aws-sdk-client-mock`, no real AWS.
 */

import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it, vi } from "vitest";
import { sanitizeSourceItem } from "../filters/pii.js";
import type { VoiceBaselineService } from "../services/voice-baseline.js";
import type { PipelineConfig, RankedSection, SanitizedSourceItem, SourceItem } from "../types.js";
import { NewsletterGenerator } from "./generator.js";

const CONFIG: PipelineConfig = {
  slackReviewChannelId: "C123",
  backupApproverIds: [],
  voiceBaselineBucket: "digest-pipeline-voice-baseline",
  rawAggregationsBucket: "digest-pipeline-raw-aggregations",
  llm: {
    modelId: "anthropic.claude-sonnet-4",
    region: "us-east-1",
    maxTokens: 2048,
    temperature: 0.4,
  },
  schedule: {
    timezone: "America/Los_Angeles",
    dayOfWeek: "Friday",
    draftPostHour: 9,
    draftPostMinute: 45,
    reminderHour: 11,
    expiryHour: 12,
  },
};

function item(overrides: Partial<SourceItem> = {}): SanitizedSourceItem {
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

function section(name: RankedSection["name"], items: SanitizedSourceItem[]): RankedSection {
  return { name, displayName: name, items, truncatedCount: 0 };
}

/** A draft that names every populated section header so `validateOutput` passes. */
function bedrockReply(text: string): { body: Uint8Array } {
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })) };
}

/** Stubs the three injected ports the generator needs. */
function makeDeps(opts: { send: ReturnType<typeof vi.fn>; baselineKeys?: string[] }) {
  const bedrock = { send: opts.send } as never;
  const s3 = { send: vi.fn() } as never;
  const voiceBaseline: VoiceBaselineService = {
    listBaselineKeys: vi.fn().mockResolvedValue(opts.baselineKeys ?? []),
  };
  return { config: CONFIG, voiceBaseline, bedrock, s3 };
}

const SECTIONS: RankedSection[] = [section("what_shipped", [item({ id: "a" })])];
const FULL_DRAFT = "🚀 What Shipped\n**Shipped the billing migration** — done.";

describe("NewsletterGenerator", () => {
  it("sends the system prompt as a content-block array carrying an ephemeral cache breakpoint", async () => {
    const send = vi.fn().mockResolvedValue(bedrockReply(FULL_DRAFT));
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await generator.generate("run-1", SECTIONS);

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as InvokeModelCommand;
    const body = JSON.parse(command.input.body as string);

    // llm-policy: caching is mandatory. The stable voice-baseline system prefix
    // is sent as a content-block array with an ephemeral prompt-cache breakpoint.
    expect(body.system).toEqual([
      {
        type: "text",
        text: expect.stringContaining("weekly all-hands newsletter"),
        cache_control: { type: "ephemeral" },
      },
    ]);

    // The per-run user turn stays after the breakpoint, uncached.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0]).not.toHaveProperty("content.cache_control");
    expect(JSON.stringify(body.messages[0])).not.toContain("cache_control");
  });

  it("keeps anthropic_version / max_tokens / temperature unchanged on the body", async () => {
    const send = vi.fn().mockResolvedValue(bedrockReply(FULL_DRAFT));
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await generator.generate("run-2", SECTIONS);

    const body = JSON.parse((send.mock.calls[0][0] as InvokeModelCommand).input.body as string);
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.max_tokens).toBe(CONFIG.llm.maxTokens);
    expect(body.temperature).toBe(CONFIG.llm.temperature);
  });

  it("returns the model text and embeds the voice-baseline examples in the cached system block", async () => {
    const send = vi.fn().mockResolvedValue(bedrockReply(FULL_DRAFT));
    const deps = makeDeps({ send, baselineKeys: ["2026-15.md"] });
    // s3.send resolves a GetObject-shaped body for the one baseline key.
    (deps.s3 as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn().mockResolvedValue({
      Body: { transformToString: async () => "PRIOR APPROVED NEWSLETTER TEXT" },
    });
    const generator = new NewsletterGenerator(deps);

    const result = await generator.generate("run-3", SECTIONS);

    expect(result.fullText).toContain("What Shipped");
    const body = JSON.parse((send.mock.calls[0][0] as InvokeModelCommand).input.body as string);
    expect(body.system[0].text).toContain("PRIOR APPROVED NEWSLETTER TEXT");
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("accepts an envelope carrying usage token accounting", async () => {
    const send = vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ text: FULL_DRAFT }],
          usage: {
            input_tokens: 1200,
            output_tokens: 480,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 300,
          },
        }),
      ),
    });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    const result = await generator.generate("run-4", SECTIONS);

    expect(result.fullText).toContain("What Shipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails the run loudly on a malformed envelope instead of emitting an empty draft", async () => {
    // A Bedrock error body has no `content` array. Schema validation throws on
    // every attempt, so the retry budget exhausts and the run fails.
    const send = vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ message: "Too many requests" })),
    });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await expect(generator.generate("run-5", SECTIONS)).rejects.toThrow(/content/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects an empty content array", async () => {
    const send = vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [] })),
    });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await expect(generator.generate("run-6", SECTIONS)).rejects.toThrow(
      "Bedrock returned empty content array",
    );
  });
});
