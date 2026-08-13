/**
 * `/api/v1/webhooks` — six methods, one scope.
 *
 * Tickets: PF-428 (every method declares `webhooks:manage`), PF-429 (create),
 * PF-430 (cursor-paginated list, app-scoped), PF-431 (get/patch/delete),
 * PF-432 (a foreign id is `not_found`), PF-433 (rotate).
 *
 * PRD p.3, Webhook Subscriptions: *"Manageable via /api/v1/webhooks (gated by
 * webhooks:manage scope)."*
 *
 * ## No method is cheaper than another (PF-428)
 *
 * All six require `webhooks:manage`, including the two reads. **Read is not
 * exempt**, and that is a decision rather than an oversight: the subscription
 * list names an app's target URLs, which is reconnaissance — it tells a caller
 * which internal hostnames an integration talks to and which events it cares
 * about. There is no `webhooks:read`, because p.3 registers exactly seven scopes
 * and PF-062 asserts exactly seven; inventing an eighth to soften a read would
 * break the assertion MVP gate item 6 rests on.
 *
 * ## The app comes from the token, never from the body
 *
 * Every handler reads `appId` and `workspaceId` off `res.locals.platformAuth`.
 * The create schema is `.strict()` so a body carrying `app_id` is a 422 rather
 * than an override, and every single-row repository method takes the app id as a
 * PARAMETER — so a subscription belonging to another app cannot be returned,
 * patched, deleted or rotated even by a handler that forgot to check. PF-432 is
 * structural, not vigilant.
 *
 * ## No SQL, and no publish
 *
 * Both are lane-wide fitness rules over `platform/api/v1/**` and this file obeys
 * them for the same reasons L09's does: every read and write goes through
 * `IWebhookSubscriptionRepo`, and nothing here calls `.publish(`. The bus
 * subscription that turns an event into a signed request is S4's, and it lives
 * in `platform/webhooks/`, not on a route.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { z } from 'zod';
import { ApiError } from '../errors.js';
import { parsePageRequest, pageSchema } from '../page.js';
import { sliceToPage } from '../pagination.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import {
  assertEventType,
  UnknownEventTypeError,
  type EventType,
} from '../../../webhooks/events.js';
import {
  DuplicateSubscriptionError,
  type IWebhookSubscriptionRepo,
  type WebhookSubscription,
} from '../../../webhooks/subscriptions.js';
import type { IDeliveryLog } from '../../../webhooks/deliveryLog.js';
import { mountDeliveries } from './deliveries.routes.js';
import {
  WEBHOOKS_RESOURCE,
  WEBHOOKS_SCOPE,
  createWebhookRequestSchema,
  patchWebhookRequestSchema,
  webhookIdParamSchema,
  webhookSubscriptionSchema,
  webhookSubscriptionWithSecretSchema,
  IMMUTABLE_SUBSCRIPTION_FIELDS,
  type WebhookSubscriptionBody,
} from './webhooks.schema.js';

export interface WebhooksRouteDeps {
  repo: IWebhookSubscriptionRepo;
}

// ─────────────────────────────────────────────────────────────────────────────
// The six declarations, made ONCE at module load.
//
// Same discipline as L09's documents and L10's `/me`: `routeMetadata.declare()`
// throws on a duplicate key and a test suite builds many apps, so the records
// are created when this module is first imported and `mountWebhooks` only
// mounts. The guards are shared across mounts; they close over nothing
// per-request.
// ─────────────────────────────────────────────────────────────────────────────

const createGuard = declareV1Route({
  method: 'post',
  path: '/webhooks',
  scope: WEBHOOKS_SCOPE,
  list: false,
  request: createWebhookRequestSchema,
  response: webhookSubscriptionWithSecretSchema,
  summary: 'Subscribe to one event type. Returns the signing secret exactly once.',
  description:
    'Creates a subscription bound to the calling token\'s app. The `signing_secret` in ' +
    'the response is the only time it is ever returned — capture it here or rotate. ' +
    '`target_url` must be an absolute `https` URL that does not resolve into private ' +
    'address space.',
});

const listGuard = declareV1Route({
  method: 'get',
  path: '/webhooks',
  scope: WEBHOOKS_SCOPE,
  // PF-227's rule: a collection backed by a database table paginates by cursor.
  // This is not a fixed-cardinality registry — an app may hold arbitrarily many
  // subscriptions — so `'none'` would be a false claim about the data.
  list: 'cursor',
  resource: WEBHOOKS_RESOURCE,
  response: pageSchema(webhookSubscriptionSchema),
  summary: 'List this app\'s webhook subscriptions, newest first.',
});

const getGuard = declareV1Route({
  method: 'get',
  path: '/webhooks/:id',
  scope: WEBHOOKS_SCOPE,
  list: false,
  params: webhookIdParamSchema,
  response: webhookSubscriptionSchema,
  summary: 'Fetch one subscription by id.',
});

const patchGuard = declareV1Route({
  method: 'patch',
  path: '/webhooks/:id',
  scope: WEBHOOKS_SCOPE,
  list: false,
  params: webhookIdParamSchema,
  request: patchWebhookRequestSchema,
  response: webhookSubscriptionSchema,
  summary: 'Activate or deactivate a subscription. `active` is the only mutable field.',
});

const deleteGuard = declareV1Route({
  method: 'delete',
  path: '/webhooks/:id',
  scope: WEBHOOKS_SCOPE,
  list: false,
  params: webhookIdParamSchema,
  response: webhookSubscriptionSchema,
  status: 200,
  summary: 'Deactivate a subscription. Idempotent; the row is retained.',
  description:
    'Sets `active` to false and stamps `deactivated_at`. The row is NOT removed, so the ' +
    'delivery log keeps a resolvable `subscription_id` after a subscriber walks away. ' +
    'Calling it twice returns the same 200 and the same `deactivated_at`.',
});

const rotateGuard = declareV1Route({
  method: 'post',
  path: '/webhooks/:id/rotate',
  scope: WEBHOOKS_SCOPE,
  list: false,
  params: webhookIdParamSchema,
  response: webhookSubscriptionWithSecretSchema,
  status: 200,
  summary: 'Mint a new signing secret. The previous one stops verifying immediately.',
  description:
    'Returns the new `signing_secret` exactly once and increments `secret_version`. ' +
    'There is no grace period: the previous secret verifies nothing from the moment ' +
    'this returns, and the retry ladder is what covers the window while a subscriber ' +
    'updates its environment.',
});

/** Every declared method, as data — PF-428's test iterates this rather than a copy. */
export const WEBHOOK_ROUTES = [
  { method: 'post', path: '/webhooks' },
  { method: 'get', path: '/webhooks' },
  { method: 'get', path: '/webhooks/:id' },
  { method: 'patch', path: '/webhooks/:id' },
  { method: 'delete', path: '/webhooks/:id' },
  { method: 'post', path: '/webhooks/:id/rotate' },
] as const;

export { WEBHOOKS_SCOPE };

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

function validationFailed(fields: { field: string; message: string }[]): ApiError {
  return new ApiError('validation_failed', 'The request is not valid.', {
    details: { fields },
  });
}

/**
 * A `ZodError` becomes `details.fields[]`, per L07's PF-198 policy.
 *
 * `unrecognized_keys` is special-cased because its `path` is EMPTY — Zod points
 * at the object and lists the keys in `issue.keys`. Mapping it naively yields
 * `field: ''` for every rejected key, which is exactly the caller that needs
 * telling *which* field they sent.
 *
 * The immutable fields get their own sentence. "There is no such field" and
 * "you may not change that field" are different facts, and a caller PATCHing
 * `target_url` needs the second one.
 */
function zodFields(error: z.ZodError): { field: string; message: string }[] {
  const fields: { field: string; message: string }[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        fields.push({
          field: key,
          message: (IMMUTABLE_SUBSCRIPTION_FIELDS as readonly string[]).includes(key)
            ? `\`${key}\` is immutable. Changing a subscription's target in place would ` +
              `silently redirect an existing signing secret to a new host, so a new target ` +
              `is DELETE followed by POST — which mints a new secret.`
            : `Unknown field. It is not part of this request; \`app_id\` and ` +
              `\`workspace_id\` in particular come from the access token and are rejected ` +
              `rather than ignored, so a caller is never left believing they set one.`,
        });
      }
      continue;
    }
    fields.push({
      field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
      message: issue.message,
    });
  }
  return fields;
}

/**
 * PF-432 — one `not_found`, and NO `details`.
 *
 * Four ways to arrive: a well-formed UUID matching no row, a UUID belonging to
 * ANOTHER app, and the same two on the rotate path. The second must not be 403.
 * A 403 confirms the id EXISTS, which turns every one of these endpoints into an
 * existence oracle over UUIDs — a caller iterating ids learns which ones are
 * real subscriptions in apps they cannot read. `CODES_WITHOUT_DETAILS` in
 * `errors.ts` already lists `not_found`; anything in `details` here would be the
 * same leak arriving by another door.
 */
function notFound(): ApiError {
  return new ApiError('not_found', 'No webhook subscription with that id.');
}

/** Wraps an async handler so a rejection reaches `apiErrorMiddleware`. */
function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

interface CallerApp {
  appId: string;
  workspaceId: string;
  userId: string | null;
}

/** The acting app, from the TOKEN and nothing else. */
function caller(res: Response): CallerApp {
  const auth = getPlatformAuth(res);
  if (!auth) {
    // Unreachable behind the guards, which 401 on a missing context. Kept as a
    // throw rather than a `!` so a future reorder of the middleware stack fails
    // loudly instead of writing a subscription with `undefined` as the app.
    throw new ApiError('unauthorized', 'This endpoint requires an access token.');
  }
  return { appId: auth.appId, workspaceId: auth.workspaceId, userId: auth.userId };
}

/** Validates `:id` HERE, so a non-UUID is a 422 and never a Postgres error. */
function subscriptionId(req: Request): string {
  const parsed = webhookIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw validationFailed([
      {
        field: 'id',
        message:
          'Expected a UUID. A malformed id is a validation failure rather than a ' +
          'database error surfacing as `server_error`.',
      },
    ]);
  }
  return parsed.data.id;
}

/** Domain row → the public body. Field by field, so a new column cannot arrive by accident. */
function toBody(row: WebhookSubscription): WebhookSubscriptionBody {
  return {
    id: row.id,
    event: row.event,
    target_url: row.target_url,
    active: row.active,
    secret_prefix: row.secret_prefix,
    secret_version: row.secret_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deactivated_at: row.deactivated_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export function mountWebhooks(router: Router, deps: WebhooksRouteDeps): void {
  const repo = deps.repo;

  // ── POST /api/v1/webhooks ────────────────────────────────────────────────
  router.post(
    '/webhooks',
    createGuard,
    handler(async (req, res) => {
      const parsed = createWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) throw validationFailed(zodFields(parsed.error));

      // PF-429 — `assertEventType` rather than a hand-written list. The Zod
      // enum above already narrows the type; this is the SECOND check on
      // purpose, and it is the one that survives: the day a ninth event type is
      // registered, the enum is derived from `EVENT_TYPES` and this call reads
      // the same registry, so neither is a copy anybody has to remember.
      try {
        assertEventType(parsed.data.event);
      } catch (err) {
        if (err instanceof UnknownEventTypeError) {
          throw validationFailed([{ field: 'event', message: err.message }]);
        }
        throw err;
      }

      const who = caller(res);
      let created;
      try {
        created = await repo.create({
          // Bound to the CALLING token's app. A body carrying `app_id` was
          // already a 422 above; this is where it would have been honoured.
          app_id: who.appId,
          workspace_id: who.workspaceId,
          user_id: who.userId,
          event: parsed.data.event as EventType,
          target_url: parsed.data.target_url,
        });
      } catch (err) {
        if (err instanceof DuplicateSubscriptionError) {
          throw validationFailed([{ field: 'target_url', message: err.message }]);
        }
        throw err;
      }

      res
        .status(201)
        .location(`/api/v1/webhooks/${created.subscription.id}`)
        .json({ ...toBody(created.subscription), signing_secret: created.signing_secret });
    }),
  );

  // ── GET /api/v1/webhooks ─────────────────────────────────────────────────
  router.get(
    '/webhooks',
    listGuard,
    handler(async (req, res) => {
      const page = parsePageRequest(req.query as Record<string, unknown>, WEBHOOKS_RESOURCE);
      const who = caller(res);

      // `limit + 1` — one extra row answers "is there more?" without a second
      // COUNT(*), which would double the query load on every page and be racy.
      const rows = await repo.listByApp({
        app_id: who.appId,
        limit: page.limit + 1,
        cursor: page.cursor ? { timestamp: page.cursor.timestamp, id: page.cursor.id } : null,
      });

      const sliced = sliceToPage(rows, page.limit, WEBHOOKS_RESOURCE);
      res.json({
        data: sliced.data.map(toBody),
        // Present and NULL on the last page, never absent (PF-224).
        next_cursor: sliced.next_cursor,
      });
    }),
  );

  // ── GET /api/v1/webhooks/:id ─────────────────────────────────────────────
  router.get(
    '/webhooks/:id',
    getGuard,
    handler(async (req, res) => {
      const row = await repo.getById(caller(res).appId, subscriptionId(req));
      if (!row) throw notFound();
      res.json(toBody(row));
    }),
  );

  // ── PATCH /api/v1/webhooks/:id ───────────────────────────────────────────
  router.patch(
    '/webhooks/:id',
    patchGuard,
    handler(async (req, res) => {
      const id = subscriptionId(req);
      const parsed = patchWebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) throw validationFailed(zodFields(parsed.error));

      const row = await repo.setActive(caller(res).appId, id, parsed.data.active);
      if (!row) throw notFound();
      res.json(toBody(row));
    }),
  );

  // ── DELETE /api/v1/webhooks/:id ──────────────────────────────────────────
  router.delete(
    '/webhooks/:id',
    deleteGuard,
    handler(async (req, res) => {
      // PF-431 — idempotent. The repository's `setActive` is a no-op UPDATE when
      // the row is already inactive and answers from a SELECT instead, so the
      // second call returns the same 200 and the same `deactivated_at`. A 404 on
      // the second call would be wrong: the resource is still there, which is
      // the whole point of deactivating rather than deleting.
      const row = await repo.deactivate(caller(res).appId, subscriptionId(req));
      if (!row) throw notFound();
      res.json(toBody(row));
    }),
  );

  // ── POST /api/v1/webhooks/:id/rotate ─────────────────────────────────────
  router.post(
    '/webhooks/:id/rotate',
    rotateGuard,
    handler(async (req, res) => {
      const rotated = await repo.rotateSecret(caller(res).appId, subscriptionId(req));
      // PF-432's fourth verb. A foreign id is 404 here too — a 403 would confirm
      // the subscription exists, and this is the verb where that matters most,
      // because it also proves the caller could not rotate it.
      if (!rotated) throw notFound();
      res.json({ ...toBody(rotated.subscription), signing_secret: rotated.signing_secret });
    }),
  );
}

/**
 * The `mountResources` callback the composition root composes.
 *
 * Takes the repository and the delivery log rather than the db, so the
 * composition root stays the only place a concrete is chosen
 * (PF-014/PF-015/PF-427/PF-458).
 *
 * ## The mount order is load-bearing (L16 PF-464)
 *
 * `mountDeliveries` runs FIRST, and that is not a style choice. Express matches
 * in registration order, so `/webhooks/:id` registered before
 * `/webhooks/deliveries` swallows the delivery list: the request matches the
 * subscription route with `id = 'deliveries'`, and the caller gets a
 * `validation_failed` saying `deliveries` is not a UUID — an error that names
 * the wrong thing entirely.
 *
 * The order is here, in one function, rather than left to whoever calls the two
 * mounts, so there is no way to compose them wrongly.
 * `deliveries.routes.test.ts` asserts the shadowing does not happen, because
 * this failure is invisible in a route table.
 */
export function webhooksResources(deps: {
  repo: IWebhookSubscriptionRepo;
  log: IDeliveryLog;
}): (router: Router) => void {
  return (router: Router) => {
    mountDeliveries(router, { log: deps.log });
    mountWebhooks(router, { repo: deps.repo });
  };
}
