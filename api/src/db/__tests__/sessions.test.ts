import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SESSION_TIMEOUT_MS } from '@ship/shared';

vi.mock('../client.js', () => ({
  pool: { query: vi.fn() },
}));

import {
  shouldWriteSessionActivity,
  touchSessionActivity,
  validateSessionForConnection,
  SESSION_ACTIVITY_WRITE_INTERVAL_MS,
} from '../sessions.js';
import { pool } from '../client.js';
import { ABSOLUTE_SESSION_TIMEOUT_MS } from '@ship/shared';

/**
 * Regression tests for Category 4, W4-1.
 *
 * The audit measured 13 of the 48 queries on the "view a document" flow as
 * `UPDATE sessions SET last_activity`, one per authenticated request. These tests fail
 * if that unconditional write comes back.
 */
describe('session activity write throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pool.query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  describe('shouldWriteSessionActivity', () => {
    it('skips the write while the stored timestamp is still fresh', () => {
      expect(shouldWriteSessionActivity(0)).toBe(false);
      expect(shouldWriteSessionActivity(1)).toBe(false);
      expect(shouldWriteSessionActivity(SESSION_ACTIVITY_WRITE_INTERVAL_MS - 1)).toBe(false);
    });

    it('writes once the stored timestamp is stale by a full interval', () => {
      expect(shouldWriteSessionActivity(SESSION_ACTIVITY_WRITE_INTERVAL_MS)).toBe(true);
      expect(shouldWriteSessionActivity(SESSION_ACTIVITY_WRITE_INTERVAL_MS * 10)).toBe(true);
    });

    it('never lets the stored timestamp lag far enough to matter to the idle timeout', () => {
      // The throttle can only expire a session EARLY, by at most one interval. If the
      // interval ever grew to a meaningful fraction of the timeout, an active user could
      // be logged out mid-session. One minute against fifteen keeps the worst case at
      // under 7% of the window.
      expect(SESSION_ACTIVITY_WRITE_INTERVAL_MS).toBeLessThanOrEqual(SESSION_TIMEOUT_MS / 10);
    });
  });

  describe('touchSessionActivity', () => {
    it('issues no query at all for a request inside the interval', async () => {
      const wrote = await touchSessionActivity('sess-1', new Date(), 30 * 1000);

      expect(wrote).toBe(false);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('issues exactly one UPDATE once the interval has elapsed', async () => {
      const now = new Date();
      const wrote = await touchSessionActivity('sess-1', now, 90 * 1000);

      expect(wrote).toBe(true);
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledWith(
        'UPDATE sessions SET last_activity = $1 WHERE id = $2',
        [now, 'sess-1']
      );
    });

    it('collapses a burst of requests into a single write', async () => {
      // 20 requests one second apart. Only the one that crosses the interval writes.
      let inactivityMs = 0;
      let writes = 0;
      for (let i = 0; i < 20; i++) {
        inactivityMs += 5 * 1000;
        if (await touchSessionActivity('sess-1', new Date(), inactivityMs)) {
          writes++;
          inactivityMs = 0;
        }
      }

      expect(writes).toBe(1);
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('validateSessionForConnection (WebSocket handshake)', () => {
    const SELECT_SQL = expect.stringContaining('SELECT user_id, workspace_id');
    const UPDATE_SQL = 'UPDATE sessions SET last_activity = $1 WHERE id = $2';
    const DELETE_SQL = 'DELETE FROM sessions WHERE id = $1';

    function mockSession(lastActivity: Date, createdAt = new Date()) {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rows: [{
          user_id: 'user-123',
          workspace_id: 'ws-123',
          last_activity: lastActivity,
          created_at: createdAt,
        }],
      } as never);
    }

    // Each document view opens a Yjs socket and an events socket. Both handshakes used
    // to write last_activity unconditionally; they were the last 3 UPDATE statements on
    // the "view a document" flow after the HTTP middleware was throttled.
    it('does NOT write last_activity for a handshake inside the interval', async () => {
      mockSession(new Date(Date.now() - 30 * 1000));

      const result = await validateSessionForConnection('sess-1');

      expect(result).toEqual({ userId: 'user-123', workspaceId: 'ws-123' });
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledWith(SELECT_SQL, ['sess-1']);
      expect(pool.query).not.toHaveBeenCalledWith(UPDATE_SQL, expect.anything());
    });

    it('writes last_activity once the interval has elapsed', async () => {
      mockSession(new Date(Date.now() - 90 * 1000));

      await validateSessionForConnection('sess-1');

      expect(pool.query).toHaveBeenCalledWith(UPDATE_SQL, [expect.any(Date), 'sess-1']);
    });

    it('rejects and deletes a session past the idle timeout', async () => {
      mockSession(new Date(Date.now() - SESSION_TIMEOUT_MS - 1000));

      const result = await validateSessionForConnection('sess-1');

      expect(result).toBeNull();
      expect(pool.query).toHaveBeenCalledWith(DELETE_SQL, ['sess-1']);
      expect(pool.query).not.toHaveBeenCalledWith(UPDATE_SQL, expect.anything());
    });

    it('rejects and deletes a session past the absolute timeout', async () => {
      mockSession(new Date(), new Date(Date.now() - ABSOLUTE_SESSION_TIMEOUT_MS - 1000));

      const result = await validateSessionForConnection('sess-1');

      expect(result).toBeNull();
      expect(pool.query).toHaveBeenCalledWith(DELETE_SQL, ['sess-1']);
    });

    it('rejects an unknown session without further queries', async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);

      expect(await validateSessionForConnection('nope')).toBeNull();
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('rejects rather than throwing when the database is unreachable', async () => {
      // A WebSocket upgrade has nowhere to put a 500, so the failure mode is "refuse
      // the socket", same as the inline version this replaced.
      vi.mocked(pool.query).mockRejectedValueOnce(new Error('connection refused'));

      expect(await validateSessionForConnection('sess-1')).toBeNull();
    });
  });
});
