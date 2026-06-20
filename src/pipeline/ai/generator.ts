/**
 * Newsletter Draft Generator
 * Claude via Amazon Bedrock with few-shot voice baseline examples
 * Agent: eng-ai
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertNoPii } from '../filters/pii.js';
import { withRetry, withTimeout } from '../utils/resilience.js';
import { awsRequestHandler } from '../../common/aws.js';
import { getLogger } from '../../common/logger.js';
import { getTracer } from '../../common/tracer.js';
import { bedrockTokens, type BedrockTokenKind } from '../../common/metrics.js';
import type { VoiceBaselineService } from '../services/voice-baseline.js';
import { SECTION_DISPLAY_NAMES } from '../sections.js';
import type { RankedSection, PipelineConfig } from '../types.js';

const tracer = getTracer('digest-pipeline.generator');

const MAX_ITEMS_PER_SECTION = 5;
// Bedrock model inference is slower than the aggregator calls; S3 voice-baseline
// reads are quick. Each bounds the AWS SDK socket and backs the withTimeout wrap.
const BEDROCK_TIMEOUT_MS = 60_000;
const S3_TIMEOUT_MS = 8_000;

export interface NewsletterGeneratorDeps {
  config: PipelineConfig;
  voiceBaseline: VoiceBaselineService;
  bedrock?: BedrockRuntimeClient;
  s3?: S3Client;
}

export class NewsletterGenerator {
  private bedrock: BedrockRuntimeClient;
  private s3: S3Client;
  private config: PipelineConfig;
  private voiceBaseline: VoiceBaselineService;

  constructor(deps: NewsletterGeneratorDeps) {
    this.config = deps.config;
    this.voiceBaseline = deps.voiceBaseline;
    this.bedrock =
      deps.bedrock ??
      new BedrockRuntimeClient({
        region: deps.config.llm.region,
        requestHandler: awsRequestHandler(BEDROCK_TIMEOUT_MS),
        // withRetry owns retries; keep the SDK to a single attempt so the two
        // layers don't multiply (3 x 3 = 9 calls).
        maxAttempts: 1,
      });
    this.s3 =
      deps.s3 ?? new S3Client({ region: deps.config.llm.region, requestHandler: awsRequestHandler(S3_TIMEOUT_MS) });
  }

  async generate(runId: string, sections: RankedSection[]): Promise<{ fullText: string; sections: RankedSection[] }> {
    const cappedSections = sections.map((s) => ({
      ...s,
      truncatedCount: Math.max(0, s.items.length - MAX_ITEMS_PER_SECTION),
      items: s.items.slice(0, MAX_ITEMS_PER_SECTION),
    }));
    const voiceExamples = await tracer.startActiveSpan('bedrock.load_voice_baseline', async (span) => {
      try {
        const examples = await this.loadVoiceBaseline(runId);
        span.setAttribute('examples.count', examples.length);
        return examples;
      } finally {
        span.end();
      }
    });
    const systemPrompt = this.buildSystemPrompt(voiceExamples);
    const userPrompt = this.buildUserPrompt(runId, cappedSections);
    // Defense-in-depth: aggregators already invoked piiFilter, but assert on the
    // assembled prompt before sending to Bedrock so any aggregator regression
    // blocks the call rather than leaking into the model's context.
    assertNoPii(userPrompt, runId);
    const response = await this.callBedrock(runId, systemPrompt, userPrompt);
    const validatedText = tracer.startActiveSpan('bedrock.validate_output', (span) => {
      try {
        const out = this.validateOutput(runId, response, cappedSections);
        return out;
      } finally {
        span.end();
      }
    });
    assertNoPii(validatedText, runId);
    return { fullText: validatedText, sections: cappedSections };
  }

  private buildSystemPrompt(voiceExamples: string[]): string {
    const examplesBlock = voiceExamples
      .map((ex, i) => `## Example newsletter ${i + 1} (approved)\n\n${ex}`)
      .join('\n\n---\n\n');
    return `You are writing the weekly all-hands newsletter for a 500-person company.\nMatch the voice, tone, and style of the Chief of Staff who writes this newsletter.\n\nVOICE: Direct and warm. Concise sentences (avg 15-20 words). No corporate jargon.\nOpening: conversational, never starts with "This week...".\nSection headers use the emoji prefix shown. Items: **Bold title** \u2014 one sentence. Author in italics.\nClosing: one sentence, sometimes a question. Total: 400-600 words.\n\nHARD RULES:\n- EXACTLY 5 sections in order: What Shipped, What's Coming, New Joiners, Wins & Recognition, The Ask\n- AT MOST 5 items per section\n- Never fabricate information\n- Never include email addresses, phone numbers, salary/compensation, or performance plan references\n- If a section has no items: "Nothing to report this week."\n\n${voiceExamples.length > 0 ? `APPROVED EXAMPLES (match this voice exactly):\n\n${examplesBlock}` : '(No voice baseline yet \u2014 write in a clear, direct, warm company voice)'}`;
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
              : '';
            const desc = item.description ? `\n  ${item.description}` : '';
            const link = item.url ? `\n  Link: ${item.url}` : '';
            return `${i + 1}. ${item.title}${author}${desc}${link}`;
          })
          .join('\n');
        const truncatedNote =
          section.truncatedCount > 0 ? `\n(${section.truncatedCount} additional items not shown)` : '';
        return `### ${displayName}\n${itemLines}${truncatedNote}`;
      })
      .join('\n\n');
    return `Write this week's newsletter using the data below. Run ID: ${runId}\n\n${sectionBlocks}\n\nWrite the complete newsletter now.`;
  }

  private async callBedrock(_runId: string, systemPrompt: string, userPrompt: string): Promise<string> {
    // Transient Bedrock errors (throttling, 5xx) are retried with jittered
    // exponential backoff. A validation error will still exhaust the budget
    // and throw, but adding a few seconds of delay is cheap for a weekly run.
    return tracer.startActiveSpan('bedrock.invoke_model', async (span) => {
      span.setAttribute('model.id', this.config.llm.modelId);
      span.setAttribute('max_tokens', this.config.llm.maxTokens);
      try {
        return await withRetry(
          async () => {
            const body = JSON.stringify({
              anthropic_version: 'bedrock-2023-05-31',
              max_tokens: this.config.llm.maxTokens,
              temperature: this.config.llm.temperature,
              // Prompt-cache breakpoint on the stable system prefix. The system
              // prompt embeds the voice-baseline few-shot examples, which are
              // large and identical across the weekly run and across retries —
              // marking it ephemeral-cacheable means the few-shot corpus is read
              // from cache instead of re-billed on every call. The per-run user
              // turn stays after the breakpoint, uncached.
              system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
              messages: [{ role: 'user', content: userPrompt }],
            });
            const command = new InvokeModelCommand({
              modelId: this.config.llm.modelId,
              contentType: 'application/json',
              accept: 'application/json',
              body,
            });
            const response = await withTimeout(this.bedrock.send(command), BEDROCK_TIMEOUT_MS);
            const decoded = JSON.parse(new TextDecoder().decode(response.body));
            const usage = decoded.usage as
              | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                }
              | undefined;
            const recordTokens = (kind: BedrockTokenKind, count: number | undefined, attribute: string) => {
              if (count) {
                bedrockTokens.add(count, { kind, model: this.config.llm.modelId });
                span.setAttribute(attribute, count);
              }
            };
            recordTokens('input', usage?.input_tokens, 'tokens.input');
            recordTokens('output', usage?.output_tokens, 'tokens.output');
            recordTokens('cache_read', usage?.cache_read_input_tokens, 'tokens.cache_read');
            recordTokens('cache_write', usage?.cache_creation_input_tokens, 'tokens.cache_write');
            return decoded.content?.[0]?.text ?? '';
          },
          { attempts: 3, initialDelay: 500, maxDelay: 5_000, jitter: true }
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
      expectedSections.filter((s) => s.items.length > 0).map((s) => s.name)
    );
    const requiredHeaders = (Object.keys(SECTION_DISPLAY_NAMES) as Array<keyof typeof SECTION_DISPLAY_NAMES>)
      .filter((name) => populatedSectionNames.has(name))
      .map((name) => SECTION_DISPLAY_NAMES[name]);
    const missingHeaders = requiredHeaders.filter((h) => !text.includes(h));
    if (missingHeaders.length > 0)
      throw new Error(`[${runId}] LLM output missing sections: ${missingHeaders.join(', ')}`);
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
      getLogger().warn({ runId, err: error }, 'voice-baseline.load-failed');
      return [];
    }
  }

  private async readS3Text(key: string): Promise<string | null> {
    try {
      const response = await withTimeout(
        this.s3.send(new GetObjectCommand({ Bucket: this.config.voiceBaselineBucket, Key: key })),
        S3_TIMEOUT_MS
      );
      return (await response.Body?.transformToString()) ?? null;
    } catch {
      return null;
    }
  }
}
