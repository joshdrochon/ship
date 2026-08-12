/**
 * One metadata record per route (PF-228), carrying every lane's per-route
 * declaration. Registered at wiring time, read by the fitness harness.
 *
 * ## Why one record and not one per lane
 *
 * L03 needs a scope per route (PF-072). L08 needs a pagination mode per route.
 * L13 needs an OpenAPI operation per route. Three separate registries would mean
 * three lists that can disagree about which routes exist, and the disagreement
 * would show up as a clause passing vacuously — a route missing from L08's list
 * is a route clause (d) never checks, which is silence, not a failure.
 *
 * So: one record, `declareRoute()`, keyed by `METHOD /path`. L03's `scope` field
 * is declared here as optional TODAY because L03's `require-scope.ts` is not on
 * this branch; when the lanes merge it becomes required and this comment goes.
 *
 * ## Why `list` has no default
 *
 * PF-228: `list: 'cursor' | 'none' | false` is REQUIRED. A default would make
 * "the author did not think about pagination" indistinguishable from "the author
 * decided this route does not paginate", and clause (d) of Testing Scenario 4 is
 * exactly the check that those are different. `createApp()` throwing at wiring
 * time is the same discipline as PF-068: a defect that fails at boot is found by
 * whoever caused it, a defect that fails in a test is found by whoever runs the
 * suite next.
 */

/**
 * How a route paginates.
 *
 *   'cursor'  a collection backed by a database table. MUST return
 *             `{ data, next_cursor }` and MUST accept `limit` and `cursor`.
 *   'none'    a collection whose length is a compile-time constant. Returns
 *             `{ data }` with NO `next_cursor` key.
 *   false     not a collection at all — a single resource, an action, a write.
 */
export type ListMode = 'cursor' | 'none' | false;

export interface RouteMetadata {
  method: string;
  /** Full public path including the `/api/v1` prefix. */
  path: string;
  /** PF-228. Required — see the module docstring. */
  list: ListMode;
  /**
   * The scope this route requires. L03's field (PF-072), on the same record so
   * there is one metadata object per route and not two.
   *
   * Three states, and they are three different things (see the B6 discussion in
   * `platform/scopes/route-metadata.ts`):
   *
   *   a scope name   the route requires it.
   *   `null`         an explicit declaration that it requires none. A claim.
   *   `undefined`    nobody declared. Caught by `assertEveryRouteDeclaresScope`
   *                  (PF-248) at wiring time for any MOUNTED route.
   *
   * Still optional in the type so L08's own fixture registries — which are never
   * mounted, and exist to test the pagination clause — do not have to restate a
   * field they have no opinion about. The enforcement point is the live router,
   * not this interface.
   */
  scope?: string | null;
  /** The resource name a cursor is bound to. Required when `list === 'cursor'`. */
  resource?: string;
  /**
   * PF-248 / PF-251 — the request and response schemas, on the same record.
   *
   * Typed as `unknown` rather than `z.ZodTypeAny` so this module does not take a
   * Zod dependency for a field it only stores. L13's generator narrows it; the
   * registry's job is to make sure there is exactly one place to look.
   */
  request?: unknown;
  response?: unknown;
}

export class RouteMetadataRegistry {
  private byKey = new Map<string, RouteMetadata>();

  /** `GET /api/v1/documents` — the key every lane agrees on. */
  static key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }

  /**
   * Declares a route. Throws at WIRING time on anything malformed, which is the
   * ticket: `createApp()` fails to boot rather than a test failing later.
   */
  declare(metadata: RouteMetadata): void {
    const key = RouteMetadataRegistry.key(metadata.method, metadata.path);

    if (metadata.list === undefined) {
      throw new Error(
        `${key}: route metadata is missing the required \`list\` field. ` +
          `Declare 'cursor' (a collection backed by a table), 'none' (a collection whose ` +
          `length is bounded by code), or false (not a collection). There is deliberately ` +
          `no default: "nobody thought about it" and "it does not paginate" must not look ` +
          `the same to Testing Scenario 4 clause (d).`,
      );
    }

    if (metadata.list === 'cursor' && !metadata.resource) {
      throw new Error(
        `${key}: a route declaring list:'cursor' must also declare \`resource\`. ` +
          `Cursors are bound to the collection that minted them (PF-218) — without a ` +
          `resource name a cursor from another endpoint decodes fine and returns a ` +
          `wrong-but-plausible page.`,
      );
    }

    if (this.byKey.has(key)) {
      throw new Error(
        `${key}: declared twice. Two metadata records for one route means two answers to ` +
          `"what scope does it need" and "does it paginate", and the fitness harness would ` +
          `read whichever landed last.`,
      );
    }

    this.byKey.set(key, metadata);
  }

  get(method: string, path: string): RouteMetadata | undefined {
    return this.byKey.get(RouteMetadataRegistry.key(method, path));
  }

  list(): RouteMetadata[] {
    return [...this.byKey.values()];
  }

  /** Test isolation. Not for production code. */
  clear(): void {
    this.byKey.clear();
  }
}

/**
 * The process-wide registry. A singleton for the same reason `scopeRegistry` is:
 * routes are declared at module load across many files, and threading a registry
 * through every mount function would put the wiring in every signature.
 */
export const routeMetadata = new RouteMetadataRegistry();

/**
 * PF-227 — WHERE THE PAGINATION LINE FALLS. Pre-Search 2.2 (p.16) asks; this
 * answers.
 *
 * **Any collection endpoint backed by a database table paginates. A collection
 * whose cardinality is bounded by CODE returns `{ data }` with no
 * `next_cursor`.**
 *
 * The rule is cardinality-bounded-by-code vs. bounded-by-data — deliberately not
 * "small vs. large". "Small" is a judgement that ages: `/api/v1/scopes` has seven
 * entries today and a list of seven feels small, but if scopes were rows in a
 * table then "small" would be a fact about the current data and not a property of
 * the endpoint, and the day it stopped being true nothing would tell us. A list
 * whose length is a compile-time constant CANNOT grow into a pagination bug,
 * because growing it requires editing this repository.
 *
 * Concretely today:
 *
 *   `/api/v1/documents`, `/api/v1/issues`, `/api/v1/sprints`   → 'cursor'
 *   `/api/v1/scopes`, `/api/v1/events`                         → 'none'
 *
 * `/api/v1/scopes` is `SCOPES` in `platform/scopes/registry.ts`; `/api/v1/events`
 * is L14's event-type registry. Both are `as const` arrays. If either ever moves
 * into a table, its metadata changes to 'cursor' in the same commit — and PF-231
 * is what makes forgetting visible, because a 'none' route that starts returning
 * a cursor fails the negative clause.
 */
export const PAGINATION_LINE = {
  rule:
    'A collection endpoint backed by a database table paginates with an opaque cursor. ' +
    'A collection whose cardinality is bounded by code returns { data } with no next_cursor.',
  test: 'bounded-by-code vs. bounded-by-data — not small vs. large',
} as const;

/**
 * PF-228's wiring-time half — called from `createApp()` immediately after the
 * public router is mounted.
 *
 * Walks the LIVE Express stack via `enumerateV1Routes` (PF-200) and throws if any
 * mounted route has no metadata record. Two lists cannot disagree here, because
 * one of them is not a list: the routes come from the router itself.
 *
 * Throwing at wiring time rather than in a test is the point. A test failure is
 * found by whoever runs the suite next; a boot failure is found by whoever caused
 * it, in the same minute, with the route name in the message.
 */
export function assertEveryRouteDeclaresList(
  app: import('express').Express,
  enumerate: (app: import('express').Express) => { method: string; path: string }[],
  registry: RouteMetadataRegistry = routeMetadata,
  exemptPaths: readonly string[] = [],
): void {
  const undeclared = enumerate(app)
    .filter((route) => !exemptPaths.includes(route.path))
    .filter((route) => registry.get(route.method, route.path) === undefined)
    .map((route) => RouteMetadataRegistry.key(route.method, route.path));

  if (undeclared.length === 0) return;

  throw new Error(
    `${undeclared.length} /api/v1 route(s) mounted with no metadata record:\n` +
      undeclared.map((r) => `  ${r}`).join('\n') +
      `\n\nEvery public route must declare \`list\` ('cursor' | 'none' | false) through ` +
      `routeMetadata.declare(). Testing Scenario 4 clause (d) asks "does it paginate if it ` +
      `is a list endpoint" — without the declaration that question is answered by guessing ` +
      `at the path string, and a route nobody declared is a route the clause silently skips.`,
  );
}

export interface RouteMetadataProblem {
  route: string;
  problem: string;
}

/**
 * Reports routes whose metadata is incomplete. Collects rather than throwing, so
 * a merge that lands forty routes yields forty problems as one work list.
 */
export function auditRouteMetadata(
  registry: RouteMetadataRegistry = routeMetadata,
): RouteMetadataProblem[] {
  const problems: RouteMetadataProblem[] = [];
  for (const metadata of registry.list()) {
    const key = RouteMetadataRegistry.key(metadata.method, metadata.path);
    if (metadata.list === 'cursor' && !metadata.resource) {
      problems.push({ route: key, problem: "list:'cursor' without a resource name" });
    }
    if (metadata.scope === undefined) {
      // `=== undefined`, not falsy. `scope: null` is a DECLARATION that the route
      // needs no particular permission (L10's `GET /api/v1/me`), and reporting it
      // as a problem is what pushes an author to invent an eighth scope to quiet
      // the report — which would break PF-062's exactly-seven assertion.
      problems.push({ route: key, problem: 'no scope declared (L03 PF-072)' });
    }
  }
  return problems;
}
