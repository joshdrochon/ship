import { pool } from './client.js';
import { SESSION_TIMEOUT_MS, ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

/**
 * Session activity bookkeeping.
 *
 * Background — Category 4, W4-1 (`docs/audit/audit-report.md`).
 *
 * Every authenticated request used to issue
 *
 *     UPDATE sessions SET last_activity = $1 WHERE id = $2
 *
 * unconditionally. That turned every read request into a write: a row lock on the
 * session, a heap update, a WAL record, and eventually vacuum work — all to move a
 * timestamp forward by a few milliseconds. On the measured "view a document" flow it
 * accounted for 13 of 48 queries.
 *
 * The write exists to support a 15-minute idle timeout. A timeout measured in minutes
 * does not need a timestamp accurate to the millisecond, so the write is throttled: it
 * happens only once the stored value is already stale by more than
 * `SESSION_ACTIVITY_WRITE_INTERVAL_MS`.
 *
 * Two properties of this design are deliberate:
 *
 * 1. **The decision is derived from the row we just read**, not from an in-process
 *    cache. Multiple API processes, or a restart, cannot disagree about whether a write
 *    is due, and there is no cache to invalidate.
 * 2. **It can only expire a session early, never late.** The stored `last_activity`
 *    lags real activity by at most the interval, so the idle timeout fires at
 *    15 minutes minus up to the interval. Erring toward logging a user out sooner is
 *    the safe direction for a security control.
 */

/**
 * How stale the stored `last_activity` must be before it is worth a write.
 *
 * Shared with the sliding-cookie refresh in `middleware/auth.ts`, which had already
 * adopted the same 60-second threshold for the same reason. Keeping one constant stops
 * the two throttles from drifting apart.
 */
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 60 * 1000;

/**
 * Is the stored `last_activity` stale enough to be worth writing?
 *
 * @param inactivityMs milliseconds between now and the stored `last_activity`.
 */
export function shouldWriteSessionActivity(inactivityMs: number): boolean {
  return inactivityMs >= SESSION_ACTIVITY_WRITE_INTERVAL_MS;
}

/**
 * Advance a session's `last_activity`, skipping the write when the stored value is
 * still recent enough.
 *
 * @param sessionId    session row to touch.
 * @param now          timestamp to store.
 * @param inactivityMs milliseconds between `now` and the stored `last_activity`, as
 *                     already computed by the caller from the row it read.
 * @returns whether a write was actually issued — callers use this in tests, and it
 *          keeps the "did we skip?" decision observable rather than invisible.
 */
export async function touchSessionActivity(
  sessionId: string,
  now: Date,
  inactivityMs: number
): Promise<boolean> {
  if (!shouldWriteSessionActivity(inactivityMs)) return false;

  await pool.query('UPDATE sessions SET last_activity = $1 WHERE id = $2', [now, sessionId]);
  return true;
}

/**
 * Validate a session for a WebSocket handshake.
 *
 * The Yjs collaboration server and the events server each open a socket per document
 * view, and each handshake used to repeat the HTTP middleware's session dance inline:
 * SELECT, two timeout checks, then an unconditional `UPDATE sessions SET last_activity`.
 * Those handshake writes were the remaining `UPDATE sessions` statements on the measured
 * "view a document" flow once the HTTP middleware was throttled — 3 of the 40 queries.
 *
 * Lifting it here does two things: the same throttle now covers both authentication
 * paths, and the timeout rules live in one place instead of being duplicated in
 * `middleware/auth.ts` and `collaboration/index.ts`, where they could silently drift.
 *
 * Behaviour is otherwise identical to the inline version it replaces: an expired session
 * is deleted and rejected, and any error surfaces as a rejection rather than an
 * exception, because a WebSocket upgrade has nowhere to put a 500.
 *
 * @returns the session's user and workspace, or null if the socket must be refused.
 */
export async function validateSessionForConnection(
  sessionId: string
): Promise<{ userId: string; workspaceId: string } | null> {
  try {
    const result = await pool.query(
      `SELECT user_id, workspace_id, last_activity, created_at
       FROM sessions WHERE id = $1`,
      [sessionId]
    );

    const session = result.rows[0];
    if (!session) return null;

    const now = new Date();
    const inactivityMs = now.getTime() - new Date(session.last_activity).getTime();
    const sessionAgeMs = now.getTime() - new Date(session.created_at).getTime();

    if (sessionAgeMs > ABSOLUTE_SESSION_TIMEOUT_MS || inactivityMs > SESSION_TIMEOUT_MS) {
      await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
      return null;
    }

    await touchSessionActivity(sessionId, now, inactivityMs);

    return { userId: session.user_id, workspaceId: session.workspace_id };
  } catch {
    return null;
  }
}
