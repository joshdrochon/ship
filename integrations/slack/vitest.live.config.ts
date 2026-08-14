import { defineConfig } from 'vitest/config';

/**
 * PF-743's whole-path walk, which needs a booted Ship.
 *
 * A separate config rather than a `--dir` flag on the default one: the default
 * config EXCLUDES `tests/live/**` so `pnpm --filter @ship/slack test` stays
 * runnable on a laptop with nothing else running, and a CLI flag does not
 * override an exclude. Measured — `vitest run --dir tests/live` reports "No test
 * files found" against that config, which reads as a broken filter rather than
 * as the exclude doing its job.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    retry: 0,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
