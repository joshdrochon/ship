/**
 * oauth/ — RFC 6749 Authorization Code, RFC 7636 PKCE, RFC 8628 Device Grant.
 *
 * Token issuance lives here, including one-time-use refresh tokens with family
 * revocation on reuse. `/oauth/*` is mounted by the composition root, never by
 * another platform module.
 */
export { createOAuthRouter } from './router.js';
export * from './pkce.js';
