import { defineConfig } from "vitest/config";

// The data-layer tier runs on its own config so it can never be picked up by
// `npm test`, for the same reason the eval tier has one: it needs a dependency
// the unit suite must not require. `npm test` has to stay runnable on a laptop
// with nothing installed.
//
// What it needs is a real Postgres. The draft status machine is written in SQL —
// conditional UPDATEs plus CHECK constraints — so the guards it relies on are
// enforced by the engine, not by TypeScript. A fake pool can confirm the
// statement text and the rowCount handling, which is what `drafts.test.ts` does
// and is worth doing; it cannot confirm that Postgres agrees. Two concurrent
// approvals racing for one row is the property that matters most here, and it
// only exists where there is a real transaction.
//
// No coverage block. These files re-exercise modules the unit suite already
// measures, so counting them again would inflate the same lines twice and make
// the ratchet in vitest.config.ts read higher than the unit suite earns.
export default defineConfig({
  test: {
    environment: "node",
    env: { LOG_LEVEL: "silent", OTEL_SDK_DISABLED: "true" },
    include: ["src/**/*.db.test.ts"],
    // Every file works against the same database and truncates between cases,
    // so running them in parallel would have them clearing each other's rows.
    fileParallelism: false,
  },
});
