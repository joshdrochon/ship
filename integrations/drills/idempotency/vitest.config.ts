import { defineConfig } from 'vitest/config';

/**
 * Server-backed by construction. PF-728 requires the deliveries to arrive over
 * real HTTP from a real Ship, so there is nothing here that can run without one
 * and no conditional skip anywhere in the package.
 *
 * `pnpm drill:idempotency` sets:
 *
 *   SHIP_DRILL_BASE_URL     a booted Ship, started with
 *                           SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS=true (PF-575 /
 *                           L99 B8 — the named, default-off opt-in that lets a
 *                           subscription target 127.0.0.1)
 *   SHIP_DRILL_CLIENT_ID    the seeded public demo app
 *   DATABASE_URL            for the operator's approval subprocess only
 *
 * The timeout is generous because PF-731 rides the REAL retry ladder: 1 s + 4 s
 * + 16 s before the fourth attempt. That is not a test sleeping — it is the
 * server's own schedule, and the drill waits on the arrival of a request rather
 * than on a clock (p.11).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
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
