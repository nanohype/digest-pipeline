/**
 * Tracer accessor. The SDK is registered globally by otel-bootstrap.ts;
 * this just hands out a Tracer scoped by instrumentation name.
 */

import { trace, type Tracer } from '@opentelemetry/api';

export function getTracer(name = 'dispatch'): Tracer {
  return trace.getTracer(name);
}
