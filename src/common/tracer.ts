/**
 * Tracer accessor. The SDK is registered globally by otel-bootstrap.ts;
 * this just hands out a Tracer scoped by instrumentation name.
 */

import { type Tracer, trace } from "@opentelemetry/api";

export function getTracer(name = "digest-pipeline"): Tracer {
  return trace.getTracer(name);
}
