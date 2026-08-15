/**
 * PF-548 — which surfaces are STABLE and which are PRE-1.0, as machine-readable
 * data.
 *
 * p.12's Required Documentation, SDK Surface row: *"Public surface of @ship/sdk:
 * resource clients, auth helpers, async iterators, error union, webhook
 * verifier. Mark which surfaces are stable and which are pre-1.0."*
 *
 * ── Why a module and not a doc comment ──────────────────────────────────────
 * A prose list in `index.ts`'s header is what this replaced, and it had already
 * gone stale: it named `ShipClient`, `paginate` and `verifyWebhook` and knew
 * nothing about the four resource clients, the OAuth helpers, the operation
 * bindings or the error-union members added since. A list nothing checks is a
 * list that describes the SDK someone meant to write.
 *
 * `surfaceStability.test.ts` asserts every export of the published barrel
 * appears in EXACTLY ONE of the two arrays below — so a new export fails the
 * suite until someone states which half of the promise it is under. That is the
 * whole mechanism: the cost of adding a surface is one line saying what you are
 * promising about it.
 *
 * ── What "stable for the week" means ────────────────────────────────────────
 * The signature will not change during the submission window and the demo, the
 * CLI, the portal and the drill can all be written against it. It is not a 1.0
 * compatibility promise; this package is `0.1.0` and `private`.
 *
 * ── What "pre-1.0" means ────────────────────────────────────────────────────
 * Useful, exported, and reserved the right to move. A consumer using one is
 * fine; a consumer building a public API on top of one is on notice.
 *
 * The same split is written in prose in `docs/architecture.md`'s SDK Surface
 * section, which p.12 makes a graded deliverable, and the test below asserts the
 * two cannot drift apart on the load-bearing names.
 */

/**
 * Stable for the week — p.4's five feature rows and the client that carries
 * them.
 *
 * Every name here is something the PRD asks for by name, or is the type a
 * consumer needs in order to write down what one of those returns. That is the
 * membership rule, and it is why `ShipTransport` is NOT here: p.4 never mentions
 * it and nothing a consumer writes needs to name it.
 */
export const STABLE_SURFACE = [
  // ── the client itself (p.2's gate expression, p.7's sketch) ───────────────
  'ShipClient',
  'ShipClientOptions',
  'Me',
  'ShipOpenApiDocument',
  'SDK_USER_AGENT',
  'RESOURCE_NAMES',
  'ResourceName',

  // ── the four resource clients (p.4 "Typed SDK Surface", p.7) ──────────────
  'DocumentsClient',
  'IssuesClient',
  'SprintsClient',
  'WebhooksClient',
  // Nested under WebhooksClient — p.4 puts the delivery log, DLQ and replay
  // under /webhooks and the SDK mirrors that shape (PF-526).
  'WebhookDeliveriesClient',
  'WebhookDelivery',
  'DeliveryStatus',
  'ListDeliveriesInput',
  'DELIVERY_STATUSES',
  'ResourceClient',
  // ⚑ DEVIATION FROM p.4, deliberate and recorded here because this file is the
  // authority on the published surface.
  //
  // p.4: *"Cursors handled internally; consumer code never sees them."* That is
  // true of `iterate()` and NOT true of the surface as a whole. `ListOptions`
  // carries `cursor?: string` and `Page` (below) carries `next_cursor`, and both
  // are re-exported from the barrel — so a consumer CAN hold a cursor.
  //
  // Kept, because `list()` is a different operation from `iterate()`: the
  // developer portal renders one page at a time and the CLI's `--limit` must not
  // drain a collection, and neither is expressible without a cursor in and a
  // cursor out. Pre-Search 2.4 (p.17) asks whether to expose raw cursors,
  // iterators, or both; the answer taken is both.
  //
  // The cost is bounded on purpose: `cursor` is on `ListOptions` and ABSENT from
  // `IterateOptions`, so the ergonomic path cannot see one even by accident, and
  // `typeProofs/paginationHidesCursor.ts` pins that with `@ts-expect-error`.
  // Read p.4's sentence as satisfied for `iterate()` and knowingly overridden for
  // `list()`. Stated the same way in docs/architecture.md → SDK Surface.
  'ListOptions',
  'IterateOptions',

  // resource types — a consumer cannot type a variable without these
  'ShipDocument',
  'CreateDocumentInput',
  'PublicDocumentType',
  'PUBLIC_DOCUMENT_TYPES',
  'BelongsToRef',
  'BelongsToType',
  'BELONGS_TO_TYPES',
  'DocumentPage',
  'ShipIssue',
  'CreateIssueInput',
  'UpdateIssueInput',
  'IssueState',
  'IssuePriority',
  'ISSUE_STATES',
  'ISSUE_PRIORITIES',
  'ShipSprint',
  'CreateSprintInput',
  'UpdateSprintInput',
  'SprintStatus',
  'SPRINT_STATUSES',
  'WebhookSubscription',
  'WebhookSubscriptionWithSecret',
  'CreateWebhookInput',
  'UpdateWebhookInput',
  'ShipEventType',
  'SHIP_EVENT_TYPES',

  // ── async-iterator pagination (p.4) ───────────────────────────────────────
  'paginate',
  'Page',
  'PaginationStalledError',

  // ── OAuth helpers (p.4) ───────────────────────────────────────────────────
  'ITokenStore',
  'StoredTokens',
  'InMemoryTokenStore',
  'FileTokenStore',
  'runDeviceLogin',
  'runAuthorizationCodeFlow',
  // L23 PF-686 — RFC 6749 §4.4. Stable on the same footing as its two
  // neighbours: it is a named grant in a published RFC, the shape is the same
  // `FlowResult`, and the FleetGraph agent depends on it from Epic 7 onward.
  'runClientCredentials',
  'buildAuthorizationRequest',
  'parseAuthorizationRedirect',
  'exchangeAuthorizationCode',
  'oauthErrorCode',
  'DeviceLoginOptions',
  'AuthorizationCodeFlowOptions',
  'ClientCredentialsOptions',
  'AuthorizationRequest',
  'FlowResult',

  // ── the typed error union (p.4) ───────────────────────────────────────────
  'ShipError',
  'ShipErrorKind',
  'SHIP_ERROR_KINDS',
  'ShipApiErrorCode',
  'SHIP_API_ERROR_CODES',
  'ShipUnauthorizedReason',
  'SHIP_UNAUTHORIZED_REASONS',
  'ApiErrorBody',
  'KIND_BY_CODE',
  'isShipApiErrorCode',
  'kindForStatus',

  // ── the webhook verifier (p.4, p.7) ───────────────────────────────────────
  'verifyWebhook',
  'SIGNATURE_HEADER',
  'DEFAULT_TOLERANCE_SECONDS',
  'WebhookHeaders',

  // ── rate limits (p.4's own row) ───────────────────────────────────────────
  'RateLimitStatus',
] as const;

/**
 * Pre-1.0 — exported, useful, and reserved the right to move.
 *
 * Three families, and each is here for a stated reason rather than by default:
 *
 *   TRANSPORT INTERNALS.  `ShipTransport`, `HttpClient`, `SdkClock`,
 *   `RETRY_POLICY` and the retry constants exist so a consumer can inject a
 *   proxy or a test double. They are the shape of an implementation, and the
 *   implementation is the thing most likely to change.
 *
 *   THE STORES BEYOND IN-MEMORY AND FILE. `LocalStorageTokenStore`'s option bag
 *   in particular: `localStorage` is XSS-readable and a better browser story
 *   (an in-memory store plus a refresh in a worker) would change this shape.
 *
 *   THE PARITY BINDING. `OPERATION_BINDINGS` and friends are published so the
 *   fitness test in `api/` can read them across the package boundary the ESLint
 *   fence enforces. They are a testing seam that happens to be exported, not a
 *   contract — and the day the spec grows a `requestBody` shape the table cannot
 *   express, it changes.
 */
export const PRE_1_0_SURFACE = [
  // transport internals
  'ShipTransport',
  'Transport',
  'TransportDeps',
  'REFRESH_SKEW_SECONDS',
  'createFetchHttpClient',
  'resolveGlobalFetch',
  'FetchLike',
  'HttpClient',
  'HttpRequest',
  'HttpResponse',
  'HeaderReader',
  'ShipErrorInit',
  'errorFromResponse',
  'notAuthenticatedError',
  'transportError',
  'parseRetryAfter',
  'parseRateLimit',
  'RATE_LIMIT_HEADERS',

  // retry policy
  'RETRY_POLICY',
  'RETRYABLE_STATUSES',
  'NEVER_RETRY_STATUSES',
  'MAX_ATTEMPTS',
  'BASE_RETRY_DELAY_MS',
  'MAX_RETRY_DELAY_MS',
  'computeRetryDelayMs',
  'isRetryableStatus',
  'realClock',
  'SdkClock',

  // base-URL resolution
  'resolveBaseUrl',
  'buildRequestUrl',
  'buildOAuthTokenUrl',
  'API_PATH_PREFIX',
  'BASE_URL_ENV_VAR',
  'DEFAULT_BASE_URL',
  'BaseUrlSource',
  'ResolvedBaseUrl',
  'CLIENT_ID_ENV_VAR',

  // refresh plumbing
  'exchangeRefreshToken',
  'singleFlight',
  'isStoredTokens',

  // stores beyond in-memory / file
  'LocalStorageTokenStore',
  'LocalStorageTokenStoreOptions',
  'WebStorageLike',
  'DEFAULT_LOCAL_STORAGE_KEY',
  'FileTokenStoreOptions',
  'defaultCredentialsPath',
  'CREDENTIAL_DIR_MODE',
  'CREDENTIAL_FILE_MODE',

  // PKCE primitives — the one-call helpers above are the stable surface
  'createPkcePair',
  'generateCodeVerifier',
  'generateState',
  'deriveCodeChallenge',
  'base64UrlEncode',
  'CODE_CHALLENGE_METHOD',
  'PkcePair',
  'SLOW_DOWN_INCREMENT_SECONDS',
  'DEFAULT_POLL_INTERVAL_SECONDS',

  // verifier options bag — p.7's positional `toleranceSec` is the stable form
  'VerifyOptions',

  // the stability lists THEMSELVES, which the barrel exports so L26's
  // submission artifact and any consumer can read the split programmatically.
  // Pre-1.0 for the same reason as the parity binding: it is a seam, and the
  // day the SDK ships a real deprecation policy this shape changes.
  //
  // These four are here because the test caught them — the first run after
  // exporting them failed on "nothing is UNLISTED", which is the mechanism
  // working on its own author.
  'STABLE_SURFACE',
  'PRE_1_0_SURFACE',
  'stabilityOf',
  'StableExport',
  'Pre1_0Export',

  // the spec-parity binding (a testing seam that happens to be exported)
  'OPERATION_BINDINGS',
  'BINDING_BY_OPERATION_ID',
  'resolveBoundMethod',
  'listPublicMethodPaths',
  'OperationBinding',
  'ClientMethodPath',
  'ReturnShape',
  'DOCUMENT_FIELDS',
  'CREATE_DOCUMENT_FIELDS',
  'ISSUE_FIELDS',
  'CREATE_ISSUE_FIELDS',
  'UPDATE_ISSUE_FIELDS',
  'SPRINT_FIELDS',
  'CREATE_SPRINT_FIELDS',
  'UPDATE_SPRINT_FIELDS',
  'WEBHOOK_SUBSCRIPTION_FIELDS',
  'WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS',
  'CREATE_WEBHOOK_FIELDS',
  'UPDATE_WEBHOOK_FIELDS',
  'WEBHOOK_DELIVERY_FIELDS',
] as const;

export type StableExport = (typeof STABLE_SURFACE)[number];
export type Pre1_0Export = (typeof PRE_1_0_SURFACE)[number];

/** Both lists as one lookup, so a caller asks once. */
export function stabilityOf(exportName: string): 'stable' | 'pre-1.0' | 'unlisted' {
  if ((STABLE_SURFACE as readonly string[]).includes(exportName)) return 'stable';
  if ((PRE_1_0_SURFACE as readonly string[]).includes(exportName)) return 'pre-1.0';
  return 'unlisted';
}
