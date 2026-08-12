/**
 * ApiError — the single public error envelope.
 *
 * Every failure on /api/v1/* ships this exact shape:
 *   { code, message, details?, request_id }
 *
 * The code set is CLOSED (PRD p.7 prints it verbatim). It does NOT map 1:1 onto
 * the SDK's `kind` union — the mapping is 6 → 5, because `unauthorized` and
 * `forbidden` both collapse to `kind: 'auth'` (PF-189, finding F6). The old
 * comment here claimed 1:1; it was wrong, and `SDK_KIND_BY_CODE` below is now
 * the published mapping so no consumer has to restate it.
 *
 * A fitness test enumerates every /api/v1 route and asserts the shape on failure
 * paths (see `routeFitness.ts`), so a new route cannot quietly invent its own
 * error format.
 *
 * Tickets: PF-186 (closed union), PF-187 (class), PF-188 (status map),
 * PF-189 (SDK kind map).
 */

/**
 * The closed set of public error codes — PRD p.7.
 *
 * This array is the ONE definition. `ApiErrorCode` is derived from it, and both
 * the status map and the SDK-kind map are keyed by it, so a seventh code cannot
 * be added in one place and forgotten in another: `Record<ApiErrorCode, …>`
 * makes the omission a `pnpm type-check` failure, and `errors.test.ts` asserts
 * this array against the union printed in the PRD.
 *
 * Deliberately NOT extended for expired tokens. MVP gate item 3 (p.2) asks for
 * "401 with a distinct error code"; that distinction lives in `details.reason`
 * on the `unauthorized` envelope (L06 PF-161), not in a seventh member here.
 * See the dispute recorded as B14 in `tickets/plugforge/lane-99-unassigned.md`
 * and the `details` policy note below.
 */
export const API_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'server_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Code → HTTP status. Exhaustive by construction (PF-188).
 *
 * `Record<ApiErrorCode, number>` means omitting a code fails type-check rather
 * than shipping an `undefined` status that Express would turn into a 200.
 *
 * PRD-mandated pairs: `unauthorized`→401 (p.2, p.3), `forbidden`→403 (p.3),
 * `rate_limited`→429 (p.4).
 *
 * `validation_failed`→422 is OUR call, not the PRD's — the body parses, the
 * semantics fail, which is precisely what 422 means. The one `400` in the PRD
 * (p.2) is `invalid_grant` on `/oauth/token`, which is RFC 6749's error format
 * on a non-`/api/v1` route and is not an `ApiError` at all. Rationale is
 * recorded in `docs/architecture.md`.
 */
export const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  rate_limited: 429,
  server_error: 500,
};

/**
 * The SDK's discriminated-union tag. Restated here as a type only so this module
 * can publish the mapping without importing from `sdk/` — the boundary contract
 * (platform/README.md, fence 3) is that `sdk/**` imports nothing from this repo,
 * and the dependency must not run the other way either. `errors.test.ts` asserts
 * this list equals the SDK's `ShipErrorKind` union by reading `sdk/src/errors.ts`,
 * so the two cannot drift silently.
 */
export const SDK_KINDS = ['auth', 'rate_limit', 'not_found', 'validation', 'server'] as const;

export type SdkErrorKind = (typeof SDK_KINDS)[number];

/**
 * ApiErrorCode → SDK `kind`, published as data (PF-189).
 *
 * SIX codes onto FIVE kinds. `unauthorized` and `forbidden` both become `auth`,
 * because an SDK consumer's `catch` branches on "can I fix this by getting a
 * better token?" and both answers are yes. L17 imports this map; it does not
 * restate it. Finding F6 was the stale "1:1" claim this replaces.
 */
export const SDK_KIND_BY_CODE: Record<ApiErrorCode, SdkErrorKind> = {
  unauthorized: 'auth',
  forbidden: 'auth',
  not_found: 'not_found',
  validation_failed: 'validation',
  rate_limited: 'rate_limit',
  server_error: 'server',
};

/** Options bag for the third `ApiError` argument (PF-187). */
export interface ApiErrorOptions {
  /**
   * Structured, machine-readable context. The sub-shape is fixed PER CODE, not
   * per route — see the `details` policy in `platform/README.md` (PF-198) and
   * `apiErrorBodySchema` (PF-199), which enforces it.
   */
  details?: unknown;
  /**
   * The underlying failure. Retained for the server log; NEVER serialized —
   * `Error.cause` set through the constructor options is non-enumerable, so
   * `JSON.stringify` skips it, and `apiErrorMiddleware` never reads it into the
   * body.
   */
  cause?: unknown;
}

/**
 * The error every public handler throws.
 *
 * `details` is declared but not emitted as a class field (`declare`), so the key
 * is genuinely ABSENT when no details were supplied rather than present-and-
 * undefined. That distinction is load-bearing: `apiErrorBodySchema` is
 * `.strict()`, and the codes that MUST omit `details` are checked by key
 * presence, not by value.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;

  /** Present only when supplied. See the class note above (PF-187). */
  declare readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, options?: ApiErrorOptions) {
    // Only pass the options object when there is a cause: `new Error(m, {})`
    // would still define an own `cause` key on some runtimes.
    super(message, options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.code = code;

    if (options?.details !== undefined) {
      // Assigning (rather than declaring with an initializer) is what keeps the
      // key absent in the no-details case.
      (this as { details?: unknown }).details = options.details;
    }

    // Node sets this automatically for `Error` subclasses under V8, but only
    // when Error.captureStackTrace exists. Being explicit keeps the stack from
    // starting inside this constructor.
    if (Error.captureStackTrace) Error.captureStackTrace(this, ApiError);
  }

  /** The HTTP status this code maps to. Never `undefined` — see STATUS_BY_CODE. */
  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  /** The SDK `kind` a client would surface for this error. */
  get sdkKind(): SdkErrorKind {
    return SDK_KIND_BY_CODE[this.code];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-198 / PF-199 — the `details` policy, as a schema rather than as prose.
//
// THE ONE DEFINITION OF THE WIRE SHAPE. The serializer in `errorMiddleware.ts`
// and the route-fitness harness both import this; `ApiErrorBody` is inferred
// from it rather than declared alongside it, so there is no second copy of the
// shape to drift. `grep -rn "apiErrorBodySchema"` is the proof.
//
// Policy (answers Pre-Search 2.2, p.16 — which asks the question and does not
// answer it):
//
//   The envelope is IDENTICAL across all routes. `details` is the only variable
//   part, and its sub-shape is fixed PER CODE, never per route.
//
//   validation_failed  MUST carry details.fields[]
//   forbidden          MUST carry details.missing_scope   (p.3 — the 403 names it)
//   rate_limited       MAY  carry details.retry_after_seconds
//   unauthorized       MUST omit details
//   not_found          MUST omit details
//   server_error       MUST omit details
//
// "No details ever" was never available: p.3 requires a 403 to name the missing
// scope. Per-route detail shapes were available and were rejected — a consumer
// that must learn a different error body per endpoint has a convention, not an
// envelope. Prose version in `platform/README.md`.
// ─────────────────────────────────────────────────────────────────────────────
import { z } from 'zod';

/** Fields common to every member of the union. */
const envelopeBase = {
  message: z.string().min(1),
  request_id: z.string().uuid(),
};

/** One entry per invalid field. L09 produces these. */
export const validationFieldSchema = z
  .object({
    field: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/**
 * The public error envelope.
 *
 * `.strict()` on every member rejects an unknown TOP-LEVEL key — that is what
 * stops a route quietly bolting `error: '…'` or `stack` onto the envelope. The
 * discriminated union on `code` is what enforces the per-code `details` rules:
 * a `not_found` carrying `details` fails, and a `forbidden` without it fails too.
 */
export const apiErrorBodySchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('unauthorized'), ...envelopeBase }).strict(),
  z
    .object({
      code: z.literal('forbidden'),
      ...envelopeBase,
      details: z.object({ missing_scope: z.string().min(1) }).strict(),
    })
    .strict(),
  z.object({ code: z.literal('not_found'), ...envelopeBase }).strict(),
  z
    .object({
      code: z.literal('validation_failed'),
      ...envelopeBase,
      details: z.object({ fields: z.array(validationFieldSchema).min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      code: z.literal('rate_limited'),
      ...envelopeBase,
      details: z.object({ retry_after_seconds: z.number().int().positive() }).strict().optional(),
    })
    .strict(),
  z.object({ code: z.literal('server_error'), ...envelopeBase }).strict(),
]);

/**
 * The wire shape, INFERRED from the schema above. `request_id` is always present
 * — it is minted by `requestIdMiddleware` before anything can fail (PF-190).
 */
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Codes whose envelope must NOT carry a `details` key. */
export const CODES_WITHOUT_DETAILS: readonly ApiErrorCode[] = [
  'unauthorized',
  'not_found',
  'server_error',
];

/** Codes whose envelope MUST carry a `details` key. */
export const CODES_REQUIRING_DETAILS: readonly ApiErrorCode[] = ['forbidden', 'validation_failed'];

// This module is now types and data only. The runtime pieces live beside it:
//   requestId.ts       — minting and the `X-Request-Id` header (PF-190–193)
//   errorMiddleware.ts — the terminal handler, `asyncRoute`, the 404 catch-all
//                        (PF-194–197)
// Both are re-exported from the `api/v1` barrel, so importers see one surface.
