/**
 * `GET /api/v1/me` — who is this token.
 *
 * Tickets: PF-271 (`scope: null`, explicitly declared), PF-272 (a public schema,
 * not `/api/auth/me`'s body), PF-273 (resolves from the bearer token, never from
 * a session), PF-274 (names the acting app and the granted scopes), PF-275 (not
 * a collection, and no query parameters).
 *
 * MVP gate item 8 (PRD p.2): *"SDK skeleton exists in a pnpm workspace package;
 * `new ShipClient({ token }).me()` against a running server returns the typed
 * authenticated user."* L17 owns the client; this is the server half, and until
 * it existed the gate clause could not close on the production surface — the
 * route was reported missing by `sdkGate.test.ts` §1 rather than stubbed.
 *
 * Testing Scenario 3 (p.5) ends with *"confirm the resulting token works against
 * /api/v1/me"*, so L05's device-grant scenario also resolves through this file.
 *
 * ## PF-271 — this route declares `scope: null`, and that is a claim
 *
 * PRD p.3 registers exactly seven scopes and PF-062 asserts exactly seven; MVP
 * gate item 6 resolves through that assertion. None of the seven names the
 * authenticated identity, and inventing an eighth to satisfy a fitness test
 * would break a graded one.
 *
 * `declareV1Route` requires the `scope` key to be PRESENT — `{method, path}`
 * with no `scope` is a compile error and an explicit `undefined` throws at
 * wiring time. So `null` here is a declaration, not an omission, and L03's
 * `auditRouterScopes` tells the two apart by design: `undeclared` (nobody said)
 * and `unregistered` (said something that does not exist) are separate failure
 * kinds, and neither is what this route is.
 *
 * Requiring `documents:read` was the other alternative and it is worse than it
 * looks: a webhooks-only app — one that holds `webhooks:manage` and nothing else
 * — could not discover who it is, which makes `ship login` unable to print what
 * it was authorized for.
 *
 * ## PF-273 — the token, never the session
 *
 * There is no session middleware in this router at all (PF-211), so a request
 * carrying a valid Ship session cookie and no `Authorization` header 401s. That
 * is a property of the composition, not of this handler, and it is the reason
 * the handler CAN'T get it wrong: `res.locals.platformAuth` is the only identity
 * in scope, and `identityService.user()` takes a `userId` argument rather than a
 * request, so there is nothing else to read.
 *
 * ## The publish site is not here
 *
 * There is no write on this route, so there is no event. Stated because the
 * fitness grep over `platform/api/v1/**` for `.publish(` is lane-wide, and a
 * reader should not have to wonder whether this file is an exception.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError } from '../errors.js';
import { declareV1Route } from '../declareV1Route.js';
import { getPlatformAuth } from '../../../scopes/require-scope.js';
import type { IOAuthAppRepo } from '../../../apps/repo.js';
import type { Database } from '../../../../db/client.js';
import { createIdentityService, type IdentityService } from '../../../../services/identity.js';
import { meSchema, type Me } from './me.schema.js';

export interface MeRouteDeps {
  db: Database;
  service: IdentityService;
  /**
   * PF-274's app half. `PlatformAuthContext` carries `appId` and `clientId` but
   * not the app's NAME, and the name is what a consent-aware CLI prints.
   *
   * Injected rather than solved by widening the auth context, which is L06's
   * interface: adding a field there to save one lookup on one route would put a
   * string on every request in the process for the benefit of the least-hot
   * route on the surface. If `me` ever becomes hot enough for the extra query to
   * matter, the fix is a cache in the repository, not a wider context.
   */
  appsRepo: IOAuthAppRepo;
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-271 — the declaration, made ONCE at module load.
//
// Same discipline as L09's `documents/routes.ts`: `routeMetadata.declare()`
// throws on a duplicate key and a test suite builds many apps, so the record is
// created when this module is first imported and `mountMe` only mounts.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `list: false`, and NOT `'none'` — a deliberate departure from PF-275's text.
 *
 * PF-275 asks for `list: 'none'` so that clause (d) of Testing Scenario 4 has a
 * real subject for its negative half instead of a fixture. The intent is right
 * and the mechanism does not fit: L08's `assertNoCursorOnFixedList`
 * (`paginationAssertion.ts`) asserts that a `'none'` route's body has an ARRAY
 * at `data` — because `'none'` means *a collection whose cardinality is bounded
 * by code*, per `routeMetadata.ts`'s own definition. `me` is not a collection at
 * all; it returns one object. Declaring `'none'` would fail L08's clause with
 * "`data` is not an array", which is L08 being correct.
 *
 * `false` — *"not a collection at all — a single resource"* — is what this route
 * is. The observable half of PF-275 is kept and tested regardless: the body
 * carries no `next_cursor` key, and `?limit=1` is rejected rather than ignored.
 *
 * The consequence PF-275 was actually worried about survives and is reported:
 * PF-231's negative half still has no non-fixture subject on the public surface.
 * The routes that would give it one are `/api/v1/scopes` and `/api/v1/events`,
 * which are L03's and L14's — not this lane's, and not inventable here.
 */
const meGuard = declareV1Route({
  method: 'get',
  path: '/me',
  scope: null,
  list: false,
  response: meSchema,
  summary: 'The authenticated caller: which app, which user, and what the token may do.',
  description:
    'Resolves the presented bearer token into the app it was issued to, the user who ' +
    'consented (null for a machine-to-machine token), and the scopes the token actually ' +
    'carries — which may be a subset of the scopes the app requested. Requires no scope: ' +
    'a token can always discover its own identity.',
});

/**
 * PF-275 — no query parameters at all, and `limit` least of all.
 *
 * Not `assertAllowedQueryParams` from `page.ts`: that helper allows `limit` and
 * `cursor` unconditionally, because every route it was written for is a
 * cursor-paginated list. On a route that is not a collection, `?limit=1` being
 * accepted-and-ignored is exactly the silent success PF-226's decision exists to
 * prevent — a caller who sends it believes something happened.
 *
 * The message names the whole situation rather than the parameter, because the
 * caller's actual mistake is thinking this endpoint is a list.
 */
function rejectQueryParams(query: Record<string, unknown>): void {
  const keys = Object.keys(query);
  if (keys.length === 0) return;

  throw new ApiError('validation_failed', 'The request query is not valid.', {
    details: {
      fields: keys.map((field) => ({
        field,
        message:
          'This endpoint accepts no query parameters. It returns exactly one object — the ' +
          'identity behind the presented token — so there is nothing to page, filter or sort.',
      })),
    },
  });
}

/** Wraps an async handler so a rejection reaches `apiErrorMiddleware`. */
function handler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/**
 * Mounts the route. Called through `createPublicRouter`'s `mountResources` hook
 * so it lands ABOVE the unknown-path catch-all.
 */
export function mountMe(router: Router, deps: MeRouteDeps): void {
  router.get(
    '/me',
    meGuard,
    handler(async (req, res) => {
      rejectQueryParams(req.query as Record<string, unknown>);

      const auth = getPlatformAuth(res);
      if (!auth) {
        // Unreachable behind bearer auth, which 401s on a missing context. Kept
        // as a throw rather than a `!` so a future reorder of the middleware
        // stack fails loudly instead of reporting an undefined identity as a
        // successful one — which on THIS route would be the worst possible
        // failure mode.
        throw new ApiError('unauthorized', 'This endpoint requires an access token.');
      }

      // PF-273: `auth.userId` and nothing else. There is no `req.userId` on this
      // surface and no session to fall back to, so a `?user_id=` parameter is
      // already a 422 from `rejectQueryParams` above and could not have been
      // read here anyway.
      const user = await deps.service.user({
        workspaceId: auth.workspaceId,
        userId: auth.userId,
        db: deps.db,
      });

      // ── the two "cannot happen" branches, and why they are 500s ─────────
      //
      // Both are UNREACHABLE while the token resolves, and the schema is what
      // makes that true rather than an assumption: `oauth_tokens.user_id` and
      // `oauth_tokens.app_id` are both `ON DELETE RESTRICT` (migration 043,
      // `:83` and `:77`), so neither row can be deleted while a token points at
      // it, and a token whose row is gone 401s in L06 before reaching here.
      //
      // So arriving here means a database invariant is broken, which is a
      // SERVER fault. A plain `Error` becomes L07's scrubbed 500 — already in
      // every operation's documented response set — rather than a 404, which
      // would be a client-shaped answer to a server-shaped problem AND an
      // undocumented status: L13 derives `404` from the presence of a path
      // parameter, and `/me` has none. Keeping the failure inside the derived
      // response set is what lets PF-294 hold (zero lines under
      // `platform/openapi/`) without the spec quietly becoming wrong.
      if (user === undefined) {
        throw new Error(
          `A resolved token names user ${auth.userId}, which has no row in \`users\`. ` +
            `oauth_tokens.user_id is ON DELETE RESTRICT, so this should be unreachable — ` +
            `either the constraint was dropped or the token was resolved without a database.`,
        );
      }

      const app = await deps.appsRepo.findById(auth.appId);
      if (!app) {
        throw new Error(
          `A resolved token names app ${auth.appId}, which the app repository does not have. ` +
            `oauth_tokens.app_id is ON DELETE RESTRICT, so this should be unreachable.`,
        );
      }

      const body: Me = {
        user:
          user === null
            ? null
            : {
                id: user.id,
                email: user.email,
                name: user.name,
                workspace_id: auth.workspaceId,
              },
        // PF-274 — `client_id` and `name`, built field by field. Never the app
        // row: it carries `clientSecretHash` and spreading it here is the one
        // mistake on this route that would be a credential disclosure.
        app: { client_id: app.clientId, name: app.name },
        // The TOKEN's scopes, not the app's requested set. A user can consent to
        // a subset, and reporting the requested set would tell a CLI it may do
        // things that 403.
        scopes: [...auth.scopes],
      };

      res.json(body);
    }),
  );
}

/**
 * The `mountResources` callback the composition root composes.
 *
 * Takes the db and the apps repository and builds the service, so the
 * composition root stays the only place a concrete is chosen (PF-014/PF-015).
 */
export function meResources(deps: {
  db: Database;
  appsRepo: IOAuthAppRepo;
}): (router: Router) => void {
  const service = createIdentityService();
  return (router: Router) =>
    mountMe(router, { db: deps.db, service, appsRepo: deps.appsRepo });
}
