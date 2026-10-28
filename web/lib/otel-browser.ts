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

import { context, propagation, trace } from "@opentelemetry/api";
import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

let started = false;

export function startBrowserOtel(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      "service.name": "digest-pipeline-web-browser",
      "service.namespace": "digest-pipeline",
    }),
    spanProcessors: [
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: "/api/otel/v1/traces" }) }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new ZoneContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );
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
