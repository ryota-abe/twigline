import { defineConfig } from 'vitest/config';

// Timing of the performance targets (npm run test:perf)
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.test.ts'],
    setupFiles: ['test/unit/setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
  },
});
