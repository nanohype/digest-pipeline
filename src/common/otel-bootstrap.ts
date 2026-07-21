/**
 * OpenTelemetry SDK bootstrap. Loaded via `node --import` so it
 * registers before any instrumented module is required.
 *
 * Traces and metrics only — logs go to stdout via Pino and are picked
 * up by the eks-gitops cluster collector into Loki (the universal
 * interface). The OTel pino instrumentation still injects trace context
 * into log records so Loki lines carry trace_id / span_id for
 * correlation back to Tempo.
 *
 * No exporter credentials: OTLP goes to the in-cluster Alloy collector,
 * whose receiver takes no authentication. Alloy owns the upstream auth
 * (SigV4 to Amazon Managed Prometheus) and Tempo and Loki are in-cluster.
 *
 * Skip the whole SDK when `OTEL_SDK_DISABLED=true` (tests, local dev
 * without a collector).
 */

import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

if (process.env.OTEL_SDK_DISABLED !== "true") {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "digest-pipeline",
      "service.version": process.env.npm_package_version ?? "0.0.0",
      "deployment.environment": process.env.NODE_ENV ?? "development",
      "service.namespace": "digest-pipeline",
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  const shutdown = (): void => {
    void sdk
      .shutdown()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
