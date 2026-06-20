/**
 * Custom digest-pipeline metrics. Created lazily on first access so the
 * MeterProvider has a chance to register before instruments are
 * created.
 *
 * Naming follows OTel conventions: `digest-pipeline.<area>.<unit>` with
 * dot-separated segments. Cardinality is intentionally low — sources
 * are a fixed set (github/linear/slack/notion); status is one of
 * SUCCESS/PARTIAL/FAILED. Per-run identifiers (run_id, draft_id) are
 * deliberately kept OFF metric labels — they live on the trace and in
 * audit_events — so the series count stays bounded.
 */

import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

const meter = metrics.getMeter('digest-pipeline');

export const runDuration: Histogram = meter.createHistogram('digest-pipeline.run.duration_ms', {
  description: 'Pipeline run wall-clock time',
  unit: 'ms',
});

export const sourceItems: Counter = meter.createCounter('digest-pipeline.source.items', {
  description: 'Items returned by aggregator',
});

export const sourceFailure: Counter = meter.createCounter('digest-pipeline.source.failure', {
  description: 'Aggregator failures by source',
});

// Allowed values for the `kind` label on `digest-pipeline.bedrock.tokens`. `input` /
// `output` are the per-call token counts; `cache_read` / `cache_write` come
// from the Anthropic prompt-cache usage fields (`cache_read_input_tokens` /
// `cache_creation_input_tokens`) and surface cache effectiveness on the
// Grafana dashboard. Kept low-cardinality on purpose.
export type BedrockTokenKind = 'input' | 'output' | 'cache_read' | 'cache_write';

export const bedrockTokens: Counter = meter.createCounter('digest-pipeline.bedrock.tokens', {
  description: 'Bedrock token usage',
  unit: 'tokens',
});

export const bedrockFallback: Counter = meter.createCounter('digest-pipeline.bedrock.fallback', {
  description: 'Skeleton-fallback runs (Bedrock generation failed)',
});

export const draftEditRate: Histogram = meter.createHistogram('digest-pipeline.draft.edit_rate', {
  description: 'Per-draft Levenshtein edit rate (0-1)',
});

export const emailSent: Counter = meter.createCounter('digest-pipeline.email.sent', {
  description: 'Newsletter sends',
  unit: 'emails',
});
