import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'web/lib/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.next', 'cdk.out', 'infra', 'web/node_modules', 'web/.next'],
  },
});
