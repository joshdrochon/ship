/**
 * PF-529 — the operation→method binding, as EXPORTED DATA.
 *
 * Testing Scenario 5 (p.5) is *"validate the generated /api/v1/openapi.json
 * against the OpenAPI 3.1 JSON schema. Then walk every spec method and assert
 * the SDK exposes a typed call for it."* L13 owns the validation and the
 * spec-side walk (`listSpecOperations`, PF-378). This file is the SDK side of
 * the join, and it is the whole reason the walk can be exact.
 *
 * ── Why a table and not a heuristic ─────────────────────────────────────────
 * The obvious implementation derives `documents.list` from `GET /documents` by
 * string surgery. It is rejected on purpose. A heuristic answers "is there a
 * method for this operation?" by CONSTRUCTING the name it expects and looking it
 * up — which means it also cheerfully "matches" `POST /widgets` to a
 * `widgets.create` that nobody wrote, as long as the lookup is written the
 * slightly-wrong way, and it can never detect a method the SDK invented. A
 * table is a claim someone made, and a claim can be wrong in a way a test can
 * see.
 *
 * ── The two failure modes, and where each one fires ─────────────────────────
 *   a spec operation with no entry here   → `specSurfaceParity.test.ts` fails
 *                                           at runtime, naming the operationId
 *                                           and its `METHOD /path`
 *   an entry naming a method that does
 *   not exist on the client               → `pnpm type-check` fails, because
 *                                           `ClientMethodPath` below is derived
 *                                           from the real classes
 *
 * The second is the one that matters most: it means this table cannot rot into
 * a list of aspirations. Rename `DocumentsClient.list` and the SDK stops
 * compiling here.
 *
 * ── This file parses NOTHING ────────────────────────────────────────────────
 * There is no OpenAPI reading anywhere under `sdk/` — no YAML walker, no JSON
 * schema traversal, no re-read of `docs/openapi.json`. Exactly one
 * implementation of "every spec method" exists in this repository and it is
 * L13's. `specSurfaceParity.test.ts` greps for that and fails if a second one
 * appears, because Scenario 5 comparing two parsers would be measuring their
 * agreement rather than the spec's agreement with the SDK.
 */
import type { ShipClient } from './client.js';
import type { DocumentsClient } from './resources/documents.js';
import type { IssuesClient } from './resources/issues.js';
import type { SprintsClient } from './resources/sprints.js';
import type { WebhooksClient } from './resources/webhookSubscriptions.js';
import type { WebhookDeliveriesClient } from './resources/webhookDeliveries.js';
import type { AuditClient } from './resources/audit.js';
// The field tuples come from the resource modules rather than being restated
// here, so the binding and the type it describes cannot drift: adding a field to
// `ShipIssue` without adding it to `ISSUE_FIELDS` is already a type error
// (`typeProofs/resourceTypes.ts`), and this table reads that same tuple.
import { WEBHOOK_DELIVERY_FIELDS } from './resources/webhookDeliveries.js';
import { CREATE_DOCUMENT_FIELDS, DOCUMENT_FIELDS } from './resources/documents.js';
import { CREATE_ISSUE_FIELDS, ISSUE_FIELDS, UPDATE_ISSUE_FIELDS } from './resources/issues.js';
import { CREATE_SPRINT_FIELDS, SPRINT_FIELDS, UPDATE_SPRINT_FIELDS } from './resources/sprints.js';
import { AUDIT_CALL_FIELDS } from './resources/audit.js';
import {
  CREATE_WEBHOOK_FIELDS,
  UPDATE_WEBHOOK_FIELDS,
  WEBHOOK_SUBSCRIPTION_FIELDS,
  WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS,
} from './resources/webhookSubscriptions.js';

/** Keys of `T` whose value is callable. */
type MethodNames<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** `'documents.list'`, `'webhooks.rotate'`, … — derived from the real classes. */
type ResourceMethodPath =
  | `documents.${MethodNames<DocumentsClient> & string}`
  | `issues.${MethodNames<IssuesClient> & string}`
  | `sprints.${MethodNames<SprintsClient> & string}`
  | `webhooks.${MethodNames<WebhooksClient> & string}`
  // F113 — p.4's audit trail. Standalone client (no `get()`), because there is
  // no `GET /audit/{id}` operation for it to bind to.
  | `audit.${MethodNames<AuditClient> & string}`
  // Nested collection. p.4 puts the delivery log, DLQ and replay under
  // `/webhooks`, and the SDK mirrors that URL shape rather than flattening it to
  // `webhookDeliveries.*`. Derived from the real class for the same reason as
  // the four above: rename a method on `WebhookDeliveriesClient` and this file
  // stops compiling instead of a test quietly passing.
  | `webhooks.deliveries.${MethodNames<WebhookDeliveriesClient> & string}`;

/** A method on `ShipClient` itself — `me`, `openapi`. */
type ClientOwnMethodPath = MethodNames<ShipClient> & string;

/**
 * Every legal value of `call` below. A typo, a renamed method or a method that
 * was never written is a compile error rather than a test that quietly passes.
 */
export type ClientMethodPath = ResourceMethodPath | ClientOwnMethodPath;

/** How the operation's success body is shaped. Drives PF-530's return check. */
export type ReturnShape =
  /** `{ data: T[]; next_cursor: string | null }` */
  | 'page'
  /** A single resource object. */
  | 'item'
  /** Something with no field list to compare — the spec document itself. */
  | 'opaque';

export interface OperationBinding {
  /** L13's stable `operationId` (PF-364). The join key. */
  operationId: string;
  /** Lower-case HTTP method, as `listSpecOperations` reports it. */
  method: 'get' | 'post' | 'patch' | 'delete';
  /** The spec `paths` key — `/api/v1`-relative, `{id}`-braced. */
  path: string;
  /** The SDK method, checked against the real classes at compile time. */
  call: ClientMethodPath;
  /**
   * Other SDK methods that call this same operation — `documents.iterate` is a
   * second spelling of `documents.list`, walking it page by page.
   *
   * They are listed rather than exempted because PF-531's reverse walk asserts
   * EVERY public method resolves to a spec operation, and an exemption list is a
   * place to hide an invented method. `iterate` is bound, not excused.
   */
  aliasCalls?: readonly ClientMethodPath[];
  /** Path parameters the method takes positionally. */
  pathParams: readonly string[];
  /** Query parameters the method's options object admits. */
  queryParams: readonly string[];
  /** Request-body fields the method's input type admits. `[]` for a bodyless verb. */
  bodyFields: readonly string[];
  /** The response shape, and the field names of the item inside it. */
  returns: { shape: ReturnShape; fields: readonly string[] };
}

/** The two query parameters every cursor-paginated list accepts. */
const LIST_QUERY = ['limit', 'cursor'] as const;

/** The path parameter every single-row operation takes. */
const ID_PARAM = ['id'] as const;

/**
 * THE TABLE. One row per spec operation, and the parity test asserts the two
 * sets are equal in both directions.
 */
export const OPERATION_BINDINGS: readonly OperationBinding[] = [
  {
    operationId: 'getOpenapiJson',
    method: 'get',
    path: '/openapi.json',
    call: 'openapi',
    pathParams: [],
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'opaque', fields: [] },
  },
  {
    operationId: 'getMe',
    method: 'get',
    path: '/me',
    call: 'me',
    pathParams: [],
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: ['user', 'app', 'scopes'] },
  },

  // ── documents ─────────────────────────────────────────────────────────────
  {
    operationId: 'getDocuments',
    method: 'get',
    path: '/documents',
    call: 'documents.list',
    aliasCalls: ['documents.iterate'],
    pathParams: [],
    queryParams: LIST_QUERY,
    bodyFields: [],
    returns: { shape: 'page', fields: DOCUMENT_FIELDS },
  },
  {
    operationId: 'postDocuments',
    method: 'post',
    path: '/documents',
    call: 'documents.create',
    pathParams: [],
    queryParams: [],
    bodyFields: CREATE_DOCUMENT_FIELDS,
    returns: { shape: 'item', fields: DOCUMENT_FIELDS },
  },
  {
    operationId: 'getDocumentsById',
    method: 'get',
    path: '/documents/{id}',
    call: 'documents.get',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: DOCUMENT_FIELDS },
  },

  // ── issues ────────────────────────────────────────────────────────────────
  {
    operationId: 'getIssues',
    method: 'get',
    path: '/issues',
    call: 'issues.list',
    aliasCalls: ['issues.iterate'],
    pathParams: [],
    queryParams: LIST_QUERY,
    bodyFields: [],
    returns: { shape: 'page', fields: ISSUE_FIELDS },
  },
  {
    operationId: 'postIssues',
    method: 'post',
    path: '/issues',
    call: 'issues.create',
    pathParams: [],
    queryParams: [],
    bodyFields: CREATE_ISSUE_FIELDS,
    returns: { shape: 'item', fields: ISSUE_FIELDS },
  },
  {
    operationId: 'getIssuesById',
    method: 'get',
    path: '/issues/{id}',
    call: 'issues.get',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: ISSUE_FIELDS },
  },
  {
    operationId: 'patchIssuesById',
    method: 'patch',
    path: '/issues/{id}',
    call: 'issues.update',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: UPDATE_ISSUE_FIELDS,
    returns: { shape: 'item', fields: ISSUE_FIELDS },
  },

  // ── sprints ───────────────────────────────────────────────────────────────
  {
    operationId: 'getSprints',
    method: 'get',
    path: '/sprints',
    call: 'sprints.list',
    aliasCalls: ['sprints.iterate'],
    pathParams: [],
    queryParams: LIST_QUERY,
    bodyFields: [],
    returns: { shape: 'page', fields: SPRINT_FIELDS },
  },
  {
    operationId: 'postSprints',
    method: 'post',
    path: '/sprints',
    call: 'sprints.create',
    pathParams: [],
    queryParams: [],
    bodyFields: CREATE_SPRINT_FIELDS,
    returns: { shape: 'item', fields: SPRINT_FIELDS },
  },
  {
    operationId: 'getSprintsById',
    method: 'get',
    path: '/sprints/{id}',
    call: 'sprints.get',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: SPRINT_FIELDS },
  },
  {
    operationId: 'patchSprintsById',
    method: 'patch',
    path: '/sprints/{id}',
    call: 'sprints.update',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: UPDATE_SPRINT_FIELDS,
    returns: { shape: 'item', fields: SPRINT_FIELDS },
  },

  // ── webhook subscriptions ─────────────────────────────────────────────────
  {
    operationId: 'postWebhooks',
    method: 'post',
    path: '/webhooks',
    call: 'webhooks.create',
    pathParams: [],
    queryParams: [],
    bodyFields: CREATE_WEBHOOK_FIELDS,
    // The ONE response that carries the secret — PF-525's separate type.
    returns: { shape: 'item', fields: WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS },
  },
  {
    operationId: 'getWebhooks',
    method: 'get',
    path: '/webhooks',
    call: 'webhooks.list',
    aliasCalls: ['webhooks.iterate'],
    pathParams: [],
    queryParams: LIST_QUERY,
    bodyFields: [],
    returns: { shape: 'page', fields: WEBHOOK_SUBSCRIPTION_FIELDS },
  },
  {
    operationId: 'getWebhooksById',
    method: 'get',
    path: '/webhooks/{id}',
    call: 'webhooks.get',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: WEBHOOK_SUBSCRIPTION_FIELDS },
  },
  {
    operationId: 'patchWebhooksById',
    method: 'patch',
    path: '/webhooks/{id}',
    call: 'webhooks.update',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: UPDATE_WEBHOOK_FIELDS,
    returns: { shape: 'item', fields: WEBHOOK_SUBSCRIPTION_FIELDS },
  },
  {
    operationId: 'deleteWebhooksById',
    method: 'delete',
    path: '/webhooks/{id}',
    call: 'webhooks.delete',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: WEBHOOK_SUBSCRIPTION_FIELDS },
  },
  {
    operationId: 'postWebhooksByIdRotate',
    method: 'post',
    path: '/webhooks/{id}/rotate',
    call: 'webhooks.rotate',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS },
  },
  {
    operationId: 'getWebhooksDeliveries',
    method: 'get',
    path: '/webhooks/deliveries',
    call: 'webhooks.deliveries.list',
    pathParams: [],
    queryParams: ['limit', 'cursor', 'status', 'subscription_id', 'event_type'],
    bodyFields: [],
    returns: { shape: 'page', fields: WEBHOOK_DELIVERY_FIELDS },
  },
  {
    operationId: 'getWebhooksDeliveriesById',
    method: 'get',
    path: '/webhooks/deliveries/{id}',
    call: 'webhooks.deliveries.get',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: WEBHOOK_DELIVERY_FIELDS },
  },
  {
    operationId: 'postWebhooksDeliveriesByIdReplay',
    method: 'post',
    path: '/webhooks/deliveries/{id}/replay',
    call: 'webhooks.deliveries.replay',
    pathParams: ID_PARAM,
    queryParams: [],
    bodyFields: [],
    returns: { shape: 'item', fields: WEBHOOK_DELIVERY_FIELDS },
  },

  // ── audit ─────────────────────────────────────────────────────────────────
  {
    // F113 — p.4's public audit trail. This row is the one that was missing:
    // `GET /api/v1/audit` shipped with `AuditClient` wired onto `ShipClient` and
    // no binding here, and the parity suite stayed green because its own import
    // list omitted the audit route module, so the spec side never produced
    // `getAudit` to go looking for. See `api/v1/allRoutes.ts` for the fix to the
    // omission itself.
    operationId: 'getAudit',
    method: 'get',
    path: '/audit',
    call: 'audit.list',
    aliasCalls: ['audit.iterate'],
    pathParams: [],
    // The four filters are p.4's, and `ListAuditCallsInput` admits exactly
    // these. There is no `client_id`: the trail is scoped to the caller by
    // construction, so a parameter for it would be a way to ask for someone
    // else's history.
    queryParams: [...LIST_QUERY, 'status', 'route', 'from', 'to'],
    bodyFields: [],
    returns: { shape: 'page', fields: AUDIT_CALL_FIELDS },
  },
];

/** Lookup by `operationId`. Built once. */
export const BINDING_BY_OPERATION_ID: ReadonlyMap<string, OperationBinding> = new Map(
  OPERATION_BINDINGS.map((binding) => [binding.operationId, binding]),
);

/**
 * Resolves a `call` path against a live client — PF-528's "resolves to a
 * callable SDK method", executed rather than asserted.
 *
 * Returns `null` rather than throwing so the test can report every unresolved
 * binding in one run instead of one per re-run.
 */
export function resolveBoundMethod(
  client: ShipClient,
  call: string,
): ((...args: never[]) => unknown) | null {
  const parts = call.split('.');
  let current: unknown = client;
  for (const part of parts) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      return null;
    }
    // Walks the prototype chain on purpose: `list` lives on `ResourceClient`,
    // not on the instance, and an own-property check would report every
    // inherited method as missing.
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'function' ? (current as (...args: never[]) => unknown) : null;
}

/**
 * The sub-clients hanging off `ShipClient` that the reverse walk descends into.
 *
 * This list was `['documents', 'issues', 'sprints', 'webhooks']` and it was the
 * reverse-parity half of the audit hole: `client.audit` existed, `audit.list`
 * and `audit.iterate` were real public methods, and PF-531 never looked at them
 * because the resource name was not here. `webhooks.deliveries` was unwalked for
 * the same reason. A short list here does not fail — it walks less.
 *
 * `unwalkedClientProperties()` below is what stops that recurring: it checks
 * this list against the real instance, so a sub-client nobody adds here is
 * reported rather than skipped.
 */
const WALKED_SUB_CLIENTS = ['documents', 'issues', 'sprints', 'webhooks', 'audit'] as const;

/**
 * Nested collections — `client.webhooks.deliveries`. p.4 puts the delivery log,
 * DLQ and replay under `/webhooks`, and the SDK mirrors that URL shape.
 */
const WALKED_NESTED: readonly (readonly [(typeof WALKED_SUB_CLIENTS)[number], string])[] = [
  ['webhooks', 'deliveries'],
];

/**
 * Properties on a client object that are NOT public surface, with the reason.
 *
 * `transport` is TypeScript-`private`, which is a compile-time fiction — at
 * runtime it is an ordinary enumerable own property holding an object full of
 * methods. It is plumbing, not a resource, and it is named here rather than
 * filtered by a naming heuristic because this module's whole argument is that a
 * claim someone made can be checked and a heuristic cannot.
 */
const NOT_PUBLIC_SURFACE = new Set(['transport']);

/**
 * Own enumerable properties of `client` (or of a sub-client) that look like a
 * sub-client but are neither walked nor explicitly excluded.
 *
 * PF-531's reverse walk asserts every public SDK method maps to a spec
 * operation. That assertion is only as wide as `WALKED_SUB_CLIENTS`, so this
 * function is what makes the width itself checkable: the parity test asserts it
 * returns nothing, and adding a sixth resource to `ShipClient` without listing
 * it above turns the suite red instead of quietly narrowing the walk.
 */
export function unwalkedClientProperties(client: ShipClient): string[] {
  const walked = new Set<string>(WALKED_SUB_CLIENTS);
  const found: string[] = [];

  const inspect = (target: object, prefix: string, covered: ReadonlySet<string>): void => {
    for (const [key, value] of Object.entries(target)) {
      if (covered.has(key) || NOT_PUBLIC_SURFACE.has(key) || key.startsWith('_')) continue;
      // Only objects carrying prototype methods are candidates. A string like
      // `baseUrl` or a null `lastRateLimit` is data, not an unwalked surface.
      if (value === null || typeof value !== 'object') continue;
      if (prototypeMethods(value as object).length === 0) continue;
      found.push(`${prefix}${key}`);
    }
  };

  inspect(client, '', walked);

  for (const resource of WALKED_SUB_CLIENTS) {
    const nested = new Set(
      WALKED_NESTED.filter(([parent]) => parent === resource).map(([, child]) => child),
    );
    inspect(client[resource] as object, `${resource}.`, nested);
  }

  return found.sort();
}

/**
 * Every public method the SDK offers, as `'resource.method'` / `'method'` paths
 * — PF-531's reverse walk reads this and asserts each one appears in the table.
 *
 * Read off the real prototypes rather than from a list, because a list of
 * methods maintained beside a table of bindings is two lists that agree until
 * someone adds a method to only one. The set of OBJECTS walked is a list, and
 * `unwalkedClientProperties()` is what keeps that list honest.
 */
export function listPublicMethodPaths(client: ShipClient): string[] {
  const paths: string[] = [];

  for (const name of prototypeMethods(client)) paths.push(name);

  for (const resource of WALKED_SUB_CLIENTS) {
    for (const name of prototypeMethods(client[resource])) paths.push(`${resource}.${name}`);
  }

  for (const [parent, child] of WALKED_NESTED) {
    const nested = (client[parent] as unknown as Record<string, object>)[child];
    if (nested === undefined) continue;
    for (const name of prototypeMethods(nested)) paths.push(`${parent}.${child}.${name}`);
  }

  return paths.sort();
}

/**
 * Callable, non-private, non-constructor members of an object's prototype
 * chain, stopping at `Object.prototype`.
 *
 * `iterate` is included and is meant to be: PF-531 asks that EVERY public method
 * appear in the binding table, and `iterate` is bound to the same `list`
 * operation as `list` is — it is a second spelling of one spec call, not an
 * unbound method.
 */
function prototypeMethods(instance: object): string[] {
  const names = new Set<string>();
  let prototype: object | null = Object.getPrototypeOf(instance) as object | null;

  while (prototype !== null && prototype !== Object.prototype) {
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(prototype),
    )) {
      if (key === 'constructor' || key.startsWith('_')) continue;
      // A getter must not be INVOKED to classify it — `rateLimit` would run.
      if (descriptor.get !== undefined || descriptor.set !== undefined) continue;
      if (typeof descriptor.value === 'function') names.add(key);
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }

  return [...names];
}
