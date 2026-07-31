/**
 * `@slack/web-api`'s WebClient applies no request timeout by default
 * (`timeout: 0`) and retries on the `tenRetriesInAboutThirtyMinutes` policy.
 * A client constructed with a token alone will therefore sit on a stalled
 * socket indefinitely, and an awaited call can occupy roughly half an hour
 * before it gives up.
 *
 * That matters most where it looks least important. Every Slack call in this
 * service is a notification — "draft ready", "sent" — and the pipeline awaits
 * them. An unbounded notify call does not fail the run, it holds the run open,
 * which is the same shape as the CronJob's `activeDeadlineSeconds` firing on
 * work that had already finished.
 *
 * The counterpart to `awsRequestHandler` in ./aws.ts, so both classes of
 * external call run under a stated deadline rather than one having a contract
 * and the other inheriting whatever the SDK ships.
 */

import { retryPolicies, WebClient } from "@slack/web-api";

/** Matches the AWS-side bound. Slack posts return in tens of milliseconds. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build a bounded Slack client.
 *
 * `fiveRetriesInFiveMinutes` rather than the default thirty-minute policy: a
 * notification that has been retried for five minutes has missed the moment it
 * existed to announce, and continuing to retry only delays the caller.
 */
export function createBoundedSlackClient(token: string, timeoutMs = DEFAULT_TIMEOUT_MS): WebClient {
  return new WebClient(token, {
    timeout: timeoutMs,
    retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
  });
}
