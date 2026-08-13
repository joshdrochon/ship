/**
 * `GET /api/v1/webhooks/deliveries` — the portal's only data source.
 *
 * Tickets: PF-464 (cursor-paginated, scope-gated, filterable), PF-472 (key
 * usage on every row), PF-478 (a foreign id is `not_found`).
 *
 * PRD p.4, Dead-Letter Queue: *"After 6 failed attempts, deliveries land in a
 * DLQ visible in the developer portal."* `?status=dead_lettered` is what makes
 * that checkable at the API layer before L22 renders a single pixel — **L22
 * consumes this endpoint and adds no privileged internal route.**
 *
 * ## Mount order is load-bearing, and it is a real hazard
 *
 * `/webhooks/deliveries` must be mounted BEFORE `/webhooks/:id`. Express matches
 * in registration order, so with the reverse order a request for the delivery
 * list matches the subscription-by-id route with `id = 'deliveries'`, and the
 * caller gets `validation_failed` complaining that `deliveries` is not a UUID —
 * an error that names the wrong thing entirely and sends the reader looking at
 * their cursor. `deliveries.routes.test.ts` asserts the shadowing does not
 * happen, because the failure mode is invisible in a route table.
 *
 * ## No SQL, and no publish
 *
 * Lane-wide fitness rules over `platform/api/v1/**`. Every read goes through
 * `IDeliveryLog`; nothing here calls `.publish(`.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../errors.js';
import { parsePageRequest, pageSchema } from '../page.js';
import { sliceToPage } from '../pagination.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import {
  DELIVERY_STATUSES,
  type DeliveryRecord,
  type DeliveryStatus,
  type IDeliveryLog,
  type KeyUsage,
} from '../../../webhooks/deliveryLog.js';
import { EVENT_TYPES } from '../../../webhooks/events.js';
import { WEBHOOKS_SCOPE } from './webhooks.schema.js';
import {
  DELIVERIES_RESOURCE,
  DELIVERY_FILTER_PARAMS,
  deliverySchema,
  deliveryQuerySchema,
  keyUsageSchema,
  type DeliveryBody,
} from './deliveries.schema.js';

export interface DeliveriesRouteDeps {
  log: IDeliveryLog;
}

/**
 * The list row: the delivery, plus PF-472's key usage.
 *
 * `.extend()` on the resource schema rather than a hand-written second object,
 * so a field added to a delivery appears here for free and the two cannot drift.
 */
const deliveryListItemSchema = deliverySchema.extend({ key_usage: keyUsageSchema }).strict();

const listGuard = declareV1Route({
  method: 'get',
  path: '/webhooks/deliveries',
  scope: WEBHOOKS_SCOPE,
  // PF-227's rule: a collection backed by a database table paginates by cursor.
  // This is the highest-cardinality collection in the public surface — six rows
  // per failing delivery times every event — so `'none'` would be a false claim.
  list: 'cursor',
  resource: DELIVERIES_RESOURCE,
  query: deliveryQuerySchema,
  response: pageSchema(deliveryListItemSchema),
  summary: 'List webhook delivery attempts for this app, newest first.',
  description:
    'One row per ATTEMPT, not per delivery: a delivery that failed six times has six ' +
    'rows sharing a `delivery_group_id` and one `idempotency_key`. ' +
    '`?status=dead_lettered` is the dead-letter queue. `key_usage` reports how many ' +
    'times we sent that idempotency key and how those attempts ended — it cannot ' +
    'report whether the subscriber deduped, which needs the subscriber\'s own signal.',
});

const getGuard = declareV1Route({
  method: 'get',
  path: '/webhooks/deliveries/:id',
  scope: WEBHOOKS_SCOPE,
  list: false,
  response: deliveryListItemSchema,
  summary: 'Fetch one delivery attempt by id.',
});

/** Every declared method, as data — the fitness test iterates this, not a copy. */
export const DELIVERY_ROUTES = [
  { method: 'get', path: '/webhooks/deliveries' },
  { method: 'get', path: '/webhooks/deliveries/:id' },
] as const;

function validationFailed(fields: { field: string; message: string }[]): ApiError {
  return new ApiError('validation_failed', 'The request is not valid.', {
    details: { fields },
  });
}

/**
 * PF-478 — one `not_found`, and NO `details`.
 *
 * A delivery id belonging to another app returns this, not `forbidden`. A 403
 * confirms the id EXISTS, which turns the endpoint into an enumeration oracle
 * over every other developer's delivery ids. The scope check still runs FIRST,
 * so a caller without `webhooks:manage` gets 403 for its own deliveries — the
 * two are not interchangeable.
 */
function notFound(): ApiError {
  return new ApiError('not_found', 'No webhook delivery with that id.');
}

function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** The acting app, from the TOKEN and nothing else. */
function callerAppId(res: Response): string {
  const auth = getPlatformAuth(res);
  if (!auth) {
    throw new ApiError('unauthorized', 'This endpoint requires an access token.');
  }
  return auth.appId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates the three filters HERE, so a bad value is a 422 naming the field
 * rather than an empty page.
 *
 * An unknown `?status=retrying` returning zero rows is the worst answer: it
 * looks like "no deliveries are retrying" and it is actually "that is not a
 * status". Same reasoning as L08's PF-225 rejecting an out-of-range `limit`
 * rather than clamping it.
 */
export function parseDeliveryFilters(query: Record<string, unknown>): {
  status?: DeliveryStatus;
  subscription_id?: string;
  event_type?: string;
} {
  const fields: { field: string; message: string }[] = [];
  const out: { status?: DeliveryStatus; subscription_id?: string; event_type?: string } = {};

  const status = query.status;
  if (status !== undefined) {
    if (typeof status !== 'string' || !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
      fields.push({
        field: 'status',
        message: `Expected one of: ${DELIVERY_STATUSES.join(', ')}.`,
      });
    } else {
      out.status = status as DeliveryStatus;
    }
  }

  const subscriptionId = query.subscription_id;
  if (subscriptionId !== undefined) {
    if (typeof subscriptionId !== 'string' || !UUID.test(subscriptionId)) {
      fields.push({ field: 'subscription_id', message: 'Expected a UUID.' });
    } else {
      out.subscription_id = subscriptionId;
    }
  }

  const eventType = query.event_type;
  if (eventType !== undefined) {
    if (typeof eventType !== 'string' || !(EVENT_TYPES as readonly string[]).includes(eventType)) {
      fields.push({
        field: 'event_type',
        message: `Expected one of: ${EVENT_TYPES.join(', ')}.`,
      });
    } else {
      out.event_type = eventType;
    }
  }

  if (fields.length > 0) throw validationFailed(fields);
  return out;
}

/** Domain row → the public body. Field by field, so a new column cannot arrive by accident. */
function toBody(row: DeliveryRecord, usage: KeyUsage): DeliveryBody & { key_usage: KeyUsage } {
  return {
    id: row.id,
    delivery_group_id: row.delivery_group_id,
    subscription_id: row.subscription_id,
    event_id: row.event_id,
    event_type: row.event_type,
    attempt_number: row.attempt_number,
    status: row.status,
    response_status: row.response_status,
    response_excerpt: row.response_excerpt,
    latency_ms: row.latency_ms,
    idempotency_key: row.idempotency_key,
    dlq_reason: row.dlq_reason,
    attempted_at: row.attempted_at,
    created_at: row.created_at,
    signature_header: row.signature_header,
    replay_of_delivery_id: row.replay_of_delivery_id,
    key_usage: usage,
  };
}

export function mountDeliveries(router: Router, deps: DeliveriesRouteDeps): void {
  const log = deps.log;

  // ── GET /api/v1/webhooks/deliveries ──────────────────────────────────────
  //
  // Mounted BEFORE `/webhooks/:id` (see the header). `mountWebhookResources`
  // enforces the order; this comment is here so a future reader who moves this
  // block knows what breaks.
  router.get(
    '/webhooks/deliveries',
    listGuard,
    handler(async (req, res) => {
      const query = req.query as Record<string, unknown>;
      // The allowlist runs first, so `?offset=10` is told about the offset
      // rather than about an unknown status.
      const page = parsePageRequest(query, DELIVERIES_RESOURCE, DELIVERY_FILTER_PARAMS);
      const filters = parseDeliveryFilters(query);

      // `limit + 1` — one extra row answers "is there more?" without a second
      // COUNT(*), which would double the query load on every page and be racy.
      const rows = await log.listByApp({
        app_id: callerAppId(res),
        limit: page.limit + 1,
        cursor: page.cursor ? { timestamp: page.cursor.timestamp, id: page.cursor.id } : null,
        ...filters,
      });

      const sliced = sliceToPage(rows, page.limit, DELIVERIES_RESOURCE);
      // ONE aggregate query for the whole page, not one per row (PF-472).
      const usage = await log.keyUsageMany(
        callerAppId(res),
        sliced.data.map((r) => r.idempotency_key),
      );

      res.json({
        data: sliced.data.map((row) =>
          toBody(row, usage.get(row.idempotency_key) ?? emptyUsage(row.idempotency_key)),
        ),
        // Present and NULL on the last page, never absent (PF-224).
        next_cursor: sliced.next_cursor,
      });
    }),
  );

  // ── GET /api/v1/webhooks/deliveries/:id ──────────────────────────────────
  router.get(
    '/webhooks/deliveries/:id',
    getGuard,
    handler(async (req, res) => {
      const appId = callerAppId(res);
      const id = deliveryId(req);
      const row = await log.getById(appId, id);
      if (!row) throw notFound();
      const usage = await log.keyUsage(appId, row.idempotency_key);
      res.json(toBody(row, usage));
    }),
  );
}

/** Validates `:id` HERE, so a non-UUID is a 422 and never a Postgres error. */
export function deliveryId(req: Request): string {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw validationFailed([
      {
        field: 'id',
        message:
          'Expected a UUID. A malformed id is a validation failure rather than a ' +
          'database error surfacing as `server_error`.',
      },
    ]);
  }
  return raw;
}

/** A key we have never sent. Zero attempts, no terminal statuses — not absent. */
function emptyUsage(idempotencyKey: string): KeyUsage {
  return { idempotency_key: idempotencyKey, attempt_count: 0, terminal_statuses: [] };
}
