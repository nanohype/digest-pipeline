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
      // Without this the thresholds below were declared and never evaluated:
      // nothing passed --coverage, no test:coverage script existed, and CI ran a
      // bare `npm test` — so the gate could not fail and any new untested module
      // landed free.
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
        "src/pipeline/types.ts",
        "src/ports.ts",
        // Vendored @nanohype/runtime modules — byte-identical copies of
        // nanohype/library/runtime/src, unit-tested upstream alongside the
        // source of truth. This suite covers the app's wiring over them.
        "src/vendor/**",
      ],
      // Honest floors set just below current coverage so the gate catches a
      // regression (a new untested module) without flaking on minor
      // fluctuation. Raise these as the data-layer + auth tests grow. Enforced by
      thresholds: {
        // A ratchet under measured whole-source coverage, not the org floor
        // (branches 60 / functions 75 / lines 75 / statements 75 in
        // nanohype/standards/testing-rubric.json). Closing that gap means
        // testing the untested pipeline orchestrator, the data layer and the
        // service adapters — real work, tracked separately. These sit just
        // under measured so a regression fails and ordinary movement does not.
        lines: 63, // measured 63.72
        functions: 64, // measured 64.78
        branches: 55, // measured 55.86
        statements: 62, // measured 62.93

        // Per-file 100%, above the global floor, on the security- and
        // compliance-critical path. A global floor averages these files with
        // everything around them, so the package can sit comfortably above its
        // ratchet while an uncovered branch in the token verifier ships.
        //
        // auth.ts decides whether a request is authenticated at all. Its verify
        // path had no test before — 36.8% of lines, with signature, issuer and
        // expiry checking entirely unexercised — because the JWKS was resolved
        // remotely and the only obvious way to test it was to mock `jose`. The
        // key set is injectable now, so the real jose path runs against a local
        // key.
        "src/api/auth.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },

        // Both audit ledgers, on a product whose whole shape is a human
        // approval gate. An audit write that fails silently means an approval or
        // a send with no record, so the tests assert the writes are awaited as
        // well as their content.
        "src/data/audit.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/pipeline/audit.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
