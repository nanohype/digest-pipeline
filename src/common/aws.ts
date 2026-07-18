/**
 * AWS SDK v3 clients apply no request timeout by default, so a stalled call
 * (Bedrock model inference, S3, SES, Secrets Manager) would hang until the
 * pod's activeDeadline — or, on the synchronous API send path, indefinitely.
 * This shared requestHandler bounds every client at the socket:
 * connectionTimeout caps the TCP/TLS handshake, requestTimeout caps the
 * response. Call sites layer withTimeout (and, where the operation is
 * idempotent, withRetry) on top for an application-level deadline.
 */

import { NodeHttpHandler } from "@smithy/node-http-handler";

const CONNECTION_TIMEOUT_MS = 5_000;

export function awsRequestHandler(requestTimeoutMs: number): NodeHttpHandler {
  return new NodeHttpHandler({
    requestTimeout: requestTimeoutMs,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
  });
}
