import { retryPolicies } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { createBoundedSlackClient, SLACK_CLIENT_BOUNDS } from "./slack.js";

// WebClient keeps `timeout` and `retryConfig` private, so these assert the
// bounds object rather than reading them back off a constructed client. That is
// the honest target: a test that reaches through the type to an SDK's private
// field measures the SDK, and breaks on an upgrade that changed nothing here.

describe("SLACK_CLIENT_BOUNDS", () => {
  it("sets a finite request timeout", () => {
    // The default is 0, which @slack/web-api reads as "no timeout" — so the
    // failure being guarded against is specifically a falsy value, not a
    // too-large one.
    expect(SLACK_CLIENT_BOUNDS.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(SLACK_CLIENT_BOUNDS.timeout)).toBe(true);
  });

  it("retries on the five-minute policy, not the thirty-minute default", () => {
    // Named against the library's own vocabulary, and contrasted with the
    // default it replaces: a hand-rolled object with the same retry count would
    // drift from the backoff factor the policy carries with it.
    expect(SLACK_CLIENT_BOUNDS.retryConfig).toEqual(retryPolicies.fiveRetriesInFiveMinutes);
    expect(SLACK_CLIENT_BOUNDS.retryConfig).not.toEqual(
      retryPolicies.tenRetriesInAboutThirtyMinutes,
    );
  });

  it("keeps the retry budget under the default", () => {
    // Stated as a relation rather than a literal, so this still means something
    // if @slack/web-api retunes either policy.
    const ours = SLACK_CLIENT_BOUNDS.retryConfig.retries;
    const theirs = retryPolicies.tenRetriesInAboutThirtyMinutes.retries;
    // Both declare `retries` optional. Asserting the types first keeps a
    // dropped field from reading as a failed comparison, which would send a
    // reader looking at the wrong thing.
    expect(typeof ours).toBe("number");
    expect(typeof theirs).toBe("number");
    expect(Number(ours)).toBeLessThan(Number(theirs));
  });
});

describe("createBoundedSlackClient", () => {
  it("returns a client", () => {
    expect(createBoundedSlackClient("xoxb-test")).toBeDefined();
  });

  it("accepts a wider per-caller timeout", () => {
    // conversations.history pulls 200 messages and needs more room than a
    // chat.postMessage. Nothing observable comes back, so this only proves the
    // override is accepted — the bound itself is asserted above.
    expect(createBoundedSlackClient("xoxb-test", 15_000)).toBeDefined();
  });
});
