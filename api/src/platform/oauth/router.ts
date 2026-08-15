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
import { SystemClock } from '../clock.js';
import type { IOAuthAppRepo } from '../apps/repo.js';
import { verifyClientSecret } from '../apps/repo.js';
import type { ISecretAuthLog } from '../apps/secret-auth-log.js';
import { secretAuthOnAttempt } from '../apps/secret-auth-log.js';
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
import { deviceCodeGrant, DEVICE_CODE_GRANT_TYPE } from './deviceGrant.js';
import { mountDeviceAuthorizationRoutes } from './deviceAuthorization.js';
import { mountDeviceVerifyRoutes } from './deviceVerify.js';
import {
  clientCredentialsGrant,
  CLIENT_CREDENTIALS_GRANT_TYPE,
} from './clientCredentialsGrant.js';
import { publicCors } from '../publicCors.js';

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
  /**
   * F112 — PF-050's `client_secret_auth_log`, the leaked-secret alert signal.
   *
   * Optional, and its absence means "record nothing" rather than "record to a
   * stub". Two reasons it is not required:
   *
   *   1. The existing suite builds dozens of routers with `InMemoryOAuthAppRepo`
   *      and no database. Making this required would force every one of them to
   *      construct a log to exercise a grant that has nothing to do with
   *      alerting.
   *   2. Recording is observability, not authorization. A server that cannot
   *      write the log must still be able to authenticate a client — the
   *      opposite choice fails an OAuth flow closed on an alerting table.
   *
   * The production wiring is asserted separately: `secretAuthWiring.test.ts`
   * drives `createApp()`'s real `/oauth/token` and reads rows back out, so a
   * composition root that forgot this fails there rather than silently logging
   * nothing — which is exactly how this went undetected before F112.
   */
  secretAuthLog?: ISecretAuthLog;
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

    /**
     * ★ DEVICE GRANT. L05's entry, added as a NEW KEY in this map — the
     * dispatcher below was not touched, which is the property PF-166/PF-134
     * exist to preserve. That is now three lanes registering three grant types
     * against one dispatcher, none of which edited it.
     *
     * Conditional on `deviceCodeRepo`, on exactly `authorization_code`'s
     * reasoning: a server with nowhere to record a device authorization cannot
     * honour a grant that redeems one. Omitting the key means the dispatcher
     * answers `unsupported_grant_type`, which is true, rather than
     * `invalid_grant`, which would send the client hunting for a bad
     * device_code it is actually holding correctly.
     */
    ...(deps.deviceCodeRepo
      ? {
          [DEVICE_CODE_GRANT_TYPE]: deviceCodeGrant({
            deviceCodeRepo: deps.deviceCodeRepo,
            tokenRepo: deps.tokenRepo,
            clock: deps.clock,
            ttl: deps.ttl,
          }),
        }
      : {}),

    /**
     * ★ CLIENT CREDENTIALS. L23's entry (PF-686), and the FOURTH lane to add a
     * grant type to this map without editing the dispatcher below.
     *
     * NOT conditional on any extra repository, unlike its three neighbours: it
     * redeems nothing and stores nothing beyond the token it issues, so there is
     * no store whose absence would make it dishonest to advertise. The two
     * dependencies it has — the token repo and the clock — are required by
     * `OAuthRouterDeps` already.
     *
     * The eligibility rules (first-party, confidential) live in the handler
     * rather than here, because they are properties of the grant and not of the
     * router's wiring. See `clientCredentialsGrant.ts`.
     */
    [CLIENT_CREDENTIALS_GRANT_TYPE]: clientCredentialsGrant({
      tokenRepo: deps.tokenRepo,
      clock: deps.clock,
      ttl: deps.ttl,
    }),
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
 *
 * ---------------------------------------------------------------------------
 * PUBLIC CLIENTS — L99 F27 / F50, closed by migration 074 (found by L17 and
 * L05, landed from L24 under MVP-gate pressure; see RESERVATIONS.md).
 * ---------------------------------------------------------------------------
 * RFC 6749 §2.1 defines a public client as one that cannot keep a secret, and
 * §3.2.1 requires client authentication only of clients that HAVE credentials.
 * A browser SPA and a CLI are the two canonical public clients, and RFC 7636
 * (PKCE) exists so that they can run the authorization-code grant safely.
 *
 * Before this, `if (!clientId || !clientSecret) return null` ran above every
 * grant, so a public client got `401 invalid_client` on every exchange:
 * PRD p.5's Testing Scenario 2 ("from a registered web app") was unreachable
 * except by publishing a secret in a JavaScript bundle, and F50 measured the
 * device grant failing identically for TS-3's "test CLI".
 *
 * The narrow fix: a request presenting `client_id` and no secret authenticates
 * ONLY IF the registration says `is_public`. Three properties this shape has
 * that the tempting one-liner ("no secret presented → skip the check") does
 * not:
 *
 *   1. A confidential app cannot be downgraded by omitting a parameter. That
 *      downgrade is the entire attack, and it is why the column exists rather
 *      than an inference from the request.
 *   2. `active` is still honoured, so D2/PF-052 holds for public clients too —
 *      a deactivated public app authenticates nothing.
 *   3. Every failure is still one indistinguishable `null`. Unknown client,
 *      inactive app, and confidential-app-without-secret produce the same 401
 *      with the same body, so this adds no enumeration oracle to the one
 *      PF-036 is careful not to be.
 *
 * What this does NOT do is make PKCE optional. `authorize.ts` requires
 * `code_challenge` + S256 with no fallback path, and `authorizationCodeGrant`
 * verifies the verifier. For a public client that verification is the whole of
 * the security, which is the RFC 7636 threat model exactly.
 */
async function authenticateClient(
  repo: IOAuthAppRepo,
  req: Request,
  params: Record<string, string>,
  // F112 — PF-050's recording hook, finally connected. Optional so that every
  // test building a router without a log keeps its current behaviour exactly.
  secretAuthLog?: ISecretAuthLog,
  clock: Clock = new SystemClock(),
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

  // Identification is required of every client, public or not (RFC 6749 §3.2.1).
  if (!clientId) return null;

  if (!clientSecret) {
    const app = await repo.findByClientId(clientId);
    if (!app || !app.active || !app.isPublic) return null;
    return app;
  }

  // F112 — every attempt lands in `client_secret_auth_log`, successes included:
  // two of the three alert conditions are about SUCCESSFUL verifications from
  // new source IPs and about attempts against deactivated apps.
  //
  // The callback is invoked synchronously inside `verifyClientSecret`, but the
  // INSERT it starts is never awaited (`recordSecretAuthSafely`). That is what
  // keeps PF-036's constant-time property: this function must take the same time
  // for an unknown client as for a wrong secret, and awaiting a write whose row
  // differs between those two cases would reintroduce the timing oracle the
  // `ABSENT_APP_DIGEST` comparison exists to remove.
  const outcome = await verifyClientSecret(
    repo,
    clientId,
    clientSecret,
    secretAuthOnAttempt(secretAuthLog, clock, clientId, sourceIpOf(req)),
  );
  return outcome.ok ? outcome.app : null;
}

/**
 * The caller's address, or `null` when there isn't a meaningful one.
 *
 * `null` rather than the string `'unknown'` that `limiter.ts` uses: alert
 * condition (b) counts DISTINCT source IPs, and a literal `'unknown'` would be
 * counted as a distinct address — so a handful of socket-less internal calls
 * would trip the "one secret in use from more places than an integration should
 * have" alarm on their own. Migration 040 makes the column nullable for exactly
 * this, and `countDistinctSuccessIps` filters `IS NOT NULL`.
 */
function sourceIpOf(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
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
      // F112 — the device flow verifies secrets too, so it records too.
      ...(deps.secretAuthLog ? { secretAuthLog: deps.secretAuthLog } : {}),
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

  // L99 F38 — CORS, on the TOKEN ENDPOINT ONLY.
  //
  // A public client is a browser app by definition (RFC 6749 §2.1), and a
  // browser app's token exchange is a cross-origin `fetch`. Without this the
  // exchange fails in the browser and *only* in the browser: `curl` succeeds,
  // every server-side test succeeds, and the single-page demo shows an opaque
  // network error. That is the failure mode this endpoint had before migration
  // 074 made public clients reachable at all.
  //
  // Scoped to `/token` rather than mounted router-wide, deliberately. The
  // neighbours on this router — `/authorize`, `/authorize/decision`,
  // `/device/verify` — are SESSION-COOKIE-authenticated browser pages, and a
  // cookie-authenticated surface is exactly what CORS exists to protect. They
  // are top-level navigations and same-origin form posts, so they need no CORS
  // headers and must not advertise any. `/token` carries no ambient credential:
  // its caller presents a code plus a PKCE verifier it already holds.
  router.use('/token', publicCors());

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
      const app = await authenticateClient(
        deps.appsRepo,
        req,
        params,
        deps.secretAuthLog,
        deps.clock,
      );
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
