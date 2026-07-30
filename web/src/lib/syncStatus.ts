/**
 * The editor's sync indicator, as a set of pure decisions.
 *
 * W6-5 was that this indicator did not report the state of the collaboration
 * socket. Two specific lies were measured (docs/audit/evidence/w6-5/):
 *
 *  - With the browser online and the socket severed for 12 s, the badge read
 *    "Cached" — blue, benign — while everything typed into the body failed to
 *    reach the server. `cached` was the startup state ("showing local cache while
 *    the socket comes up") and was being reused for a socket that dropped after a
 *    successful sync.
 *  - The audit's related observation that the badge can read "Saved" through a
 *    reconnect loop (W6-10) has the same root: the state was set once per event
 *    and never reconciled against whether the socket was actually up.
 *
 * The decisions live here rather than inline in Editor.tsx so the rule that
 * matters — a state that claims the work is safe is never shown while the socket
 * is down — is unit-testable without mounting the editor.
 */
export type SyncStatus = 'connecting' | 'cached' | 'synced' | 'disconnected';

/**
 * What to show when the collaboration socket reports a disconnect.
 *
 * `hasSyncedOnce` is the whole fix: before the first successful connection, a
 * closed socket really is "still starting up", and falling back to the cache is
 * honest. After it, a closed socket means the user's edits are going nowhere, and
 * the only honest report is a disconnection.
 */
export function nextStatusOnDisconnect(
  { hasSyncedOnce, hasCachedContent }: { hasSyncedOnce: boolean; hasCachedContent: boolean }
): SyncStatus {
  if (hasSyncedOnce) return 'disconnected';
  return hasCachedContent ? 'cached' : 'disconnected';
}

/**
 * A browser-level outage outranks the socket state: there is no point reporting
 * "connecting" when the machine has no network.
 */
export function effectiveSyncStatus(status: SyncStatus, isBrowserOnline: boolean): SyncStatus {
  return isBrowserOnline ? status : 'disconnected';
}

/**
 * The four visible words. Deliberately unchanged — the accessibility suite and
 * several E2E specs assert on `/Saved|Cached|Saving|Offline/`, and W6-5 is about
 * showing the right one, not about new vocabulary.
 */
export function syncStatusLabel(effective: SyncStatus): string {
  switch (effective) {
    case 'synced': return 'Saved';
    case 'cached': return 'Cached';
    case 'connecting': return 'Saving';
    case 'disconnected': return 'Offline';
  }
}

/** Tooltip text: what the state means for the user's work. */
export function syncStatusDetail(effective: SyncStatus, isBrowserOnline: boolean): string {
  switch (effective) {
    case 'synced':
      return 'Connected. Changes are saved as you type.';
    case 'cached':
      return 'Showing cached content while connecting.';
    case 'connecting':
      return 'Connecting to the collaboration server.';
    case 'disconnected':
      return isBrowserOnline
        ? 'Not connected to the collaboration server. Your changes are kept on this device and will sync when the connection returns.'
        : 'You are offline. Your changes are kept on this device and will sync when you reconnect.';
  }
}

/**
 * Does this state tell the user their work is safely on the server?
 *
 * Used by the regression test: no reassuring state may be shown while the socket
 * is down. "Cached" counts as reassuring — it is blue, it reads as a normal
 * condition, and nothing in it suggests edits are not being saved.
 */
export function claimsWorkIsSafe(effective: SyncStatus): boolean {
  return effective === 'synced' || effective === 'cached';
}
