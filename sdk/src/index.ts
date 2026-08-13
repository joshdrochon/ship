/**
 * `@ship/sdk` — the default (Node) entry point.
 *
 * Everything in `core.ts`, plus the two pieces that need a Node runtime:
 * `verifyWebhook` (`node:crypto`) and `FileTokenStore` (`node:fs`). A browser
 * bundler resolves `@ship/sdk` to `browser.ts` instead, through the `browser`
 * condition in the `exports` map — see that file for the defect this split
 * closes (PF-507 / L99 F14).
 *
 * ── Stability ───────────────────────────────────────────────────────────────
 * The split lives in `stability.ts` as two exported arrays, NOT as prose here.
 *
 * This paragraph used to be the prose version and it had already gone stale: it
 * named `ShipClient`, `paginate` and `verifyWebhook` and knew nothing about the
 * four resource clients, the OAuth helpers or the operation bindings added
 * since. `surfaceStability.test.ts` now asserts that every name this file
 * re-exports appears in exactly one of `STABLE_SURFACE` / `PRE_1_0_SURFACE`, so
 * an unmarked export fails the suite rather than quietly acquiring whatever
 * promise a reader assumes. PF-548; p.12's Required Documentation row.
 *
 * The same split is written in prose, for humans, in `docs/architecture.md`'s
 * SDK Surface section — and §4 of that test asserts the two cannot drift.
 */
export * from './core.js';

// ── Node-only ───────────────────────────────────────────────────────────────
export {
  verifyWebhook,
  SIGNATURE_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
} from './webhooks.js';
export type { VerifyOptions, WebhookHeaders } from './webhooks.js';
export {
  FileTokenStore,
  defaultCredentialsPath,
  CREDENTIAL_DIR_MODE,
  CREDENTIAL_FILE_MODE,
} from './auth/fileTokenStore.js';
export type { FileTokenStoreOptions } from './auth/fileTokenStore.js';

// ── Also exported here so a Node consumer can build one deliberately ────────
// (it needs a `WebStorageLike` passed in, since there is no global
// `localStorage` in Node — the constructor says so).
export {
  LocalStorageTokenStore,
  DEFAULT_LOCAL_STORAGE_KEY,
} from './auth/localStorageTokenStore.js';
export type {
  LocalStorageTokenStoreOptions,
  WebStorageLike,
} from './auth/localStorageTokenStore.js';
