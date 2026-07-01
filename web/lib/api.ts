/**
 * Server-side helpers for proxying digest-pipeline-web route handlers to the
 * digest-pipeline Fastify API. The access token is extracted from the WorkOS
 * AuthKit session cookie — the client doesn't need to send Authorization
 * headers.
 */

import { NextResponse } from 'next/server';
import { getAccessToken } from './auth';

function apiBaseUrl(): string {
  const url = process.env.API_BASE_URL;
  if (!url) throw new Error('API_BASE_URL is not set');
  return url.replace(/\/$/, '');
}

// Upstream bound for the Fastify API. Generous enough for the approve path
// (which performs the SES send inline) while still guaranteeing the route
// handler can never hang on a wedged upstream.
const UPSTREAM_TIMEOUT_MS = 15_000;

export async function proxyRequest(method: 'GET' | 'POST', path: string, body?: unknown): Promise<NextResponse> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return NextResponse.json(
      { error: timedOut ? 'Upstream API timed out' : 'Upstream API unreachable' },
      { status: timedOut ? 504 : 502 },
    );
  }

  const text = await response.text();
  const runId = response.headers.get('x-run-id');
  return new NextResponse(text, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
      ...(runId ? { 'x-run-id': runId } : {}),
    },
  });
}
