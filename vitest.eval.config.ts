import { defineConfig } from "vitest/config";

// The model tier runs on its own config so it can never be picked up by
// `npm test`. Separate file, separate include, separate CI workflow — the
// design goal is that "tests passed" and "evals passed" are two statements
// nobody can confuse for one.
//
// No coverage block: an eval measures a model, not lines of this repo.
export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    // Real model calls producing 400-600 word drafts, several at a time.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Concurrency within a suite is bounded on purpose (see the runner);
    // file-level parallelism would multiply it into a Bedrock throttle.
    fileParallelism: false,
  },
});
