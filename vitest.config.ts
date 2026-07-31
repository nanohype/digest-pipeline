import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { LOG_LEVEL: "silent", OTEL_SDK_DISABLED: "true" },
    // web/ owns its own tests (web/vitest.config.ts) so the web app stays
    // self-contained; the root suite covers the pipeline + api + data layers.
    // evals/*.test.ts is the offline half of the eval tier — fixture validity
    // and the graders. It runs here, on every PR, because the model half can
    // be skipped and a rotted golden set must not wait for it. The model half
    // is evals/*.eval.ts, on its own config (npm run eval).
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "evals/**/*.test.ts"],
    exclude: ["node_modules", "dist", ".next", "web"],
    coverage: {
      // Always on, so `npm test` enforces the floor locally exactly as CI does.
      // A threshold that only evaluates under an opt-in flag is not a gate:
      // whoever forgets the flag lands an untested module for free.
      enabled: true,
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      // Composition roots, the OTel bootstrap, the thin metric/tracer wrappers,
      // and type-only modules are wiring, not behavior — excluded so the gate
      // measures the code that actually carries logic.
      exclude: [
        "src/**/*.test.ts",
        "src/**/entrypoint.ts",
        // Thin per-service SDK adapters (real, complete implementations) —
        // exercised through the pipeline integration test with fakes at their
        // ports, not unit-tested per adapter. The gate measures behavioral
        // logic, not plumbing.
        "src/pipeline/services/**",
        "src/common/otel-bootstrap.ts",
        "src/common/metrics.ts",
        "src/common/tracer.ts",
        "src/common/aws.ts",
        "src/common/logger.ts",
        "src/common/secrets.ts",
        "src/data/pool.ts",
        // The migration runner is a CLI that calls main() at import, so a unit
        // test would exercise a refactored shape rather than the shipped one.
        // It is covered where it actually matters instead: the `docker` CI job
        // runs `migrate:up` inside the built api image against a real Postgres
        // and asserts the migration is recorded and its tables exist. That
        // proves the thing a unit test cannot — that the image contains a
        // runnable migrator — which is precisely how this broke.
        "src/data/migrate.ts",
        "src/pipeline/types.ts",
        "src/ports.ts",
        // Vendored @nanohype/runtime modules — byte-identical copies of
        // nanohype/library/runtime/src, unit-tested upstream alongside the
        // source of truth. This suite covers the app's wiring over them.
        "src/vendor/**",
      ],
      // A ratchet: each floor sits a point under measured coverage, so a new
      // untested module fails the gate while ordinary movement does not. These
      // clear the org floor in nanohype/standards/testing-rubric.json
      // (branches 60 / functions 75 / lines 75 / statements 75) with room, and
      // they are meant to be raised — never lowered — as coverage grows.
      thresholds: {
        lines: 94, // measured 94.37
        functions: 93, // measured 94.16
        branches: 79, // measured 79.88
        statements: 93, // measured 93.63

        // Per-file 100%, above the global floor, on the security- and
        // compliance-critical path. A global floor averages these files with
        // everything around them, so the package can sit comfortably above its
        // ratchet while an uncovered branch in the token verifier ships.
        //
        // auth.ts decides whether a request is authenticated at all. The key
        // set is injectable so the real `jose` path — signature, issuer and
        // expiry — runs against a local key rather than being mocked away.
        "src/api/auth.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },

        // Both audit ledgers, on a product whose whole shape is a human
        // approval gate. An audit write that fails silently means an approval or
        // a send with no record, so the tests assert the writes are awaited as
        // well as their content.
        "src/data/audit.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/pipeline/audit.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },

        // The draft state machine. Its guards are WHERE clauses, not
        // TypeScript, so the only thing standing between a second approval and
        // a second send to the whole company is a conditional UPDATE and the
        // rowCount check on it.
        "src/data/drafts.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
