/**
 * `GET /oauth/device/verify` and the decision POSTs — RFC 8628 §3.3.
 * PF-128 – PF-133 (lane L05, slice S2).
 *
 * PRD p.3's second clause: *"/oauth/device/verify accepts the user_code."*
 *
 * ---------------------------------------------------------------------------
 * D-PF-128 — THE VERIFICATION UX, DECIDED.
 * ---------------------------------------------------------------------------
 * PRD p.16 asks it as a genuinely open question: *"For the Device Authorization
 * Grant: what is your verification URL UX — do users paste a code into a form,
 * or do you embed the code in a URL they click? RFC 8628 allows both."*
 *
 * **Decision: ship both, with the form as the normative path.** The form is what
 * p.3 requires — a URL that carries the code does not "accept" it — and what
 * p.7's SDK callback presumes by handing the caller a code AND a URL as two
 * separate values. `verification_uri_complete` (RFC 8628 §3.3.1) ships alongside
 * it because a clickable link is a materially better demo.
 *
 * **The load-bearing part is not which one ships.** It is that the completed URI
 * still renders the code and asks the user to confirm it matches their terminal
 * (see `renderDeviceConsentPage`). Without that confirmation the completed URI is
 * a one-click device-phishing primitive, and RFC 8628 §5.4 names exactly this
 * attack. It would be very easy to ship it without, because the flow "works"
 * either way.
 *
 * Rejected: form-only (worse demo for no security gain, since the form is still
 * reachable and the confirmation is what does the work); complete-URI-only
 * (removes the confirmation step and contradicts p.3).
 *
 * ---------------------------------------------------------------------------
 * TWO POSTS, MIRRORING L04's `/authorize` + `/authorize/decision`.
 * ---------------------------------------------------------------------------
 *   POST /device/verify           the user_code is submitted  -> consent shown
 *   POST /device/verify/decision  allow or deny               -> recorded
 *
 * The same split, in the same shape, as the authorization-code flow, so the two
 * consent surfaces are one pattern rather than two. Both carry PF-097's exact
 * hardening: bearer refused OUTRIGHT before anything else, then the
 * UNCONDITIONAL `csrfProtection` — never `conditionalCsrf`, whose bearer skip
 * (L99 F26) must not be able to route around the check here.
 *
 * ---------------------------------------------------------------------------
 * THE HIDDEN `user_code` IS NOT TRUSTED.
 * ---------------------------------------------------------------------------
 * The consent form re-submits the code, and the decision handler looks it up
 * again from scratch. Anything else would make a hidden field the security
 * boundary — a POST is as forgeable as a GET, and "we already checked this" is
 * how a validated code turns back into an attacker-supplied one between two
 * requests.
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import type { Clock } from '../clock.js';
import type { IOAuthAppRepo } from '../apps/repo.js';
import type { ScopeRegistry, ScopeDefinition } from '../scopes/registry.js';
import { scopeRegistry, type Scope } from '../scopes/scopes.js';
import { resolveGrantedScopes } from '../scopes/validation.js';
import type { BrowserUser, OAuthBrowserDeps } from './consent.js';
import {
  renderDeviceEntryPage,
  renderDeviceConsentPage,
  renderDeviceResultPage,
  renderAuthorizeErrorPage,
} from './consentPage.js';
import {
  normalizeUserCode,
  type IDeviceCodeRepo,
  type DeviceCodeRecord,
} from './deviceCodes.js';
import {
  UserCodeAttemptThrottle,
  throttleKeysFor,
  USER_CODE_FAILURE_COOLDOWN_SECONDS,
} from './deviceThrottle.js';
import { DEVICE_VERIFY_PATH } from './deviceAuthorization.js';

/** Mount path of the device consent decision, relative to the `/oauth` mount. */
export const DEVICE_DECISION_PATH = '/device/verify/decision';

export interface DeviceVerifyDeps {
  appsRepo: IOAuthAppRepo;
  deviceCodeRepo: IDeviceCodeRepo;
  clock: Clock;
  browser: OAuthBrowserDeps;
  registry?: ScopeRegistry<string>;
  /** Injected so a test can drive the thresholds. Defaults to the shipped constants. */
  throttle?: UserCodeAttemptThrottle;
}

/** The copy for each terminal state. Data, so the tests assert what ships. */
export const DEVICE_VERIFY_MESSAGES = {
  notFound: 'That code was not recognised. Check the code shown in your terminal and try again.',
  expired: 'This code has expired. Start again by running the command on your device.',
  alreadyApproved: 'Already approved — return to your terminal.',
  alreadyDecided: 'This code has already been used. Start again from your device if you need to connect it.',
  denied: 'Access denied. The device will not be connected.',
  approved: 'Device connected — return to your terminal.',
  throttled:
    'Too many incorrect codes have been entered. For security, code entry is paused. Try again later, or start a new login from your device.',
  invalidated:
    'This code has been invalidated because too many incorrect codes were entered from here. Start a new login from your device.',
} as const;

function renderResult(res: Response, status: number, heading: string, message: string): void {
  res.status(status).type('html').send(renderDeviceResultPage(heading, message));
}

/**
 * PF-097's first line of defence, applied to THIS route rather than assumed from
 * the neighbour. Mirrors `consent.ts`'s `rejectBearerAuth` deliberately: the two
 * browser surfaces on this router must not depend on each other for hardening.
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
            'The device verification screen accepts session authentication only. A bearer token cannot approve a grant on a user’s behalf.',
          ),
        );
      return;
    }
    next();
  };
}

/** Copies the form's `_csrf` body field onto the header the app's extractor reads. */
function csrfFromBody(): RequestHandler {
  return (req, _res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!req.headers['x-csrf-token'] && typeof body._csrf === 'string') {
      req.headers['x-csrf-token'] = body._csrf;
    }
    next();
  };
}

function definitionsFor(
  scopes: Scope[],
  registry: ScopeRegistry<string>,
): ScopeDefinition<string>[] {
  return scopes
    .map((scope) => registry.get(scope))
    .filter((def): def is ScopeDefinition<string> => def !== undefined);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

export function mountDeviceVerifyRoutes(router: Router, deps: DeviceVerifyDeps): void {
  const registry = deps.registry ?? scopeRegistry;
  const { browser } = deps;
  const throttle = deps.throttle ?? new UserCodeAttemptThrottle(deps.clock);

  /** Session id, for the throttle's first key. Undefined for an anonymous visitor. */
  function sessionIdOf(req: Request): string | undefined {
    const withSession = req as Request & { sessionID?: string };
    return withSession.sessionID;
  }

  function keysFor(req: Request): string[] {
    return throttleKeysFor(sessionIdOf(req), req.ip);
  }

  /**
   * Resolves a submitted `user_code` to a usable pending row, or renders the
   * reason it is not one and returns null.
   *
   * Shared by the two POSTs so they cannot disagree about what a usable code is
   * — which is the failure the decision handler's re-lookup exists to prevent.
   */
  async function resolvePending(
    req: Request,
    res: Response,
    submitted: string,
  ): Promise<DeviceCodeRecord | null> {
    const keys = keysFor(req);

    for (const key of keys) {
      const decision = throttle.check(key);
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds ?? USER_CODE_FAILURE_COOLDOWN_SECONDS));
        renderResult(res, 429, 'Too many attempts', DEVICE_VERIFY_MESSAGES.throttled);
        return null;
      }
    }

    const normalized = normalizeUserCode(submitted);
    const row = normalized === '' ? null : await deps.deviceCodeRepo.findByUserCode(normalized);

    if (!row) {
      // PF-132 — count the FAILURE, not the request. L11's limiter already
      // counts requests; this is the tighter, guess-specific counter.
      let blocked = false;
      for (const key of keys) {
        const decision = throttle.recordFailure(key);
        if (!decision.allowed) blocked = true;
      }
      if (blocked) {
        res.setHeader('Retry-After', String(USER_CODE_FAILURE_COOLDOWN_SECONDS));
        renderResult(res, 429, 'Too many attempts', DEVICE_VERIFY_MESSAGES.throttled);
        return null;
      }
      renderResult(res, 404, 'Code not recognised', DEVICE_VERIFY_MESSAGES.notFound);
      return null;
    }

    // PF-132's second half: a code FOUND while this origin is over the threshold
    // is a guessed code, not a user finally typing their own correctly. It is
    // invalidated rather than left live — the legitimate user re-runs the
    // command, which costs one command; the attacker loses the code they found.
    if (keys.some((key) => throttle.isSuspect(key))) {
      await deps.deviceCodeRepo.invalidate(row.id, new Date(deps.clock.nowMs()));
      renderResult(res, 429, 'Code invalidated', DEVICE_VERIFY_MESSAGES.invalidated);
      return null;
    }

    const now = deps.clock.nowMs();

    // PF-127 — expiry is a real outcome the user can act on. Checked before the
    // status branches, because an expired approved code is still expired.
    if (row.expiresAt.getTime() <= now) {
      renderResult(res, 410, 'Code expired', DEVICE_VERIFY_MESSAGES.expired);
      return null;
    }

    // PF-133 — the already-decided states, each distinct and each terminal.
    if (row.consumedAt !== null) {
      renderResult(res, 409, 'Already used', DEVICE_VERIFY_MESSAGES.alreadyDecided);
      return null;
    }
    if (row.status === 'approved') {
      // Not a second consent screen. The user already said yes.
      renderResult(res, 200, 'Already approved', DEVICE_VERIFY_MESSAGES.alreadyApproved);
      return null;
    }
    if (row.status === 'denied') {
      renderResult(res, 200, 'Access denied', DEVICE_VERIFY_MESSAGES.denied);
      return null;
    }

    for (const key of keys) throttle.recordSuccess(key);
    return row;
  }

  /**
   * PF-129 — the entry screen.
   *
   * An anonymous visitor is sent through Ship's login and returned to THIS URL
   * with the code parameter intact. Losing the code across the login round trip
   * is the classic bug in this leg: the user clicks a completed URI, logs in,
   * and lands on an empty form having lost the value they were never asked to
   * memorise.
   */
  router.get(DEVICE_VERIFY_PATH, ...browser.sessionMiddleware, (req, res, next) => {
    void (async () => {
      const user = await browser.resolveBrowserUser(req);
      if (!user) {
        const returnTo = req.originalUrl;
        res.redirect(302, `${browser.loginPath}?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }

      res.status(200).type('html').send(
        renderDeviceEntryPage({
          // Pre-filled when arrived at via `verification_uri_complete`.
          userCode: readString(req.query as Record<string, unknown>, 'user_code') ?? '',
          actionPath: `${req.baseUrl}${DEVICE_VERIFY_PATH}`,
          csrfToken: browser.generateCsrfToken(req),
          userLabel: user.label ?? user.userId,
        }),
      );
    })().catch(next);
  });

  /** PF-130 — the code is submitted; consent is shown. */
  router.post(
    DEVICE_VERIFY_PATH,
    rejectBearerAuth(),
    ...browser.sessionMiddleware,
    csrfFromBody(),
    browser.csrfProtection,
    (req, res, next) => {
      void (async () => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const user = await browser.resolveBrowserUser(req);
        if (!user) {
          renderResult(res, 401, 'Session ended', 'Your session ended before the code was accepted. Sign in and try again.');
          return;
        }

        const row = await resolvePending(req, res, readString(body, 'user_code') ?? '');
        if (!row) return;

        const app = await deps.appsRepo.findById(row.appId);
        if (!app || !app.active) {
          // D2 again, at the second gate. An app deactivated between issuance
          // and approval must not be approvable.
          renderResult(res, 403, 'Application unavailable', 'This application is no longer active.');
          return;
        }

        if (app.workspaceId !== user.workspaceId) {
          // Tenancy, on the same terms as L04's consent screen: `issueTokenPair`
          // stamps the token with `app.workspaceId`, so a user in workspace A
          // approving an app registered in B would mint a B-scoped token on an A
          // session. F43 closed exactly this on the authorize leg.
          renderResult(
            res,
            403,
            'Wrong workspace',
            'This application belongs to a different workspace than the one you are signed in to.',
          );
          return;
        }

        const offered = resolveGrantedScopes(app.requestedScopes, row.scopes);
        if (offered.length === 0) {
          renderResult(res, 400, 'Nothing to approve', 'This application requested no permissions this device can be granted.');
          return;
        }

        res.status(200).type('html').send(
          renderDeviceConsentPage({
            appName: app.name,
            clientId: app.clientId,
            // PF-128 — the code, rendered, for the user to compare against
            // their terminal. This is the anti-phishing step.
            userCode: row.userCode,
            // PF-063/PF-070 — descriptions read from the registry. A grep
            // asserts no scope literal exists in the template.
            scopes: definitionsFor(offered, registry),
            actionPath: `${req.baseUrl}${DEVICE_DECISION_PATH}`,
            csrfToken: browser.generateCsrfToken(req),
            userLabel: user.label ?? user.userId,
          }),
        );
      })().catch(next);
    },
  );

  /** PF-130 / PF-133 — the decision is recorded and the user bound to the grant. */
  router.post(
    DEVICE_DECISION_PATH,
    rejectBearerAuth(),
    ...browser.sessionMiddleware,
    csrfFromBody(),
    browser.csrfProtection,
    (req, res, next) => {
      void (async () => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const user = await browser.resolveBrowserUser(req);
        if (!user) {
          renderResult(res, 401, 'Session ended', 'Your session ended before the decision was recorded. Sign in and try again.');
          return;
        }

        // RE-LOOKED UP from scratch. The hidden field is input, not evidence.
        const row = await resolvePending(req, res, readString(body, 'user_code') ?? '');
        if (!row) return;

        const app = await deps.appsRepo.findById(row.appId);
        if (!app || !app.active || app.workspaceId !== user.workspaceId) {
          renderResult(res, 403, 'Application unavailable', 'This application is no longer active for your workspace.');
          return;
        }

        const now = new Date(deps.clock.nowMs());

        if (body.decision !== 'allow') {
          // PF-133 — denial is terminal and VISIBLE to the poller. A server that
          // left the row pending would make the CLI poll until expiry and report
          // the wrong reason.
          await deps.deviceCodeRepo.deny(row.id, now);
          renderResult(res, 200, 'Access denied', DEVICE_VERIFY_MESSAGES.denied);
          return;
        }

        // PF-074 — the RESOLVED grant. The app's registration is a ceiling the
        // row's requested set cannot raise, applied here as well as at issuance
        // because the app's registration may have narrowed in between.
        const granted = resolveGrantedScopes(app.requestedScopes, row.scopes);
        if (granted.length === 0) {
          renderResult(res, 400, 'Nothing to approve', 'This application requested no permissions this device can be granted.');
          return;
        }

        const won = await deps.deviceCodeRepo.approve(
          { id: row.id, userId: user.userId, workspaceId: user.workspaceId, scopes: granted },
          now,
        );
        if (!won) {
          // Lost a race with another tab. The other decision stands.
          renderResult(res, 409, 'Already decided', DEVICE_VERIFY_MESSAGES.alreadyDecided);
          return;
        }

        renderResult(res, 200, 'Device connected', DEVICE_VERIFY_MESSAGES.approved);
      })().catch(next);
    },
  );
}
