/**
 * PF-248 — ONE metadata record per route, and one call that produces it.
 *
 * Three lanes read a per-route declaration and each of them arrived with its own
 * registry:
 *
 *   L03  the required scope (`routeScopes`, PF-072) — for the 403 body, for
 *        PF-079's fitness clause, and for L13's `security` block.
 *   L08  the pagination mode (`routeMetadata`, PF-228) — for Testing Scenario 4
 *        clause (d).
 *   L13  the request/response Zod — for the generated spec (PF-358).
 *
 * Three registries means three lists that can disagree about which routes exist,
 * and the disagreement shows up as a clause passing VACUOUSLY: a route missing
 * from L08's list is a route clause (d) never checks, which is silence rather
 * than a failure. That is not hypothetical here — it is the shape of the bug
 * this lane found in L03's own fitness test (see `scope-fitness.test.ts`).
 *
 * So there is one call. `declareV1Route` records the scope, the list mode, the
 * resource name and both schemas on the SAME object, and returns the guard that
 * enforces the scope it just declared. A route that guards without declaring, or
 * declares without guarding, is not a shape this module offers.
 *
 * ## Why the declaration happens at module load, not at mount
 *
 * `routeMetadata` is a process-wide singleton and `declare()` throws on a
 * duplicate key — correctly, because two records for one route means two answers
 * to "what scope does it need". But a test suite builds many apps, and each one
 * mounts the same resource routes. So declaration is done ONCE, when the route
 * module is first imported, and `mountDocuments` only mounts. Handlers built at
 * module load are reused across every app in the process, which is also what
 * makes them safe to share: they close over nothing per-request.
 */
import type { RequestHandler } from 'express';
import type { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { routeMetadata, type ListMode, type RouteMetadataRegistry } from './routeMetadata.js';
import { declareRoute } from '../../scopes/require-scope.js';
import type { HttpMethod } from '../../scopes/route-metadata.js';
import type { Scope } from '../../scopes/scopes.js';
import { V1_PREFIX } from './testSupport.js';
import { registerV1Operation } from '../../openapi/operations.js';
import { paginationQuerySchema } from './page.js';
import { responseContract } from './responseContract.js';

export interface V1RouteDeclaration {
  method: HttpMethod;
  /** Path WITHIN the v1 router, e.g. `/documents/:id`. The prefix is added here. */
  path: string;
  /**
   * The scope this route requires, or an explicit `null`.
   *
   * Required-with-`null`-in-the-type rather than optional: `{method, path}` with
   * no `scope` key is a compile error, so forgetting is caught by `tsc` and not
   * by a fitness test running later. `null` is a claim the author makes — see
   * the B6 discussion in `platform/scopes/route-metadata.ts`.
   */
  scope: Scope | null;
  /** PF-228. `'cursor' | 'none' | false`, no default — see routeMetadata.ts. */
  list: ListMode;
  /** Required when `list === 'cursor'`: the collection a cursor is bound to. */
  resource?: string;
  /** The request body schema, for L13's generator. Absent on routes with no body. */
  request?: z.ZodTypeAny;
  /**
   * The path-parameter schema (PF-358). Present when the path has a `:param`.
   *
   * Carried on the declaration rather than derived from the path string so the
   * spec documents the parameter the handler actually validates — `:id` is a
   * UUID on `/documents/:id` and the generator has no way to know that from the
   * path alone.
   */
  params?: z.ZodTypeAny;
  /**
   * Extra query parameters beyond the pagination pair. A `list: 'cursor'` route
   * gets `limit` and `cursor` automatically, from L08's schema (PF-362).
   */
  query?: z.ZodTypeAny;
  /** The response body schema. Required — every public route returns something. */
  response: z.ZodTypeAny;
  /** Success status. Defaults to 201 for POST, 200 otherwise. */
  status?: number;
  /** One line, shown as the operation summary in the generated spec. */
  summary?: string;
  description?: string;
  /**
   * PF-366 — this route is mounted ABOVE bearer auth and answers anonymously.
   *
   * Its path MUST also be in `V1_UNAUTHENTICATED_PATHS`; `router.test.ts`
   * asserts the two agree. The generator gives such an operation `security: []`
   * and no `401` response, because it cannot produce one.
   */
  unauthenticated?: boolean;
  registry?: RouteMetadataRegistry;
  /** The OpenAPI registry to register into. Defaults to `publicRegistry`. */
  openapiRegistry?: OpenAPIRegistry;
}

/**
 * Declares a route and returns its scope guard.
 *
 * Throws at WIRING time — which is module load, inside `createApp()` — on a
 * missing field or an unregistered scope. A defect that fails at boot is found
 * by whoever caused it, in the same minute, with the route name in the message;
 * a defect that fails in a test is found by whoever runs the suite next.
 */
export function declareV1Route(declaration: V1RouteDeclaration): RequestHandler {
  const fullPath = `${V1_PREFIX}${declaration.path}`;
  const key = `${declaration.method.toUpperCase()} ${fullPath}`;

  if (!('scope' in declaration) || declaration.scope === undefined) {
    throw new Error(
      `${key}: declared without a scope. Every public route states what it requires; ` +
        `a route that genuinely needs none declares \`scope: null\`, which is a claim, ` +
        `not a default.`,
    );
  }
  if (!declaration.response) {
    throw new Error(
      `${key}: declared without a \`response\` schema. PRD p.11 requires every public ` +
        `route's schema to live in Zod adjacent to the handler — L13's generator walks ` +
        `this field, and a route without one becomes an operation with no documented ` +
        `body rather than a build failure.`,
    );
  }

  const registry = declaration.registry ?? routeMetadata;
  registry.declare({
    method: declaration.method.toUpperCase(),
    path: fullPath,
    list: declaration.list,
    // `?? undefined` because `RouteMetadata.scope` is `string | null | undefined`
    // and the three mean different things; a declared null must survive as null.
    scope: declaration.scope,
    ...(declaration.resource ? { resource: declaration.resource } : {}),
    ...(declaration.request ? { request: declaration.request } : {}),
    response: declaration.response,
  });

  // ── L13's half (PF-358) ────────────────────────────────────────────────────
  //
  // The SAME call that records the metadata and builds the guard also registers
  // the spec operation. Two separate registration calls is the drift this whole
  // lane exists to prevent: with two, "does every route have a spec entry?" is a
  // question about how careful the author was, and the parity test measures
  // discipline rather than a property of the code.
  //
  // PF-362 — a `list: 'cursor'` route gets `limit` and `cursor` from L08's
  // `paginationQuerySchema`, which is defined beside the cursor codec in
  // `page.ts` rather than restated here. `cursor` is typed `string` because the
  // cursors are opaque base64url, not offsets; a spec that types it `integer`
  // tells every SDK generator to build an offset pager.
  const query =
    declaration.list === 'cursor'
      ? declaration.query
        ? (paginationQuerySchema.merge(declaration.query as never) as z.ZodTypeAny)
        : (paginationQuerySchema as z.ZodTypeAny)
      : declaration.query;

  registerV1Operation({
    method: declaration.method.toLowerCase() as V1OperationMethod,
    path: fullPath,
    scope: declaration.scope,
    list: declaration.list,
    ...(declaration.request ? { request: declaration.request } : {}),
    ...(declaration.params ? { params: declaration.params } : {}),
    ...(query ? { query } : {}),
    response: declaration.response,
    ...(declaration.status !== undefined ? { status: declaration.status } : {}),
    ...(declaration.summary ? { summary: declaration.summary } : {}),
    ...(declaration.description ? { description: declaration.description } : {}),
    ...(declaration.unauthenticated ? { unauthenticated: true } : {}),
    ...(declaration.openapiRegistry ? { registry: declaration.openapiRegistry } : {}),
  });

  // L03's half: records into `routeScopes` AND builds the guard, in one call, so
  // the metadata and the enforcement cannot drift apart.
  const guard = declareRoute(declaration.scope, {
    method: declaration.method,
    path: declaration.path,
  });

  // PF-360 — the declared response schema is applied to what the handler actually
  // returns. Without this a spec entry can exist and still lie, and PF-373's
  // parity test would stay green while the body drifted for good.
  const contract = responseContract(declaration.response, key);

  return function declaredV1Route(req, res, next): void {
    contract(req, res, (err?: unknown) => {
      if (err) return next(err);
      guard(req, res, next);
    });
  };
}

type V1OperationMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * PF-248's wiring-time assertion — every MOUNTED route carries a scope
 * declaration on its metadata record.
 *
 * The counterpart to L08's `assertEveryRouteDeclaresList`, and deliberately the
 * same shape: it walks the LIVE Express stack rather than trusting any list, so
 * a route that never went through `declareV1Route` is caught rather than being
 * invisible. Two lists cannot disagree when one of them is not a list.
 */
export function assertEveryRouteDeclaresScope(
  app: import('express').Express,
  enumerate: (app: import('express').Express) => { method: string; path: string }[],
  registry: RouteMetadataRegistry = routeMetadata,
  exemptPaths: readonly string[] = [],
): void {
  const undeclared = enumerate(app)
    .filter((route) => !exemptPaths.includes(route.path))
    .filter((route) => {
      const metadata = registry.get(route.method, route.path);
      // No record at all, or a record whose scope was never set. A record with
      // `scope: null` PASSES — that is the declared-null case, not the forgot case.
      return metadata === undefined || metadata.scope === undefined;
    })
    .map((route) => `${route.method.toUpperCase()} ${route.path}`);

  if (undeclared.length === 0) return;

  throw new Error(
    `${undeclared.length} /api/v1 route(s) mounted with no scope declaration:\n` +
      undeclared.map((r) => `  ${r}`).join('\n') +
      `\n\nEvery public route declares its required scope through declareV1Route() — MVP ` +
      `gate item 4 (p.2): "Each route declares its required scope via a require(scope) ` +
      `middleware factory." A route that needs no particular permission declares ` +
      `\`scope: null\`, which is a claim the fitness test honours.`,
  );
}
