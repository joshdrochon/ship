/**
 * PF-507 — the BROWSER entry point.
 *
 * ── The defect this file closes (L99 F14) ───────────────────────────────────
 * `index.ts` re-exports `verifyWebhook`, and `webhooks.ts` imports `node:crypto`
 * at module top level. A top-level import is unconditional, so any bundler
 * resolving `@ship/sdk` for the browser pulled a Node built-in: esbuild and Vite
 * fail to resolve it outright, and webpack 4-era configs silently polyfilled
 * crypto into every consumer's bundle — hundreds of kilobytes against a 250 KB
 * budget (p.9). Either way, PRD p.4's *"browser localStorage"* token store and
 * p.8's Browser SDK Demo were dead.
 *
 * Found independently by L17 and L24. L24's PF-738 is the detector and sequences
 * after this fix.
 *
 * ── The fix, and why this shape ─────────────────────────────────────────────
 * A CONDITIONAL `exports` map (see `package.json`): the `browser` condition
 * resolves `@ship/sdk` to this file, every other condition resolves to
 * `index.ts`. So:
 *
 *   - a Node consumer's `import { verifyWebhook } from '@ship/sdk'` is unchanged
 *     — nothing breaks, which matters because L18 and L24 build on it;
 *   - a bundler targeting the browser gets a graph with no `node:` specifier in
 *     it at all, verified by `browserEntry.test.ts` rather than asserted here.
 *
 * The rejected alternative was moving `verifyWebhook` to a subpath only. That
 * also works and is a breaking change for every existing import, for no gain
 * over a condition the resolver already understands. `@ship/sdk/node` exists
 * anyway, for a consumer who wants to be explicit.
 *
 * What is deliberately NOT here: `verifyWebhook` (needs HMAC over a raw body —
 * a webhook is delivered to a server, and a browser holding the signing secret
 * is a leaked secret), and `FileTokenStore` (there is no filesystem).
 */
export * from './core.js';

export {
  LocalStorageTokenStore,
  DEFAULT_LOCAL_STORAGE_KEY,
} from './auth/localStorageTokenStore.js';
export type {
  LocalStorageTokenStoreOptions,
  WebStorageLike,
} from './auth/localStorageTokenStore.js';
