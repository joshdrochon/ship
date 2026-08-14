/**
 * `/api/apps/:id/portal-token` — the developer portal's ONE privileged route.
 * Lane L22, slice S1 (PF-652).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS EXACTLY ONE ROUTE IN THIS FILE, AND WHY IT IS NOT ON /api/v1.
 * ---------------------------------------------------------------------------
 * PRD p.10: *"the portal reuses the public API like any other client (eat the
 * dog food)"*. PF-651 settled how far that can literally go, and the answer is
 * "everything except getting the credential". Three facts force it:
 *
 *   1. **Bootstrap.** You cannot obtain an OAuth token for an app through an API
 *      that already requires an OAuth token. Something has to be first, and p.2
 *      says the first actor is an *admin* — a human with a session.
 *   2. **No scope could gate it.** p.3's registry is seven scopes and none of
 *      them is `apps:*`. L03's PF-068 throws at wiring time on an unregistered
 *      scope, so "just add one" is a PRD extension, not a fix.
 *   3. **Different principal.** `/api/v1` scopes every read to the CALLING APP —
 *      PF-478 returns `not_found` for another app's delivery id. A portal user is
 *      a human who owns several apps. One portal-wide OAuth app would render an
 *      empty delivery log, which is the opposite of what TS-8 (p.5) grades.
 *
 * So the escape hatch is this endpoint and nothing else: the owner proves
 * ownership with their Ship session, and gets back a short-lived bearer token
 * **for the app they own**. Every subsequent read and write about that app goes
 * over `/api/v1` through `@ship/sdk` — the same calls a stranger makes.
 *
 * `portalSurfaceFitness.test.ts` fails the build on a second internal route in
 * this module that returns webhook, delivery or subscription data. That test is
 * what keeps "exactly one escape hatch" true rather than aspirational.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN'S SHAPE, AND WHY EACH CONSTRAINT IS THERE.
 * ---------------------------------------------------------------------------
 * * **TTL ≤ 15 minutes** (`PORTAL_TOKEN_TTL_SECONDS`). Ship's session idle
 *   timeout is 15 minutes (`SESSION_TIMEOUT_MS`), and a credential minted on the
 *   authority of a session must not outlive the session that authorized it.
 * * **No refresh token in the response.** `issueTokenPair` is the ONE issuance
 *   site in this codebase (PF-155) and it always mints a pair — so rather than
 *   growing a second minting path and letting the two drift, this route uses it
 *   and then immediately revokes the refresh half. The refresh token is dead
 *   before the handler returns and never appears in a response body.
 * * **Scopes are the app's own, never a superset.** `app.requestedScopes` is the
 *   app's ceiling. `assertNoScopeEscalation` re-checks the minted set against it
 *   rather than trusting the call site, because a superset here would let the
 *   portal do things the app itself cannot.
 * * **No ownership oracle.** A foreign app id and a nonexistent app id return
 *   byte-identical bodies, the same rule `/api/apps` applies (PF-043). Otherwise
 *   the endpoint confirms other people's apps to anyone enumerating ids.
 *
 * CSRF: this router is mounted inside `conditionalCsrf`, and `rejectBearerAuth`
 * closes the same hole `/api/apps` closes by hand — `conditionalCsrf` skips CSRF
 * for any request carrying an `Authorization: Bearer` header, so a route that
 * accepted bearers would be reachable with no CSRF token at all. PF-665 owns the
 * regression test for the coupling itself.
 */
import { Router, Request, Response, NextFunction } from 'express';
import type { Router as RouterType } from 'express';
import { ERROR_CODES, HTTP_STATUS } from '@ship/shared';
import { authMiddleware, requireAuth } from '../middleware/auth.js';
import { logAuditEvent } from '../services/audit.js';
import type { Clock } from '../platform/clock.js';
import type { Scope } from '../platform/scopes/scopes.js';
import type { IOAuthAppRepo, OAuthApp } from '../platform/apps/index.js';
import type { ITokenRepo } from '../platform/oauth/tokenRepo.js';
import { issueTokenPair } from '../platform/oauth/issue.js';

/**
 * 15 minutes, matching `SESSION_TIMEOUT_MS`.
 *
 * PF-652 says "≤ 15 minutes so it cannot outlive the session that authorized
 * it". Equal is the ceiling: the session's idle clock is reset by the portal's
 * own activity, so a token that expired sooner would force a re-mint mid-scroll
 * for no security gain, and one that expired later would be a credential the
 * authorizing session no longer backs.
 */
export const PORTAL_TOKEN_TTL_SECONDS = 900;

export interface PortalRouterDeps {
  appsRepo: IOAuthAppRepo;
  tokenRepo: ITokenRepo;
  clock: Clock;
}

/** The response body. There is no `refresh_token` key — not null, no slot for one. */
export interface PortalTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  /** Which app this token acts as. The portal renders it; it is not a secret. */
  client_id: string;
}

function notFound(res: Response): void {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    error: { code: ERROR_CODES.NOT_FOUND, message: 'App not found' },
  });
}

/** Session-only. Identical in intent to `/api/apps`'s guard; see this file's header. */
function rejectBearerAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        code: ERROR_CODES.UNAUTHORIZED,
        message:
          'Minting a portal token requires an interactive session. Bearer tokens are not accepted on this endpoint.',
      },
    });
    return;
  }
  next();
}

/**
 * Ownership, checked once. Returns null for "missing", "someone else's" and
 * "not a UUID" alike — the three cases the caller must not be able to tell apart.
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
    return null;
  }
  if (!app) return null;
  if (app.ownerUserId !== userId) return null;
  return app;
}

/**
 * The scopes a portal token may carry: the app's own requested set, and nothing
 * beyond it.
 *
 * Exported because the test asserts against this function rather than against a
 * copy of the rule. A portal token is minted on the owner's authority, so there
 * is no consent record to resolve against (L03's `resolveGrantedScopes` answers
 * "what did the user consent to", which is a question about a third party using
 * *their* data — here the owner is acting as their own app). The app's ceiling
 * is therefore the right bound, and the escalation check below is what stops a
 * future edit from quietly widening it.
 */
export function portalTokenScopes(app: OAuthApp): Scope[] {
  return [...app.requestedScopes];
}

/** Throws rather than returning a bad token — an escalation is not a 4xx, it is a bug. */
export function assertNoScopeEscalation(app: OAuthApp, granted: readonly Scope[]): void {
  const ceiling = new Set<string>(app.requestedScopes);
  const escalated = granted.filter((s) => !ceiling.has(s));
  if (escalated.length > 0) {
    throw new Error(
      `portal token would escalate scopes beyond the app's own grant: ${escalated.join(', ')}`
    );
  }
}

export function createPortalRouter(deps: PortalRouterDeps): RouterType {
  const router: RouterType = Router();

  router.use(rejectBearerAuth);

  router.post(
    '/:id/portal-token',
    authMiddleware,
    async (req: Request, res: Response): Promise<void> => {
      const auth = requireAuth(req);
      const app = await findOwnedApp(deps.appsRepo, String(req.params.id), auth.userId);
      if (!app) {
        notFound(res);
        return;
      }

      // PF-052 — a deactivated app's tokens do not validate, so minting one
      // would hand the portal a credential that 401s on first use. The owner
      // CAN see this app in their list, so hiding it behind not-found here would
      // be a worse lie than naming the state.
      if (!app.active) {
        res.status(HTTP_STATUS.CONFLICT).json({
          success: false,
          error: {
            code: ERROR_CODES.FORBIDDEN,
            message:
              'This app is deactivated. Reactivate it before using the portal against its API.',
          },
        });
        return;
      }

      try {
        const scopes = portalTokenScopes(app);
        assertNoScopeEscalation(app, scopes);

        const issued = await issueTokenPair(
          {
            tokenRepo: deps.tokenRepo,
            clock: deps.clock,
            ttl: {
              accessSeconds: PORTAL_TOKEN_TTL_SECONDS,
              // The refresh token is revoked on the next line and never
              // returned. Its TTL is therefore only ever a database value; it is
              // set equal to the access TTL so a stray row cannot outlive the
              // access token even if the revoke below were somehow skipped.
              refreshSeconds: PORTAL_TOKEN_TTL_SECONDS,
            },
          },
          {
            app,
            // The token acts for the app, on behalf of the human who owns it.
            userId: auth.userId,
            scopes,
          }
        );

        // Dead on arrival. See the header: one issuance site (PF-155) beats a
        // second minting path, so the pair is minted and half of it is killed.
        await deps.tokenRepo.revokeToken(
          issued.refresh.id,
          'app_revoked',
          new Date(deps.clock.nowMs())
        );

        await logAuditEvent({
          workspaceId: auth.workspaceId,
          actorUserId: auth.userId,
          action: 'oauth_app.portal_token_minted',
          resourceType: 'oauth_app',
          resourceId: app.id,
          // The client_id and the scopes, never the token or its hash.
          details: { client_id: app.clientId, scopes, expires_in: PORTAL_TOKEN_TTL_SECONDS },
          req,
        });

        const body: PortalTokenResponse = {
          access_token: issued.response.access_token,
          token_type: 'Bearer',
          expires_in: PORTAL_TOKEN_TTL_SECONDS,
          scope: issued.response.scope,
          client_id: app.clientId,
        };

        res.status(HTTP_STATUS.OK).json({ success: true, data: body });
      } catch (error) {
        // Deliberately does not interpolate the error: `issueTokenPair`'s return
        // value holds a raw token, and an error message that happened to carry
        // one would be a leak in a response body.
        console.error('Mint portal token error:', error);
        res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
          success: false,
          error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'Failed to mint portal token' },
        });
      }
    }
  );

  return router;
}
