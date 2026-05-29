/**
 * Custom dispatch metrics. Created lazily on first access so the
 * MeterProvider has a chance to register before instruments are
 * created.
 *
 * Naming follows OTel conventions: `dispatch.<area>.<unit>` with
 * dot-separated segments. Cardinality is intentionally low — sources
 * are a fixed set (github/linear/slack/notion); status is one of
 * SUCCESS/PARTIAL/FAILED; draft_id is omitted from histograms.
 */

import { metrics, type Counter, type Histogram } from '@opentelemetry/api';

const meter = metrics.getMeter('dispatch');

export const runDuration: Histogram = meter.createHistogram('dispatch.run.duration_ms', {
  description: 'Pipeline run wall-clock time',
  unit: 'ms',
});

export const sourceItems: Counter = meter.createCounter('dispatch.source.items', {
  description: 'Items returned by aggregator',
});

export const sourceFailure: Counter = meter.createCounter('dispatch.source.failure', {
  description: 'Aggregator failures by source',
});

// Allowed values for the `kind` label on `dispatch.bedrock.tokens`. `input` /
// `output` are the per-call token counts; `cache_read` / `cache_write` come
// from the Anthropic prompt-cache usage fields (`cache_read_input_tokens` /
// `cache_creation_input_tokens`) and surface cache effectiveness on the
// Grafana dashboard. Kept low-cardinality on purpose.
export type BedrockTokenKind = 'input' | 'output' | 'cache_read' | 'cache_write';

export const bedrockTokens: Counter = meter.createCounter('dispatch.bedrock.tokens', {
  description: 'Bedrock token usage',
  unit: 'tokens',
});

export const bedrockFallback: Counter = meter.createCounter('dispatch.bedrock.fallback', {
  description: 'Skeleton-fallback runs (Bedrock generation failed)',
});

export const draftEditRate: Histogram = meter.createHistogram('dispatch.draft.edit_rate', {
  description: 'Per-draft Levenshtein edit rate (0-1)',
});

export const emailSent: Counter = meter.createCounter('dispatch.email.sent', {
  description: 'Newsletter sends',
  unit: 'emails',
});
