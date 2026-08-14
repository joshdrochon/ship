/**
 * `GET /oauth/authorize` and the consent decision `POST`. PF-094 – PF-099.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY BROWSER DEPENDENCY IS INJECTED RATHER THAN IMPORTED.
 * ---------------------------------------------------------------------------
 * This page needs three things the internal stack owns: the `session_id` cookie's
 * identity, the `csrf-sync` synchroniser token, and the login path to bounce an
 * anonymous visitor to. All three arrive as constructor arguments.
 *
 * That is not ceremony. `eslint.config.js` fences `platform/**` out of
 * `**\/middleware/**` and `**\/routes/**` (PF-009/PF-010), and the fence is
 * right: `platform/` having its own opinion about session auth is precisely the
 * drift that would make the public/internal split a slogan. Injection also means
 * the composition root hands over the SAME `csrf-sync` instance and the SAME
 * `express-session` instance the portal uses — a second `session()` call would
 * create a second MemoryStore and the consent screen would silently not see the
 * user's login.
 *
 * ---------------------------------------------------------------------------
 * PF-097 / L99 F26 — CSRF, AND THE BEARER SKIP THAT MUST NOT REACH THIS ROUTE.
 * ---------------------------------------------------------------------------
 * `api/src/app.ts:73`'s `conditionalCsrf` skips CSRF whenever an
 * `Authorization: Bearer` header is present. That is safe TODAY only because
 * `api/src/middleware/auth.ts:135` does not fall back to session auth on an
 * invalid bearer — a coupling nothing in the repo pinned until L01's middleware
 * snapshot hashed `auth.ts` and L22's PF-665 tested it.
 *
 * This route does not rely on that coupling and does not duplicate it either. It
 * closes the hole locally, the same way L02's PF-046 does for the app-form
 * routes: the consent POST REFUSES BEARER AUTHENTICATION OUTRIGHT, before
 * anything else, and then runs the unconditional `csrfProtection` — not
 * `conditionalCsrf`. A caller presenting a session cookie and a junk bearer
 * header therefore gets rejected rather than skipping the check.
 *
 * Transport note: an HTML form cannot set an `x-csrf-token` header, so the token
 * travels as a `_csrf` body field and is copied onto the header the app's
 * configured extractor reads. Same synchroniser, same session secret, same
 * validation — only the transport differs, which is a property of HTML forms and
 * not a weakening of the check.
 *
 * ---------------------------------------------------------------------------
 * THE HIDDEN FORM FIELDS ARE NOT TRUSTED.
 * ---------------------------------------------------------------------------
 * The consent form re-submits the authorize parameters, and the POST handler
 * runs `validateAuthorizeRequest` over them again from scratch. Anything else
 * would make the hidden fields the security boundary — a POST is as forgeable as
 * a GET, and "we already checked these" is how a validated `redirect_uri` turns
 * back into an attacker-supplied one between two requests.
 *
 * ---------------------------------------------------------------------------
 * D4 IS IMPLEMENTED BY DOING NOTHING SPECIAL (PF-099).
 * ---------------------------------------------------------------------------
 * Scope upgrade is re-consent with union. There is no grant table here, no
 * lookup of a prior grant and no `UPDATE` against one — a client that now wants
 * more simply restarts `/oauth/authorize` asking for the union, the user sees
 * every scope the new token will carry, and a fresh token replaces the old one.
 * The absence of grant state IS the implementation, which is what makes the
 * decision cheap; `consent.test.ts` greps this lane to prove the absence.
 */
import { Router, urlencoded } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { Clock } from '../clock.js';
import type { IOAuthAppRepo } from '../apps/repo.js';
import type { ScopeRegistry, ScopeDefinition } from '../scopes/registry.js';
import { scopeRegistry, type Scope } from '../scopes/scopes.js';
import { resolveGrantedScopes } from '../scopes/validation.js';
import {
  validateAuthorizeRequest,
  buildRedirect,
  type AuthorizeQuery,
  type ValidatedAuthorizeRequest,
} from './authorize.js';
import { renderConsentPage, renderAuthorizeErrorPage } from './consentPage.js';
import {
  generateAuthorizationCode,
  hashAuthorizationCode,
  authorizationCodePrefix,
  AUTHORIZATION_CODE_TTL_SECONDS,
  type IAuthCodeRepo,
} from './authCodes.js';

/** The logged-in human, as the composition root resolves them from the session cookie. */
export interface BrowserUser {
  userId: string;
  workspaceId: string;
  /** For display only. Falls back to the id when the resolver has nothing better. */
  label?: string;
}

/** Everything the browser-facing half of `/oauth` needs, all injected. See the header. */
export interface OAuthBrowserDeps {
  /** Same instances as the internal stack: cookie parsing and `express-session`. */
  sessionMiddleware: RequestHandler[];
  /** The app's `csrf-sync` synchroniser. NOT `conditionalCsrf` — see the header. */
  csrfProtection: RequestHandler;
  /** The app's `csrf-sync` token generator, for the form's hidden field. */
  generateCsrfToken: (req: Request) => string;
  /** Resolves the `session_id` cookie to a user, applying Ship's own timeout rules. */
  resolveBrowserUser: (req: Request) => Promise<BrowserUser | null>;
  /** Where an anonymous visitor is sent. Must honour `returnTo`. */
  loginPath: string;
}

export interface AuthorizeRoutesDeps {
  appsRepo: IOAuthAppRepo;
  authCodeRepo: IAuthCodeRepo;
  clock: Clock;
  browser: OAuthBrowserDeps;
  /** Overridable for the PF-095 test that mutates a description. Defaults to L03's. */
  registry?: ScopeRegistry<string>;
}

/** Mount path of the consent decision, relative to the `/oauth` mount. */
export const CONSENT_DECISION_PATH = '/authorize/decision';

/**
 * PF-096 — clickjacking protection, as headers on the actual response.
 *
 * ⚑ MEASURED, NOT ASSUMED, and the ticket asked for exactly this re-check:
 * `createApp()` configures helmet once, app-wide, with an explicit
 * `contentSecurityPolicy.directives` object that lists `frameSrc: ["'none'"]`
 * and NO `frame-ancestors`. `frameSrc` controls what THIS page may embed;
 * `frame-ancestors` controls who may embed this page. They are different
 * directives solving opposite problems, and confusing them is the most common
 * way a consent screen ends up framable while looking protected.
 *
 * So the header is set HERE, explicitly, on the OAuth router, and
 * `consent.test.ts` asserts it on a real response and inside a real framed
 * browser (PF-108's Playwright suite). A lane that "relies on helmet" is relying
 * on a config another lane can change without failing any test.
 *
 * Three headers, deliberately:
 *   frame-ancestors 'none'  the standard, and the only one that can express
 *                           "nobody, including same-origin".
 *   X-Frame-Options: DENY   what a browser too old for CSP Level 2 honours.
 *   Cache-Control: no-store so a back-navigation cannot re-present a consent
 *                           form bound to a request that has already been spent.
 *
 * Applied router-wide rather than per-route. Wider than PF-096 asks for, and on
 * purpose: it means L05's device-verification screen — a second browser-facing
 * page on this same router — inherits the protection instead of having to
 * remember it. `/oauth/token` picking up two irrelevant headers costs nothing.
 */
export function oauthBrowserSecurityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  };
}

/**
 * PF-097's first line of defence: this surface accepts session authentication
 * and nothing else.
 *
 * Mirrors L02's `rejectBearerAuth` in `routes/apps.ts`, and exists for the same
 * reason: it makes the `conditionalCsrf` bearer skip structurally unable to
 * route around CSRF here, rather than leaving that to a coupling in another file.
 */
function rejectBearerAuth(): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^bearer\s/i.test(header)) {
      res
        .status(401)
        .type('html')
        .send(
          renderAuthorizeErrorPage(
            'invalid_request',
            'The consent screen accepts session authentication only. A bearer token cannot approve a grant on a user’s behalf.',
          ),
        );
      return;
    }
    next();
  };
}

/** The authorize parameters, read from either a query string or a form body. */
function readAuthorizeParams(source: Record<string, unknown>): AuthorizeQuery {
  const str = (key: string): string | undefined => {
    const value = source[key];
    // Express gives an array when a parameter is repeated. A repeated
    // `redirect_uri` is not a request this server tries to interpret — taking
    // the first or the last is exactly the kind of parser disagreement the
    // byte-for-byte comparison exists to avoid.
    return typeof value === 'string' ? value : undefined;
  };
  return {
    response_type: str('response_type'),
    client_id: str('client_id'),
    redirect_uri: str('redirect_uri'),
    scope: str('scope'),
    state: str('state'),
    code_challenge: str('code_challenge'),
    code_challenge_method: str('code_challenge_method'),
  };
}

/** Exactly the fields the consent form re-submits. Omitting one loses it. */
function hiddenFields(query: AuthorizeQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * PF-091 / PF-074 — what the user is actually asked to approve.
 *
 * The intersection of what the client asked for and what the app registered.
 * Showing a scope the app never registered would be a lie: `resolveGrantedScopes`
 * would strip it at issuance, so the user would be consenting to something the
 * token cannot carry.
 */
function offeredScopes(request: ValidatedAuthorizeRequest): Scope[] {
  return resolveGrantedScopes(request.app.requestedScopes, request.requestedScopes);
}

function definitionsFor(scopes: Scope[], registry: ScopeRegistry<string>): ScopeDefinition<string>[] {
  return scopes
    .map((scope) => registry.get(scope))
    .filter((def): def is ScopeDefinition<string> => def !== undefined);
}

function renderError(res: Response, status: number, error: string, description: string): void {
  res.status(status).type('html').send(renderAuthorizeErrorPage(error, description));
}

/**
 * Mounts `GET /authorize` and `POST /authorize/decision` onto the OAuth router.
 *
 * A function rather than its own Router so that the security headers, the body
 * parser and the token endpoint all sit on one router — PF-107's assertion that
 * `/oauth/*` shares no middleware with the v1 stack is about a single mounted
 * layer, and two nested routers would make "the terminal handler for /oauth is
 * this lane's" harder to state than it needs to be.
 */
export function mountAuthorizeRoutes(router: Router, deps: AuthorizeRoutesDeps): void {
  const registry = deps.registry ?? scopeRegistry;
  const { browser } = deps;

  /**
   * Resolves `client_id` and validates everything, then dispatches the three
   * outcomes. Shared by GET and POST so the two cannot disagree about what a
   * valid request is — which is the failure the re-validation exists to prevent.
   */
  async function validate(
    req: Request,
    res: Response,
    params: AuthorizeQuery,
  ): Promise<ValidatedAuthorizeRequest | null> {
    const app = params.client_id ? await deps.appsRepo.findByClientId(params.client_id) : null;
    const outcome = validateAuthorizeRequest(app, params, registry);

    if (outcome.ok) return outcome.request;

    if (outcome.error.disposition === 'render') {
      // RFC 6749 §4.1.2.1. No `Location`, ever — see authorize.ts's header.
      renderError(res, 400, outcome.error.error, outcome.error.errorDescription);
      return null;
    }

    res.redirect(
      302,
      buildRedirect(
        outcome.error.redirectUri,
        { error: outcome.error.error, error_description: outcome.error.errorDescription },
        outcome.error.state,
      ),
    );
    return null;
  }

  /**
   * Tenancy. Not in any ticket, and it is a hole without it.
   *
   * `issueTokenPair` stamps the token with `app.workspaceId` (L06's choice, and
   * the right one — a token belongs to the app's workspace). So a user signed
   * into workspace A consenting to an app registered in workspace B would mint a
   * token scoped to B on the strength of an A session. That is a cross-tenant
   * escalation reachable by anyone who can read a client_id, and client_ids are
   * not secret.
   *
   * Rendered rather than redirected, for PF-093's reason: the grant cannot
   * happen, and there is nothing useful for the client to do with the failure.
   */
  function sameWorkspace(request: ValidatedAuthorizeRequest, user: BrowserUser): boolean {
    return request.app.workspaceId === user.workspaceId;
  }

  router.get('/authorize', ...browser.sessionMiddleware, (req, res, next) => {
    void (async () => {
      const params = readAuthorizeParams(req.query as Record<string, unknown>);
      const request = await validate(req, res, params);
      if (!request) return;

      const user = await browser.resolveBrowserUser(req);
      if (!user) {
        // PF-098 — login in the middle, with the authorize parameters intact.
        //
        // The whole original URL is the return target, so `code_challenge` and
        // `state` survive the round trip. Losing the challenge here is the
        // classic bug in this flow: the user logs in, comes back to a bare
        // `/oauth/authorize`, and either gets an opaque `invalid_request` or —
        // far worse in an implementation that made PKCE optional — a code with
        // no challenge bound to it.
        const returnTo = req.originalUrl;
        res.redirect(302, `${browser.loginPath}?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }

      if (!sameWorkspace(request, user)) {
        renderError(
          res,
          403,
          'access_denied',
          'This application belongs to a different workspace than the one you are signed in to.',
        );
        return;
      }

      const scopes = offeredScopes(request);
      if (scopes.length === 0) {
        // Every scope the client asked for was outside the app's registration.
        // Consent to nothing is not consent, and issuing a zero-scope token is
        // the failure authorize.ts's scope note already refuses.
        res.redirect(
          302,
          buildRedirect(
            request.redirectUri,
            {
              error: 'invalid_scope',
              error_description: 'None of the requested scopes are registered to this application.',
            },
            request.state,
          ),
        );
        return;
      }

      res.status(200).type('html').send(
        renderConsentPage({
          appName: request.app.name,
          clientId: request.app.clientId,
          redirectUri: request.redirectUri,
          scopes: definitionsFor(scopes, registry),
          actionPath: `${req.baseUrl}${CONSENT_DECISION_PATH}`,
          csrfToken: browser.generateCsrfToken(req),
          hidden: hiddenFields(params),
          userLabel: user.label ?? user.userId,
        }),
      );
    })().catch(next);
  });

  router.post(
    CONSENT_DECISION_PATH,
    // Order is the ticket. Bearer is refused BEFORE the CSRF check, so a caller
    // cannot reach the check at all with a bearer header; and `csrfProtection`
    // is the unconditional synchroniser, never `conditionalCsrf`.
    rejectBearerAuth(),
    ...browser.sessionMiddleware,
    (req, _res, next) => {
      // An HTML form cannot set a header, so the token arrives as `_csrf` in the
      // body and is copied onto the header the app's extractor reads. Same
      // instance, same session secret, same validation.
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!req.headers['x-csrf-token'] && typeof body._csrf === 'string') {
        req.headers['x-csrf-token'] = body._csrf;
      }
      next();
    },
    browser.csrfProtection,
    (req, res, next) => {
      void (async () => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const params = readAuthorizeParams(body);

        // RE-VALIDATED from scratch. The hidden fields are input, not evidence.
        const request = await validate(req, res, params);
        if (!request) return;

        const user = await browser.resolveBrowserUser(req);
        if (!user) {
          renderError(res, 401, 'access_denied', 'Your session ended before the decision was recorded. Start the authorization again.');
          return;
        }

        if (!sameWorkspace(request, user)) {
          renderError(
            res,
            403,
            'access_denied',
            'This application belongs to a different workspace than the one you are signed in to.',
          );
          return;
        }

        // PF-098 — Deny is a first-class outcome. No row is written, which the
        // test asserts by row count rather than by the absence of a `code`
        // parameter: an implementation that wrote the row and then declined to
        // return it would pass the weaker check.
        if (body.decision !== 'allow') {
          res.redirect(
            302,
            buildRedirect(
              request.redirectUri,
              { error: 'access_denied', error_description: 'The user denied the request.' },
              request.state,
            ),
          );
          return;
        }

        // PF-091 / PF-074 — the app's registration is a ceiling the consent
        // payload cannot raise. Applied here as well as at render time, because
        // this body came over the network and the rendered form did not
        // constrain it.
        const granted = resolveGrantedScopes(request.app.requestedScopes, request.requestedScopes);
        if (granted.length === 0) {
          res.redirect(
            302,
            buildRedirect(
              request.redirectUri,
              {
                error: 'invalid_scope',
                error_description: 'None of the requested scopes are registered to this application.',
              },
              request.state,
            ),
          );
          return;
        }

        const now = new Date(deps.clock.nowMs());
        const code = generateAuthorizationCode();
        await deps.authCodeRepo.insert({
          codeHash: hashAuthorizationCode(code),
          codePrefix: authorizationCodePrefix(code),
          appId: request.app.id,
          userId: user.userId,
          workspaceId: request.app.workspaceId,
          redirectUri: request.redirectUri,
          scopes: granted,
          codeChallenge: request.codeChallenge,
          codeChallengeMethod: request.codeChallengeMethod,
          expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
          createdAt: now,
        });

        res.redirect(302, buildRedirect(request.redirectUri, { code }, request.state));
      })().catch(next);
    },
  );
}

/**
 * The form parser for the consent POST.
 *
 * Exported so the router mounts it once alongside the token endpoint's, rather
 * than this module reaching for `express.urlencoded` a second time with a
 * different limit.
 */
export function consentBodyParser(): RequestHandler {
  return urlencoded({ extended: false, limit: '64kb' });
}
