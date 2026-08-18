/**
 * Browser-side OpenTelemetry bootstrap. Posts OTLP traces to the
 * Next.js proxy route at /api/otel/v1/traces, which forwards to the
 * collector sidecar on localhost — no public collector exposure, no
 * CORS configuration.
 *
 * Trace context is automatically propagated to fetch calls via the
 * W3C `traceparent` header; the API proxy routes pick it up and the
 * Fastify backend continues the trace.
 */

"use client";

import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

let started = false;

export function startBrowserOtel(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "digest-pipeline-web-browser",
      "service.namespace": "digest-pipeline",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: "/api/otel/v1/traces" }))],
  });
  provider.register({ contextManager: new ZoneContextManager() });
  registerInstrumentations({
    instrumentations: [
      getWebAutoInstrumentations({
        "@opentelemetry/instrumentation-fetch": {
          propagateTraceHeaderCorsUrls: [/.+/],
        },
      }),
    ],
  });
}
