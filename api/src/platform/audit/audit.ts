/**
 * The public audit trail — one row per `/api/v1` call.
 *
 * Tickets: PF-326 (the record shape), PF-328 (fire-and-forget), PF-329 (the
 * in-memory sink), PF-330 (`request_id` is consumed, never minted), PF-331
 * (route template), PF-332 (full-stack latency), PF-333 (`scope used`),
 * PF-334/335 (failures are audited), PF-337 (aborts), PF-338 (exactly once).
 *
 * PRD p.4: *"Every public API call recorded"* — timestamp, app `client_id`,
 * `user_id`, route, scope used, status, latency — *"Queryable in the developer
 * portal."* p.18 (Pre-Search 3.5) names one more field the p.4 row does not:
 * `request_id`. Both lists are the contract; `PUBLIC_API_CALL_FIELDS` below is
 * the single place they are written down.
 *
 * p.12 places this middleware at the public layer only. The internal `/api`
 * surface gets no audit middleware and writes no rows — asserted, because the
 * insert is a per-call query and MVP-9's +10% per-route query-count budget is
 * measured on the Part 1 internal routes.
 *
 * ── THIS MODULE MINTS NOTHING ────────────────────────────────────────────────
 * `request_id` comes from `res.locals.requestId`, which L07's
 * `requestIdMiddleware` (PF-190/PF-193) originates as the FIRST layer in the v1
 * stack. PF-330 greps this directory for id generation. An audit trail whose
 * ids do not match the ids the caller was given is an audit trail nobody can
 * correlate against a support conversation.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Request, Response, NextFunction } from 'express';
import type { PlatformAuthContext } from '../scopes/auth-context.js';
import { getRequestId } from '../api/v1/requestId.js';

/**
 * PF-326 — the field list, as data.
 *
 * Exported so three things can be compared against ONE definition rather than
 * three copies: the TypeScript type below, the field list in
 * `docs/architecture.md` (PF-327), and the columns of the `public_api_calls`
 * table (PF-339). A doc that lists six of seven fields is how a field quietly
 * never gets stored, which is finding G2 and is why this array exists.
 */
export const PUBLIC_API_CALL_FIELDS = [
  'occurredAt',
  'clientId',
  'userId',
  'method',
  'route',
  'scopeUsed',
  'status',
  'latencyMs',
  'requestId',
] as const;

export type PublicApiCallField = (typeof PUBLIC_API_CALL_FIELDS)[number];

/**
 * One recorded public API call.
 *
 * ── WHAT EACH NULLABLE FIELD MEANS WHEN IT IS NULL (PF-326) ─────────────────
 * Three fields are nullable and none of them means "unknown". A null with no
 * documented meaning is a null every reader guesses about differently.
 *
 *   clientId   null  ⇒ the request never authenticated. Bearer auth rejected it
 *                      (401), or it hit a route mounted above bearer auth
 *                      (`/api/v1/openapi.json`), or it was throttled by the
 *                      anonymous backstop before auth ran (429).
 *   userId     null  ⇒ either the same, OR an authenticated call by a token
 *                      with no end user behind it — the `client_credentials`
 *                      grant the first-party agent uses. `clientId` non-null
 *                      with `userId` null is machine-to-machine and is normal.
 *   scopeUsed  null  ⇒ NO SCOPE WAS CHECKED on this request. An unscoped route
 *                      (`declareRoute(null, …)`), or a request rejected before
 *                      the scope middleware ran. It NEVER means "the scope
 *                      check passed" — that case records the scope name.
 *
 * ── WHAT IS DELIBERATELY ABSENT (PF-340, and B11) ───────────────────────────
 * No request body, no response body, no headers, no token material, no client
 * secret. Pre-Search 1.4 (p.15) treats a log line as a leakage path and this
 * type is the enforcement: a field that does not exist cannot be filled in by a
 * later well-meaning edit.
 *
 * Also absent, and this one is a KNOWN LIMITATION rather than a safety property:
 * there is no field distinguishing a call the developer portal made on a user's
 * behalf from a call the developer's own integration made. Both authenticate as
 * the same app with the same token type and are indistinguishable in this trail.
 * L22's PF-676 discloses that in the portal UI rather than adding a field here —
 * the closed key set is the thing that keeps this row honest, and quietly
 * widening it to paper over a reporting gap would cost more than the gap does.
 */
export interface PublicApiCallRecord {
  /** When the response completed. */
  occurredAt: Date;
  /** The OAuth app's `client_id`. Null ⇒ unauthenticated. */
  clientId: string | null;
  /** The end user, if any. Null ⇒ unauthenticated OR machine-to-machine. */
  userId: string | null;
  /** Upper-case HTTP method. */
  method: string;
  /** The route TEMPLATE, `/api/v1`-prefixed. Never a concrete resource id. */
  route: string;
  /** The scope `requireScope` checked. Null ⇒ no scope was checked. */
  scopeUsed: string | null;
  /** Final HTTP status. */
  status: number;
  /** Whole-stack latency in milliseconds — auth and throttling included. */
  latencyMs: number;
  /** L07's id, consumed. This module mints none. */
  requestId: string;
}

/**
 * PF-328 — where a recorded call goes.
 *
 * `void | Promise<void>` rather than `void`: the Postgres sink is asynchronous,
 * and a synchronous-only signature would force it to swallow its own errors
 * inside an un-awaited promise where nothing could log them. The contract is
 * FIRE-AND-FORGET in both shapes — a caller neither awaits the result nor lets a
 * failure change the response. `recordSafely` below is how that is guaranteed
 * once rather than at each call site.
 */
export interface IAuditSink {
  record(entry: PublicApiCallRecord): void | Promise<void>;
}

/**
 * PF-328 — call a sink so that it can never fail a request.
 *
 * An audit sink that can 500 a working request is worse than no audit sink: it
 * converts an observability outage into an availability outage, and it does so
 * on the exact path — every public call — where the blast radius is total.
 *
 * Both failure shapes are caught, because they fail differently and only one of
 * them is obvious. A synchronous `throw` inside a `res.on('finish')` listener
 * becomes an `uncaughtException` and takes the PROCESS down, not the request. A
 * rejected promise becomes an `unhandledRejection`, which Node 15+ also treats
 * as fatal by default. Neither would show up as a failed test of the response.
 *
 * The failure is logged once, with the `request_id`, so an operator can tie a
 * missing row to a specific call rather than to a time range.
 */
export function recordSafely(sink: IAuditSink, entry: PublicApiCallRecord): void {
  try {
    const result = sink.record(entry);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err: unknown) => {
        logAuditFailure(entry, err);
      });
    }
  } catch (err) {
    logAuditFailure(entry, err);
  }
}

function logAuditFailure(entry: PublicApiCallRecord, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(
    `[api/v1] audit sink failed (request_id=${entry.requestId}, route=${entry.route}, ` +
      `status=${entry.status}):`,
    err,
  );
}

/**
 * PF-329 — the test double, and the local-dev sink.
 *
 * `records` is append-only and in insertion order, which is what makes "exactly
 * one row per request" (PF-338) a checkable claim rather than a spot check.
 */
export class InMemoryAuditSink implements IAuditSink {
  readonly records: PublicApiCallRecord[] = [];
  record(entry: PublicApiCallRecord): void {
    this.records.push(entry);
  }
}

/** What `route` records when the request matched no route at all (PF-331). */
export const UNMATCHED_ROUTE = '<unmatched>';

/**
 * Marks a response as already audited, so a second mount cannot double-count.
 *
 * On `res.locals` rather than a `WeakSet` keyed by response: `res.locals` is
 * per-request by construction and is cleaned up with the response, while a
 * module-level set would be shared across every app in the process — including
 * two apps in the same test file.
 */
const AUDITED_LOCAL = '__publicApiCallAudited';

export function publicAuditMiddleware(sink: IAuditSink) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // PF-338 — the once-guard. Mounting this middleware twice (a sub-router that
    // composes the public router, a test that wires it by hand) would otherwise
    // double every row, and duplicate rows destroy the Epic 7 count as
    // effectively as missing ones.
    if (res.locals[AUDITED_LOCAL]) {
      next();
      return;
    }
    res.locals[AUDITED_LOCAL] = true;

    // PF-332 — the timer starts HERE, and this middleware is second in the v1
    // stack, so bearer validation, the scope check and rate limiting are all
    // inside the number. A latency that excludes auth is not the latency a P95
    // target means.
    const startedAt = process.hrtime.bigint();

    let written = false;
    const write = (): void => {
      // PF-337 — `finish` and `close` both fire for a normal response, and only
      // `close` fires when a client disconnects mid-response. Listening to both
      // with a guard is the only combination that records the aborted case
      // exactly once. Without it, the one class of request most worth
      // investigating is the one class with no row.
      if (written) return;
      written = true;

      const auth = res.locals.platformAuth as PlatformAuthContext | undefined;
      recordSafely(sink, {
        occurredAt: new Date(),
        clientId: auth?.clientId ?? null,
        userId: auth?.userId ?? null,
        method: req.method,
        route: routeTemplate(req),
        scopeUsed: (res.locals.scopeUsed as string | undefined) ?? null,
        status: res.statusCode,
        latencyMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        // PF-330 — CONSUMED, never minted. The `?? 'unknown'` is a soft edge L07
        // deliberately left in place for the case this middleware is mounted
        // outside the v1 stack; the fitness run asserts no record ever carries
        // it, including on 401s, 404s and 429s.
        requestId: getRequestId(res) ?? 'unknown',
      });
    };

    res.on('finish', write);
    res.on('close', write);
    next();
  };
}

/**
 * PF-331 — the route TEMPLATE, prefixed. Never the raw path.
 *
 * Two measured defects in the sketch's `req.route?.path ? … : req.path`:
 *
 *   1. Inside a router mounted at `/api/v1`, `req.path` is `/documents` — so
 *      even the matched case recorded rows with the prefix missing, and a row
 *      that says `/documents` cannot be told apart from an internal one.
 *   2. On a 401 or a 404 `req.route` is `undefined`, so the fallback recorded
 *      the RAW path. That puts document UUIDs in the route column: unbounded
 *      cardinality, a resource id in an audit field, and an index on `route`
 *      that is useless for the one query the portal actually runs.
 *
 * `req.baseUrl` carries the mount prefix and is correct for nested routers;
 * `req.route.path` is the template with `:params` intact. Unmatched requests
 * record a constant, so "this call routed nowhere" is a value you can group by.
 */
export function routeTemplate(req: Request): string {
  const template = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof template !== 'string') {
    return `${req.baseUrl || ''}${UNMATCHED_ROUTE}` || UNMATCHED_ROUTE;
  }
  const joined = `${req.baseUrl || ''}${template}`;
  // A router mounted at '/' gives baseUrl '' and template '/', which would
  // record '' rather than '/'.
  return joined === '' ? '/' : joined;
}
