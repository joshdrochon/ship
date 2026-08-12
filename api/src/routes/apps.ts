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
import {
  createAppRequestSchema,
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

  return router;
}
