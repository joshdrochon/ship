/**
 * Testing Scenario 4 **clause (a)** — L13's clause, plus the reverse direction
 * the clause structurally cannot cover.
 *
 * Tickets: PF-373 (forward parity, through L07's seam), PF-375 (reverse parity),
 * PF-376 (both fail loudly on an empty input).
 *
 * PRD p.5, clause (a): every `/api/v1` route *"has an OpenAPI entry"*. PRD p.11:
 * *"The fitness test that asserts spec ↔ route parity is the single best defense
 * against drift."*
 *
 * ## Forward is registered; reverse is a separate function, and that is not an
 * inconsistency
 *
 * `registerRouteAssertion` runs a clause **per enumerated route** — that is
 * exactly the shape of "every route has a spec entry", so forward parity goes
 * through the seam like L07's and L08's clauses do. There is no second route
 * walk here; `assertRouteHasSpecEntry` receives the route the harness found.
 *
 * Reverse parity asks the opposite question — "does every spec operation have a
 * route" — which is per-OPERATION, not per-route, and there is no seam for that
 * because no other lane needs one. Expressing it through the route seam would
 * mean re-deriving the full route set inside a per-route callback and running the
 * whole comparison once per route: N² work and N copies of every failure message.
 * So it is a function the spec calls once, and it takes the enumerator as an
 * argument rather than importing a second one.
 *
 * ## Why the reverse direction is the one that matters most
 *
 * Forward parity catches a route somebody forgot to document. Reverse parity
 * catches a documented endpoint that does not exist — which is literally what
 * *"hand-written specs lie within a week"* describes. A consumer who writes code
 * against a phantom operation finds out at runtime, in production, on their side.
 */
import type { Express } from 'express';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import {
  registerRouteAssertion,
  type EnumeratedRoute,
  type RouteAssertionContext,
} from '../api/v1/routeFitness.js';
import { generatePublicOpenAPIDocument, publicRegistry } from './registry.js';
import { toOpenApiPath } from './operations.js';
import { listSpecOperations } from './specOperations.js';

export interface ParityOptions {
  /** The document to compare against. Defaults to generating from `publicRegistry`. */
  spec?: OpenAPIObject;
}

let options: ParityOptions = {};

/** Points the clause at a fixture document. Called by a spec, not by app code. */
export function configureParityClause(next: ParityOptions): void {
  options = next;
}

function currentSpec(): OpenAPIObject {
  return options.spec ?? generatePublicOpenAPIDocument(publicRegistry);
}

/**
 * PF-373 — clause (a). For one enumerated route, assert the spec has its
 * operation.
 *
 * The path is normalized by `toOpenApiPath`, the SAME function the generator
 * used to produce the key (PF-374). Two normalizers would mean this test fails on
 * a formatting difference or passes on a coincidence, and both look identical
 * from the outside.
 */
export function assertRouteHasSpecEntry({ route }: RouteAssertionContext): void {
  const spec = currentSpec();
  const path = toOpenApiPath(route.path);
  const method = route.method.toLowerCase();

  const pathItem = spec.paths?.[path];
  if (!pathItem) {
    throw new Error(
      `${route.method} ${route.path} has no OpenAPI entry — the generated spec has no ` +
        `\`paths["${path}"]\` at all. Every public route's operation is produced by its own ` +
        `declareV1Route() call (PF-358); a route mounted with a bare router.get() bypasses ` +
        `that and is invisible to every consumer. Known spec paths: ` +
        `${Object.keys(spec.paths ?? {}).join(', ') || '(none)'}`,
    );
  }

  if (!(method in pathItem)) {
    throw new Error(
      `${route.method} ${route.path} has no OpenAPI entry — \`paths["${path}"]\` exists but ` +
        `declares no \`${method}\`. It declares: ` +
        `${Object.keys(pathItem).join(', ')}. A path documented for one method and mounted ` +
        `for two is the drift this clause exists to catch.`,
    );
  }
}

/**
 * PF-375 — the reverse direction. Every spec operation maps to a mounted route.
 *
 * PF-376's guard is in here rather than in the caller: both parity directions
 * pass **vacuously** on an empty input, and p.6 sets the target at 100% — 0 of 0
 * is 100%. The two failure messages are deliberately different, because "the
 * enumerator found nothing" and "the generator produced nothing" have completely
 * different causes and the same green tick.
 *
 * Repo precedent for exactly this class of guard: `scripts/assert-tests-ran.sh`
 * already wraps the agent and E2E suites in CI for the same reason.
 */
export function assertSpecMatchesRoutes(
  routes: readonly EnumeratedRoute[],
  spec: OpenAPIObject,
): void {
  if (routes.length === 0) {
    throw new Error(
      'Spec↔route parity was asked to compare ZERO routes. The enumeration is empty, so both ' +
        'directions would pass without checking anything — 0 of 0 routes documented is 100%. ' +
        'Either the app was built without mounting its resources, or enumerateV1Routes() is ' +
        'walking the wrong prefix.',
    );
  }

  const specPaths = Object.keys(spec.paths ?? {});
  if (specPaths.length === 0) {
    throw new Error(
      'Spec↔route parity was asked to compare against a spec with ZERO paths. The generator ' +
        'produced an empty document, which passes the reverse direction vacuously. Either no ' +
        'route module was imported before generation (registration happens at module load), ' +
        'or the routes were declared into a different registry instance.',
    );
  }

  const mounted = new Set(
    routes.map((route) => `${route.method.toLowerCase()} ${toOpenApiPath(route.path)}`),
  );

  const phantom = listSpecOperations(spec)
    .filter((operation) => !mounted.has(`${operation.method} ${operation.path}`))
    .map((operation) => `${operation.method.toUpperCase()} ${operation.path} (${operation.operationId})`);

  if (phantom.length === 0) return;

  throw new Error(
    `${phantom.length} operation(s) in the generated spec have no mounted route:\n` +
      phantom.map((p) => `  ${p}`).join('\n') +
      `\n\nThis is the direction "hand-written specs lie" actually describes — a documented ` +
      `endpoint that does not exist. A consumer who writes code against it finds out at ` +
      `runtime, on their side. Mounted routes: ${[...mounted].sort().join(', ')}`,
  );
}

/**
 * PF-373 — registers clause (a) through PF-202's seam.
 *
 * Import this module from any spec that runs `runRouteAssertions`, and clause (a)
 * appears in the same failure report as clauses (c) and (d).
 */
export function registerOpenApiParityAssertions(): void {
  registerRouteAssertion(
    'L13 (a): every route has an OpenAPI entry',
    assertRouteHasSpecEntry,
  );
}

/** Convenience for a spec that has an app and wants both directions in one call. */
export function assertParity(
  app: Express,
  enumerate: (app: Express) => EnumeratedRoute[],
  spec: OpenAPIObject = currentSpec(),
): void {
  const routes = enumerate(app);
  assertSpecMatchesRoutes(routes, spec);
  for (const route of routes) {
    assertRouteHasSpecEntry({ route, app });
  }
}
