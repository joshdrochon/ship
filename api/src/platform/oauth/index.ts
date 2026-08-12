/**
 * oauth/ — RFC 6749 Authorization Code, RFC 7636 PKCE, RFC 8628 Device Grant.
 *
 * Token issuance lives here, including one-time-use refresh tokens with family
 * revocation on reuse. `/oauth/*` is mounted by the composition root, never by
 * another platform module.
 */
export { createOAuthRouter, grantHandlers } from './router.js';
export type { OAuthRouterDeps, GrantHandler, GrantOutcome } from './router.js';
export * from './pkce.js';

// Token lifecycle — L06. Generation and hashing, the repository seam, the one
// issuance site, resolution, the bearer middleware and refresh rotation.
export * from './tokens.js';
export * from './tokenRepo.js';
export { PgTokenRepo } from './pgTokenRepo.js';
export * from './issue.js';
export * from './resolve.js';
export * from './bearer.js';
export * from './rotation.js';
export {
  OAUTH_ERROR_CODES,
  oauthErrorBodySchema,
  oauthTokenResponseSchema,
  type OAuthErrorCode,
} from './oauthErrors.js';
