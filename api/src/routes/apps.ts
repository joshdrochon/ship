/**
 * `/api/apps` — OAuth application CRUD. Lane L02, slice S2 (PF-039–PF-046).
 *
 * ---------------------------------------------------------------------------
 * PF-039 — WHY THIS LIVES ON THE INTERNAL SESSION SURFACE AND NOT ON /api/v1.
 * ---------------------------------------------------------------------------
 * L22's PF-651 settled the shape; this file makes the server match it rather
 * than re-deciding it. Three structural reasons, none of them preference:
 *
 *   1. p.2 says "admin can create an app" — an admin, not an app. The actor is
 *      a human with a session, not an integration with a token.
 *   2. The bootstrap paradox: you cannot register your first OAuth app through
 *      an API that requires an OAuth token. Something has to come first.
 *   3. p.3's scope registry is seven scopes and none of them could gate app
 *      CRUD. Inventing an eighth (`apps:manage`) to put this on /api/v1 would
 *      contradict the registry the fitness tests pin at exactly seven, and
 *      L03's PF-068 makes an unregistered scope a wiring-time throw.
 *
 * L22's `POST /api/apps/:id/portal-token` (PF-652) is the ONLY other route in
 * this family and is L22's to write. Every route here is a sibling of it under
 * the same session auth. The two surfaces must not drift apart, which is why
 * PF-043's not-found rule below is stated in the same terms PF-652 uses.
 *
 * ---------------------------------------------------------------------------
 * PF-046 — CSRF placement, and the bearer hole this route closes by hand.
 * ---------------------------------------------------------------------------
 * p.17 asks what CSRF protection these endpoints have, "given they sit
 * alongside the OAuth consent screen". They are on the session-cookie half, so
 * they inherit the shipped `csrf-sync` synchroniser token (`api/src/app.ts`,
 * header `x-csrf-token`) plus `sameSite: 'strict'` cookies — this router is
 * mounted inside the `conditionalCsrf` chain.
 *
 * MEASURED HAZARD, not inherited assumption: `conditionalCsrf` skips CSRF for
 * ANY request carrying an `Authorization: Bearer` header, and `authMiddleware`
 * happily authenticates `api_tokens` bearers. So mounting alone would leave a
 * path where a bearer-authenticated caller reaches these routes with no CSRF
 * token at all. That is safe today only because of a coupling nothing pins
 * (L99 F26). `rejectBearerAuth` below closes it here rather than relying on it:
 * these two routes accept session authentication and nothing else, so the
 * `conditionalCsrf` skip can never route around CSRF on this path.
 *
 * L22's PF-665 owns the regression test for the coupling itself.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { Router as RouterType } from 'express';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware, requireAuth } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.js';
import { pool } from '../db/client.js';
import { listCalls } from '../platform/audit/pgAuditSink.js';
import {
  createAppRequestSchema,
  reactivateRequestSchema,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  secretPrefix,
  toPublicApp,
  type IOAuthAppRepo,
  type OAuthApp,
  type RotationPolicy,
} from '../platform/apps/index.js';

/**
 * D3 — the rotation model this build ships, as a value rather than as prose.
 *
 * PF-048's documented departure from Stripe names THIS constant, so flipping
 * the behaviour forces `docs/architecture.md` to change with it. L22's PF-670
 * renders whichever value the API returns, which is what makes a future grace
 * period a data change instead of a portal rewrite.
 */
export const ROTATION_POLICY: RotationPolicy = 'instant';

/**
 * PF-043 — one not-found body, used for three different situations: the id
 * does not exist, the id exists but belongs to another user, and the id is not
 * a UUID at all.
 *
 * Byte-identical on purpose. If "not yours" were distinguishable from "no such
 * app", the endpoint would confirm the existence of other people's apps to
 * anyone willing to enumerate ids — the same oracle PF-036 refuses to be at the
 * token endpoint, and the same rule L22's PF-652 applies to the token mint.
 */
function notFound(res: Response): void {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: 'App not found' },
  });
}

function validationFailed(res: Response, details: unknown): void {
  res.status(HTTP_STATUS.BAD_REQUEST).json({
    success: false,
    error: {
      code: ERROR_CODES.VALIDATION_ERROR,
      message: 'Invalid request',
      // PF-038(d): `details` carries field paths and reasons. It must never
      // carry a credential — nothing in this object is derived from a secret.
      details,
    },
  });
}

/**
 * PF-046 — these routes are session-only.
 *
 * Rejects before `authMiddleware` runs, so a valid `api_tokens` bearer gets 401
 * rather than authenticating. Placed as its own middleware rather than folded
 * into each handler so that a route added to this router later inherits it.
 */
function rejectBearerAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message:
          'App management requires an interactive session. Bearer tokens are not accepted on this endpoint.',
      },
    });
    return;
  }
  next();
}

/**
 * PF-043 — fetch an app the session user owns, or null.
 *
 * Ownership is checked HERE, once, rather than in each handler, so that a new
 * route cannot forget it. Returning null for both "missing" and "someone
 * else's" is what makes the two indistinguishable at the response.
 */
async function findOwnedApp(
  repo: IOAuthAppRepo,
  id: string,
  userId: string
): Promise<OAuthApp | null> {
  let app: OAuthApp | null;
  try {
    app = await repo.findById(id);
  } catch {
    // A malformed UUID makes Postgres throw. That must look like "not found",
    // not like a 500 — a 500 on a bad id and a 404 on a good one is a weaker
    // version of the same oracle.
    return null;
  }
  if (!app) return null;
  if (app.ownerUserId !== userId) return null;
  return app;
}

/**
 * The router is a factory taking its repository, not a module-level singleton
 * reaching for `pool`. That is what lets `createApp(testDeps())` drive these
 * routes against `InMemoryOAuthAppRepo` with no database, and it keeps the
 * construction of `PgOAuthAppRepo` in the composition root where PF-037 says
 * it belongs.
 */
/** Page-size bounds for the audit trail. Mirrors the public list limits. */
const CALLS_DEFAULT_LIMIT = 25;
const CALLS_MAX_LIMIT = 100;

export function createAppsRouter(repo: IOAuthAppRepo): RouterType {
  const router: RouterType = Router();

  router.use(rejectBearerAuth);

  /**
   * PF-040 — registration. 201, and the raw secret in the body exactly once.
   *
   * This is MVP gate item 1 (p.2): "admin can create an app, receive a
   * client_id, and a client_secret hashed in the database (raw secret shown
   * exactly once on creation)".
   */
  router.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const parsed = createAppRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // PF-041 / PF-042: unknown scope names and bad redirect URIs both land
      // here, each naming its own field and index.
      validationFailed(res, parsed.error.flatten());
      return;
    }

    const auth = requireAuth(req);

    try {
      const clientId = generateClientId();
      // The only place this value exists in plaintext is this function's scope
      // and the response body below. It is never logged, never stored, and
      // never returned again.
      const rawSecret = generateClientSecret();

      const app = await repo.create({
        clientId,
        clientSecretHash: hashClientSecret(rawSecret),
        secretPrefix: secretPrefix(rawSecret),
        name: parsed.data.name,
        ownerUserId: auth.userId,
        workspaceId: auth.workspaceId,
        redirectUris: parsed.data.redirect_uris,
        requestedScopes: parsed.data.requested_scopes,
      });

      // Audited with the client_id, never the secret or its hash. The
      // client_id is the identifier the whole audit trail joins on (L12).
      await logAuditEvent({
        workspaceId: auth.workspaceId,
        actorUserId: auth.userId,
        action: 'oauth_app.created',
        resourceType: 'oauth_app',
        resourceId: app.id,
        details: { client_id: app.clientId, requested_scopes: app.requestedScopes },
        req,
      });

      res.status(HTTP_STATUS.CREATED).json({
        success: true,
        data: {
          // The allowlist projection (PF-038) …
          ...toPublicApp(app),
          // … plus the two fields that exist only on this response and on
          // rotation's. `client_secret` is ADDED here rather than living in the
          // projection, so no read path can ever include it by accident.
          client_secret: rawSecret,
          rotation_policy: ROTATION_POLICY,
          warning: 'Save this secret now. It is not recoverable and will not be shown again.',
        },
      });
    } catch (error) {
      // Deliberately does not interpolate the error into the response, and
      // deliberately does not log the request body — which holds nothing
      // secret today, but would if this handler ever grew a field that did.
      console.error('Create OAuth app error:', error);
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to create app' },
      });
    }
  });

  /**
   * PF-044 — the read side L22 renders.
   *
   * Owner-scoped at the repository. Another owner's app is ABSENT from this
   * list, not present-and-403: a 403 would still confirm the app exists.
   */
  router.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    try {
      const apps = await repo.listByOwner(auth.userId);
      res.json({ success: true, data: apps.map(toPublicApp) });
    } catch (error) {
      console.error('List OAuth apps error:', error);
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
        success: false,
        error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to list apps' },
      });
    }
  });

  /** PF-044 + PF-043 — single read, owner-scoped, no ownership oracle. */
  router.get('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const app = await findOwnedApp(repo, String(req.params.id), auth.userId);
    if (!app) {
      notFound(res);
      return;
    }
    // No `client_secret` key at all — not an empty string, not null. The
    // projection has no slot for one.
    res.json({ success: true, data: toPublicApp(app) });
  });

  /**
   * F111 — the audit trail, over HTTP at last.
   *
   * PRD p.4 requires every public API call recorded "with timestamp, app
   * client_id, user_id, route, scope used, status, latency" and **queryable in
   * the developer portal**. L12 shipped the recording and `listCalls(...)` — a
   * repository function. React cannot call a repository function, so the
   * requirement had no HTTP surface at all and L22's audit slice was blocked on
   * a route neither lane owned.
   *
   * ## Why this sits on the SESSION surface and not `/api/v1`
   *
   * Same reason app registration does, and L22 already argued it for the app
   * list: none of p.3's seven scopes can gate this. There is no `audit:read`,
   * and inventing one would put a scope in the registry the PRD never asked
   * for. Worse, the natural OAuth framing is circular — an app reading its own
   * call log through a token issued to that same app means every read appends a
   * row about the read.
   *
   * A developer signed into the portal is a different principal from an app
   * holding a token, and that is exactly the principal p.4's "in the developer
   * portal" describes.
   *
   * ## Ownership, not client_id, is the gate
   *
   * The `:id` is the app's UUID and is resolved through `findOwnedApp`, so a
   * developer sees the trail for apps they own and nothing else. The
   * `client_id` used to scope the query is read off the RESOLVED row rather
   * than taken from the caller — passing a `client_id` straight through would
   * let anyone read any app's trail by guessing an identifier that is published
   * in a README.
   */
  router.get('/:id/calls', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const auth = requireAuth(req);
    const app = await findOwnedApp(repo, String(req.params.id), auth.userId);
    if (!app) {
      // Byte-identical to the other not-found bodies here: a foreign app and an
      // absent one must be indistinguishable, or this route becomes an oracle
      // for which app ids exist.
      notFound(res);
      return;
    }

    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), CALLS_MAX_LIMIT)
      : CALLS_DEFAULT_LIMIT;

    const status = Number.parseInt(String(req.query.status ?? ''), 10);
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    // An unparseable date is a client mistake, not an empty page: silently
    // dropping the filter would answer a question nobody asked.
    for (const [name, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && Number.isNaN(value.getTime())) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            code: ERROR_CODES.VALIDATION_ERROR,
            message: `\`${name}\` must be an ISO 8601 timestamp`,
          },
        });
        return;
      }
    }

    const page = await listCalls(pool, {
      clientId: app.clientId,
      limit,
      cursor: req.query.cursor ? String(req.query.cursor) : null,
      ...(Number.isFinite(status) ? { status } : {}),
      ...(req.query.route ? { route: String(req.query.route) } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });

    res.json({ success: true, data: page.data, next_cursor: page.next_cursor });
  });

  /**
   * PF-047 — D3: rotate. New secret shown once; the old one dies immediately.
   * PF-049 — the same route is the admin force-rotate, on a foreign app.
   *
   * Two actors, one code path:
   *   * the OWNER rotating their own app (the normal case), and
   *   * a SUPER-ADMIN force-rotating an app they do not own, which is p.17's
   *     "admin-driven force-rotate" option.
   *
   * A non-admin rotating a foreign app gets PF-043's not-found body, so the
   * route is not an ownership oracle for anyone without the privilege.
   *
   * REJECTED AND RECORDED, not silently dropped: **automatic rotation on leak
   * detection**. PF-050 detects; nothing closes the loop automatically, because
   * there is no channel in this build to hand a newly rotated secret to its
   * owner. Rotating a credential nobody asked to rotate converts a *suspected*
   * leak into a *certain* outage.
   *
   * BLAST RADIUS, stated because the playbook depends on it: rotating the
   * secret does NOT revoke tokens already issued. The secret is an issuance
   * credential, not a session. The response to a confirmed leak is therefore
   * rotate AND revoke, and revocation belongs to the token lane.
   */
  router.post(
    '/:id/rotate-secret',
    authMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      const auth = requireAuth(req);
      const id = String(req.params.id);

      let target = await findOwnedApp(repo, id, auth.userId);
      let forced = false;

      if (!target && req.isSuperAdmin) {
        // PF-049 — force-rotate. Only reached when the actor is a super-admin,
        // so a normal user still cannot distinguish "not yours" from "absent".
        try {
          target = await repo.findById(id);
        } catch {
          target = null;
        }
        forced = target !== null;
      }

      if (!target) {
        notFound(res);
        return;
      }

      try {
        const rawSecret = generateClientSecret();
        const rotated = await repo.rotateSecret(
          target.id,
          hashClientSecret(rawSecret),
          secretPrefix(rawSecret)
        );
        if (!rotated) {
          notFound(res);
          return;
        }

        // The ACTING user is recorded, not the owner — that is the whole point
        // of force-rotate being a distinct, attributable event.
        await logAuditEvent({
          workspaceId: auth.workspaceId,
          actorUserId: auth.userId,
          action: forced ? 'oauth_app.secret_force_rotated' : 'oauth_app.secret_rotated',
          resourceType: 'oauth_app',
          resourceId: rotated.id,
          details: {
            client_id: rotated.clientId,
            secret_version: rotated.secretVersion,
            // The new prefix, never the secret (PF-035).
            secret_prefix: rotated.secretPrefix,
            forced,
          },
          req,
        });

        res.json({
          success: true,
          data: {
            ...toPublicApp(rotated),
            // The second and last response body in the codebase carrying a raw
            // secret (PF-038's rule extends to rotation, per p.2: shown once
            // "on creation and rotation").
            client_secret: rawSecret,
            rotation_policy: ROTATION_POLICY,
            warning:
              'The previous secret stopped working immediately. Any integration using it will now fail.',
          },
        });
      } catch (error) {
        console.error('Rotate OAuth app secret error:', error);
        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
          success: false,
          error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to rotate secret' },
        });
      }
    }
  );

  /**
   * PF-053 — D2's recovery story: an admin reactivates and reassigns.
   *
   * p.17 says of the owner-deleted options that "Each is a different recovery
   * story", so ours has to exist rather than be implied. Super-admin only,
   * because the previous owner is gone and there is nobody else with standing.
   *
   * REJECTS reactivation without a live owner. An active app whose owner does
   * not exist is precisely the orphan state D2 was chosen to avoid — it would
   * be a credential nobody can rotate and nobody is accountable for. The
   * `owner_user_id` foreign key is what enforces it, so the check cannot be
   * skipped by a future caller that forgets to validate.
   *
   * `client_id` and `client_secret_hash` are left untouched, so the audit
   * history stays continuous and the owner's stored credential still works.
   */
  router.post(
    '/:id/reactivate',
    authMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      const auth = requireAuth(req);
      if (!req.isSuperAdmin) {
        // Not 403: a non-admin must not learn that the app exists.
        notFound(res);
        return;
      }

      const parsed = reactivateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        validationFailed(res, parsed.error.flatten());
        return;
      }

      const id = String(req.params.id);
      try {
        const before = await repo.findById(id);
        if (!before) {
          notFound(res);
          return;
        }

        const app = await repo.reactivate(id, parsed.data.owner_user_id);
        if (!app) {
          notFound(res);
          return;
        }

        await logAuditEvent({
          workspaceId: auth.workspaceId,
          actorUserId: auth.userId,
          action: 'oauth_app.reactivated',
          resourceType: 'oauth_app',
          resourceId: app.id,
          details: { client_id: app.clientId, new_owner_user_id: app.ownerUserId },
          req,
        });

        res.json({ success: true, data: toPublicApp(app) });
      } catch (error) {
        // The FK rejecting a deleted owner lands here. It is a client error,
        // not a server one: the caller named a user that does not exist.
        const message = error instanceof Error ? error.message : '';
        if (/owner_user_id/.test(message) || /foreign key/i.test(message)) {
          validationFailed(res, {
            fieldErrors: {
              owner_user_id: [
                'must name a live user; an app cannot be reactivated without an owner',
              ],
            },
          });
          return;
        }
        console.error('Reactivate OAuth app error:', error);
        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
          success: false,
          error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to reactivate app' },
        });
      }
    }
  );

  return router;
}
