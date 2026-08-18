import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedFetch, DEFAULT_REQUEST_TIMEOUT_MS } from "./http.js";

/**
 * These assert the property the wrapper exists for: a deadline *per request*,
 * not a deadline for the wrapper's lifetime. A shared `AbortSignal` reads almost
 * identically at the call site and is silently wrong on the second call, so the
 * distinction is pinned rather than left to review.
 *
 * `globalThis.fetch` is stubbed rather than module-mocked — the wrapper's whole
 * job is what it passes to fetch, so the stub is the observation point, not a
 * stand-in for the code under test.
 */
describe("boundedFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Capture the `RequestInit` each call hands to fetch. */
  function stubFetch(): RequestInit[] {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", (_input: unknown, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response("{}"));
    });
    return calls;
  }

  it("attaches a signal to a request that had none", async () => {
    const calls = stubFetch();
    await boundedFetch(1_000)("https://example.test");

    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal?.aborted).toBe(false);
  });

  it("gives every request its own signal, so one deadline cannot expire the next", async () => {
    const calls = stubFetch();
    const bounded = boundedFetch(1_000);

    await bounded("https://example.test/one");
    await bounded("https://example.test/two");

    expect(calls[0].signal).not.toBe(calls[1].signal);
  });

  it("aborts a request that outlives the deadline", async () => {
    const calls = stubFetch();
    // A real timer, not a faked one: `AbortSignal.timeout` is implemented in the
    // runtime rather than on `setTimeout`, so fake timers never drive it and a
    // test built on them would pass while asserting nothing. The wait is on the
    // abort event itself, so it resolves exactly when the deadline fires.
    await boundedFetch(5)("https://example.test");
    const signal = calls[0].signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
  });

  it("preserves a caller's signal — an explicit abort still cancels", async () => {
    const calls = stubFetch();
    const caller = new AbortController();
    await boundedFetch(60_000)("https://example.test", { signal: caller.signal });

    expect(calls[0].signal?.aborted).toBe(false);
    caller.abort(new Error("caller changed its mind"));
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("passes the rest of the init through untouched", async () => {
    const calls = stubFetch();
    await boundedFetch(1_000)("https://example.test", {
      method: "POST",
      body: "payload",
      headers: { "content-type": "application/json" },
    });

    expect(calls[0]).toMatchObject({
      method: "POST",
      body: "payload",
      headers: { "content-type": "application/json" },
    });
  });

  it("defaults to the bound the aggregators wrap with", async () => {
    // Asserted on the deadline the wrapper asks for rather than by waiting out
    // eight seconds. `AbortSignal.timeout` is the only place the number is used,
    // so observing the call is observing the contract.
    const timeout = vi.spyOn(AbortSignal, "timeout");
    stubFetch();

    await boundedFetch()("https://example.test");

    expect(timeout).toHaveBeenCalledWith(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(8_000);
    timeout.mockRestore();
  });
});
