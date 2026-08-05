/**
 * The durable checkpointer.
 *
 * ── Why this is not optional ───────────────────────────────────────────────
 * Human approval takes hours. The Render cron container exits when its run
 * ends. Without a checkpointer in Postgres, a run suspended at `interrupt()`
 * dies with the process and the approval has nothing to resume — the entire
 * human-in-the-loop requirement collapses to "approve within the 30 seconds the
 * container is alive" (Q19).
 *
 * LangGraph's Postgres checkpointer points at the database we already have, so
 * this costs one `setup()` call and no new infrastructure.
 *
 * ── Where its tables live ──────────────────────────────────────────────────
 * `setup()` creates `checkpoints`, `checkpoint_blobs`, `checkpoint_writes` and
 * `checkpoint_migrations` in whatever database the connection string names —
 * Ship's, here. They are NOT in `api/src/db/migrations/`, and that is a real
 * asymmetry worth knowing about before someone goes looking for them: the
 * library owns their schema and migrates them itself. Adding a hand-written
 * migration for them would fight the library the first time it changes them.
 *
 * `setup()` is idempotent, so calling it on every cold start is correct rather
 * than merely tolerable — it is what makes the destroy-and-redeploy cycle work
 * against an empty database with no manual step (FG-203/FG-204).
 */
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

let cached: PostgresSaver | null = null;

/**
 * The saver, created once per process.
 *
 * Cached because `setup()` is a round trip and the cron entrypoint would
 * otherwise pay it per workspace. Not cached across processes — a cron
 * container is short-lived by design.
 */
export async function getCheckpointer(connectionString?: string): Promise<PostgresSaver> {
  if (cached) return cached;

  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '[fleetgraph] DATABASE_URL is required for the checkpointer — without it a run ' +
        'suspended for approval cannot survive the container exiting'
    );
  }

  const saver = PostgresSaver.fromConnString(url);
  await saver.setup();
  cached = saver;
  return saver;
}

/**
 * Drop the cached saver AND close its connections.
 *
 * The close is the part that matters, and leaving it out cost a green suite
 * that still exited 1. `PostgresSaver.fromConnString` opens its own pool,
 * separate from `data/pool.ts`, and nothing else owns it. A test that stopped
 * its container without closing this produced eight unhandled `57P01`
 * ("terminating connection due to administrator command") *after* reporting
 * 146/146 passing — vitest counts those as failures, so CI reads red on a
 * suite where every assertion held.
 *
 * A cron container exiting does not need this: the process death takes the
 * sockets with it. Long-lived hosts and tests do.
 */
export async function resetCheckpointer(): Promise<void> {
  const saver = cached;
  cached = null;
  if (!saver) return;
  try {
    await saver.end();
  } catch {
    // Already closed, or the server went away first. Either way there is
    // nothing left to release.
  }
}
