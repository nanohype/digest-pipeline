/**
 * A per-request deadline for SDKs that speak `fetch` and ship no timeout of
 * their own.
 *
 * `withTimeout` in the vendored runtime races a promise against a deadline and
 * rejects when the deadline wins — but it cannot cancel the work behind the
 * promise, which is a limitation of promises rather than of that function. The
 * caller stops waiting; the socket stays open until the peer or the pod's
 * `activeDeadlineSeconds` closes it. That is why every external call here is
 * supposed to carry a transport-level floor underneath the application-level
 * wrap: `awsRequestHandler` for the AWS SDKs, `SLACK_CLIENT_BOUNDS` for Slack,
 * the Anthropic client's own `timeout`, and this for the rest.
 *
 * `AbortSignal.timeout` is created per call rather than once per client, and the
 * distinction is the whole point. A signal built at construction time fires once
 * and stays aborted, so sharing one across a client's lifetime does not bound
 * each request — it bounds the client, and every call after the first deadline
 * fails before it is sent. A fresh signal per request is a deadline; a shared
 * one is an expiry date.
 *
 * A caller-supplied signal is preserved rather than replaced: `AbortSignal.any`
 * means an explicit cancellation and the deadline both still work, and whichever
 * arrives first wins.
 */

/** Matches the aggregators' `withTimeout` bound, so the floor and the wrap agree. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

/**
 * Wrap `fetch` so every request it issues carries its own deadline.
 *
 * Returned as a plain `fetch`-shaped function so it can be handed to any SDK
 * that accepts a fetch implementation.
 */
export function boundedFetch(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): typeof fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return fetch(input, { ...init, signal });
  };
}
