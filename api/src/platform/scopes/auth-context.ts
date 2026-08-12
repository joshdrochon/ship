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
  /**
   * The workspace every query made under this token is scoped to (PF-260).
   *
   * Added by L09, because without it the tenancy answer had nowhere to come
   * from. `documentService` takes a `DomainContext {workspaceId, userId, db}`
   * and PRD p.18's 3.4 asks how a grader gets a pre-registered app *"without
   * exposing your tenant's data"* — the answer is that the workspace is a
   * property of the TOKEN, resolved once at authentication from
   * `oauth_apps.workspace_id`, and never read from a request body, query
   * parameter or header. A public handler that could take it from the request
   * is a cross-tenant read waiting to be discovered.
   *
   * On this interface rather than looked up per request in each resource: one
   * resolution site means one place tenancy can be wrong, and L10's three
   * resources inherit it rather than each re-deriving it.
   */
  workspaceId: string;
}
