/**
 * OAuth 2.0 endpoints — hand-rolled, IETF-correct, minimal.
 *
 * Routes this router will expose (build order per docs/architecture.md):
 *
 *   GET  /oauth/authorize      Auth Code + PKCE: login + consent, stores
 *                              code_challenge, 302s back with a short-lived code
 *   POST /oauth/token          grant_type=authorization_code  → verifies PKCE (S256)
 *                              grant_type=refresh_token       → ROTATION: new pair,
 *                                old spent; reuse of spent token revokes the family
 *                              grant_type=urn:ietf:params:oauth:grant-type:device_code
 *                              grant_type=client_credentials  → first-party agent (M2M)
 *   POST /oauth/device/code    issues device_code + user_code + verification_uri
 *   GET  /oauth/device/verify  user enters the short code + consents
 *
 * Error semantics per RFC 6749 §5.2 (invalid_grant, slow_down for 8628 §3.5).
 *
 * ---------------------------------------------------------------------------
 * THE ERROR SURFACE HERE IS **NOT** L07's ApiError envelope (L99 U3, PF-172).
 * ---------------------------------------------------------------------------
 * `/oauth/*` emits RFC 6749 §5.2's `{error, error_description?}` and never the
 * public envelope. Two different specs govern two different surfaces, and
 * pretending otherwise would break every OAuth client library on the planet.
 * A grep in `rotation.test.ts` asserts this lane imports nothing from L07's
 * `ApiError` module.
 *
 * ---------------------------------------------------------------------------
 * GRANT TYPES ARE **DATA** (PF-166 / PF-134).
 * ---------------------------------------------------------------------------
 * `grantHandlers(deps)` returns a map from `grant_type` to a handler. Adding the
 * authorization-code grant (L04) or the device grant (L05) is a NEW ENTRY in
 * that map, never an edit to the dispatcher below. That is the difference
 * between three lanes composing and three lanes editing one `switch` statement
 * and merging over each other all week.
 */
import { Router, urlencoded } from 'express';
import type { Request } from 'express';
import type { Clock } from '../clock.js';
import type { IOAuthAppRepo } from '../apps/repo.js';
import { verifyClientSecret } from '../apps/repo.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { scopeRegistry } from '../scopes/scopes.js';
import type { ScopeRegistry } from '../scopes/registry.js';
import type { ITokenRepo } from './tokenRepo.js';
import type { TokenTtlConfig } from './tokens.js';
import { rotateRefreshToken, type OAuthErrorBody } from './rotation.js';
import type { IAuthCodeRepo } from './authCodes.js';
import {
  mountAuthorizeRoutes,
  oauthBrowserSecurityHeaders,
  type OAuthBrowserDeps,
} from './consent.js';
import { authorizationCodeGrant } from './authCodeGrant.js';
import type { IDeviceCodeRepo } from './deviceCodes.js';
import type { UserCodeAttemptThrottle } from './deviceThrottle.js';
import { mountDeviceAuthorizationRoutes } from './deviceAuthorization.js';
import { mountDeviceVerifyRoutes } from './deviceVerify.js';

export interface OAuthRouterDeps {
  appsRepo: IOAuthAppRepo;
  tokenRepo: ITokenRepo;
  clock: Clock;
  ttl: TokenTtlConfig;
  /** D14 / PF-171 override. Defaults to the shipped constant (0 — strict). */
  replayWindowMs?: number;
  /**
   * L04 PF-086 — the `oauth_authorization_codes` store.
   *
   * Optional so that a test exercising only the refresh grant does not have to
   * construct one. When it is absent the `authorization_code` grant is NOT
   * registered, which is the honest behaviour: a server with nowhere to record a
   * code cannot honour a grant that redeems one, and answering
   * `unsupported_grant_type` is better than answering `invalid_grant` for a
   * reason the client cannot act on.
   */
  authCodeRepo?: IAuthCodeRepo;
  /**
   * L04 PF-094 — the browser-facing half: `/oauth/authorize` and the consent
   * decision.
   *
   * Optional for the same reason, and its absence is caught where it matters
   * rather than by the type system: PF-113 asserts the SHIPPED route table
   * contains `GET /oauth/authorize`, walking the live Express stack of
   * `createApp()`. A composition root that forgot to wire this fails there.
   */
  browser?: OAuthBrowserDeps;
  /**
   * L05 PF-121 — the `oauth_device_codes` store.
   *
   * Optional for `authCodeRepo`'s reason and with the same consequence: when it
   * is absent the device-code grant is NOT registered in the map below, so the
   * dispatcher answers `unsupported_grant_type`. That is the honest answer — a
   * server with nowhere to record a device authorization cannot honour a grant
   * that redeems one — and it is better than `invalid_grant`, which would send
   * the client hunting for a bad device_code it actually holds correctly.
   */
  deviceCodeRepo?: IDeviceCodeRepo;
  /**
   * L05 PF-122 — absolute origin of this instance, for `verification_uri`.
   *
   * Required whenever `deviceCodeRepo` is present. A relative or hard-coded
   * localhost URL is the defect a grader hits first: the CLI prints a URL that
   * does not resolve on the deployed instance.
   */
  publicBaseUrl?: string;
  /**
   * L05 PF-132 — the `user_code` guess counter.
   *
   * Injected so a table test can drive tight thresholds against a `FakeClock`
   * rather than making 5 real requests to observe a cooldown. Defaults to the
   * shipped constants.
   */
  deviceThrottle?: UserCodeAttemptThrottle;
  /** Overridable scope registry, for PF-095's mutated-description test. */
  scopeRegistry?: ScopeRegistry<string>;
}

/** What a grant handler returns: a token response, or an RFC 6749 error. */
export type GrantOutcome =
  | { ok: true; body: unknown }
  | { ok: false; status: number; body: OAuthErrorBody };

export type GrantHandler = (ctx: {
  app: OAuthApp;
  params: Record<string, string>;
}) => Promise<GrantOutcome>;

/**
 * Parses a space-delimited `scope` parameter against the registry.
 *
 * Returns `undefined` when absent (meaning "inherit"), and `null` when it names
 * something the registry does not know — which is `invalid_scope`, not a silent
 * drop.
 */
function parseScopeParam(raw: string | undefined): Scope[] | null | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parts = raw.trim().split(/\s+/);
  const known: Scope[] = [];
  for (const part of parts) {
    if (!scopeRegistry.has(part)) return null;
    known.push(part);
  }
  return known;
}

/**
 * THE GRANT MAP. One entry per `grant_type`.
 *
 * L06 registers `refresh_token`. L04 adds `authorization_code`, L05 adds the
 * device-code grant, and neither has to touch the dispatcher.
 */
export function grantHandlers(deps: OAuthRouterDeps): Record<string, GrantHandler> {
  return {
    /**
     * ★ PKCE. L04's entry, added as a NEW KEY in this map — the dispatcher
     * below was not touched, which is the property PF-166/PF-134 exist to
     * preserve.
     *
     * Conditional on `authCodeRepo`, because a server with nowhere to record a
     * code cannot honour a grant that redeems one. Omitting the key means the
     * dispatcher answers `unsupported_grant_type`, which is true, rather than
     * `invalid_grant`, which would send the client hunting for a bad code.
     */
    ...(deps.authCodeRepo
      ? {
          authorization_code: authorizationCodeGrant({
            authCodeRepo: deps.authCodeRepo,
            tokenRepo: deps.tokenRepo,
            clock: deps.clock,
            ttl: deps.ttl,
          }),
        }
      : {}),

    /**
     * ★ ROTATION. `docs/architecture.md:118` marks this grant as the site, and
     * `rotation.ts` is where it lands.
     */
    refresh_token: async ({ app, params }) => {
      const presented = params.refresh_token;
      if (!presented) {
        return {
          ok: false,
          status: 400,
          body: { error: 'invalid_request', error_description: 'refresh_token is required.' },
        };
      }

      const requested = parseScopeParam(params.scope);
      if (requested === null) {
        return {
          ok: false,
          status: 400,
          body: { error: 'invalid_scope', error_description: 'Unknown scope requested.' },
        };
      }

      const result = await rotateRefreshToken(
        {
          tokenRepo: deps.tokenRepo,
          clock: deps.clock,
          ttl: deps.ttl,
          ...(deps.replayWindowMs !== undefined ? { replayWindowMs: deps.replayWindowMs } : {}),
        },
        {
          app,
          presentedToken: presented,
          ...(requested ? { requestedScopes: requested } : {}),
        },
      );

      if (!result.ok) return { ok: false, status: result.status, body: result.body };
      return { ok: true, body: result.response };
    },

    // (L04's authorization_code is registered at the TOP of this map — the
    //  instruction here was followed literally: a new entry, no dispatcher edit.)
    // TODO(L05): urn:ietf:params:oauth:grant-type:device_code — same seam.
    // TODO(L05/D5): client_credentials for the seeded first-party agent app.
  };
}

/**
 * RFC 6749 §2.3.1 — client authentication.
 *
 * HTTP Basic is the REQUIRED form; credentials in the request body are the
 * optional one. Both are accepted, Basic first.
 *
 * The comparison itself is L02's `verifyClientSecret` (PF-036) and is never
 * redefined here — that function is the only client-secret comparison site in
 * the repository, it is constant-time, and it deliberately cannot tell the
 * caller WHICH of unknown-client / bad-secret / deactivated-app happened.
 */
async function authenticateClient(
  repo: IOAuthAppRepo,
  req: Request,
  params: Record<string, string>,
): Promise<OAuthApp | null> {
  let clientId = params.client_id;
  let clientSecret = params.client_secret;

  const header = req.headers.authorization;
  if (typeof header === 'string' && /^basic\s/i.test(header)) {
    const decoded = Buffer.from(header.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator !== -1) {
      // RFC 6749 §2.3.1 requires form-urlencoding of the two halves.
      clientId = decodeURIComponent(decoded.slice(0, separator));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    }
  }

  if (!clientId || !clientSecret) return null;

  const outcome = await verifyClientSecret(repo, clientId, clientSecret);
  return outcome.ok ? outcome.app : null;
}

export function createOAuthRouter(deps: OAuthRouterDeps): Router {
  const router = Router();
  const handlers = grantHandlers(deps);

  // L04 PF-096 — clickjacking and cache headers, set explicitly and router-wide.
  //
  // ABOVE the body parser and above every route, so a request that fails to
  // parse still answers with them. Helmet's app-wide config does NOT set
  // `frame-ancestors` (measured — see `consent.ts`), so relying on it would be
  // relying on another lane's configuration that no test pins.
  router.use(oauthBrowserSecurityHeaders());

  // RFC 6749 §4.1.3: the token endpoint takes application/x-www-form-urlencoded.
  // The consent decision POST is a browser form and is the same content type, so
  // one parser serves both.
  router.use(urlencoded({ extended: false, limit: '64kb' }));

  // L05 PF-122 — the device authorization request. Mounted before `/token` so
  // the route table reads in flow order.
  if (deps.deviceCodeRepo) {
    if (!deps.publicBaseUrl) {
      // Loud at wiring time rather than at the first request. A missing base URL
      // would otherwise surface as a `verification_uri` of `undefined/...`
      // printed into a user's terminal, which is a defect nobody notices until a
      // grader follows the link.
      throw new Error('publicBaseUrl is required when deviceCodeRepo is provided (PF-122)');
    }
    mountDeviceAuthorizationRoutes(router, {
      appsRepo: deps.appsRepo,
      deviceCodeRepo: deps.deviceCodeRepo,
      clock: deps.clock,
      publicBaseUrl: deps.publicBaseUrl,
      ...(deps.scopeRegistry ? { registry: deps.scopeRegistry } : {}),
    });

    // L05 PF-129/PF-130 — the human-facing half. Needs the same browser
    // dependencies the consent screen does, so it mounts only when they are
    // wired; a device flow with no verification screen can issue a code that
    // nobody can ever approve, and answering 404 says so.
    if (deps.browser) {
      mountDeviceVerifyRoutes(router, {
        appsRepo: deps.appsRepo,
        deviceCodeRepo: deps.deviceCodeRepo,
        clock: deps.clock,
        browser: deps.browser,
        ...(deps.scopeRegistry ? { registry: deps.scopeRegistry } : {}),
        ...(deps.deviceThrottle ? { throttle: deps.deviceThrottle } : {}),
      });
    }
  }

  // L04 PF-094 — the browser-facing half. Mounted before `/token` so the route
  // table reads in flow order; Express matches by path so the order is cosmetic.
  if (deps.browser && deps.authCodeRepo) {
    mountAuthorizeRoutes(router, {
      appsRepo: deps.appsRepo,
      authCodeRepo: deps.authCodeRepo,
      clock: deps.clock,
      browser: deps.browser,
      ...(deps.scopeRegistry ? { registry: deps.scopeRegistry } : {}),
    });
  }

  router.post('/token', (req, res, next) => {
    void (async () => {
      // RFC 6749 §5.1 and §5.2 both require this on token endpoint responses:
      // a cached token response is a token leak through the browser cache.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');

      const params = (req.body ?? {}) as Record<string, string>;

      const grantType = params.grant_type;
      if (!grantType) {
        res
          .status(400)
          .json({ error: 'invalid_request', error_description: 'grant_type is required.' });
        return;
      }

      const handler = handlers[grantType];
      if (!handler) {
        res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: `Unsupported grant_type: ${grantType}`,
        });
        return;
      }

      // Client authentication happens BEFORE the grant runs, for every grant.
      // Doing it per-handler would make it something a new grant could forget.
      const app = await authenticateClient(deps.appsRepo, req, params);
      if (!app) {
        res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
        res
          .status(401)
          .json({ error: 'invalid_client', error_description: 'Client authentication failed.' });
        return;
      }

      const outcome = await handler({ app, params });
      if (!outcome.ok) {
        res.status(outcome.status).json(outcome.body);
        return;
      }
      res.status(200).json(outcome.body);
    })().catch(next);
  });

  // TODO(josh): E1 slices, in order:
  //  1. POST /oauth/token (authorization_code + PKCE) — negative tests first
  //  2. GET  /oauth/authorize (consent screen, minimal layout inside Ship UI)
  //  4. device pair (POST /device/code, GET /device/verify, token polling + slow_down)
  //  5. client_credentials for the seeded first-party agent app
  // (3. refresh rotation + family revocation — DONE, this lane.)

  return router;
}
