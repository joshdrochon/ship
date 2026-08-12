/**
 * The route-enumerating fitness harness — shared infrastructure, not an L07 test.
 *
 * Tickets: PF-200 (`enumerateV1Routes`), PF-202 (registration seams).
 *
 * PRD Build Strategy §3 (p.11): *"Build the fitness test that enumerates routes
 * and asserts the shape — that's your TODO list for E2."* Testing Scenario 4
 * (p.5) is FOUR checks over EVERY `/api/v1` route, and they belong to four
 * different lanes:
 *
 *   | clause | assertion                                  | owning lane |
 *   |--------|--------------------------------------------|-------------|
 *   | (a)    | the route has an OpenAPI entry             | **L13**     |
 *   | (b)    | the route declares a scope                 | **L03**     |
 *   | (c)    | failures ship the `ApiError` envelope      | **L07** (here) |
 *   | (d)    | list endpoints paginate with an opaque cursor | **L08**  |
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW TO ADD YOUR CLAUSE (L03, L08, L13 — read this)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Do NOT write your own route walk. Three enumerators means three different
 * definitions of "every route", and the one that is subtly wrong is the one that
 * passes. Register an assertion instead:
 *
 *   // api/src/platform/scopes/scopeFitness.ts   (L03's file, not this one)
 *   import { registerRouteAssertion } from '../api/v1/routeFitness.js';
 *
 *   registerRouteAssertion('L03: every route declares a scope', ({ route }) => {
 *     const scope = scopeForRoute(route);
 *     if (!scope) {
 *       throw new Error(`${route.method} ${route.path} declares no scope`);
 *     }
 *   });
 *
 * Then import that module from your spec and call `runRouteAssertions(app)`.
 * Your assertion runs against every route the enumerator finds, including routes
 * added by lanes that do not exist yet. Throw to fail; the harness reports which
 * route and which clause.
 *
 * An assertion receives `{ route, app }`. `route.handlers` is the raw handler
 * chain, which is how a clause can inspect middleware (that is how L03 can find
 * a `requireScope` marker without parsing source).
 *
 * `runRouteAssertions` is async, so an assertion may issue real requests.
 */
import type { Express, Router } from 'express';
import { V1_PREFIX } from './testSupport.js';

/** One mounted route. */
export interface EnumeratedRoute {
  /** Upper-case HTTP method: 'GET', 'POST', … */
  method: string;
  /** Full path including the `/api/v1` prefix, with `:params` intact. */
  path: string;
  /** The handler chain, in order. Lets a clause inspect middleware. */
  handlers: unknown[];
}

// Express's internals are untyped. Narrow shims rather than `any` everywhere.
interface ExpressLayer {
  route?: {
    path: string | string[];
    stack: { method?: string; handle?: unknown }[];
  };
  name?: string;
  handle?: { stack?: ExpressLayer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: { name: string | number }[];
}

/**
 * Recovers the mount path of a sub-router from the RegExp Express compiled it
 * into. There is no public API for this — `layer.path` is only populated for
 * routes, not for mounted routers — so the source has to be decoded.
 *
 * Express 4 builds these with path-to-regexp 0.1.7, so the shapes are fixed and
 * few: `/^\/api\/v1\/?(?=\/|$)/i` for a literal mount, with `(?:([^\/]+?))` in
 * place of each `:param`. `fast_slash` marks a router mounted at '/'.
 */
function decodeMountPath(layer: ExpressLayer): string {
  const regexp = layer.regexp;
  if (!regexp || regexp.fast_slash) return '';

  let source = regexp.source;

  // Trailing forms: `\/?(?=\/|$)` for a mount, `\/?$` for a terminal route.
  source = source.replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
  source = source.replace(/\\\/\?\$$/, '');
  source = source.replace(/^\^/, '').replace(/\$$/, '');

  // Each param capture group becomes `:name`, in declaration order.
  const keys = layer.keys ?? [];
  let keyIndex = 0;
  source = source.replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, () => {
    const key = keys[keyIndex++];
    return `:${key ? String(key.name) : 'param'}`;
  });

  // Unescape what path-to-regexp escaped.
  source = source.replace(/\\(.)/g, '$1');

  return source;
}

/** Joins path segments without doubling or dropping slashes. */
function joinPaths(prefix: string, suffix: string): string {
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = suffix.startsWith('/') || suffix === '' ? suffix : `/${suffix}`;
  const joined = `${left}${right}`;
  return joined === '' ? '/' : joined;
}

function walkLayers(layers: ExpressLayer[], prefix: string, out: EnumeratedRoute[]): void {
  for (const layer of layers) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const routePath of paths) {
        const fullPath = joinPaths(prefix, routePath);
        const handlers = layer.route.stack.map((s) => s.handle);
        // One entry per METHOD: `.get()` and `.post()` on one path are two
        // routes for every clause that matters (scope, OpenAPI entry, shape).
        const methods = new Set(
          layer.route.stack
            .map((s) => s.method)
            .filter((m): m is string => typeof m === 'string'),
        );
        for (const method of methods) {
          out.push({ method: method.toUpperCase(), path: fullPath, handlers });
        }
      }
      continue;
    }

    // A mounted router — descend, extending the prefix.
    const nested = layer.handle?.stack;
    if (nested) {
      walkLayers(nested, joinPaths(prefix, decodeMountPath(layer)), out);
    }
  }
}

/**
 * Reads the top-level layer stack off an app or a router, across Express versions.
 *
 * The `try` is not defensive padding. Express 4 lazily creates `app._router` on
 * the first `use`/`get`, so on an app with no routes yet it is `undefined` — and
 * the next candidate, `app.router`, is a **getter Express 4 defines purely to
 * throw** `'app.router' is deprecated!`. So the plain `??` chain turns "an app
 * with no routes" into a thrown error rather than an empty list.
 *
 * That matters here specifically: the callers most likely to hand this a
 * route-less app are the ones checking the vacuous case on purpose — PF-232's
 * anti-vacuity fixture and PF-228's wiring assertion, both of which need "zero
 * routes" to be a value they can reason about. Express 5 makes `app.router` the
 * real accessor, which is why the branch stays.
 */
function rootStack(target: Express | Router): ExpressLayer[] {
  const candidate = target as unknown as {
    _router?: { stack?: ExpressLayer[] };
    router?: { stack?: ExpressLayer[] };
    stack?: ExpressLayer[];
  };
  if (candidate._router?.stack) return candidate._router.stack;
  try {
    if (candidate.router?.stack) return candidate.router.stack;
  } catch {
    // Express 4's deprecation getter. Not an error condition — it means "this is
    // Express 4 and nothing has been mounted yet".
  }
  return candidate.stack ?? [];
}

/**
 * PF-200 — every route mounted under `/api/v1`, walked from the live app.
 *
 * There is no hand-maintained list anywhere in this function, which is the
 * point: a route added by any lane appears here with no edit to the harness, and
 * therefore inherits every registered clause automatically. A list would go
 * stale exactly when it mattered — the day someone adds a route and forgets.
 *
 * Returns routes in mount order. Sub-routers are walked recursively.
 */
export function enumerateV1Routes(app: Express, prefix: string = V1_PREFIX): EnumeratedRoute[] {
  const all: EnumeratedRoute[] = [];
  walkLayers(rootStack(app), '', all);
  return all.filter((route) => route.path === prefix || route.path.startsWith(`${prefix}/`));
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-202 — the registration seam
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteAssertionContext {
  route: EnumeratedRoute;
  app: Express;
}

export type RouteAssertionFn = (ctx: RouteAssertionContext) => void | Promise<void>;

export interface RegisteredRouteAssertion {
  name: string;
  fn: RouteAssertionFn;
}

const assertions: RegisteredRouteAssertion[] = [];

/**
 * Adds a Testing Scenario 4 clause. See the module docstring for the owning-lane
 * table and a worked example.
 *
 * Registering the same `name` twice replaces the first — importing a clause
 * module from two specs is normal and must not double-run it.
 */
export function registerRouteAssertion(name: string, fn: RouteAssertionFn): void {
  const existing = assertions.findIndex((a) => a.name === name);
  if (existing >= 0) {
    assertions[existing] = { name, fn };
    return;
  }
  assertions.push({ name, fn });
}

/** Every registered clause, in registration order. */
export function listRouteAssertions(): readonly RegisteredRouteAssertion[] {
  return [...assertions];
}

/** Test-isolation escape hatch. Not for production code. */
export function clearRouteAssertions(): void {
  assertions.length = 0;
}

export interface RouteAssertionFailure {
  assertion: string;
  route: string;
  error: Error;
}

/**
 * Runs every registered clause against every enumerated route.
 *
 * Collects failures rather than throwing on the first: when a new clause lands
 * and forty routes fail it, "all forty, here they are" is a work list, while
 * "the first one" is forty more runs.
 */
export async function runRouteAssertions(
  app: Express,
  prefix: string = V1_PREFIX,
): Promise<RouteAssertionFailure[]> {
  const routes = enumerateV1Routes(app, prefix);
  const failures: RouteAssertionFailure[] = [];

  for (const route of routes) {
    for (const { name, fn } of assertions) {
      try {
        await fn({ route, app });
      } catch (err) {
        failures.push({
          assertion: name,
          route: `${route.method} ${route.path}`,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  return failures;
}
