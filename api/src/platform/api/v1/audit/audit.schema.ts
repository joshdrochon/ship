/**
 * Request and response Zod for `GET /api/v1/audit`, adjacent to the handler.
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."*
 *
 * PRD p.4, Public Audit Trail: *"Every public API call recorded with timestamp,
 * app client_id, user_id, route, scope used, status, latency. Queryable in the
 * developer portal."* The seven named fields are the seven below plus the
 * identifiers that make a row addressable.
 *
 * ## What is NOT on the wire
 *
 * `client_id` IS present, and it is always the caller's own — see the route
 * header for why the filter cannot be supplied by the caller. It is kept on the
 * row rather than omitted as redundant because the portal renders several apps
 * in one session and a row that does not say which app it belongs to is one the
 * UI has to remember context for.
 *
 * There is no request/response BODY of the original call here, and there never
 * should be. `public_api_calls` records metadata about a call, not its content;
 * adding a body column would turn the audit trail into a copy of every payload
 * that ever crossed the API, with all of that payload's sensitivity and none of
 * its access control. Migration 057's header makes the same point.
 *
 * `.strict()` is what enforces the shape: L13's `responseContract` parses every
 * 2xx body through this schema, so a handler that added a field would fail to
 * serialise rather than quietly widening the public contract.
 */
import { z } from 'zod';

/**
 * The cursor's resource binding (PF-218).
 *
 * `'audit'`, matching the ROUTE path segment, not `'public_api_calls'`, which is
 * the TABLE. L08's convention — asserted for every mounted route by
 * `documents/documents.regression.test.ts` — is that a route's cursor resource
 * is derived from its path, so that a cursor names the collection a caller asked
 * for rather than the storage behind it. A public cursor that leaked the table
 * name would also make the storage layout part of the public contract.
 *
 * `listCalls` takes this as its `resource` parameter, so the binding is the same
 * on the way in and the way out. If it were not, page one would work and page
 * two would 422 with "this cursor belongs to another collection" — the paging
 * bug that is hardest to notice, because every test that fetches a single page
 * passes.
 */
export const AUDIT_RESOURCE = 'audit';

/**
 * The filters this route accepts beyond the pagination pair.
 *
 * `client_id` is deliberately NOT here. See the route header: accepting it would
 * make the endpoint an oracle over every other developer's traffic.
 */
export const AUDIT_FILTER_PARAMS = ['status', 'route', 'from', 'to'] as const;

export const auditCallSchema = z
  .object({
    id: z.string().uuid(),
    /**
     * L07's per-request id, carried on the `ApiError` body and the response
     * header. This is what ties a row to a specific call a developer is looking
     * at — the reason a support conversation can start from a request id.
     */
    request_id: z.string(),
    /**
     * PRD p.4's "app client_id". Never null on this route: the endpoint requires
     * a token, and the rows it returns are filtered to the token's own app. The
     * COLUMN is nullable — an unauthenticated call records `null` — but such a
     * row can never match this filter.
     */
    client_id: z.string(),
    /** PRD p.4's "user_id". Null for machine-to-machine tokens, which have no consenting user. */
    user_id: z.string().nullable(),
    method: z.string(),
    /**
     * PRD p.4's "route". The route TEMPLATE (`/api/v1/documents/:id`), not the
     * concrete path — so it is a groupable dimension rather than a
     * high-cardinality string, and `?route=` is a real filter.
     */
    route: z.string(),
    /**
     * PRD p.4's "scope used". Null on a route that declares `scope: null` — which
     * includes this one — and on a call that never got far enough to need one.
     */
    scope_used: z.string().nullable(),
    /** PRD p.4's "status". The HTTP status actually sent. */
    status: z.number().int(),
    /** PRD p.4's "latency". Milliseconds, server-side. */
    latency_ms: z.number().int(),
    /** PRD p.4's "timestamp". ISO 8601, and the column the keyset orders by. */
    occurred_at: z.string(),
  })
  .strict();

export type AuditCallBody = z.infer<typeof auditCallSchema>;

/**
 * The query schema, for the generated spec.
 *
 * Every parameter is optional and every one is validated in the handler rather
 * than only described here — a spec that documents a constraint the handler does
 * not enforce is worse than one that documents nothing, because an SDK author
 * trusts it.
 */
export const auditQuerySchema = z.object({
  status: z.coerce
    .number()
    .int()
    .optional()
    .describe('Exact HTTP status match. `429` answers "when was I throttled".'),
  route: z
    .string()
    .optional()
    .describe('Exact route TEMPLATE match, e.g. `/api/v1/documents/:id`.'),
  from: z
    .string()
    .optional()
    .describe('Inclusive lower bound on `occurred_at`, ISO 8601.'),
  to: z
    .string()
    .optional()
    .describe('Exclusive upper bound on `occurred_at`, ISO 8601.'),
});
