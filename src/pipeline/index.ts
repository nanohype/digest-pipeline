/**
 * DigestPipeline Pipeline — Main Orchestrator
 * Entry point for the weekly pipeline CronJob (k8s)
 * Agent: eng-backend
 */

import { randomUUID } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import { getLogger } from "../common/logger.js";
import { bedrockFallback, runDuration, sourceFailure, sourceItems } from "../common/metrics.js";
import { getTracer } from "../common/tracer.js";
import { buildAggregatorRegistry } from "./aggregators/registry.js";
import type {
  AggregatorConfig,
  AggregatorContext,
  AggregatorServices,
  IdentitySource,
} from "./aggregators/types.js";
import type { NewsletterGenerator } from "./ai/generator.js";
import { deduplicateItems, rankAndSection } from "./ai/ranker.js";
import type { AuditWriter } from "./audit.js";
import type { WorkOsIdentityResolver } from "./identity/workos.js";
import type {
  AggregationResult,
  PipelineRunResult,
  RankedSection,
  ResolvedIdentity,
} from "./types.js";

const SKELETON_BANNER = "> ⚠️ Auto-generated skeleton — Bedrock failed. Edit before approving.\n\n";

export interface PipelineDraftStore {
  create(input: {
    runId: string;
    weekOf: Date;
    sections: Awaited<ReturnType<NewsletterGenerator["generate"]>>["sections"];
    fullText: string;
  }): Promise<string>;
}

export interface PipelineNotifier {
  notifyDraftReady(runId: string, draftId: string, fullText: string): Promise<void>;
  alert(runId: string, message: string): Promise<void>;
}

export interface PipelineDeps {
  resolver: WorkOsIdentityResolver;
  generator: NewsletterGenerator;
  auditWriter: AuditWriter;
  draftStore: PipelineDraftStore;
  notifier: PipelineNotifier;
  services: AggregatorServices;
  aggregatorConfig: AggregatorConfig;
  now?: () => Date;
  /** Lookback window in days for source aggregation. Defaults to 7 (one
   * week — matches the Friday-to-Friday newsletter cadence). Overridable
   * via the LOOKBACK_DAYS env in entrypoint.ts; useful for catch-up runs
   * after a stale period or for first-time test deploys with sparse
   * recent activity. */
  lookbackDays?: number;
}

export async function runPipeline(deps: PipelineDeps): Promise<PipelineRunResult> {
  const { resolver, generator, auditWriter, draftStore, notifier, services, aggregatorConfig } =
    deps;
  const log = getLogger();
  const tracer = getTracer("digest-pipeline.pipeline");
  const runId = randomUUID();
  const start = Date.now();
  const weekOf = getThisFriday(deps.now?.() ?? new Date());

  return tracer.startActiveSpan("pipeline.run", async (rootSpan) => {
    rootSpan.setAttribute("run.id", runId);
    rootSpan.setAttribute("week_of", weekOf.toISOString());
    log.info({ runId, weekOf: weekOf.toISOString() }, "pipeline.start");

    const lookbackDays = deps.lookbackDays ?? 7;
    const since = new Date(weekOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    rootSpan.setAttribute("lookback.days", lookbackDays);
    const aggregatorRegistry = buildAggregatorRegistry();
    const resolveIdentity = async (
      source: IdentitySource,
      externalId: string,
    ): Promise<ResolvedIdentity | null> => {
      if (source === "github") return resolver.resolveGitHubUser(externalId);
      if (source === "linear") return resolver.resolveLinearUser(externalId);
      return resolver.resolveSlackUser(externalId);
    };
    const ctx: AggregatorContext = {
      runId,
      since,
      resolveIdentity,
      services,
      config: aggregatorConfig,
    };

    const sourceNames = aggregatorRegistry.names();

    const sourceResults = await tracer.startActiveSpan("phase.aggregate", async (span) => {
      span.setAttribute("source.count", sourceNames.length);
      try {
        const settled = await Promise.allSettled(
          sourceNames.map((name) => aggregatorRegistry.get(name)(ctx)),
        );
        const results: AggregationResult[] = settled.map((r, i) =>
          settledToResult(r, sourceNames[i]),
        );
        for (const r of results) {
          sourceItems.add(r.items.length, { source: r.source });
          if (r.error) {
            sourceFailure.add(1, { source: r.source });
            log.error({ runId, source: r.source, error: r.error }, "aggregator.failure");
          }
        }
        span.setAttribute("with_errors", results.filter((r) => r.error).length);
        return results;
      } finally {
        span.end();
      }
    });

    const allItems = sourceResults.flatMap((r) => r.items);

    const deduplicated = tracer.startActiveSpan("phase.dedupe", (span) => {
      span.setAttribute("items.in", allItems.length);
      const out = deduplicateItems(allItems);
      span.setAttribute("items.out", out.length);
      span.end();
      return out;
    });

    const rankedSections = tracer.startActiveSpan("phase.rank", (span) => {
      const sections = rankAndSection(deduplicated);
      span.setAttribute("sections.populated", sections.filter((s) => s.items.length > 0).length);
      span.end();
      return sections;
    });

    const { draft, usedSkeleton } = await tracer.startActiveSpan("phase.generate", async (span) => {
      try {
        const result = await generator.generate(runId, rankedSections);
        span.setAttribute("used_skeleton", false);
        return { draft: result, usedSkeleton: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        span.recordException(error instanceof Error ? error : new Error(message));
        span.setAttribute("used_skeleton", true);
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        await auditWriter.write(runId, "PIPELINE_FAILURE", "system", {
          phase: "generation",
          error: message,
          fallback: "skeleton",
        });
        log.error({ runId, err: error }, "generator.failed-falling-back-to-skeleton");
        bedrockFallback.add(1);
        const skeleton = buildSkeletonDraft(rankedSections);
        await notifier.alert(
          runId,
          `Bedrock generation failed — raw skeleton draft posted for manual editing. Error: ${message}`,
        );
        return { draft: skeleton, usedSkeleton: true };
      } finally {
        span.end();
      }
    });

    const draftId = await tracer.startActiveSpan("phase.audit_and_notify", async (span) => {
      try {
        const id = await draftStore.create({
          runId,
          weekOf,
          sections: draft.sections,
          fullText: draft.fullText,
        });
        await auditWriter.draftGenerated(
          runId,
          id,
          sourceResults.map((r) => ({
            source: r.source,
            itemCount: r.items.length,
            error: r.error,
          })),
          0,
        );
        await notifier.notifyDraftReady(runId, id, draft.fullText);
        span.setAttribute("draft.id", id);
        return id;
      } finally {
        span.end();
      }
    });

    const durationMs = Date.now() - start;
    const status: PipelineRunResult["status"] =
      usedSkeleton || sourceResults.some((r) => r.error) ? "PARTIAL" : "SUCCESS";
    runDuration.record(durationMs, { status });
    rootSpan.setAttribute("status", status);
    rootSpan.setAttribute("duration_ms", durationMs);
    rootSpan.end();
    log.info({ runId, draftId, durationMs, usedSkeleton, status }, "pipeline.complete");
    return { runId, weekOf, draftId, status, sourceResults, durationMs };
  });
}

function settledToResult(
  result: PromiseSettledResult<AggregationResult>,
  source: string,
): AggregationResult {
  if (result.status === "fulfilled") return result.value;
  return {
    source,
    items: [],
    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    durationMs: 0,
  };
}

function getThisFriday(now: Date): Date {
  const diff = (5 - now.getDay() + 7) % 7;
  const friday = new Date(now);
  friday.setDate(now.getDate() + diff);
  friday.setHours(0, 0, 0, 0);
  return friday;
}

function buildSkeletonDraft(sections: RankedSection[]): {
  fullText: string;
  sections: RankedSection[];
} {
  const blocks = sections.map((section) => {
    if (section.items.length === 0) {
      return `## ${section.displayName}\n\n_Nothing to report this week._`;
    }
    const lines = section.items.map((item) => {
      const author = item.author ? ` — ${item.author.displayName}, ${item.author.role}` : "";
      const link = item.url ? ` ${item.url}` : "";
      return `- **${item.title}**${author}${link}`;
    });
    return `## ${section.displayName}\n\n${lines.join("\n")}`;
  });
  const fullText = `${SKELETON_BANNER}${blocks.join("\n\n")}\n`;
  return { fullText, sections };
}
