/**
 * OTLP/HTTP proxy. Browser SDK posts traces here; we forward to the
 * ADOT collector sidecar on localhost. Server-only — keeps the
 * collector off the public LB and avoids CORS configuration.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const COLLECTOR_BASE = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await params;
  const body = await req.arrayBuffer();
  const response = await fetch(`${COLLECTOR_BASE}/v1/${path.join('/')}`, {
    method: 'POST',
    headers: {
      'content-type': req.headers.get('content-type') ?? 'application/x-protobuf',
    },
    body,
  });
  const responseBody = await response.arrayBuffer();
  return new NextResponse(responseBody, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/x-protobuf',
    },
  });
}
