/**
 * Turning ONE route declaration into ONE spec operation.
 *
 * Tickets: PF-358 (one call produces the handler and the spec entry), PF-361
 * (the shared `ApiError` component on every operation), PF-362 (list operations
 * declare the cursor parameters and the `{data, next_cursor}` envelope), PF-364
 * (deterministic, unique `operationId`), PF-374 (`toOpenApiPath`, one shared
 * normalizer).
 *
 * This module is called from `declareV1Route()` — the same call that registers
 * the route's scope, its pagination mode and its guard. That is the whole point
 * of PF-358: **two separate registration calls is the drift this lane exists to
 * prevent.** With one call, a route cannot be mounted without appearing in the
 * spec, and a spec entry cannot exist without a route behind it; the parity
 * fitness test then measures a property rather than measuring how disciplined
 * whoever wrote the route happened to be that afternoon.
 */
import type {
  OpenAPIRegistry,
  RouteConfig,
  ZodContentObject,
} from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';
import {
  publicRegistry,
  PUBLIC_API_SERVER_URL,
  PUBLIC_SECURITY_SCHEME,
  API_ERROR_COMPONENT,
} from './registry.js';

/**
 * PF-374 — Express path template → OpenAPI path template. ONE function, used by
 * the generator (here) and by the parity clause (`specParity.ts`).
 *
 * Two normalizers would mean parity fails on a formatting difference or passes
 * on a coincidence, and both outcomes look exactly like the code being right.
 *
 * Three transformations, in order:
 *
 *   1. Strip the `/api/v1` mount prefix. The prefix belongs to `servers[0].url`
 *      and to the `app.use()` call, never to a `paths` key — an SDK builds a URL
 *      by concatenating the two, so a prefix in both yields `/api/v1/api/v1/...`.
 *   2. `:param` → `{param}`, including Express's optional `:param?`.
 *   3. Drop a trailing slash, except on the root. `/documents` and `/documents/`
 *      are the same route to Express and two different keys in a JSON object.
 */
export function toOpenApiPath(expressPath: string): string {
  let path = expressPath;

  if (path === PUBLIC_API_SERVER_URL) {
    path = '/';
  } else if (path.startsWith(`${PUBLIC_API_SERVER_URL}/`)) {
    path = path.slice(PUBLIC_API_SERVER_URL.length);
  }

  path = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? `{${segment.slice(1).replace(/\?$/, '')}}` : segment,
    )
    .join('/');

  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '') path = '/';
  if (!path.startsWith('/')) path = `/${path}`;

  return path;
}

/**
 * PF-364 — a deterministic, unique `operationId`, derived from method + path by
 * this one exported function.
 *
 * `getDocuments`, `getDocumentsById`, `postDocuments`. Derived rather than
 * hand-supplied because a hand-supplied id is a second name for a route that can
 * disagree with the first, and because L18 keys its SDK-method walk off these:
 * an id that moves between runs makes the `docs/openapi.json` staleness check
 * (PF-369) flap and gives the SDK test no stable handle.
 *
 * Byte-stability is asserted in `operations.test.ts` across two consecutive
 * generations in one process AND across a fresh import, because a `Map`
 * iteration order or a `Date.now()` sneaking into a derivation is exactly the
 * kind of thing that is stable within a process and not across one.
 */
export function operationIdFor(method: string, expressPath: string): string {
  const segments = toOpenApiPath(expressPath)
    .split('/')
    .filter((segment) => segment.length > 0);

  const parts = segments.map((segment, index) => {
    const isParam = segment.startsWith('{') && segment.endsWith('}');
    const name = isParam ? segment.slice(1, -1) : segment;
    const camel = name
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((word, wordIndex) =>
        index === 0 && wordIndex === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1),
      )
      .join('');
    // A path parameter reads as `ById`, not as `Id` — `getDocumentsId` and
    // `getDocumentsById` are equally derivable and only one reads like a method.
    return isParam ? `By${camel.charAt(0).toUpperCase()}${camel.slice(1)}` : camel;
  });

  const tail = parts.join('');
  return `${method.toLowerCase()}${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
}

/** The first path segment, which is also the resource tag. `/` → `root`. */
function tagFor(expressPath: string): string {
  const first = toOpenApiPath(expressPath).split('/').filter(Boolean)[0];
  if (!first || first.startsWith('{')) return 'root';
  return first;
}

/** A `$ref` to the one shared error component. */
function apiErrorContent(): ZodContentObject {
  return {
    'application/json': {
      schema: { $ref: `#/components/schemas/${API_ERROR_COMPONENT}` },
    },
  };
}

export interface V1OperationInput {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Full public path INCLUDING the `/api/v1` prefix. Normalized here. */
  path: string;
  /** The declared scope, or `null` for a route that requires none. */
  scope: string | null;
  /** PF-362 — `'cursor'` makes this a list operation. */
  list: 'cursor' | 'none' | false;
  request?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  /** Success status. Defaults to 201 for POST, 200 otherwise. */
  status?: number;
  summary?: string;
  description?: string;
  /**
   * True for a route mounted ABOVE bearer auth (`V1_UNAUTHENTICATED_PATHS`).
   *
   * Such an operation gets `security: []` and NO `401` response, because it
   * genuinely cannot produce one — see the note on PF-361 in `registry.test.ts`.
   * Declaring a 401 it can never return would be a hand-written lie of exactly
   * the kind this generator exists to make impossible.
   */
  unauthenticated?: boolean;
  registry?: OpenAPIRegistry;
}

/**
 * PF-358 — registers the operation. Called by `declareV1Route`, never directly
 * by a route module.
 *
 * ## Which error responses are declared, and why not "all six"
 *
 * PF-361 requires at least `401` and `500` on every operation, and both are
 * declared here for a structural reason rather than a per-route judgement: the
 * public router mounts `bearerAuth` above every resource route (so 401 is
 * reachable on all of them) and `apiErrorMiddleware` below every one (so 500
 * is). `429` is declared for the same reason — `rateLimitMiddleware` is in the
 * shared stack.
 *
 * `403` is declared only when the route declares a scope, because a route with
 * `scope: null` has no scope to be missing. `422` is declared when there is
 * anything to validate — a body, path parameters or query parameters. `404` is
 * declared when the path has a parameter, which is when a caller can name a row
 * that does not exist.
 *
 * Each of those is derived from the declaration rather than listed by the route
 * author, so an operation's error surface cannot drift from its actual middleware
 * stack without this function changing.
 */
export function registerV1Operation(input: V1OperationInput): void {
  const registry = input.registry ?? publicRegistry;
  const path = toOpenApiPath(input.path);
  const successStatus = input.status ?? (input.method === 'post' ? 201 : 200);

  const responses: RouteConfig['responses'] = {
    [successStatus]: {
      description: input.summary ?? 'Success.',
      content: { 'application/json': { schema: input.response } },
    },
  };

  if (!input.unauthenticated) {
    responses[401] = {
      description:
        'No access token, or a token that is expired or invalid. `details.reason` ' +
        'distinguishes `expired` / `invalid` / `missing`.',
      content: apiErrorContent(),
    };
  }

  if (input.scope !== null) {
    responses[403] = {
      description:
        `The token is valid but was not granted \`${input.scope}\`. The body names the ` +
        'missing scope, the granted scopes, and what the missing one permits.',
      content: apiErrorContent(),
    };
  }

  if (input.params) {
    responses[404] = { description: 'No such resource.', content: apiErrorContent() };
  }

  if (input.request || input.params || input.list === 'cursor') {
    responses[422] = {
      description: 'The request did not validate. `details.fields[]` names each problem.',
      content: apiErrorContent(),
    };
  }

  if (!input.unauthenticated) {
    responses[429] = {
      description: 'Rate limit exceeded. See `Retry-After` and the `X-RateLimit-*` headers.',
      content: apiErrorContent(),
    };
  }

  responses[500] = { description: 'Unexpected server error.', content: apiErrorContent() };

  const config: RouteConfig = {
    method: input.method,
    path,
    operationId: operationIdFor(input.method, input.path),
    tags: [tagFor(input.path)],
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.description ? { description: input.description } : {}),
    // PF-356 — the per-operation scope requirement. `security: []` on an
    // unauthenticated operation is not the same as omitting `security`: omitting
    // it inherits the document default, and `[]` says "explicitly none".
    security: input.unauthenticated
      ? []
      : [{ [PUBLIC_SECURITY_SCHEME]: input.scope === null ? [] : [input.scope] }],
    responses,
  };

  const request: NonNullable<RouteConfig['request']> = {};
  if (input.params) request.params = input.params as never;
  if (input.query) request.query = input.query as never;
  if (input.request) {
    request.body = {
      required: true,
      content: { 'application/json': { schema: input.request } },
    };
  }
  if (Object.keys(request).length > 0) config.request = request;

  registry.registerPath(config);
}
