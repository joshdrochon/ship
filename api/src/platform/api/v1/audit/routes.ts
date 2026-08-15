/**
 * `GET /api/v1/audit` — the public audit trail, over the public API.
 *
 * PRD p.4, Public Audit Trail: *"Every public API call recorded with timestamp,
 * app client_id, user_id, route, scope used, status, latency. **Queryable in the
 * developer portal.**"*
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS MISSING, AND WHAT WAS NOT
 * ---------------------------------------------------------------------------
 * The recording half shipped whole (L12: `audit.ts`, migration 057) and so did
 * the query half (`listCalls`, PF-343). What neither lane owned was a surface a
 * BROWSER could reach. `GET /api/apps/:id/calls` (F111) later closed that on the
 * SESSION surface, and it is still there and still correct for an operator
 * looking across the apps they own.
 *
 * This route is the other principal, and it is the one p.10 asks for:
 *
 *   > *"the portal reuses the public API like any other client (eat the dog
 *   > food)"*
 *
 * The portal already works this way for the delivery log — it mints a
 * short-lived per-app token at `/api/apps/:id/portal-token` (L22, the ONE
 * privileged escape hatch) and then reads `/api/v1/webhooks/deliveries` through
 * `@ship/sdk`. The audit trail was the one portal surface with no `/api/v1`
 * equivalent, so rendering it would have meant a second internal data route —
 * exactly what `portalSurfaceFitness.test.ts` exists to prevent.
 *
 * `listCalls` was built for this. Its header says the portal renders
 * `{data, next_cursor}` "exactly as it would for any other public collection,
 * using the same opaque base64url cursor the rest of `/api/v1` uses". This route
 * is that sentence made reachable.
 *
 * ---------------------------------------------------------------------------
 * WHY `scope: null`, AND WHY THAT IS NOT A LOOPHOLE
 * ---------------------------------------------------------------------------
 * PRD p.3 registers exactly seven scopes and PF-062 asserts exactly seven. None
 * of them names "read your own call history", and the two ways to force one are
 * both worse than declaring `null`:
 *
 *   * **Invent `audit:read`.** That is an eighth scope. It breaks PF-062's
 *     assertion in four test files, and p.3's list is not ours to extend for our
 *     own convenience — the seven names come from the PRD.
 *   * **Reuse `webhooks:manage`.** Semantically false, and a real privilege
 *     escalation: an app granted the ability to manage webhook subscriptions
 *     would silently also be able to read the complete call log. A scope that
 *     grants something its name does not say is worse than no scope.
 *
 * `GET /api/v1/me` settled this exact question first (PF-271) and the reasoning
 * transfers intact: a token can always discover facts about ITSELF. `/me`
 * returns the identity behind the token; this returns what that identity did.
 * Neither is a workspace resource, and no scope grant could sensibly widen or
 * narrow either — the token already fully determines the answer.
 *
 * `declareV1Route` requires the `scope` key to be PRESENT, so `null` here is a
 * claim the author makes and not an omission; `assertEveryRouteDeclaresScope`
 * tells a declared null from a forgotten declaration by design.
 *
 * A caller with a token holding NO scopes at all can therefore read its own
 * trail. That is intended, and it is the same posture as `/me`: an app that has
 * been granted nothing can still see that it was granted nothing, and can still
 * see its own 403s — which is precisely the trail a developer debugging a scope
 * problem needs most.
 *
 * ---------------------------------------------------------------------------
 * THE TENANCY RULE, WHICH IS THE WHOLE SECURITY OF THIS ROUTE
 * ---------------------------------------------------------------------------
 * `client_id` comes from `getPlatformAuth(res).clientId` and from NOWHERE else.
 * It is not readable from the query string, the body or a header, and
 * `AUDIT_FILTER_PARAMS` deliberately omits it so that `?client_id=` is a 422
 * naming the parameter rather than a filter that silently works.
 *
 * This is not defensive coding. `client_id` values are PUBLISHED — they appear
 * in READMEs, in the portal, in `GET /api/apps` — so an endpoint that filtered
 * by a caller-supplied `client_id` would let anyone read any app's complete API
 * history by pasting an identifier that was never meant to be secret. That
 * history includes which routes an app calls, when, and with what scopes: a
 * competitive-intelligence feed and a reconnaissance tool in one.
 *
 * `audit.tenancy.test.ts` drives the attempt from a second app and asserts the
 * parameter is rejected rather than honoured.
 *
 * ---------------------------------------------------------------------------
 * THE SELF-REFERENCE, STATED RATHER THAN HIDDEN
 * ---------------------------------------------------------------------------
 * Reading the audit trail is itself a public API call, so it is itself recorded.
 * That is honest — a call happened, and a trail that omitted reads of itself
 * would be a trail with a blind spot exactly where an intruder would look — but
 * it does mean a portal tab left open on a polling refresh writes a row per
 * poll. The portal therefore loads on demand rather than polling, and this note
 * is here so that a future author adding a refresh interval knows what it costs.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../errors.js';
import { parsePageRequest, pageSchema } from '../page.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import type { Database } from '../../../../db/client.js';
import { listCalls, type PublicApiCallRow } from '../../../audit/pgAuditSink.js';
import {
  AUDIT_RESOURCE,
  AUDIT_FILTER_PARAMS,
  auditCallSchema,
  auditQuerySchema,
  type AuditCallBody,
} from './audit.schema.js';

export interface AuditRouteDeps {
  db: Database;
}

/** The declaration, made ONCE at module load. See `declareV1Route`'s header. */
const listGuard = declareV1Route({
  method: 'get',
  path: '/audit',
  // See the header. The token fully determines the answer; no scope could narrow
  // or widen it, and `/me` (PF-271) is the precedent.
  scope: null,
  // PF-227's rule: a collection backed by a database table paginates by cursor.
  // This is the highest-cardinality table in the system — one row per public API
  // call ever made — so `'none'` would be a false claim.
  list: 'cursor',
  resource: AUDIT_RESOURCE,
  query: auditQuerySchema,
  response: pageSchema(auditCallSchema),
  summary: 'List this app\'s public API calls, newest first.',
  description:
    'The audit trail for the app the presented token was issued to — every call it has ' +
    'made to /api/v1, with timestamp, route template, scope used, status and latency. ' +
    'Scoped to the caller by construction: there is no `client_id` parameter, and the ' +
    'filter is taken from the token, so an app can only ever read its own history. ' +
    'Requires no scope, for the same reason /api/v1/me requires none — a token can ' +
    'always discover what it itself did. Reading this endpoint is itself a recorded ' +
    'call, so it appears in the next page you fetch.',
});

function validationFailed(fields: { field: string; message: string }[]): ApiError {
  return new ApiError('validation_failed', 'The request is not valid.', {
    details: { fields },
  });
}

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** The acting app's `client_id`, from the TOKEN and nothing else. */
function callerClientId(res: Response): string {
  const auth = getPlatformAuth(res);
  if (!auth) {
    // Unreachable behind bearer auth, which 401s on a missing context. A throw
    // rather than a `!` so that a future reorder of the middleware stack fails
    // loudly instead of running this query with an undefined filter — which on
    // THIS route would return every app's rows.
    throw new ApiError('unauthorized', 'This endpoint requires an access token.');
  }
  return auth.clientId;
}

/**
 * Validates the four filters HERE, so a bad value is a 422 naming the field
 * rather than an empty page.
 *
 * An unparseable `?from=last-tuesday` returning zero rows is the worst answer:
 * it reads as "you made no calls" and it actually means "that is not a date".
 * Same reasoning as L08's PF-225 rejecting an out-of-range `limit` rather than
 * clamping it, and as F111's date handling on the session route.
 */
export function parseAuditFilters(query: Record<string, unknown>): {
  status?: number;
  route?: string;
  from?: Date;
  to?: Date;
} {
  const fields: { field: string; message: string }[] = [];
  const out: { status?: number; route?: string; from?: Date; to?: Date } = {};

  const status = query.status;
  if (status !== undefined) {
    const parsed = Number.parseInt(String(status), 10);
    // The upper bound matters: `?status=200000` is a typo, not a status, and
    // answering with an empty page hides the typo.
    if (!Number.isFinite(parsed) || parsed < 100 || parsed > 599) {
      fields.push({ field: 'status', message: 'Expected an HTTP status code between 100 and 599.' });
    } else {
      out.status = parsed;
    }
  }

  const route = query.route;
  if (route !== undefined) {
    if (typeof route !== 'string' || route.length === 0) {
      fields.push({ field: 'route', message: 'Expected a route template, e.g. `/api/v1/documents`.' });
    } else {
      out.route = route;
    }
  }

  for (const name of ['from', 'to'] as const) {
    const raw = query[name];
    if (raw === undefined) continue;
    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) {
      fields.push({ field: name, message: 'Expected an ISO 8601 timestamp.' });
    } else {
      out[name] = parsed;
    }
  }

  if (fields.length > 0) throw validationFailed(fields);
  return out;
}

/**
 * Row → public body, field by field.
 *
 * Never a spread of the row: `listCalls` selects a fixed column list today, but
 * a column added to `public_api_calls` tomorrow would ride a spread straight
 * onto the public contract without anyone deciding to publish it. `.strict()`
 * on the schema would then 500 the route — which is the safe failure, but the
 * explicit mapping means the question never arises.
 */
function toBody(row: PublicApiCallRow): AuditCallBody {
  return {
    id: row.id,
    request_id: row.request_id,
    // Non-null by construction: the filter is the caller's own client_id, so a
    // row with a null client_id cannot match. The fallback keeps the response
    // contract satisfiable rather than throwing on an impossible row.
    client_id: row.client_id ?? '',
    user_id: row.user_id,
    method: row.method,
    route: row.route,
    scope_used: row.scope_used,
    status: row.status,
    latency_ms: row.latency_ms,
    occurred_at:
      row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  };
}

export function mountAudit(router: Router, deps: AuditRouteDeps): void {
  router.get(
    '/audit',
    listGuard,
    handler(async (req, res) => {
      const query = req.query as Record<string, unknown>;
      // The allowlist runs FIRST, so `?client_id=...` is told that the parameter
      // is not accepted rather than being silently ignored — the difference
      // between a caller learning the endpoint is self-scoped and a caller
      // believing they successfully read someone else's trail.
      const page = parsePageRequest(query, AUDIT_RESOURCE, AUDIT_FILTER_PARAMS);
      const filters = parseAuditFilters(query);

      const result = await listCalls(deps.db, {
        // From the token. Not from `query`, not from the body, not from a header.
        clientId: callerClientId(res),
        limit: page.limit,
        // `parsePageRequest` has already DECODED and validated this — including
        // that the cursor was minted for THIS resource (PF-218), so a cursor
        // from `/webhooks/deliveries` is rejected here rather than silently
        // walking the wrong table. `listCalls` takes the opaque string and
        // decodes it again; the redundant decode is deliberate, because the
        // alternative is widening `listCalls`'s signature to accept a decoded
        // payload and losing the validation for its other caller.
        cursor: page.cursor ? String(req.query.cursor) : null,
        // Bind minted cursors to THIS route's collection name, so the cursor
        // this response hands back is one this same route will accept.
        resource: AUDIT_RESOURCE,
        ...filters,
      });

      res.json({
        data: result.data.map(toBody),
        // Present and NULL on the last page, never absent (PF-224).
        next_cursor: result.next_cursor,
      });
    }),
  );
}

/** The `mountResources` callback the composition root composes. */
export function auditResources(deps: { db: Database }): (router: Router) => void {
  return (router: Router) => mountAudit(router, { db: deps.db });
}
