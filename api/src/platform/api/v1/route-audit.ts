/**
 * PF-079 — walk a mounted router and find every route that does not declare a
 * registered scope. This is Testing Scenario 4(b) (PRD p.5).
 *
 * ## Why this walks the router and not just the declaration table
 *
 * The obvious implementation reads `RouteScopeTable` and checks each entry's
 * scope against the registry. That catches a route that declared *badly* and is
 * structurally incapable of catching a route that never declared at all — the
 * table only knows about routes that called `declareRoute`. A route added with a
 * plain `router.get(path, handler)` leaves no trace in it, and that is precisely
 * the failure mode the ticket describes: *"a route added later without a scope
 * fails CI."*
 *
 * So the router stack is the ground truth for which routes exist, and the table
 * is consulted for what each one claimed. Three outcomes:
 *
 *   declared a registered scope   fine
 *   declared `scope: null`        fine — an explicit claim that the route needs
 *                                 no particular permission (dispute B6; L10's
 *                                 `GET /api/v1/me`). Bearer auth still applies.
 *   declared an unregistered name `unregistered` violation. In practice
 *                                 `requireScope` has already thrown at wiring
 *                                 time (PF-068), so this is the belt to that
 *                                 braces — it also catches a table entry written
 *                                 without going through the factory.
 *   no declaration at all         `undeclared` violation. The forgot case.
 *
 * The last two are different failures and the messages say so. Reporting both as
 * "missing scope" is what would push someone toward `scope: null` as a way to
 * make CI quiet, which converts the fitness test into a rubber stamp.
 *
 * ## Known limit, stated rather than discovered later
 *
 * Sub-routers are walked, but a route inside one is matched on its *own* path,
 * not the full mounted path — Express keeps the mount prefix as a compiled
 * RegExp and reconstructing it is guesswork. This is fine because
 * `declareRoute` is called at the same place `router.get(...)` is, with the same
 * path string. It does mean two sub-routers mounting the same inner path share
 * one declaration. If the v1 surface ever needs that, this function needs the
 * mount prefix passed in rather than inferred.
 */
import type { Router } from 'express';
import { scopeRegistry } from '../../scopes/scopes.js';
import type { ScopeRegistry } from '../../scopes/registry.js';
import {
  routeScopes,
  HTTP_METHODS,
  type HttpMethod,
  type RouteScopeTable,
} from '../../scopes/route-metadata.js';

/** A route that exists on the router, as discovered by walking it. */
export interface MountedRoute {
  method: HttpMethod;
  path: string;
}

export type RouteScopeViolation =
  | {
      kind: 'undeclared';
      method: HttpMethod;
      path: string;
      message: string;
    }
  | {
      kind: 'unregistered';
      method: HttpMethod;
      path: string;
      scope: string;
      message: string;
    };

/** The shape Express actually gives us. Not in @types/express, so declared here. */
interface ExpressLayer {
  name?: string;
  route?: { path?: unknown; methods?: Record<string, boolean> };
  handle?: { stack?: ExpressLayer[] };
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * Every `{method, path}` the router will actually serve.
 *
 * Exported because PF-079 is not the only consumer that wants it: L13's OpenAPI
 * parity check needs the same list to assert the spec covers every route, and a
 * second implementation of this walk would be a second thing to get wrong.
 */
export function mountedRoutes(router: Router): MountedRoute[] {
  const found: MountedRoute[] = [];

  const walk = (layers: ExpressLayer[] | undefined): void => {
    for (const layer of layers ?? []) {
      if (layer.route) {
        const path = layer.route.path;
        const methods = layer.route.methods ?? {};
        // Express allows an array of paths on one route registration.
        const paths = Array.isArray(path) ? path : [path];
        for (const p of paths) {
          if (typeof p !== 'string') continue;
          for (const [method, enabled] of Object.entries(methods)) {
            if (enabled && isHttpMethod(method)) found.push({ method, path: p });
          }
        }
      } else if (layer.name === 'router') {
        walk(layer.handle?.stack);
      }
    }
  };

  walk((router as unknown as { stack?: ExpressLayer[] }).stack);
  return found;
}

export interface RouteAuditOptions {
  table?: RouteScopeTable<string>;
  registry?: ScopeRegistry<string>;
}

/**
 * PF-079 — the fitness check itself. Empty array means every mounted route
 * declares something the registry recognises, or declares an explicit null.
 */
export function auditRouterScopes(
  router: Router,
  options: RouteAuditOptions = {},
): RouteScopeViolation[] {
  const table = options.table ?? (routeScopes as unknown as RouteScopeTable<string>);
  const registry = options.registry ?? scopeRegistry;
  const violations: RouteScopeViolation[] = [];

  for (const { method, path } of mountedRoutes(router)) {
    const declaration = table.find(method, path);
    const where = `${method.toUpperCase()} ${path}`;

    if (!declaration) {
      violations.push({
        kind: 'undeclared',
        method,
        path,
        message:
          `${where} is mounted on the public router but declares no scope. Wire it with ` +
          `declareRoute(scope, {method, path}), which installs the guard and records the ` +
          `declaration in one call. A route that genuinely needs no particular permission ` +
          `declares scope: null — that is a claim someone makes on purpose, not a way to ` +
          `quiet this check.`,
      });
      continue;
    }

    // An explicit null is a declaration and it passes. See dispute B6.
    if (declaration.scope === null) continue;

    if (!registry.has(declaration.scope)) {
      violations.push({
        kind: 'unregistered',
        method,
        path,
        scope: declaration.scope,
        message:
          `${where} declares the scope "${declaration.scope}", which is not registered. ` +
          `Scopes register at module load in platform/scopes/scopes.ts. This is a different ` +
          `failure from declaring nothing: the route stated a requirement, and the ` +
          `requirement does not exist.`,
      });
    }
  }

  return violations;
}
