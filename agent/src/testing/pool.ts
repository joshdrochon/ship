import { Pool } from 'pg';

/**
 * A `pg.Pool` for tests that survives its own testcontainer being stopped.
 *
 * ── The bug this exists to catch ─────────────────────────────────────────────
 * Every agent test spins up a Postgres testcontainer, and every one tears down
 * in the right order — `await pool.end()`, then `await container.stop()`. That
 * ordering is not enough.
 *
 * Stopping the container sends the server SIGTERM. Postgres answers any socket
 * still open with `FATAL 57P01 terminating connection due to administrator
 * command`, and `pg` surfaces that by emitting `error` on the client. A pool
 * with no `error` listener turns that into an unhandled error, and vitest exits
 * 1 — *after* printing that every test passed.
 *
 * Which is exactly what CI showed on the merge to main:
 *
 *     Tests  186 passed (186)
 *     ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1
 *     assert-tests-ran: 186 tests executed (>= 162); command exit 1
 *
 * A green suite reported red. It is timing-dependent, so it passed locally and
 * on the branch and failed on the merge commit — the worst shape of flake,
 * because the natural response is to re-run it until it goes away.
 *
 * This is the second time this class of bug has cost a CI run. `FG-278` was the
 * first: `resetCheckpointer()` dropped a cached `PostgresSaver` without closing
 * its pool. That fix closed one specific pool; this one removes the whole
 * failure mode, because the listener makes a post-shutdown error a logged event
 * rather than an unhandled one.
 *
 * ── Why a listener rather than tighter teardown ──────────────────────────────
 * There is no ordering that removes the race. `pool.end()` resolves when the
 * pool considers itself drained; the server's shutdown notice can still arrive
 * on a socket the kernel has not finished closing. `data/pool.ts` already
 * concluded the same thing for the production pool and attaches a listener
 * there for the same reason — this is that decision, applied to tests.
 *
 * The listener deliberately does not fail the test. An error arriving *because*
 * we asked the container to stop is expected; treating it as a failure would
 * invert the bug rather than fix it.
 */
export function createTestPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });

  pool.on('error', (err) => {
    // 57P01 is the container shutting down underneath us, which is what the
    // test asked for. Anything else is worth seeing, so it is logged rather
    // than swallowed — but neither is allowed to become an unhandled error.
    const code = (err as NodeJS.ErrnoException & { code?: string }).code;
    if (code !== '57P01') {
      console.error('[test-pool] idle client error:', err.message);
    }
  });

  return pool;
}
