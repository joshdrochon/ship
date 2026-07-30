import { describe, it, expect } from 'vitest';
import {
  nextStatusOnDisconnect,
  effectiveSyncStatus,
  syncStatusLabel,
  syncStatusDetail,
  claimsWorkIsSafe,
  type SyncStatus,
} from './syncStatus';

/**
 * Regression tests for W6-5 — the sync indicator misreporting the state of the
 * collaboration socket.
 *
 * Measured before the fix (docs/audit/evidence/w6-5/w6-5-before.json): browser
 * online, collaboration socket severed and kept severed for 12 s, everything
 * typed into the body failing to reach the server, and the badge reading
 * **"Cached"** the whole time. `badge_claims_saved_while_not_saving: true`.
 *
 * The invariant these tests pin down: once a document has synced, no state that
 * reads as "your work is safe" may be shown while the socket is down.
 */
describe('sync status (W6-5 regression)', () => {
  const ALL: SyncStatus[] = ['connecting', 'cached', 'synced', 'disconnected'];

  describe('nextStatusOnDisconnect', () => {
    it('never claims the work is safe after a socket that had synced drops', () => {
      // This is the assertion that fails on the pre-fix logic, which returned
      // 'cached' here whenever an IndexedDB cache existed — which is almost always.
      for (const hasCachedContent of [true, false]) {
        const next = nextStatusOnDisconnect({ hasSyncedOnce: true, hasCachedContent });
        expect(next).toBe('disconnected');
        expect(claimsWorkIsSafe(next)).toBe(false);
        expect(syncStatusLabel(next)).toBe('Offline');
      }
    });

    it('still reports "Cached" before the first sync, where it is accurate', () => {
      // Startup: the socket has never been up, the content on screen genuinely did
      // come from the local cache, and nothing has been lost.
      expect(nextStatusOnDisconnect({ hasSyncedOnce: false, hasCachedContent: true })).toBe('cached');
    });

    it('reports a disconnection before the first sync when there is no cache either', () => {
      expect(nextStatusOnDisconnect({ hasSyncedOnce: false, hasCachedContent: false })).toBe('disconnected');
    });
  });

  describe('effectiveSyncStatus', () => {
    it('reports a disconnection whenever the browser is offline, whatever the socket last said', () => {
      for (const status of ALL) {
        expect(effectiveSyncStatus(status, false)).toBe('disconnected');
        expect(claimsWorkIsSafe(effectiveSyncStatus(status, false))).toBe(false);
      }
    });

    it('passes the socket state through when the browser is online', () => {
      for (const status of ALL) {
        expect(effectiveSyncStatus(status, true)).toBe(status);
      }
    });

    it('recovers as soon as the socket reconnects — no stale error state', () => {
      // The other half of W6-5: the indicator must clear once the socket is back,
      // rather than staying on the last bad value.
      expect(effectiveSyncStatus('synced', true)).toBe('synced');
      expect(syncStatusLabel(effectiveSyncStatus('synced', true))).toBe('Saved');
    });
  });

  describe('syncStatusLabel', () => {
    it('keeps exactly the four words the accessibility and E2E suites assert on', () => {
      expect(ALL.map(syncStatusLabel)).toEqual(['Saving', 'Cached', 'Saved', 'Offline']);
    });
  });

  describe('syncStatusDetail', () => {
    it('tells an online user with a dead socket that this is about the server, not them', () => {
      const detail = syncStatusDetail('disconnected', true);
      expect(detail).toMatch(/not connected to the collaboration server/i);
      expect(detail).toMatch(/kept on this device/i);
    });

    it('tells an offline user that their changes are held locally', () => {
      expect(syncStatusDetail('disconnected', false)).toMatch(/you are offline/i);
    });

    it('has a detail string for every state', () => {
      for (const status of ALL) {
        expect(syncStatusDetail(status, true).length).toBeGreaterThan(0);
        expect(syncStatusDetail(status, false).length).toBeGreaterThan(0);
      }
    });
  });

  describe('the full sequence the harness drives', () => {
    it('online -> offline -> online reports each phase honestly', () => {
      let online = true;

      // connected and synced
      let status: SyncStatus = 'synced';
      expect(syncStatusLabel(effectiveSyncStatus(status, online))).toBe('Saved');

      // browser drops
      online = false;
      status = nextStatusOnDisconnect({ hasSyncedOnce: true, hasCachedContent: true });
      expect(syncStatusLabel(effectiveSyncStatus(status, online))).toBe('Offline');

      // browser back, socket still coming up
      online = true;
      status = 'connecting';
      expect(syncStatusLabel(effectiveSyncStatus(status, online))).toBe('Saving');

      // socket back
      status = 'synced';
      expect(syncStatusLabel(effectiveSyncStatus(status, online))).toBe('Saved');
    });

    it('online browser, severed socket reports Offline rather than Cached', () => {
      // The exact scenario in measure-reconnect-ui.mjs phase 2.
      const status = nextStatusOnDisconnect({ hasSyncedOnce: true, hasCachedContent: true });
      const effective = effectiveSyncStatus(status, /* isBrowserOnline */ true);
      expect(syncStatusLabel(effective)).toBe('Offline');
      expect(claimsWorkIsSafe(effective)).toBe(false);
    });
  });
});
