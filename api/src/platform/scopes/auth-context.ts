/**
 * `PlatformAuthContext` — what bearer auth (L06) resolves a token into, and what
 * every downstream public-surface concern reads.
 *
 * It lives in `scopes/` rather than in `oauth/` because the field the rest of the
 * platform actually branches on is `scopes`, and it lives in its own file rather
 * than in `registry.ts` because the registry is *scope data* and this is *request
 * state*. PF-061 requires the registry to be importable in a bare Node context
 * with no HTTP stack; keeping request state out of it is how that stays true as
 * the context grows fields.
 *
 * Consumers today: `requireScope` (403/401), the rate limiter's per-app and
 * per-token keys, and the audit sink's `client_id` / `user_id` / `scope` columns.
 */
import type { Scope } from './scopes.js';

export interface PlatformAuthContext {
  /** `oauth_apps.id` of the app the token was issued to. */
  appId: string;
  /** The app's public `client_id` — what an audit row is filtered by. */
  clientId: string;
  /** The consenting user, or null for machine-to-machine (first-party agent) tokens. */
  userId: string | null;
  /**
   * Scopes carried by the presented token.
   *
   * Typed as the registry union, but do not trust it blindly: a token issued
   * before a scope was deregistered can carry a name the registry no longer
   * knows. PF-075 is where that mismatch is resolved (treated as not granted,
   * and recorded) rather than silently dropped.
   */
  scopes: Scope[];
  /** Primary key of the token row, for revocation and per-token rate limiting. */
  tokenId: string;
}
