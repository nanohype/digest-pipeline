import { retryPolicies, WebClient } from "@slack/web-api";
import { describe, expect, it } from "vitest";
import { createBoundedSlackClient } from "./slack.js";

describe("createBoundedSlackClient", () => {
  it("retries on a five-minute policy rather than the thirty-minute default", () => {
    // Differential against a stock client rather than a bare equality check on
    // our own numbers: what matters is that this differs from the default in
    // the intended direction. If @slack/web-api ever changes its default to
    // match, this test says so instead of quietly passing.
    const bounded = createBoundedSlackClient("xoxb-test");
    const stock = new WebClient("xoxb-test");

    expect(bounded.retryConfig.retries).toBe(5);
    expect(stock.retryConfig.retries).toBe(10);
    expect(bounded.retryConfig.retries).toBeLessThan(stock.retryConfig.retries);
  });

  it("uses the named five-retries policy, not a hand-rolled one", () => {
    // Pins the intent to the library's own vocabulary — a hand-tuned object
    // with the same retry count would drift from the backoff factor the policy
    // carries with it.
    expect(createBoundedSlackClient("xoxb-test").retryConfig).toEqual(
      retryPolicies.fiveRetriesInFiveMinutes,
    );
  });

  it("accepts a per-caller timeout for slower endpoints", () => {
    // conversations.history pulls 200 messages and needs a wider bound than a
    // chat.postMessage. The timeout is not readable off the instance — WebClient
    // keeps it private — so this asserts the call is accepted and the retry
    // bound still applies, which is the part that is observable.
    const wide = createBoundedSlackClient("xoxb-test", 15_000);
    expect(wide.retryConfig.retries).toBe(5);
  });
});
