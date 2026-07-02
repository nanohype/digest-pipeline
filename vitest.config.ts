import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
    // web/ owns its own tests (web/vitest.config.ts) so the web app stays
    // self-contained; the root suite covers the pipeline + api + data layers.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', '.next', 'web'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary'],
      include: ['src/**/*.ts'],
      // Composition roots, the OTel bootstrap, the thin metric/tracer wrappers,
      // and type-only modules are wiring, not behavior — excluded so the gate
      // measures the code that actually carries logic.
      exclude: [
        'src/**/*.test.ts',
        'src/**/entrypoint.ts',
        // Thin per-service SDK adapters (real, complete implementations) —
        // exercised through the pipeline integration test with fakes at their
        // ports, not unit-tested per adapter. The gate measures behavioral
        // logic, not plumbing.
        'src/pipeline/services/**',
        'src/common/otel-bootstrap.ts',
        'src/common/metrics.ts',
        'src/common/tracer.ts',
        'src/common/aws.ts',
        'src/common/logger.ts',
        'src/common/secrets.ts',
        'src/data/pool.ts',
        'src/pipeline/types.ts',
        'src/ports.ts',
        // Vendored @nanohype/runtime modules — byte-identical copies of
        // nanohype/library/runtime/src, unit-tested upstream alongside the
        // source of truth. This suite covers the app's wiring over them.
        'src/runtime/**',
      ],
      // Honest floors set just below current coverage so the gate catches a
      // regression (a new untested module) without flaking on minor
      // fluctuation. Raise these as the data-layer + auth tests grow. Run via
      // `npm test -- --coverage`.
      thresholds: {
        lines: 55,
        functions: 50,
        branches: 48,
        statements: 55,
      },
    },
  },
});
