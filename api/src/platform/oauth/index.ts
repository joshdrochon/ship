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

// Authorization Code + PKCE — L04. The code row and its repository seam, and
// the authorize decision table. The consent screen and the grant handler are
// exported from here too once their slices land.
export * from './authCodes.js';
export { PgAuthCodeRepo } from './pgAuthCodeRepo.js';
export * from './authorize.js';
export {
  mountAuthorizeRoutes,
  oauthBrowserSecurityHeaders,
  consentBodyParser,
  CONSENT_DECISION_PATH,
  type BrowserUser,
  type OAuthBrowserDeps,
  type AuthorizeRoutesDeps,
} from './consent.js';
export { renderConsentPage, renderAuthorizeErrorPage, escapeHtml } from './consentPage.js';

// Device Authorization Grant — L05. The device-code row and its repository
// seam, the issuance endpoint, and the response contract L18/L19 import.
export * from './deviceCodes.js';
export { PgDeviceCodeRepo } from './pgDeviceCodeRepo.js';
export * from './deviceThrottle.js';
export * from './deviceContract.js';
export * from './deviceSweeper.js';
export {
  deviceCodeGrant,
  DEVICE_CODE_GRANT_TYPE,
  DEVICE_GRANT_ERROR_DESCRIPTIONS,
  type DeviceGrantDeps,
} from './deviceGrant.js';
export {
  mountDeviceVerifyRoutes,
  DEVICE_DECISION_PATH,
  DEVICE_VERIFY_MESSAGES,
  type DeviceVerifyDeps,
} from './deviceVerify.js';
export {
  renderDeviceEntryPage,
  renderDeviceConsentPage,
  renderDeviceResultPage,
} from './consentPage.js';
export {
  mountDeviceAuthorizationRoutes,
  deviceAuthorizationResponseSchema,
  DEVICE_CODE_PATH,
  DEVICE_VERIFY_PATH,
  type DeviceAuthorizationResponse,
  type DeviceAuthorizationDeps,
} from './deviceAuthorization.js';

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
