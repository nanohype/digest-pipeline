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
import { deduplicateItems, rankAndSection } from "./ai/ranker.js";
import type { AuditWriter } from "./audit.js";
import type {
  AggregationResult,
  PipelineRunResult,
  RankedSection,
  ResolvedIdentity,
} from "./types.js";

const SKELETON_BANNER = "> ⚠️ Auto-generated skeleton — Bedrock failed. Edit before approving.\n\n";

/**
 * What the orchestrator needs from the generator, and nothing else.
 *
 * The concrete NewsletterGenerator carries private Bedrock and S3 clients, so
 * depending on the class means the only way to run this orchestrator is with a
 * live model behind it. The port is the same shape the class already satisfies
 * — entrypoint.ts still passes the real one — and it is what lets the failure
 * path below be exercised without a Bedrock client that has to fail on cue.
 */
export interface PipelineGenerator {
  generate(
    runId: string,
    sections: RankedSection[],
  ): Promise<{ fullText: string; sections: RankedSection[]; tokensUsed: number }>;
}

/** The three resolutions the aggregators dispatch across. */
export interface PipelineIdentityResolver {
  resolveGitHubUser(externalId: string): Promise<ResolvedIdentity | null>;
  resolveLinearUser(externalId: string): Promise<ResolvedIdentity | null>;
  resolveSlackUser(externalId: string): Promise<ResolvedIdentity | null>;
}

export interface PipelineDraftStore {
  create(input: {
    runId: string;
    weekOf: Date;
    sections: RankedSection[];
    fullText: string;
  }): Promise<string>;
  expirePending(before: Date): Promise<Array<{ id: string; runId: string }>>;
}

export interface PipelineNotifier {
  notifyDraftReady(runId: string, draftId: string, fullText: string): Promise<void>;
  alert(runId: string, message: string): Promise<void>;
}

export interface PipelineDeps {
  resolver: PipelineIdentityResolver;
  generator: PipelineGenerator;
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

    // Close out anything last week left open, before this week's draft exists.
    //
    // A draft nobody approved by the time the next newsletter is generated has
    // missed the week it was written for. Left PENDING it stays approvable, and
    // approving it mails a stale newsletter as though it were current — the
    // review UI shows a draft, not a date. Expiring it first means the only
    // PENDING draft at any moment is the one for the current week.
    //
    // Failures here propagate rather than degrading the run to PARTIAL. This is
    // a write to the same database the draft itself is about to be written to,
    // so if it is unreachable the run cannot persist anything anyway, and a
    // swallow path would only add a branch that hides that.
    await tracer.startActiveSpan("phase.expire_stale_drafts", async (span) => {
      try {
        const expired = await draftStore.expirePending(weekOf);
        span.setAttribute("expired.count", expired.length);
        // Audited against the run that produced the draft, not this one:
        // audit_events is keyed on the run_id it belongs to, and the expiry of
        // last week's draft is an event in last week's story.
        for (const draft of expired) {
          await auditWriter.expired(draft.runId, draft.id);
        }
        if (expired.length > 0) {
          log.info({ runId, expired: expired.length }, "pipeline.expired-stale-drafts");
        }
      } finally {
        span.end();
      }
    });

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
          draft.tokensUsed,
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
    // Seconds, matching the instrument's declared unit. Renaming without
    // converting here would put every observation 1000x high in a series whose
    // name and unit both promise seconds.
    runDuration.record(durationMs / 1000, { status });
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
  tokensUsed: number;
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
  // Genuinely zero: the skeleton is assembled locally precisely because the
  // model call did not complete, so there is no spend to record.
  return { fullText, sections, tokensUsed: 0 };
}
