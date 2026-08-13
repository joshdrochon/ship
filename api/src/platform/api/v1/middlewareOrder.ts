/**
 * V1_MIDDLEWARE_ORDER — the public stack's order, as DATA (PF-212).
 *
 * PRD p.13 asks, verbatim: *"Where exactly do AuthN, AuthZ, rate-limit, audit,
 * and webhook publication attach? Why is each a separate middleware?"* This file
 * is the answer, in a form a test can check. Two lanes downstream (L11 rate
 * limit, L12 audit) do not get to choose their own position — they slot into the
 * sequence declared here, and `router.test.ts` asserts the live router's layer
 * names EQUAL this list. Adding a middleware without editing this constant fails
 * the suite; editing this constant without moving the middleware fails it too.
 *
 * Names are `v1_`-prefixed on purpose. The prefix is what lets the same test
 * assert that no platform middleware has been smuggled into the resources region,
 * which is the one place a plain positional comparison cannot see.
 */

/** Where each entry actually attaches. */
export type V1LayerLevel =
  /** A `router.use(...)` on the public router — visible in `router.stack`. */
  | 'router'
  /** Inside a single route's own handler chain — not a router-level layer. */
  | 'route'
  /** The variable-length region where resource routers mount. */
  | 'region';

export interface V1MiddlewareEntry {
  name: string;
  level: V1LayerLevel;
  why: string;
}

/**
 * The stack, top to bottom.
 *
 * ── DEVIATION FROM PF-212 AS WRITTEN, and why ──────────────────────────────
 * The ticket's literal list is `request_id, body_parser, audit, bearer_auth,
 * rate_limit, …`. This file puts `audit` SECOND, above `body_parser`, and the
 * reason is exactly the reason PF-213 exists.
 *
 * `publicAuditMiddleware` records on `res.on('finish')`, so it audits nothing it
 * does not physically run before. `express.json()` rejects an oversized or
 * malformed body by calling `next(err)`, which skips every remaining non-error
 * layer and jumps straight to the terminal handler. Under the ticket's literal
 * order, a 413 and a 400 from the body parser are therefore UNAUDITED — the same
 * defect PF-213 fixes for 401 and 429, one layer higher up.
 *
 * Audit is mounted first-after-request_id because that is the only position from
 * which "every public API call is recorded" (PRD p.4) is true without an
 * exception list. It costs nothing: the middleware registers a hook and returns,
 * and every value it records is read at finish time.
 *
 * This is a deliberate, surfaced change to the ticket's text, not an oversight.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const V1_MIDDLEWARE_ORDER: readonly V1MiddlewareEntry[] = [
  {
    name: 'v1_request_id',
    level: 'router',
    why:
      'First, so every response — including ones that never reach a handler — carries a ' +
      'traceable id (PF-190/PF-193). Nothing downstream mints its own.',
  },
  {
    name: 'v1_audit',
    level: 'router',
    why:
      'Second, ABOVE body parsing, auth and rate limiting (PF-213 + the deviation note ' +
      'above). It hooks res.on("finish"); anything that short-circuits above it is invisible ' +
      'to the audit trail, and 401/413/429 are precisely the traffic an audit trail exists for.',
  },
  {
    name: 'v1_body_parser',
    level: 'router',
    why:
      'The public 1 MB ceiling (PF-215). Mounted on THIS router and reached before the ' +
      "app-wide 10 MB parser, because the public API's payloads are small and a 10 MB " +
      'unauthenticated body is a cheap way to make us do work.',
  },
  {
    name: 'v1_body_errors',
    level: 'router',
    why:
      "Directly below the parser, because an error handler only sees what was raised above it. " +
      'Without it a 2 MB body is an unrecognised error and the terminal handler scrubs it into a ' +
      '500 — telling an SDK retry ladder to retry a request that can never succeed. See bodyErrors.ts.',
  },
  {
    name: 'v1_anon_rate_limit',
    level: 'router',
    why:
      'L11 PF-313. The IP-keyed backstop, above BOTH the unauthenticated mount and bearer ' +
      'auth. PRD p.6 targets 100% of public API responses carrying rate-limit headers, and ' +
      'the per-app/per-token limiter below cannot head a response bearer auth already ' +
      'rejected — a 401, a 404, or /api/v1/openapi.json, which L13 measured (F45) as ' +
      'bypassing the limiter entirely. Deliberately coarse: its ceiling is set ABOVE the ' +
      'per-app one so it is an abuse backstop rather than a working limit.',
  },
  {
    name: 'v1_unauthenticated',
    level: 'router',
    why:
      'The V1_UNAUTHENTICATED_PATHS mount (PF-216). Sits above bearer auth because that is ' +
      'the only way a route inside this router can answer without a token, and inside the ' +
      'router so /api/v1/openapi.json still gets request_id and an audit row.',
  },
  {
    name: 'v1_bearer_auth',
    level: 'router',
    why:
      'AuthN. Separate from AuthZ because "who are you" has one answer per request while ' +
      '"may you do this" has one answer per route. MVP gate item 3 (p.2).',
  },
  {
    name: 'v1_rate_limit',
    level: 'router',
    why:
      'Below auth because the bucket key is the identity auth resolved (per-app AND ' +
      'per-token). Above the handlers because a throttled request must not do work. L11 owns ' +
      'its behaviour and headers; this lane owns only its position.',
  },
  {
    name: 'v1_require_scope',
    level: 'route',
    why:
      'AuthZ, per route, not per stack — the scope required by GET /documents is not the one ' +
      'required by POST /documents, so it cannot be a router-level layer. L03 owns it.',
  },
  {
    name: 'v1_resources',
    level: 'region',
    why:
      'Where L09/L10/L15/L16 mount. Variable length by design. The order test asserts no ' +
      '`v1_`-prefixed platform middleware appears in here, which is the one insertion a ' +
      'positional comparison cannot catch.',
  },
  {
    name: 'v1_not_found',
    level: 'router',
    why:
      "Below every real route: an unrouted /api/v1 path becomes the envelope, not Express's " +
      'HTML 404 (PF-197).',
  },
  {
    name: 'v1_error_handler',
    level: 'router',
    why: 'Terminal, and mounted here rather than on the app so internal /api keeps its own ' +
      'inline shapes byte-for-byte (PF-194).',
  },
] as const;

/** Just the names that appear as layers on the live router, in order. */
export const V1_ROUTER_LAYER_ORDER: readonly string[] = V1_MIDDLEWARE_ORDER.filter(
  (entry) => entry.level === 'router',
).map((entry) => entry.name);

/** The marker separating the fixed prefix from the fixed suffix. */
export const V1_RESOURCES_REGION = 'v1_resources';

/** Prefix of the layer order that must appear before any resource mount. */
export const V1_LAYERS_BEFORE_RESOURCES: readonly string[] = V1_MIDDLEWARE_ORDER.slice(
  0,
  V1_MIDDLEWARE_ORDER.findIndex((e) => e.name === V1_RESOURCES_REGION),
)
  .filter((e) => e.level === 'router')
  .map((e) => e.name);

/** Suffix of the layer order that must appear after every resource mount. */
export const V1_LAYERS_AFTER_RESOURCES: readonly string[] = V1_MIDDLEWARE_ORDER.slice(
  V1_MIDDLEWARE_ORDER.findIndex((e) => e.name === V1_RESOURCES_REGION) + 1,
)
  .filter((e) => e.level === 'router')
  .map((e) => e.name);

/**
 * Renames a middleware so the layer it becomes is identifiable by name.
 *
 * Express records `fn.name` on the layer it builds, and that is the only handle
 * a test has on "which middleware is this". Anonymous arrow functions all report
 * `''`, and every `rateLimitMiddleware()` in the process would otherwise report
 * the same generic inner name — so the stack would be unintrospectable exactly
 * when it matters.
 *
 * `configurable: true` is what makes this legal on a function declaration;
 * `Function.prototype.name` is configurable-but-not-writable.
 */
export function namedLayer<T extends (...args: never[]) => unknown>(name: string, fn: T): T {
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}
