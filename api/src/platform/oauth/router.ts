/**
 * OAuth 2.0 endpoints — hand-rolled, IETF-correct, minimal.
 *
 * Routes this router will expose (build order per docs/architecture.md):
 *
 *   GET  /oauth/authorize      Auth Code + PKCE: login + consent, stores
 *                              code_challenge, 302s back with a short-lived code
 *   POST /oauth/token          grant_type=authorization_code  → verifies PKCE (S256)
 *                              grant_type=refresh_token       → ROTATION: new pair,
 *                                old spent; reuse of spent token revokes the family
 *                              grant_type=urn:ietf:params:oauth:grant-type:device_code
 *                              grant_type=client_credentials  → first-party agent (M2M)
 *   POST /oauth/device/code    issues device_code + user_code + verification_uri
 *   GET  /oauth/device/verify  user enters the short code + consents
 *
 * Error semantics per RFC 6749 §5.2 (invalid_grant, slow_down for 8628 §3.5).
 */
import { Router } from 'express';

export interface OAuthRouterDeps {
  // TODO(josh): appsRepo, tokenRepo, authCodeRepo, deviceCodeRepo, clock
  placeholder?: never;
}

export function createOAuthRouter(_deps: OAuthRouterDeps = {}): Router {
  const router = Router();

  // TODO(josh): E1 slices, in order:
  //  1. POST /oauth/token (authorization_code + PKCE) — negative tests first
  //  2. GET  /oauth/authorize (consent screen, minimal layout inside Ship UI)
  //  3. refresh rotation + family revocation
  //  4. device pair (POST /device/code, GET /device/verify, token polling + slow_down)
  //  5. client_credentials for the seeded first-party agent app

  return router;
}
