/**
 * Typed error union — discriminated on `kind` so consumers switch exhaustively.
 *
 * ── THE MAPPING IS 6 → 5 (PF-499 / L99 F6) ──────────────────────────────────
 * The previous header on this file claimed a one-to-one correspondence with the
 * server's envelope codes. That was false, and it was load-bearing false: it is
 * exactly the sentence that makes a reader believe `kind` can be used where the
 * server's `code` is meant.
 *
 * The server publishes SIX codes (PRD p.7, printed verbatim there and defined in
 * `api/src/platform/api/v1/errors.ts`):
 *
 *     unauthorized · forbidden · not_found · validation_failed
 *     rate_limited · server_error
 *
 * This SDK publishes FIVE kinds (PRD p.4).
 * **`unauthorized` and `forbidden` both collapse to `kind: 'auth'`** — an SDK
 * consumer's `catch` asks "can a better token fix this?", and for both the
 * answer is yes.
 *
 * The collapse costs a distinction that matters — 401 means *refresh*, 403 means
 * *re-consent* (L03 PF-071) — so `ShipError` carries the raw server `code`
 * alongside `kind` (PF-500). Branch on `kind` for control flow; read `code` when
 * you need to know which of the two it was.
 *
 * ── WHY THIS FILE RESTATES THE SERVER'S CODE LIST ───────────────────────────
 * L07's PF-189 says "L17 imports this, does not restate it." It cannot. `sdk/**`
 * may import NOTHING from this repository — that is ESLint fence 4 (L99 F24),
 * and an `@ship/api` dependency would also blow the p.9 < 250 KB budget and make
 * the package unpublishable. So the SDK keeps its own copy and a TEST
 * (`errors.parity.test.ts`, which ships in neither package's `dist`) reads L07's
 * source and asserts the two key sets are string-equal. Adding a seventh server
 * code fails the SDK suite by name.
 *
 * Tickets: PF-497 (five kinds, exhaustive), PF-498 (6→5, both directions),
 * PF-499 (this comment), PF-500 (`code` preserved), PF-501 (fallback table),
 * PF-502 (`requestId` + `details` survive).
 */
import type { RateLimitStatus } from './rateLimit.js';

/**
 * The five kinds, as an array so a runtime test can enumerate them and a type
 * can be derived from the same definition. One source, two consumers.
 */
export const SHIP_ERROR_KINDS = [
  'auth',
  'rate_limit',
  'not_found',
  'validation',
  'server',
] as const;

/**
 * PRD p.4: *"Consumers can switch on kind exhaustively."* That is a COMPILE-TIME
 * property, so `errors.exhaustive.test-d.ts` proves it with a `never` assignment
 * rather than with a runtime assertion — deleting a case there fails
 * `pnpm type-check`.
 */
export type ShipErrorKind = (typeof SHIP_ERROR_KINDS)[number];

/**
 * The server's closed code set, restated (see the header for why it is not
 * imported). Key-equality with L07's `API_ERROR_CODES` is asserted by test.
 */
export const SHIP_API_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'server_error',
] as const;

export type ShipApiErrorCode = (typeof SHIP_API_ERROR_CODES)[number];

/**
 * Why a 401 happened — L06's B14 resolution, mirrored. The server puts this in
 * `details.reason` on the `unauthorized` envelope rather than inventing a
 * seventh code, and it is the field that tells a consumer which of three
 * different things to do:
 *
 *     expired  the credential was valid and is not now  → refresh it
 *     invalid  malformed, revoked, or not ours          → re-authenticate
 *     missing  no credential was presented at all       → attach one
 */
export const SHIP_UNAUTHORIZED_REASONS = ['expired', 'invalid', 'missing'] as const;

export type ShipUnauthorizedReason = (typeof SHIP_UNAUTHORIZED_REASONS)[number];

/**
 * The wire envelope. `code` is typed as the closed union widened with `string`
 * on purpose: a client compiled against v0.1 must not crash when a future server
 * adds a code, it must fall through to the status-based derivation below.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  request_id?: string;
}

/**
 * ApiErrorCode → kind. SIX keys, FIVE distinct values.
 *
 * `Record<ShipApiErrorCode, ShipErrorKind>` rather than `Record<string, …>`:
 * omitting a code is then a `pnpm type-check` failure rather than an
 * `undefined` that the fallback would paper over.
 */
export const KIND_BY_CODE: Record<ShipApiErrorCode, ShipErrorKind> = {
  unauthorized: 'auth',
  forbidden: 'auth',
  not_found: 'not_found',
  validation_failed: 'validation',
  rate_limited: 'rate_limit',
  server_error: 'server',
};

/** Narrowing guard — `body.code` is `string` on the wire. */
export function isShipApiErrorCode(code: string): code is ShipApiErrorCode {
  return (SHIP_API_ERROR_CODES as readonly string[]).includes(code);
}

/** The minimal header reader both `Headers` and a plain test double satisfy. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface ShipErrorInit {
  kind: ShipErrorKind;
  message: string;
  status: number;
  /** The server's `code`, or `null` when the failure produced no envelope. */
  code?: ShipApiErrorCode | null;
  requestId?: string | null;
  details?: unknown;
  retryAfterSeconds?: number | null;
  rateLimit?: RateLimitStatus | null;
  cause?: unknown;
}

export class ShipError extends Error {
  readonly kind: ShipErrorKind;
  readonly status: number;

  /**
   * PF-500 — the server's code, preserved.
   *
   * `kind: 'auth'` is two situations. `code: 'unauthorized'` says *get a fresh
   * token*; `code: 'forbidden'` says *this token will never work, ask the user
   * for another scope*. An SDK that kept only `kind` would make L18's auth
   * helpers retry a 403 forever.
   *
   * `null` when the response carried no Ship envelope at all — a proxy's HTML
   * 502, a truncated body, a gateway timeout.
   */
  readonly code: ShipApiErrorCode | null;

  /**
   * PF-502 — `request_id` from the body, or the `X-Request-Id` response header
   * when the body did not survive. L07's PF-191 guarantees one on every failure;
   * an SDK that swallows it makes every support ticket unanswerable.
   */
  readonly requestId: string | null;

  /** The server's `details`, verbatim. See `reason` / `requiredScope` below. */
  readonly details: unknown;

  /** Present on `kind === 'rate_limit'` when the server sent `Retry-After`. */
  readonly retryAfterSeconds: number | null;

  /** The rate-limit triple from the failing response, when it carried one. */
  readonly rateLimit: RateLimitStatus | null;

  constructor(init: ShipErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'ShipError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.rateLimit = init.rateLimit ?? null;
    if (Error.captureStackTrace) Error.captureStackTrace(this, ShipError);
  }

  /**
   * B14's `details.reason` on an `unauthorized`, typed and narrowed.
   *
   * This is what lets a consumer tell *refresh* from *re-authenticate* from
   * *attach a credential* without parsing a message string.
   */
  get reason(): ShipUnauthorizedReason | null {
    if (this.code !== 'unauthorized') return null;
    const raw = (this.details as { reason?: unknown } | null | undefined)?.reason;
    return typeof raw === 'string' &&
      (SHIP_UNAUTHORIZED_REASONS as readonly string[]).includes(raw)
      ? (raw as ShipUnauthorizedReason)
      : null;
  }

  /**
   * The scope a 403 says was missing, ready to hand to a re-consent flow.
   *
   * The shipped server field is `details.missing_scope` — PRD p.2 asks for "the
   * missing scope named explicitly in the error body" and L07 took the brief's
   * own word. PF-500's text says `required_scope`; that string PREDATES L07's
   * schema and would not match anything on the wire, so both are read and
   * `missing_scope` wins. Flagged in the lane report rather than silently
   * resolved.
   */
  get requiredScope(): string | null {
    if (this.code !== 'forbidden') return null;
    const details = this.details as
      | { missing_scope?: unknown; required_scope?: unknown }
      | null
      | undefined;
    const value = details?.missing_scope ?? details?.required_scope;
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** The scopes the token DOES carry, from a 403 body. Empty array when absent. */
  get grantedScopes(): string[] {
    const raw = (this.details as { granted_scopes?: unknown } | null | undefined)?.granted_scopes;
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
  }
}

/**
 * PF-501 — kind derivation when the body is missing, truncated, or not JSON.
 *
 * A reverse proxy between the SDK and Ship is the NORMAL case, not the exotic
 * one, so the status fallback has to be as carefully chosen as the code map.
 *
 * The rule the old implementation got wrong: its fallback chain ended at
 * `'server'` for anything unmatched, so a 400 carrying a proxy's HTML body
 * became `kind: 'server'` — which tells a consumer "not your fault, retry",
 * about a request that will fail identically forever.
 *
 * So: every 4xx lands on a client-side kind. An unrecognised 4xx (409, 418, …)
 * becomes `'validation'`, which is the honest reading among five kinds — the
 * request as sent will not be accepted. `'server'` is reserved for 5xx and for
 * a status outside 400–599, which is not a thing this function should ever see.
 */
export function kindForStatus(status: number): ShipErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'validation';
  return 'server';
}

/**
 * `Retry-After`, both RFC 7231 forms.
 *
 * delta-seconds (`120`) and HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`). The
 * date form needs a clock, which is injected rather than read from `Date.now`
 * so PF-513's no-wall-clock rule holds in the tests that cover it.
 *
 * Returns `null` for absent, unparseable, or negative values — never `NaN`, and
 * never a silent `0`, which would mean "retry immediately" and is the one wrong
 * answer that looks like a right one.
 */
export function parseRetryAfter(raw: string | null | undefined, nowMs: number): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }

  // An HTTP-date always carries letters (a weekday, a month name, `GMT`).
  // Without this guard `Date.parse('-5')` succeeds on V8 — it reads as a year —
  // and a malformed header becomes a real-looking delay.
  if (!/[A-Za-z]/.test(trimmed)) return null;

  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  const seconds = (dateMs - nowMs) / 1000;
  // A date already in the past means "you may retry now", which is 0 seconds of
  // waiting — a real answer, unlike the `null` that means "the server said
  // nothing".
  return seconds <= 0 ? 0 : seconds;
}

export interface ErrorFromResponseInit {
  status: number;
  body: ApiErrorBody | null;
  headers?: HeaderReader | null;
  rateLimit?: RateLimitStatus | null;
  /** Injected for `Retry-After`'s HTTP-date form. Defaults to the wall clock. */
  nowMs?: number;
}

/**
 * Builds the typed error from a failed response.
 *
 * Precedence, and why:
 *   1. `body.code` when it is one of the six — the server's own classification.
 *   2. `kindForStatus(status)` otherwise — the envelope did not arrive, or a
 *      future server sent a code this client does not know.
 *
 * `requestId` prefers the body and falls back to `X-Request-Id`, because the
 * header survives a body that did not.
 */
export function errorFromResponse(init: ErrorFromResponseInit): ShipError {
  const { status, body, headers } = init;
  const nowMs = init.nowMs ?? Date.now();

  const code = body && isShipApiErrorCode(body.code) ? body.code : null;
  const kind = code !== null ? KIND_BY_CODE[code] : kindForStatus(status);

  const retryAfterSeconds = parseRetryAfter(headers?.get('retry-after'), nowMs);

  return new ShipError({
    kind,
    code,
    message: body?.message ?? `Ship request failed with status ${status}.`,
    status,
    requestId: body?.request_id ?? headers?.get('x-request-id') ?? null,
    details: body?.details,
    retryAfterSeconds,
    rateLimit: init.rateLimit ?? null,
  });
}

/**
 * The error raised before a request is even attempted, when there is no usable
 * credential — no token, an empty store, or a store the SDK could not read.
 *
 * `kind: 'auth'` with `code: null` is the honest shape: nothing came back from a
 * server, so there is no server code to report. PF-508's corruption contract.
 */
export function notAuthenticatedError(detail: string): ShipError {
  return new ShipError({
    kind: 'auth',
    code: null,
    status: 0,
    message: `Not authenticated: ${detail}`,
  });
}

/**
 * A transport failure — DNS, socket, TLS, abort. `status: 0` because there was
 * no response, which is different from a 500 and a consumer can tell them apart.
 *
 * `cause` carries the original; the message never does, so a URL with a token in
 * it (which the SDK does not produce, but a caller's proxy might) cannot arrive
 * in a log through this path. See PF-495's second assertion.
 */
export function transportError(cause: unknown): ShipError {
  return new ShipError({
    kind: 'server',
    code: null,
    status: 0,
    message: 'Ship request failed before a response was received.',
    cause,
  });
}
