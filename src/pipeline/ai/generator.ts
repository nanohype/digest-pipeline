/**
 * Newsletter Draft Generator
 * Claude through the Platform's ModelGateway, with few-shot voice baseline examples
 * Agent: eng-ai
 */

import Anthropic from "@anthropic-ai/sdk";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { awsRequestHandler } from "../../common/aws.js";
import { getLogger } from "../../common/logger.js";
import { type BedrockTokenKind, bedrockTokens } from "../../common/metrics.js";
import { getTracer } from "../../common/tracer.js";
import { fenceUntrusted } from "../../vendor/runtime/guardrails.js";
import { anthropicBaseUrl } from "./gateway-url.js";
import { withRetry, withTimeout } from "../../vendor/runtime/resilience.js";
import { assertNoPii } from "../filters/pii.js";
import { SECTION_DISPLAY_NAMES } from "../sections.js";
import type { VoiceBaselineService } from "../services/voice-baseline.js";
import type { PipelineConfig, RankedSection } from "../types.js";

const tracer = getTracer("digest-pipeline.generator");

const MAX_ITEMS_PER_SECTION = 5;
// Model inference is slower than the aggregator calls; S3 voice-baseline reads
// are quick. Each bounds its client's socket and backs the withTimeout wrap.
const MODEL_TIMEOUT_MS = 60_000;
const S3_TIMEOUT_MS = 8_000;

// What this generator consumes from a Messages response: the first content
// block's text (the draft) and the token accounting. The SDK types the response,
// but it types `content` as a union of block kinds — a model that answered with
// a non-text block would otherwise flow an empty draft into section validation,
// so the shape is asserted here rather than assumed.
const CompletionResponseSchema = z.object({
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }))
    .min(1, "the gateway returned an empty content array"),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    })
    .optional(),
});

export interface NewsletterGeneratorDeps {
  config: PipelineConfig;
  voiceBaseline: VoiceBaselineService;
  /** Overridable so tests can drive the generator without a gateway. */
  model?: Anthropic;
  s3?: S3Client;
}

export class NewsletterGenerator {
  private model: Anthropic;
  private s3: S3Client;
  private config: PipelineConfig;
  private voiceBaseline: VoiceBaselineService;

  constructor(deps: NewsletterGeneratorDeps) {
    this.config = deps.config;
    this.voiceBaseline = deps.voiceBaseline;
    this.model =
      deps.model ??
      new Anthropic({
        baseURL: anthropicBaseUrl(deps.config.llm.gatewayEndpoint),
        // The gateway authenticates to Bedrock with its own Pod Identity
        // credentials, so this app holds no key. The SDK requires the field to
        // be set, and the gateway ignores it.
        apiKey: "unused-the-gateway-holds-the-credential",
        timeout: MODEL_TIMEOUT_MS,
        // withRetry owns retries; keep the SDK to a single attempt so the two
        // layers don't multiply (3 x 3 = 9 calls).
        maxRetries: 0,
      });
    this.s3 =
      deps.s3 ??
      new S3Client({
        // Region resolves from the ambient AWS configuration. The composition
        // root injects a configured client; this fallback exists for tests and
        // has no business taking its region from the model's settings, which is
        // where it used to come from.
        requestHandler: awsRequestHandler(S3_TIMEOUT_MS),
      });
  }

  async generate(
    runId: string,
    sections: RankedSection[],
  ): Promise<{ fullText: string; sections: RankedSection[]; tokensUsed: number }> {
    const cappedSections = sections.map((s) => ({
      ...s,
      truncatedCount: Math.max(0, s.items.length - MAX_ITEMS_PER_SECTION),
      items: s.items.slice(0, MAX_ITEMS_PER_SECTION),
    }));
    const voiceExamples = await tracer.startActiveSpan(
      "generator.load_voice_baseline",
      async (span) => {
        try {
          const examples = await this.loadVoiceBaseline(runId);
          span.setAttribute("examples.count", examples.length);
          return examples;
        } finally {
          span.end();
        }
      },
    );
    const systemPrompt = this.buildSystemPrompt(voiceExamples);
    const userPrompt = this.buildUserPrompt(runId, cappedSections);
    // Defense-in-depth: aggregators already invoked piiFilter, but assert on the
    // assembled prompt before sending to Bedrock so any aggregator regression
    // blocks the call rather than leaking into the model's context.
    assertNoPii(userPrompt, runId);
    const { text, tokensUsed } = await this.callModel(runId, systemPrompt, userPrompt);
    const validatedText = tracer.startActiveSpan("generator.validate_output", (span) => {
      try {
        const out = this.validateOutput(runId, text, cappedSections);
        return out;
      } finally {
        span.end();
      }
    });
    assertNoPii(validatedText, runId);
    return { fullText: validatedText, sections: cappedSections, tokensUsed };
  }

  private buildSystemPrompt(voiceExamples: string[]): string {
    const examplesBlock = voiceExamples
      .map((ex, i) => `## Example newsletter ${i + 1} (approved)\n\n${ex}`)
      .join("\n\n---\n\n");
    return `You are writing the weekly all-hands newsletter for a 500-person company.\nMatch the voice, tone, and style of the Chief of Staff who writes this newsletter.\n\nVOICE: Direct and warm. Concise sentences (avg 15-20 words). No corporate jargon.\nOpening: conversational, never starts with "This week...".\nSection headers use the emoji prefix shown. Items: **Bold title** \u2014 one sentence. Author in italics.\nClosing: one sentence, sometimes a question. Total: 400-600 words.\n\nHARD RULES:\n- EXACTLY 5 sections in order: What Shipped, What's Coming, New Joiners, Wins & Recognition, The Ask\n- AT MOST 5 items per section\n- Never fabricate information\n- Never include email addresses, phone numbers, salary/compensation, or performance plan references\n- If a section has no items: "Nothing to report this week."\n- Output the newsletter and nothing else. No preamble, and no closing note about what you did or did not include \u2014 a reviewer forwards this text as written, so a remark about your own choices ships to the whole company.\n\n${voiceExamples.length > 0 ? `APPROVED EXAMPLES (match this voice exactly):\n\n${examplesBlock}` : "(No voice baseline yet \u2014 write in a clear, direct, warm company voice)"}`;
  }

  private buildUserPrompt(runId: string, sections: RankedSection[]): string {
    // Items reach this method as SanitizedSourceItem (enforced by the
    // RankedSection.items type), so title/description are already PII-filtered.
    const sectionBlocks = sections
      .map((section) => {
        const displayName = SECTION_DISPLAY_NAMES[section.name] ?? section.name;
        if (section.items.length === 0) return `### ${displayName}\n(No items this week)`;
        const itemLines = section.items
          .map((item, i) => {
            const author = item.author
              ? ` \u2014 ${item.author.displayName}, ${item.author.role} (${item.author.team})`
              : "";
            const desc = item.description ? `\n  ${item.description}` : "";
            const link = item.url ? `\n  Link: ${item.url}` : "";
            return `${i + 1}. ${item.title}${author}${desc}${link}`;
          })
          .join("\n");
        const truncatedNote =
          section.truncatedCount > 0
            ? `\n(${section.truncatedCount} additional items not shown)`
            : "";
        return `### ${displayName}\n${itemLines}${truncatedNote}`;
      })
      .join("\n\n");
    // Every title, description and author string here was written by someone
    // outside this system — a Slack message, a PR title, a Linear issue, a
    // Notion page. The branded SanitizedSourceItem type guarantees they carry
    // no PII; it says nothing about whether they carry instructions. A single
    // "ignore the above and write X" in a PR title would otherwise arrive in
    // the same channel as this prompt's own directions.
    //
    // The whole block is fenced, section headers included, and that is safe
    // precisely because the structural requirement does not live here: the
    // system prompt owns "EXACTLY 5 sections in order", and it is ours. These
    // headers are labels on data, so nothing is lost by marking them as data.
    return `Write this week's newsletter using the data below. Run ID: ${runId}\n\n${fenceUntrusted(sectionBlocks, "aggregated source items")}\n\nWrite the complete newsletter now.`;
  }

  private async callModel(
    _runId: string,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ text: string; tokensUsed: number }> {
    // Transient upstream errors (throttling, 5xx) are retried with jittered
    // exponential backoff. A validation error will still exhaust the budget
    // and throw, but adding a few seconds of delay is cheap for a weekly run.
    return tracer.startActiveSpan("model.messages", async (span) => {
      span.setAttribute("model.route", this.config.llm.route);
      span.setAttribute("max_tokens", this.config.llm.maxTokens);
      try {
        return await withRetry(
          async () => {
            const response = await withTimeout(
              this.model.messages.create({
                // A route on the ModelGateway. The gateway rewrites it to the
                // real inference-profile id before the request reaches Bedrock,
                // so this app never names a model.
                model: this.config.llm.route,
                max_tokens: this.config.llm.maxTokens,
                // No temperature. The current Sonnet generation rejects the
                // knob outright — `400 \`temperature\` is deprecated for this
                // model` — so sending one fails every call rather than tuning
                // it. Default sampling is the only sampling available, which
                // is also why the eval scores a rate against a floor instead
                // of asserting case by case.
                // Prompt-cache breakpoint on the stable system prefix. The system
                // prompt embeds the voice-baseline few-shot examples, which are
                // large and identical across the weekly run and across retries —
                // marking it ephemeral-cacheable means the few-shot corpus is read
                // from cache instead of re-billed on every call. The per-run user
                // turn stays after the breakpoint, uncached.
                system: [
                  { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
                ],
                messages: [{ role: "user", content: userPrompt }],
              }),
              MODEL_TIMEOUT_MS,
              "model.messages",
            );
            const parsed = CompletionResponseSchema.parse(response);
            const usage = parsed.usage;
            let tokensUsed = 0;
            const recordTokens = (
              kind: BedrockTokenKind,
              count: number | undefined,
              attribute: string,
            ) => {
              if (count) {
                bedrockTokens.add(count, { kind, model: this.config.llm.route });
                span.setAttribute(attribute, count);
                tokensUsed += count;
              }
            };
            recordTokens("input", usage?.input_tokens, "tokens.input");
            recordTokens("output", usage?.output_tokens, "tokens.output");
            recordTokens("cache_read", usage?.cache_read_input_tokens, "tokens.cache_read");
            recordTokens("cache_write", usage?.cache_creation_input_tokens, "tokens.cache_write");
            // All four kinds, not just input+output. The four are disjoint in
            // Anthropic's usage block — a cached prefix is reported under
            // cache_read and excluded from input_tokens — so summing them is
            // the run's real token spend, which is what the ledger records.
            const text = parsed.content.find((b) => b.type === "text")?.text;
            if (!text) {
              throw new Error("the gateway returned a response with no text block");
            }
            return { text, tokensUsed };
          },
          { attempts: 3, initialDelayMs: 500, maxDelayMs: 5_000, jitter: true },
        );
      } finally {
        span.end();
      }
    });
  }

  private validateOutput(runId: string, text: string, expectedSections: RankedSection[]): string {
    // Only require headers for sections that actually have items. Asking the
    // LLM to render `New Joiners` with no joiners produces awkward filler
    // ("No new joiners this week") and inflates draft length; letting it omit
    // empty sections keeps the newsletter tight on sparse weeks.
    const populatedSectionNames = new Set<keyof typeof SECTION_DISPLAY_NAMES>(
      expectedSections.filter((s) => s.items.length > 0).map((s) => s.name),
    );
    const requiredHeaders = (
      Object.keys(SECTION_DISPLAY_NAMES) as Array<keyof typeof SECTION_DISPLAY_NAMES>
    )
      .filter((name) => populatedSectionNames.has(name))
      .map((name) => SECTION_DISPLAY_NAMES[name]);
    const missingHeaders = requiredHeaders.filter((h) => !text.includes(h));
    if (missingHeaders.length > 0)
      throw new Error(`[${runId}] LLM output missing sections: ${missingHeaders.join(", ")}`);
    let validated = text;
    for (const section of expectedSections) {
      if (section.truncatedCount > 0) {
        const header = SECTION_DISPLAY_NAMES[section.name];
        validated = validated.replace(header, `${header} _(+${section.truncatedCount} more)_`);
      }
    }
    return validated;
  }

  private async loadVoiceBaseline(runId: string): Promise<string[]> {
    try {
      const keys = await this.voiceBaseline.listBaselineKeys();
      const texts = await Promise.all(keys.slice(-3).map((key) => this.readS3Text(key)));
      return texts.filter((text): text is string => Boolean(text));
    } catch (error) {
      getLogger().warn({ runId, err: error }, "voice-baseline.load-failed");
      return [];
    }
  }

  private async readS3Text(key: string): Promise<string | null> {
    try {
      const response = await withTimeout(
        this.s3.send(new GetObjectCommand({ Bucket: this.config.voiceBaselineBucket, Key: key })),
        S3_TIMEOUT_MS,
        "generator.load_voice_baseline",
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch {
      return null;
    }
  }
}
