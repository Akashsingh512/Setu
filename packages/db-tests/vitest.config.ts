import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file runs its own in-memory Postgres (WASM); too many at once exhaust memory.
    maxWorkers: 3,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
