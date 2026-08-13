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
 * Stable this week: `ShipClient` and its resource clients, `ShipError` and the
 * five-member `kind` union, `ITokenStore` and its three implementations,
 * `paginate`, `verifyWebhook`.
 *
 * Pre-1.0 and may move: `ShipTransport`'s constructor shape, `RETRY_POLICY`'s
 * fields, the OAuth flow helper option bags (L18).
 */
export * from './core.js';

// ── Node-only ───────────────────────────────────────────────────────────────
export { verifyWebhook, SIGNATURE_HEADER } from './webhooks.js';
export type { VerifyOptions } from './webhooks.js';
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
