/**
 * `request_id` — one origin, three consumers.
 *
 * Tickets: PF-190 (mint), PF-191 (header on every response), PF-192 (inbound
 * ignored), PF-193 (handoff contract to the audit sink).
 *
 * This middleware is FIRST in the public stack, above bearer auth. That ordering
 * is the whole ticket: an unauthenticated request is the most likely thing a
 * confused integrator will send us, and a 401 that cannot be traced is the one
 * failure a support conversation cannot start from. Everything downstream —
 * the error envelope's `request_id`, the `X-Request-Id` response header, and
 * L12's audit row — reads `res.locals.requestId` and none of them mints its own.
 *
 * ## Why an inbound `X-Request-Id` is ignored (PF-192)
 *
 * Because the id is an audit-trail key (PRD p.4), not a correlation hint. Honouring
 * a client-supplied value would let a caller write two different calls under one id,
 * write calls under an id another app is using, or fabricate a trail that reads as
 * something that never happened. An audit trail is worth something precisely because
 * the audited party did not write it. We mint, always; the caller gets our id back in
 * the response header and can correlate on that.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** The response header carrying the server-minted id. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Reads the id for this request. The single accessor — L12's audit sink, the
 * error middleware and any handler all go through here rather than reaching into
 * `res.locals` with their own fallback.
 *
 * Returns `undefined` only if this middleware never ran, which for anything under
 * `/api/v1` is a wiring bug rather than a runtime condition. Callers on the v1
 * path should treat `undefined` as impossible; `PF-193`'s test asserts it never
 * happens, including on 401s and 500s.
 */
export function getRequestId(res: Response): string | undefined {
  const id = res.locals.requestId as unknown;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Mints a UUID per request and publishes it to `res.locals` and the response
 * header (PF-190, PF-191).
 *
 * The header is set here, not in the error middleware, so it is present on
 * SUCCESS responses too and on failures that never reach a handler — a 429 from
 * the token bucket, a 401 from bearer auth. `res.setHeader` before any body is
 * written means it survives whatever path the response takes out.
 */
export function requestIdMiddleware() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // Deliberately does not look at `_req.headers['x-request-id']`. See PF-192
    // in the module docstring. `setHeader` also overwrites rather than appends,
    // so an inbound value cannot be echoed even accidentally.
    const id = randomUUID();
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
