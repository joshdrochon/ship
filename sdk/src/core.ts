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
export { ShipClient, SDK_USER_AGENT, RESOURCE_NAMES } from './client.js';
export type { ShipClientOptions, Me, ResourceName, ShipOpenApiDocument } from './client.js';

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

// ── pagination (PF-533 – PF-536) ────────────────────────────────────────────
export { paginate, PaginationStalledError } from './pagination.js';
export type { Page } from './pagination.js';
export { ResourceClient } from './resources/base.js';
export type { ListOptions, IterateOptions } from './resources/base.js';

// ── resources (PF-521 – PF-527) ─────────────────────────────────────────────
export { DocumentsClient, PUBLIC_DOCUMENT_TYPES, BELONGS_TO_TYPES, DOCUMENT_FIELDS, CREATE_DOCUMENT_FIELDS } from './resources/documents.js';
export type {
  ShipDocument,
  CreateDocumentInput,
  PublicDocumentType,
  BelongsToType,
  BelongsToRef,
  DocumentPage,
} from './resources/documents.js';

export { IssuesClient, ISSUE_STATES, ISSUE_PRIORITIES, ISSUE_FIELDS, CREATE_ISSUE_FIELDS, UPDATE_ISSUE_FIELDS } from './resources/issues.js';
export type {
  ShipIssue,
  CreateIssueInput,
  UpdateIssueInput,
  IssueState,
  IssuePriority,
} from './resources/issues.js';

export { SprintsClient, SPRINT_STATUSES, SPRINT_FIELDS, CREATE_SPRINT_FIELDS, UPDATE_SPRINT_FIELDS } from './resources/sprints.js';
export type {
  ShipSprint,
  CreateSprintInput,
  UpdateSprintInput,
  SprintStatus,
} from './resources/sprints.js';

export {
  WebhooksClient,
  SHIP_EVENT_TYPES,
  WEBHOOK_SUBSCRIPTION_FIELDS,
  WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS,
  CREATE_WEBHOOK_FIELDS,
  UPDATE_WEBHOOK_FIELDS,
} from './resources/webhookSubscriptions.js';
export type {
  WebhookSubscription,
  WebhookSubscriptionWithSecret,
  CreateWebhookInput,
  UpdateWebhookInput,
  ShipEventType,
} from './resources/webhookSubscriptions.js';

// ── spec parity binding (PF-528 – PF-532) ───────────────────────────────────
export {
  OPERATION_BINDINGS,
  BINDING_BY_OPERATION_ID,
  resolveBoundMethod,
  listPublicMethodPaths,
} from './operations.js';
export type { OperationBinding, ClientMethodPath, ReturnShape } from './operations.js';
