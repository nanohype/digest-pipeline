/**
 * Pino logger. Apps emit structured JSON to stdout — that's the
 * universal interface. The eks-gitops cluster collector tails pod stdout
 * into Loki; log routing to other backends is an infrastructure concern,
 * not an app concern.
 *
 * Trace context (`trace_id`, `span_id`, `trace_flags`) is auto-injected
 * by `@opentelemetry/instrumentation-pino` whenever a Pino call happens
 * inside an active span — so a Loki line carries the trace_id you
 * need to jump into Tempo.
 *
 * `LOG_LEVEL=silent` muffles all output (used by the test environment).
 * `OTEL_SERVICE_NAME` drives the Pino `base.service` field, matching
 * the OTel resource attribute, so the pipeline tags as
 * `digest-pipeline-pipeline` and the API tags as `digest-pipeline-api` from the same
 * factory.
 */

import { type Logger, pino } from "pino";

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (!cached) {
    cached = pino({
      level: process.env.LOG_LEVEL ?? "info",
      base: { service: process.env.OTEL_SERVICE_NAME ?? "digest-pipeline" },
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
  return cached;
}
