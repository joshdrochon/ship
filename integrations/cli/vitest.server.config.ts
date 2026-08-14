import { defineConfig } from 'vitest/config';

/**
 * The server-backed suite — every test here drives the REAL `ship` binary
 * against a REAL booted Ship with a real database.
 *
 * Separate from `vitest.config.ts` on purpose, and the split is the reason both
 * are useful: `pnpm --filter @ship/cli test` must stay runnable on a laptop with
 * no database and no server, because it is what a contributor runs. This config
 * is what proves the CLI actually works, and it cannot run anywhere.
 *
 * What it needs, and what happens without it: both variables are REQUIRED and a
 * missing one fails loudly in `tests/server/support/env.ts`. No conditional
 * skip — a suite that silently passes when it ran nothing is how "16 tests
 * green" came to mean "nothing has ever been executed against a booted Ship".
 *
 *   SHIP_TEST_BASE_URL   a booted Ship, e.g. http://localhost:3919
 *   DATABASE_URL         the same instance's database — the approval subprocess
 *                        needs it, this package never touches it
 *
 * Single-threaded and un-parallelised: these tests share one credential file,
 * one workspace and one webhook subscription table, so concurrency here buys
 * seconds and costs determinism.
 */
export default defineConfig({
  test: {
    include: ['tests/server/**/*.test.ts'],
    environment: 'node',
    // A device flow waits for a human. Ours is a subprocess, but the poll
    // interval is still the server's (5 s), so the budget is generous.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
