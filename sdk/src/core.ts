/**
 * The RUNTIME-NEUTRAL surface: everything in `@ship/sdk` that runs unchanged in
 * Node, in a browser, in a worker and at the edge.
 *
 * Both entry points are built from this file — `index.ts` (Node) adds the
 * Node-only pieces, `browser.ts` adds the browser-only store — so the two can
 * never drift on the shared surface. There is one list, here.
 *
 * Nothing reachable from this module may import `node:` anything. That is the
 * PF-507 constraint and `browserEntry.test.ts` walks the import graph to prove
 * it.
 */

// ── client ──────────────────────────────────────────────────────────────────
export { ShipClient, SDK_USER_AGENT } from './client.js';
export type { ShipClientOptions, Me } from './client.js';

// ── base URL resolution (PF-491 / PF-494) ───────────────────────────────────
export {
  API_PATH_PREFIX,
  BASE_URL_ENV_VAR,
  DEFAULT_BASE_URL,
  buildOAuthTokenUrl,
  buildRequestUrl,
  resolveBaseUrl,
} from './baseUrl.js';
export type { BaseUrlSource, ResolvedBaseUrl } from './baseUrl.js';

// ── errors (PF-497 – PF-502) ────────────────────────────────────────────────
export {
  errorFromResponse,
  isShipApiErrorCode,
  kindForStatus,
  KIND_BY_CODE,
  notAuthenticatedError,
  parseRetryAfter,
  SHIP_API_ERROR_CODES,
  SHIP_ERROR_KINDS,
  SHIP_UNAUTHORIZED_REASONS,
  ShipError,
  transportError,
} from './errors.js';
export type {
  ApiErrorBody,
  HeaderReader,
  ShipApiErrorCode,
  ShipErrorInit,
  ShipErrorKind,
  ShipUnauthorizedReason,
} from './errors.js';

// ── rate limits (PF-512) ────────────────────────────────────────────────────
export { parseRateLimit, RATE_LIMIT_HEADERS } from './rateLimit.js';
export type { RateLimitStatus } from './rateLimit.js';

// ── retry policy (PF-510 – PF-513) ──────────────────────────────────────────
export {
  BASE_RETRY_DELAY_MS,
  computeRetryDelayMs,
  isRetryableStatus,
  MAX_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  NEVER_RETRY_STATUSES,
  realClock,
  RETRY_POLICY,
  RETRYABLE_STATUSES,
} from './retry.js';
export type { SdkClock } from './retry.js';

// ── transport (PF-495) ──────────────────────────────────────────────────────
export { ShipTransport, REFRESH_SKEW_SECONDS } from './transport.js';
export type { Transport, TransportDeps } from './transport.js';
export { createFetchHttpClient, resolveGlobalFetch } from './http.js';
export type { FetchLike, HttpClient, HttpRequest, HttpResponse } from './http.js';

// ── token stores (PF-503 – PF-505, PF-509) ──────────────────────────────────
export { InMemoryTokenStore, isStoredTokens } from './auth/tokenStore.js';
export type { ITokenStore, StoredTokens } from './auth/tokenStore.js';
export { exchangeRefreshToken, singleFlight } from './auth/refresh.js';

// ── pagination ──────────────────────────────────────────────────────────────
export { paginate } from './pagination.js';
export type { Page } from './pagination.js';

// ── resources ───────────────────────────────────────────────────────────────
export { DocumentsClient } from './resources/documents.js';
export type { ShipDocument, CreateDocumentInput } from './resources/documents.js';
