/**
 * PF-067 – PF-071 — the `require(scope)` middleware factory.
 *
 * MVP gate item 4 (PRD p.2): *"Each route declares its required scope via a
 * `require(scope)` middleware factory."* MVP gate item 6 (p.2): *"insufficient
 * scope returns 403 with the missing scope named explicitly in the error body
 * (no opaque 'forbidden')."*
 *
 * There are no scope names in this file, and there is no scope prose in this
 * file. Both live in `scopes.ts`; this file reads them out of a registry it is
 * handed. That is not stylistic — PF-070 asserts it with a grep over this
 * source, because the moment a description is written here there are two copies
 * of it and the consent screen and the 403 start telling users different things
 * about the same permission.
 *
 * Three outcomes, and the difference between the first two is the whole point:
 *
 *   no auth context      401 `unauthorized` — the caller has no token, or the
 *                        token did not resolve. An SDK reacts by refreshing or
 *                        re-authenticating. (PF-071)
 *   token lacks scope    403 `forbidden` with `details.missing_scope` — the
 *                        caller is who they say they are and still may not do
 *                        this. An SDK reacts by sending the user back through
 *                        consent, which is a different and much more disruptive
 *                        thing to do. Conflating these two makes an SDK loop.
 *   token has scope      next()
 *
 * ## Wiring-time failure (PF-068)
 *
 * An unregistered scope is a defect in the program, not a condition to handle at
 * request time. A guard built on a misspelled scope throws when the factory is
 * called — which is at module load, inside `createApp()` — so the process fails
 * to boot rather than serving a 403 to every caller of a route nobody can reach.
 * A typo that returns 403 forever looks exactly like a permissions problem from
 * the outside and gets debugged for an hour.
 *
 * (No scope name is spelled out even in these comments, misspelled or not: the
 * PF-070 grep does not read comments differently from code, and it is right not
 * to. A name in a comment goes stale exactly the same way.)
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError } from '../api/v1/errors.js';
import type { ScopeRegistry } from './registry.js';
import { scopeRegistry, type Scope } from './scopes.js';
import type { PlatformAuthContext } from './auth-context.js';
import { type HttpMethod, type RouteScopeTable, routeScopes } from './route-metadata.js';
import { reconcileTokenScopes } from './validation.js';

/** Where a guard is mounted, used only to make the boot-time error locatable. */
export interface RouteRef {
  method: HttpMethod;
  path: string;
}

export interface RequireScopeOptions<S extends string> {
  /**
   * The registry the guard reads. Defaults to the production one.
   *
   * Injectable because PF-066's Open/Closed proof registers a scope production
   * has never heard of and drives a guarded handler to 200 and 403 with this
   * file untouched. If the guard reached for a module-level singleton, that
   * proof could only be written by mutating global state, and "adding a scope
   * needs no middleware edit" would be a claim rather than a test.
   */
  registry?: ScopeRegistry<S>;
  /** Set by `declareRoute` so PF-068's message names the route, not just the scope. */
  route?: RouteRef;
}

/** Thrown at wiring time when a route guards on a scope nobody registered. */
export class UnregisteredScopeError extends Error {
  readonly scope: string;

  constructor(scope: string, route?: RouteRef) {
    const where = route ? ` (mounted at ${route.method.toUpperCase()} ${route.path})` : '';
    super(
      `Route guard requires scope "${scope}"${where}, which is not registered. ` +
        `Scopes register at module load in platform/scopes/scopes.ts; a guard on an ` +
        `unregistered name is a typo, not an authorization outcome, and would otherwise ` +
        `403 every caller forever.`,
    );
    this.name = 'UnregisteredScopeError';
    this.scope = scope;
  }
}

/**
 * Read the auth context off the response locals.
 *
 * Exported so bearer auth (L06) and the audit sink (L12) agree on the key
 * without either of them writing the string twice.
 */
export const PLATFORM_AUTH_LOCAL = 'platformAuth';

/**
 * Where PF-075 leaves scopes the presented token carried and the registry no
 * longer knows, for L12's audit sink to record against `scope used` (p.4).
 *
 * On `res.locals` rather than returned, because the guard's return channel is
 * `next()` and the audit sink runs after the response. Absent when there is
 * nothing to report — an empty array here and "never checked" would be
 * indistinguishable.
 */
export const UNRECOGNIZED_SCOPES_LOCAL = 'unrecognizedScopes';

export function getPlatformAuth(res: Response): PlatformAuthContext | undefined {
  return res.locals[PLATFORM_AUTH_LOCAL] as PlatformAuthContext | undefined;
}

/** What the token carried that the registry has forgotten, if anything. */
export function getUnrecognizedScopes(res: Response): string[] {
  return (res.locals[UNRECOGNIZED_SCOPES_LOCAL] as string[] | undefined) ?? [];
}

/**
 * Build the per-route guard.
 *
 * The single-argument overload takes only a registered `Scope`, which is what
 * makes a guard on an unregistered name a **compile** error (PF-064; the
 * `@ts-expect-error` fixture in the test suite spells out the name). The
 * two-argument overload is generic over a supplied registry's own union, so a
 * test registry can carry scopes production has never heard of without a cast.
 */
export function requireScope(scope: Scope): RequestHandler;
export function requireScope<S extends string>(
  scope: S,
  options: RequireScopeOptions<S> & { registry: ScopeRegistry<S> },
): RequestHandler;
export function requireScope(
  scope: string,
  options: RequireScopeOptions<string> = {},
): RequestHandler {
  return buildGuard(scope, options);
}

/**
 * The single implementation both public entry points share.
 *
 * Separate from `requireScope` so `declareRoute` can reach it without either
 * re-deriving the overload's type argument or casting through `unknown` — the
 * overloads exist to make an unregistered scope a compile error for *callers*,
 * and satisfying them from inside the module would be paying that cost twice for
 * no benefit.
 */
function buildGuard(scope: string, options: RequireScopeOptions<string>): RequestHandler {
  const registry: ScopeRegistry<string> = options.registry ?? scopeRegistry;

  // PF-068 — at wiring time, not at request time.
  if (!registry.has(scope)) {
    throw new UnregisteredScopeError(scope, options.route);
  }

  // Resolved once, at wiring time. The definition cannot change afterwards:
  // `register` throws on a duplicate (PF-065), so there is no path by which a
  // registered description is replaced under a running guard.
  const definition = registry.get(scope)!;

  return function requireScopeMiddleware(_req: Request, res: Response, next: NextFunction): void {
    const auth = getPlatformAuth(res);

    // PF-071 — absent context is 401, never 403. "I don't know who you are" and
    // "I know who you are and the answer is no" are different instructions to
    // the caller, and an SDK that cannot tell them apart either refreshes a
    // token that was fine or re-consents a user who did not need to.
    if (!auth) {
      next(
        new ApiError(
          'unauthorized',
          'This endpoint requires an access token. Present one as `Authorization: Bearer <token>`.',
        ),
      );
      return;
    }

    // PF-075 — what the token carries is not the same question as what it still
    // means. A name the registry has forgotten grants nothing, and the fact that
    // the token carried it is recorded rather than dropped, so the audit trail
    // (L12) can show an operator that a deregistration broke a live integration.
    const { effective, unrecognized } = reconcileTokenScopes(auth.scopes, registry);
    if (unrecognized.length > 0) {
      res.locals[UNRECOGNIZED_SCOPES_LOCAL] = unrecognized;
    }

    if (effective.includes(definition.scope as Scope)) {
      next();
      return;
    }

    // PF-069 / PF-070 — the missing scope by machine-readable name, the granted
    // set so a caller can see what it does have, and the registry's own prose so
    // the message a developer reads is the same sentence the user consented to.
    next(
      new ApiError(
        'forbidden',
        `Your access token does not carry the "${definition.scope}" scope, which this endpoint requires.`,
        {
          missing_scope: definition.scope,
          granted_scopes: effective,
          scope_description: definition.description,
          // Only when there is something to say. A caller whose token is fine
          // should not have to reason about an always-empty field.
          ...(unrecognized.length > 0 ? { unrecognized_scopes: unrecognized } : {}),
        },
      ),
    );
  };
}

/**
 * PF-067 + PF-072 — declare a route's scope and install its guard in one call.
 *
 * Two things have to be true of every public route: it is guarded, and its
 * requirement is introspectable (L13's OpenAPI generator and PF-079's fitness
 * test both read the table). Doing those in two separate calls is doing them
 * twice, and the second one is what gets forgotten — so this does both, and a
 * route that guards without declaring is not a shape the codebase offers.
 *
 * `scope: null` installs a pass-through. That is not "unauthenticated": bearer
 * auth (L06) sits upstream of the whole v1 router, so `GET /api/v1/me` still
 * needs a valid token. It means the route requires no *particular* permission
 * beyond having a token at all — see the B6 discussion in `route-metadata.ts`.
 */
export function declareRoute(scope: Scope | null, route: RouteRef): RequestHandler;
export function declareRoute<S extends string>(
  scope: S | null,
  route: RouteRef,
  options: { registry: ScopeRegistry<S>; table?: RouteScopeTable<S> },
): RequestHandler;
export function declareRoute(
  scope: string | null,
  route: RouteRef,
  options: { registry?: ScopeRegistry<string>; table?: RouteScopeTable<string> } = {},
): RequestHandler {
  const table = options.table ?? (routeScopes as unknown as RouteScopeTable<string>);
  table.declare({ method: route.method, path: route.path, scope });

  if (scope === null) {
    return function noScopeRequired(_req: Request, _res: Response, next: NextFunction): void {
      next();
    };
  }

  return buildGuard(scope, { route, ...(options.registry ? { registry: options.registry } : {}) });
}
