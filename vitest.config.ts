import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
    // web/ owns its own tests (web/vitest.config.ts) so the web app stays
    // self-contained; the root suite covers the pipeline + api + data layers.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules', 'dist', '.next', 'web', 'cdk.out', 'infra'],
  },
});
