import { defineConfig } from 'vitest/config';

/**
 * Two suites, one config, and the split is by what they need rather than by
 * what they assert:
 *
 *   tests/*.test.ts        the listener driven over real HTTP against a stubbed
 *                          Slack. No database, no Ship. This is where PF-739 to
 *                          PF-742 and PF-744 live.
 *   tests/live/*.test.ts   PF-743's whole-path walk, which needs a booted Ship.
 *                          Run by `pnpm slack:live`.
 *
 * The default `test` script runs the first set, so `pnpm --filter @ship/slack
 * test` stays runnable on a laptop with nothing else running — the same reason
 * L19 split its CLI suites.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    retry: 0,
  },
});
