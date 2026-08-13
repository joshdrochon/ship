/**
 * PF-507 — `LocalStorageTokenStore`, the browser store PRD p.4 names.
 *
 * This module is part of the BROWSER entry point and therefore imports nothing
 * from `node:`. That constraint is the whole reason `browser.ts` exists: the
 * package barrel used to re-export `verifyWebhook`, whose module top-level
 * imports `node:crypto`, so any bundler resolving `@ship/sdk` for the browser
 * pulled a Node built-in and either failed to resolve or silently polyfilled
 * crypto into every consumer's bundle — against a 250 KB budget (L99 F14, found
 * independently by L17 and L24).
 *
 * `browserEntry.test.ts` walks this module's transitive import graph and asserts
 * it contains no `node:` specifier and no bare import at all.
 *
 * ── Security note, stated rather than assumed ───────────────────────────────
 * `localStorage` is readable by any script on the origin, so a refresh token
 * kept here is exposed to XSS. It is the store the PRD names, so it ships; it is
 * not the store to reach for when a same-site cookie or an in-memory-only
 * credential would do. `keyPrefix` is configurable so two Ship instances on one
 * origin do not overwrite each other.
 */
import { isStoredTokens, type ITokenStore, type StoredTokens } from './tokenStore.js';

/** The minimal slice of the Web Storage API this store needs. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_LOCAL_STORAGE_KEY = 'ship.sdk.credentials';

export interface LocalStorageTokenStoreOptions {
  /** Defaults to `globalThis.localStorage`. Injected in tests; no jsdom required. */
  storage?: WebStorageLike;
  /** Defaults to `ship.sdk.credentials`. */
  key?: string;
}

function resolveStorage(explicit?: WebStorageLike): WebStorageLike {
  if (explicit) return explicit;
  const candidate = (globalThis as { localStorage?: WebStorageLike }).localStorage;
  if (!candidate) {
    throw new TypeError(
      'LocalStorageTokenStore requires a Web Storage implementation. There is no ' +
        '`localStorage` in this runtime — pass one as `{ storage }`, or use ' +
        'InMemoryTokenStore (any runtime) or FileTokenStore (Node, from @ship/sdk/node).',
    );
  }
  return candidate;
}

export class LocalStorageTokenStore implements ITokenStore {
  private readonly storage: WebStorageLike;
  private readonly key: string;

  constructor(options: LocalStorageTokenStoreOptions = {}) {
    this.storage = resolveStorage(options.storage);
    this.key = options.key ?? DEFAULT_LOCAL_STORAGE_KEY;
  }

  /**
   * Corrupt value → `null`, and NO write-back (PF-508).
   *
   * Three ways to be corrupt here, and all three land in the same place:
   * `getItem` throwing (Safari private mode does this), a value that is not
   * JSON, and JSON that is not a credential.
   */
  load(): Promise<StoredTokens | null> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return Promise.resolve(null);
    }
    if (raw === null) return Promise.resolve(null);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Promise.resolve(null);
    }
    return Promise.resolve(isStoredTokens(parsed) ? parsed : null);
  }

  save(tokens: StoredTokens): Promise<void> {
    this.storage.setItem(this.key, JSON.stringify(tokens));
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.storage.removeItem(this.key);
    return Promise.resolve();
  }
}
