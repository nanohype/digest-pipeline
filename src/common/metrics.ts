/**
 * Custom digest-pipeline metrics. The lazy-instrument core (namespace
 * qualification, per-name caching, creation deferred so the MeterProvider
 * registers first, no-op degradation without one) is the vendored
 * `@nanohype/runtime` metrics module; this file declares the app's
 * instruments over it.
 *
 * Naming follows OTel conventions: `digest-pipeline.<area>.<unit>` with
 * dot-separated segments. Cardinality is intentionally low — sources
 * are a fixed set (github/linear/slack/notion); status is one of
 * SUCCESS/PARTIAL/FAILED. Per-run identifiers (run_id, draft_id) are
 * deliberately kept OFF metric labels — they live on the trace and in
 * audit_events — so the series count stays bounded.
 */

import type { Counter, Histogram } from "@opentelemetry/api";

import { createMetrics } from "../vendor/runtime/metrics.js";

const metrics = createMetrics({ meterName: "digest-pipeline", namespace: "digest-pipeline" });

/**
 * Bucket edges for a pipeline run, in seconds. A run is minutes; OTel's default
 * edges top out at 10000, and `histogram_quantile` cannot return a value above
 * the highest finite edge — so without these the p95 alert below could never
 * reach its threshold whatever the real duration was. It was 60x past the
 * default top edge.
 */
export const RUN_DURATION_BUCKETS = [10, 30, 60, 120, 300, 600, 900, 1800];

export const runDuration: Histogram = metrics.histogramInstrument("run.duration_seconds", {
  description: "Pipeline run wall-clock time",
  unit: "s",
  boundaries: RUN_DURATION_BUCKETS,
});

export const sourceItems: Counter = metrics.counterInstrument("source.items", {
  description: "Items returned by aggregator",
});

export const sourceFailure: Counter = metrics.counterInstrument("source.failure", {
  description: "Aggregator failures by source",
});

// Allowed values for the `kind` label on `digest-pipeline.bedrock.tokens`. `input` /
// `output` are the per-call token counts; `cache_read` / `cache_write` come
// from the Anthropic prompt-cache usage fields (`cache_read_input_tokens` /
// `cache_creation_input_tokens`) and surface cache effectiveness on the
// Grafana dashboard. Kept low-cardinality on purpose.
export type BedrockTokenKind = "input" | "output" | "cache_read" | "cache_write";

export const bedrockTokens: Counter = metrics.counterInstrument("bedrock.tokens", {
  description: "Bedrock token usage",
  unit: "tokens",
});

export const bedrockFallback: Counter = metrics.counterInstrument("bedrock.fallback", {
  description: "Skeleton-fallback runs (Bedrock generation failed)",
});

export const draftEditRate: Histogram = metrics.histogramInstrument("draft.edit_rate", {
  description: "Per-draft Levenshtein edit rate (0-1)",
});

export const emailSent: Counter = metrics.counterInstrument("email.sent", {
  description: "Newsletter sends",
  unit: "emails",
});
