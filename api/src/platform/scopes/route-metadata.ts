/**
 * PF-072 — route-level scope metadata, introspectable without parsing source.
 *
 * Three consumers, which is why this is a record and not a comment:
 *
 *   - PF-079's fitness test, which fails any `/api/v1` route that does not
 *     declare a registered scope;
 *   - L13's OpenAPI generator, which needs the required scope per operation to
 *     emit a `security` block;
 *   - the developer portal (L22), which lists what each endpoint needs.
 *
 * None of those can read a `requireScope(...)` call out of an Express router at
 * runtime — Express keeps the handler, not its arguments. So the declaration is
 * recorded here at the moment the route is wired, by the same call that installs
 * the guard (`declareRoute`), which is what keeps the metadata and the actual
 * enforcement from drifting apart.
 *
 * ## Declared-null vs. forgot-to-declare (dispute B6)
 *
 * `GET /api/v1/me` resolves the token's own identity. It cannot require a scope:
 * the PRD registers exactly seven (p.3) and PF-062 asserts exactly seven, so
 * inventing `me:read` to make a fitness test go green would break the MVP gate
 * item the fitness test exists to protect. L10's PF-271 declares `scope: null`.
 *
 * That is a *different thing* from a route whose author never thought about
 * scopes at all, and PF-079 has to fail the second while passing the first. They
 * are distinguished structurally, not by convention:
 *
 *   scope: null        an explicit declaration that the route needs no scope.
 *                      `'scope' in record` is true and the value is `null`.
 *   scope: undefined   the property exists but carries nothing. Rejected by
 *                      `declareRoute` at wiring time — a route cannot be
 *                      declared into an undeclared state.
 *   no record at all   the route was mounted on the router without going
 *                      through `declareRoute`. This is the real
 *                      forgot-to-declare case, and it is invisible to anything
 *                      that only reads this table. PF-079 catches it by walking
 *                      the Express router stack and cross-referencing, not by
 *                      trusting this table to be complete.
 *
 * The third case is the one that matters. A table of declarations can only ever
 * prove things about routes that declared; the router stack is the ground truth
 * for which routes exist.
 */
import type { Scope } from './scopes.js';

/** The HTTP methods the public surface uses. Express lowercases its own. */
export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * A route's scope declaration.
 *
 * `scope` is a **required** property whose type includes `null`. Required rather
 * than optional on purpose: `{ method, path }` with no `scope` key is a compile
 * error, so forgetting is caught by `tsc` for every route that goes through
 * `declareRoute`, and PF-079 only has to catch the routes that bypassed it.
 */
export interface RouteScopeDeclaration<S extends string = Scope> {
  readonly method: HttpMethod;
  /** Path as mounted on the v1 router, e.g. `/documents/:id`. */
  readonly path: string;
  /**
   * The scope this route requires, or `null` for "declared as requiring none".
   *
   * `null` is a claim the author makes and the fitness test honours. It is not a
   * default and there is no default — see the module header.
   */
  readonly scope: S | null;
}

/**
 * The declarations for one router. An instance rather than a module-level
 * singleton so a test can build a two-route fixture (PF-072) without leaking
 * into the table the real router uses.
 */
export class RouteScopeTable<S extends string = Scope> {
  readonly #routes: RouteScopeDeclaration<S>[] = [];

  /**
   * Record a declaration.
   *
   * Rejects an `undefined` scope explicitly. TypeScript already makes the
   * property required, but this table is also reachable from JavaScript (the
   * OpenAPI generator, a future portal build step) and the distinction the whole
   * module rests on is worth one runtime check.
   */
  declare(route: RouteScopeDeclaration<S>): RouteScopeDeclaration<S> {
    if (!('scope' in route) || route.scope === undefined) {
      throw new Error(
        `Route ${route.method.toUpperCase()} ${route.path} was declared without a scope. ` +
          `Every public route states what it requires; a route that genuinely needs none ` +
          `declares \`scope: null\`, which is a claim, not a default.`,
      );
    }
    this.#routes.push(route);
    return route;
  }

  /** Every declaration, in registration order. */
  list(): readonly RouteScopeDeclaration<S>[] {
    return [...this.#routes];
  }

  /** The declaration for one route, or `undefined` if it never declared. */
  find(method: HttpMethod, path: string): RouteScopeDeclaration<S> | undefined {
    return this.#routes.find((r) => r.method === method && r.path === path);
  }

  get size(): number {
    return this.#routes.length;
  }
}

/** The table the mounted `/api/v1` router declares into. */
export const routeScopes = new RouteScopeTable();
