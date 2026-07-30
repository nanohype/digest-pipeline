/**
 * NewsletterGenerator tests.
 *
 * Port-injected: the generator takes an Anthropic client, an `S3Client`, and a
 * `VoiceBaselineService` as deps, so we hand it fakes and inspect the outgoing
 * Messages request. No gateway, no AWS.
 */

import type Anthropic from "@anthropic-ai/sdk";
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
    route: "default",
    gatewayEndpoint: "http://digest-pipeline-gateway.tenants-digest-pipeline.svc.cluster.local:8080",
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

/** A Messages response whose draft names every populated section header. */
function modelReply(text: string) {
  return { content: [{ type: "text", text }] };
}

/** Stubs the three injected ports the generator needs. */
function makeDeps(opts: { send: ReturnType<typeof vi.fn>; baselineKeys?: string[] }) {
  const model = { messages: { create: opts.send } } as unknown as Anthropic;
  const s3 = { send: vi.fn() } as never;
  const voiceBaseline: VoiceBaselineService = {
    listBaselineKeys: vi.fn().mockResolvedValue(opts.baselineKeys ?? []),
  };
  return { config: CONFIG, voiceBaseline, model, s3 };
}

/**
 * The request body the generator sent on its Nth call, typed as the SDK's own
 * params so the assertions below are checked against the real Messages shape
 * rather than indexing into `unknown`.
 */
function sentBody(
  send: ReturnType<typeof vi.fn>,
  call = 0,
): Anthropic.Messages.MessageCreateParams {
  return send.mock.calls[call][0] as Anthropic.Messages.MessageCreateParams;
}

/**
 * The system prompt as content blocks, refusing the plain-string form.
 *
 * `system` accepts either. Sent as a string there is nowhere to hang a
 * `cache_control` breakpoint, so prompt caching stops silently and the
 * voice-baseline corpus is re-billed on every call — the exact regression the
 * caching assertions exist to catch, which a looser cast would hide.
 */
function systemBlocks(
  body: Anthropic.Messages.MessageCreateParams,
): Anthropic.Messages.TextBlockParam[] {
  if (!Array.isArray(body.system)) {
    throw new Error(`system must be a content-block array, got ${typeof body.system}`);
  }
  return body.system;
}

const SECTIONS: RankedSection[] = [section("what_shipped", [item({ id: "a" })])];
const FULL_DRAFT = "🚀 What Shipped\n**Shipped the billing migration** — done.";

describe("NewsletterGenerator", () => {
  it("sends the system prompt as a content-block array carrying an ephemeral cache breakpoint", async () => {
    const send = vi.fn().mockResolvedValue(modelReply(FULL_DRAFT));
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await generator.generate("run-1", SECTIONS);

    expect(send).toHaveBeenCalledTimes(1);
    const body = sentBody(send);

    // llm-policy: caching is mandatory. The stable voice-baseline system prefix
    // is sent as a content-block array with an ephemeral prompt-cache breakpoint.
    expect(systemBlocks(body)).toEqual([
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

  it("sends the route name and inference settings, and no protocol version", async () => {
    const send = vi.fn().mockResolvedValue(modelReply(FULL_DRAFT));
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await generator.generate("run-2", SECTIONS);

    const body = sentBody(send);
    // anthropic_version is deliberately absent: the AIServiceBackend stamps the
    // Bedrock API version, so an app that sent its own would be pinning a
    // protocol detail it no longer owns.
    expect(body).not.toHaveProperty("anthropic_version");
    expect(body.max_tokens).toBe(CONFIG.llm.maxTokens);
    expect(body.temperature).toBe(CONFIG.llm.temperature);
    // The route name, not a Bedrock model id. The gateway rewrites it upstream,
    // so a real model id here would bypass the CR that owns model selection.
    expect(body.model).toBe("default");
  });

  it("returns the model text and embeds the voice-baseline examples in the cached system block", async () => {
    const send = vi.fn().mockResolvedValue(modelReply(FULL_DRAFT));
    const deps = makeDeps({ send, baselineKeys: ["2026-15.md"] });
    // s3.send resolves a GetObject-shaped body for the one baseline key.
    (deps.s3 as unknown as { send: ReturnType<typeof vi.fn> }).send = vi.fn().mockResolvedValue({
      Body: { transformToString: async () => "PRIOR APPROVED NEWSLETTER TEXT" },
    });
    const generator = new NewsletterGenerator(deps);

    const result = await generator.generate("run-3", SECTIONS);

    expect(result.fullText).toContain("What Shipped");
    const body = sentBody(send);
    expect(systemBlocks(body)[0].text).toContain("PRIOR APPROVED NEWSLETTER TEXT");
    expect(systemBlocks(body)[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("accepts an envelope carrying usage token accounting", async () => {
    const send = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: FULL_DRAFT }],
      usage: {
        input_tokens: 1200,
        output_tokens: 480,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 300,
      },
    });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    const result = await generator.generate("run-4", SECTIONS);

    expect(result.fullText).toContain("What Shipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails the run loudly on a malformed envelope instead of emitting an empty draft", async () => {
    // An error-shaped response has no `content` array. Schema validation throws
    // on every attempt, so the retry budget exhausts and the run fails.
    const send = vi.fn().mockResolvedValue({ message: "Too many requests" });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await expect(generator.generate("run-5", SECTIONS)).rejects.toThrow(/content/);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects an empty content array", async () => {
    const send = vi.fn().mockResolvedValue({ content: [] });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await expect(generator.generate("run-6", SECTIONS)).rejects.toThrow(
      "the gateway returned an empty content array",
    );
  });

  it("refuses a response whose only content block carries no text", async () => {
    // The Messages content array is a union of block kinds. Reading index 0 and
    // trusting it to be text would ship an undefined draft into section
    // validation, which fails later and further from the cause.
    const send = vi.fn().mockResolvedValue({
      content: [{ type: "thinking", thinking: "considering the week" }],
    });
    const generator = new NewsletterGenerator(makeDeps({ send }));

    await expect(generator.generate("run-7", SECTIONS)).rejects.toThrow(/no text block/);
  });
});
