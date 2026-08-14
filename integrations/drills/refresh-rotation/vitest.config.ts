import { defineConfig } from 'vitest/config';

/**
 * The drill is server-backed by construction — PF-723 forbids a fixture token
 * pair, so there is nothing here that can run without a booted Ship. There is no
 * second "fast" config for that reason, and no conditional skip: a suite that
 * silently passes when the world is not set up reports green for a run that
 * proved nothing.
 *
 * Required, and `tests/support/env.ts` fails loudly on a missing one:
 *
 *   SHIP_DRILL_BASE_URL          a booted Ship with default token TTLs
 *   SHIP_DRILL_EXPIRED_BASE_URL  a second instance booted with a zero-second
 *                                refresh TTL, so PF-726's `expired` case is
 *                                produced by CONFIGURATION rather than by
 *                                waiting (p.11 rules out setTimeout waits)
 *   SHIP_DRILL_CLIENT_ID         the public app both instances know
 *   DATABASE_URL                 handed to the operator's approval subprocess;
 *                                this package never opens a connection
 *
 * `pnpm drill:refresh` sets all four. See scripts/l24-drill-refresh.ts.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    // PF-726 requires the three failure shapes to be PRINTED, so a CI reader can
    // tell them apart. Vitest 4 suppresses console output from a passing file by
    // default, which would have made the ticket's own deliverable invisible on
    // every green run — the only runs anyone reads it on.
    silent: false,
    // Three device grants, each polling on the server's own 5 s interval.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    // p.9 sets drill flake at zero over twenty consecutive runs. A retry is
    // exactly what converts a flake into a pass, so there are none (L99 F27).
    retry: 0,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
  },
});
