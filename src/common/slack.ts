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

/**
 * The bounds every Slack client here is built with, exported because they are
 * the decision worth pinning. WebClient keeps both `timeout` and `retryConfig`
 * private, so a test cannot read them back off a constructed client without
 * reaching through the type — and a test that asserts an SDK's private field is
 * measuring the SDK rather than this choice.
 *
 * `fiveRetriesInFiveMinutes` rather than the default thirty-minute policy: a
 * notification that has been retried for five minutes has missed the moment it
 * existed to announce, and continuing to retry only delays the caller.
 */
export const SLACK_CLIENT_BOUNDS = {
  /** Matches the AWS-side bound. Slack posts return in tens of milliseconds. */
  timeout: 10_000,
  retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
} as const;

/**
 * Build a bounded Slack client. Pass `timeoutMs` only for an endpoint whose
 * deadline genuinely differs — `conversations.history` pulling 200 messages,
 * say, where the default would cut off a healthy call.
 */
export function createBoundedSlackClient(
  token: string,
  timeoutMs: number = SLACK_CLIENT_BOUNDS.timeout,
): WebClient {
  return new WebClient(token, {
    timeout: timeoutMs,
    retryConfig: SLACK_CLIENT_BOUNDS.retryConfig,
  });
}
