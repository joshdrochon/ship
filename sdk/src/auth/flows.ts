/**
 * OAuth flow helpers — each flow end-to-end in one call. PF-537 – PF-541.
 *
 * p.4: *"ShipClient.authorizationCodeFlow() and ShipClient.deviceLogin() handle
 * their flows end-to-end. Pluggable ITokenStore (in-memory, file, browser
 * localStorage)."* p.7 prints `deviceLogin`'s signature; p.6's five-line story
 * makes it `ship login`.
 *
 * These are the module-level implementations; `ShipClient` re-exposes them as
 * the two STATIC methods p.7 declares. Static because there is no authenticated
 * client to call them on yet — that is the point of a login helper.
 *
 * ── The one credential rule, and it is absolute (PF-540) ────────────────────
 * `save()` is called EXACTLY ONCE, at the end, with a complete pair. On any
 * failure — denied consent, expired device code, a network error mid-exchange,
 * a mismatched `state` — it is called ZERO times. That is the *"no partial
 * credential is ever written back"* clause of the Failure Modes contract (p.12)
 * applied at the only point in the system that writes credentials, and it is why
 * every failure path below throws before reaching the write rather than
 * cleaning up after it.
 *
 * ── No wall clock, anywhere (PF-538) ────────────────────────────────────────
 * Every wait goes through the injected `SdkClock`. p.11 is categorical that
 * timing-based tests are flaky tests, and `fitness.test.ts` greps every SDK test
 * for `setTimeout`.
 *
 * ── No browser is opened ────────────────────────────────────────────────────
 * The sketch this replaces invented an `openBrowser` option. The PRD never asks
 * for one — p.7's sketch shows `deviceLogin` only — and a library that shells
 * out to `open` is a library that cannot run in a container, which is where the
 * TTFE drill runs. `deviceLogin` hands the caller a code and a URL;
 * `authorizationCodeFlow` hands the caller a URL and takes back the redirect.
 * Opening something is the CALLER's job, and the caller is the one that knows
 * whether it has a display.
 */
import { buildOAuthTokenUrl, resolveBaseUrl } from '../baseUrl.js';
import { ShipError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { readEnv } from '../internal/env.js';
import { realClock, type SdkClock } from '../retry.js';
import { createFetchHttpClient } from '../http.js';
import { InMemoryTokenStore, type ITokenStore, type StoredTokens } from './tokenStore.js';
import { createPkcePair, generateState, CODE_CHALLENGE_METHOD } from './pkce.js';

/** Read like `SHIP_BASE_URL`, so p.7's zero-config call has a client id to use. */
export const CLIENT_ID_ENV_VAR = 'SHIP_CLIENT_ID';

/** RFC 8628 §3.4. */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 8628 §3.5 — the server adds 5 seconds per `slow_down`, and so do we. */
export const SLOW_DOWN_INCREMENT_SECONDS = 5;

/** RFC 8628 §3.2's default when the server advertises no `interval`. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Options every helper shares. All optional; all injected in tests. */
interface CommonFlowOptions {
  /** Defaults to the same resolution order as `ShipClient` — option, env, published. */
  baseUrl?: string;
  /** Defaults to `SHIP_CLIENT_ID`. Required by both flows one way or the other. */
  clientId?: string;
  /** A confidential client's secret. A CLI is public (RFC 6749 §2.1) and has none. */
  clientSecret?: string;
  /** Where the credential lands. Defaults to a fresh `InMemoryTokenStore`. */
  tokenStore?: ITokenStore;
  /** Injected in tests; the real one otherwise. */
  http?: HttpClient;
  /** Injected in tests — PF-513. There is no `setTimeout` in this module. */
  clock?: SdkClock;
}

/** p.7's option bag, verbatim on its two named members. */
export interface DeviceLoginOptions extends CommonFlowOptions {
  /**
   * Called ONCE, as soon as the server issues a code, with BOTH the code the
   * user types and the URL they type it into.
   *
   * p.7 writes it `(code: string, verifyUrl: string) => void`. A callback given
   * only the code makes the caller hard-code the verification URL, which is the
   * one thing a multi-deployment SDK must never make them do.
   */
  onUserCode: (code: string, verifyUrl: string) => void;
  /** Space-separated on the wire; an array here. */
  scopes?: string[];
}

export interface AuthorizationCodeFlowOptions extends CommonFlowOptions {
  /** Must exactly match one of the app's registered `redirect_uris`. */
  redirectUri: string;
  scopes?: string[];
  /**
   * Hands the caller the `/oauth/authorize` URL and the generated `state`, and
   * takes back the URL the user agent was redirected to.
   *
   * This is the seam that keeps the SDK out of the business of opening
   * browsers. A CLI spawns one and runs a loopback listener; a single-page app
   * assigns `location.href` and resolves on return; a Playwright test drives it
   * directly. All three are the same three lines to this module.
   */
  authorize: (authorizeUrl: string, state: string) => Promise<string>;
}

/** What a completed flow produces, before it becomes a client. */
export interface FlowResult {
  tokens: StoredTokens;
  tokenStore: ITokenStore;
  baseUrl: string;
  clientId: string;
}

interface ResolvedCommon {
  baseUrl: string;
  clientId: string;
  clientSecret: string | undefined;
  tokenStore: ITokenStore;
  http: HttpClient;
  clock: SdkClock;
}

function resolveCommon(options: CommonFlowOptions): ResolvedCommon {
  const clientId = options.clientId ?? readEnv(CLIENT_ID_ENV_VAR) ?? '';
  if (clientId === '') {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: 0,
      message:
        `No client id. Pass \`clientId\`, or export ${CLIENT_ID_ENV_VAR}. Both OAuth flows ` +
        `have to identify the application to /oauth/token (RFC 6749 §2.3.1); there is no ` +
        `anonymous login.`,
    });
  }

  return {
    baseUrl: resolveBaseUrl(options.baseUrl).url,
    clientId,
    clientSecret: options.clientSecret,
    tokenStore: options.tokenStore ?? new InMemoryTokenStore(),
    http: options.http ?? createFetchHttpClient(),
    clock: options.clock ?? realClock,
  };
}

/** `/oauth/<leg>`, preserving a mount path prefix the same way PF-494 does. */
function buildOAuthUrl(baseUrl: string, leg: string): URL {
  const token = buildOAuthTokenUrl(baseUrl);
  const url = new URL(token.toString());
  url.pathname = token.pathname.replace(/\/token$/, leg);
  return url;
}

interface OAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
}

/** RFC 6749 §5.1 success / §5.2 failure, parsed defensively. */
interface TokenEndpointResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function postForm(
  http: HttpClient,
  url: string,
  form: URLSearchParams,
  clientSecret: string | undefined,
): Promise<TokenEndpointResult> {
  if (clientSecret !== undefined) form.set('client_secret', clientSecret);

  const response = await http.send({
    url,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });

  const text = await response.text().catch(() => '');
  let body: Record<string, unknown> | null;
  try {
    const parsed: unknown = text === '' ? null : JSON.parse(text);
    body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * An OAuth failure as a typed `ShipError`.
 *
 * `/oauth/*` speaks RFC 6749's `{error, error_description}`, NOT L07's
 * `ApiError` envelope — two specs, two surfaces. The translation happens here so
 * a consumer still catches ONE type and can still `switch (error.kind)`.
 *
 * The `code` is `null` because the six-member `ApiErrorCode` union describes
 * `/api/v1`, and `invalid_grant` is not a member of it. Claiming otherwise would
 * be a lie a consumer could branch on.
 */
function oauthError(status: number, body: Record<string, unknown> | null, context: string): ShipError {
  const error = (body as OAuthErrorBody | null)?.error;
  const description = (body as OAuthErrorBody | null)?.error_description;
  return new ShipError({
    kind: 'auth',
    code: null,
    status,
    message:
      `${context} failed` +
      (typeof error === 'string' ? ` (${error})` : '') +
      (typeof description === 'string' ? `: ${description}` : '.'),
    // The OAuth code is preserved where a consumer can read it without parsing
    // a message string — `access_denied` and `expired_token` need different
    // handling and only this field tells them apart.
    details: typeof error === 'string' ? { oauth_error: error } : undefined,
  });
}

/** The OAuth `error` code, for a caller branching on `access_denied` vs `expired_token`. */
export function oauthErrorCode(error: unknown): string | null {
  const details = (error as { details?: { oauth_error?: unknown } } | null)?.details;
  return typeof details?.oauth_error === 'string' ? details.oauth_error : null;
}

/** RFC 6749 §5.1's success body → the store's shape. */
function toStoredTokens(body: Record<string, unknown>, nowMs: number): StoredTokens {
  const accessToken = body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: 200,
      message: 'The token endpoint returned no access_token. Nothing was persisted.',
    });
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  const scope = body.scope;
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAtSeconds: expiresIn !== null ? Math.floor(nowMs / 1000) + expiresIn : null,
    scopes: typeof scope === 'string' && scope.trim() !== '' ? scope.trim().split(/\s+/) : [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Authorization Grant — RFC 8628. PF-537, PF-538.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the device flow to completion and returns the credential.
 *
 * `ShipClient.deviceLogin()` wraps this and hands back a ready client; this
 * function exists separately so the flow can be tested without constructing one
 * and so a caller who wants the tokens rather than a client can have them.
 */
export async function runDeviceLogin(options: DeviceLoginOptions): Promise<FlowResult> {
  const common = resolveCommon(options);

  // ── 1. Ask for a device code ─────────────────────────────────────────────
  const authorizeForm = new URLSearchParams({ client_id: common.clientId });
  if (options.scopes !== undefined && options.scopes.length > 0) {
    authorizeForm.set('scope', options.scopes.join(' '));
  }

  const issued = await postForm(
    common.http,
    buildOAuthUrl(common.baseUrl, '/device/code').toString(),
    authorizeForm,
    common.clientSecret,
  );

  if (issued.status < 200 || issued.status >= 300 || issued.body === null) {
    throw oauthError(issued.status, issued.body, 'Requesting a device code');
  }

  const deviceCode = issued.body.device_code;
  const userCode = issued.body.user_code;
  const verificationUri = issued.body.verification_uri;
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string'
  ) {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: issued.status,
      message:
        'The device authorization response is missing device_code, user_code or ' +
        'verification_uri (RFC 8628 §3.2 makes all three REQUIRED).',
    });
  }

  // ── 2. Show the user their code ──────────────────────────────────────────
  //
  // BOTH values, per p.7. `verification_uri_complete` is preferred when the
  // server sent one (RFC 8628 §3.3.1) — it carries the code, so the user can
  // follow a link instead of typing eight characters.
  const completeUri = issued.body.verification_uri_complete;
  options.onUserCode(userCode, typeof completeUri === 'string' ? completeUri : verificationUri);

  // ── 3. Poll, honouring the server's interval ─────────────────────────────
  const advertised = issued.body.interval;
  let intervalSeconds =
    typeof advertised === 'number' && Number.isFinite(advertised) && advertised > 0
      ? advertised
      : DEFAULT_POLL_INTERVAL_SECONDS;

  const expiresIn = issued.body.expires_in;
  const deadlineMs =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn)
      ? common.clock.now() + expiresIn * 1000
      : Number.POSITIVE_INFINITY;

  const tokenUrl = buildOAuthTokenUrl(common.baseUrl).toString();

  for (;;) {
    // The FIRST poll waits too. RFC 8628 §3.5 says the interval is the minimum
    // between polls and the server throttles from the first one — polling
    // immediately earns a `slow_down` before the user has finished typing.
    await common.clock.sleep(intervalSeconds * 1000);

    if (common.clock.now() > deadlineMs) {
      throw new ShipError({
        kind: 'auth',
        code: null,
        status: 0,
        message:
          'The device code expired before the user finished authorizing. Nothing was ' +
          'persisted — start the login again.',
        details: { oauth_error: 'expired_token' },
      });
    }

    const polled = await postForm(
      common.http,
      tokenUrl,
      new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: common.clientId,
      }),
      common.clientSecret,
    );

    if (polled.status >= 200 && polled.status < 300 && polled.body !== null) {
      const tokens = toStoredTokens(polled.body, common.clock.now());
      // THE ONE WRITE. Complete pair in hand, every failure path already thrown.
      await common.tokenStore.save(tokens);
      return {
        tokens,
        tokenStore: common.tokenStore,
        baseUrl: common.baseUrl,
        clientId: common.clientId,
      };
    }

    const error = (polled.body as OAuthErrorBody | null)?.error;

    if (error === 'authorization_pending') continue;

    if (error === 'slow_down') {
      // RFC 8628 §3.5: add 5 seconds and keep it. Not a one-off delay — the
      // server raised its own floor, and a client that reverts to the old
      // interval on the next poll earns another `slow_down` immediately.
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
      continue;
    }

    // `access_denied`, `expired_token`, `invalid_grant`, `invalid_client` and
    // anything else: terminal. Nothing is written, and nothing is retried —
    // hammering a token endpoint that has said no is how a client gets throttled
    // and, on the refresh leg, how it revokes a token family (p.3).
    throw oauthError(polled.status, polled.body, 'The device authorization');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization Code + PKCE — RFC 6749 §4.1 + RFC 7636. PF-539.
// ─────────────────────────────────────────────────────────────────────────────

/** What `authorizationCodeFlow` builds before handing control to the caller. */
export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Builds the `/oauth/authorize` URL for a fresh PKCE pair.
 *
 * Exported because a single-page app cannot use the one-call helper below — it
 * navigates away and comes back in a new page load, so it needs the URL now and
 * the exchange later. L24's browser demo is exactly that shape.
 */
export async function buildAuthorizationRequest(options: {
  baseUrl?: string;
  clientId?: string;
  redirectUri: string;
  scopes?: string[];
}): Promise<AuthorizationRequest> {
  const baseUrl = resolveBaseUrl(options.baseUrl).url;
  const clientId = options.clientId ?? readEnv(CLIENT_ID_ENV_VAR) ?? '';
  if (clientId === '') {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: 0,
      message: `No client id. Pass \`clientId\`, or export ${CLIENT_ID_ENV_VAR}.`,
    });
  }

  const pkce = await createPkcePair();
  const state = generateState();

  const url = buildOAuthUrl(baseUrl, '/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  if (options.scopes !== undefined && options.scopes.length > 0) {
    url.searchParams.set('scope', options.scopes.join(' '));
  }

  return {
    url: url.toString(),
    state,
    codeVerifier: pkce.codeVerifier,
    codeChallenge: pkce.codeChallenge,
  };
}

/**
 * Reads `code` / `state` / `error` off the URL the user agent came back to.
 *
 * Exported for the same reason as `buildAuthorizationRequest`: an SPA resumes
 * the flow in a new page load and needs the second half on its own.
 */
export function parseAuthorizationRedirect(redirectedTo: string): {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
} {
  // A bare query string is accepted too, because that is what a loopback
  // listener often has in hand.
  const query = redirectedTo.includes('?')
    ? redirectedTo.slice(redirectedTo.indexOf('?') + 1)
    : redirectedTo;
  const params = new URLSearchParams(query.split('#')[0] ?? '');
  return {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

/** Exchanges an authorization code for tokens. The verifier leaves the process HERE and nowhere earlier. */
export async function exchangeAuthorizationCode(options: {
  baseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  tokenStore?: ITokenStore;
  http?: HttpClient;
  clock?: SdkClock;
}): Promise<FlowResult> {
  const common = resolveCommon(options);

  const exchanged = await postForm(
    common.http,
    buildOAuthTokenUrl(common.baseUrl).toString(),
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: common.clientId,
      code_verifier: options.codeVerifier,
    }),
    common.clientSecret,
  );

  if (exchanged.status < 200 || exchanged.status >= 300 || exchanged.body === null) {
    // A wrong verifier lands here as `invalid_grant` — p.5 makes that negative
    // case mandatory, and it must be a TYPED error rather than an unhandled
    // rejection two frames up.
    throw oauthError(exchanged.status, exchanged.body, 'The authorization code exchange');
  }

  const tokens = toStoredTokens(exchanged.body, common.clock.now());
  // THE ONE WRITE.
  await common.tokenStore.save(tokens);
  return {
    tokens,
    tokenStore: common.tokenStore,
    baseUrl: common.baseUrl,
    clientId: common.clientId,
  };
}

/** Runs the whole Authorization Code + PKCE flow and returns the credential. */
export async function runAuthorizationCodeFlow(
  options: AuthorizationCodeFlowOptions,
): Promise<FlowResult> {
  const common = resolveCommon(options);

  const request = await buildAuthorizationRequest({
    baseUrl: common.baseUrl,
    clientId: common.clientId,
    redirectUri: options.redirectUri,
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
  });

  const redirectedTo = await options.authorize(request.url, request.state);
  const returned = parseAuthorizationRedirect(redirectedTo);

  if (returned.error !== null) {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: 0,
      message:
        `Authorization failed (${returned.error})` +
        (returned.errorDescription !== null ? `: ${returned.errorDescription}` : '.') +
        ' Nothing was persisted.',
      details: { oauth_error: returned.error },
    });
  }

  // ── state, checked ───────────────────────────────────────────────────────
  //
  // Before the code is spent, not after. A mismatched `state` means the
  // redirect did not come from the request this process started (RFC 6749
  // §10.12), and exchanging its code would bind an attacker's authorization to
  // this user's store.
  if (returned.state !== request.state) {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: 0,
      message:
        'The authorization redirect carried a different `state` than the request. This is ' +
        'the CSRF check (RFC 6749 §10.12) — the code was NOT exchanged and nothing was ' +
        'persisted.',
    });
  }

  if (returned.code === null || returned.code === '') {
    throw new ShipError({
      kind: 'auth',
      code: null,
      status: 0,
      message: 'The authorization redirect carried no `code`. Nothing was persisted.',
    });
  }

  return exchangeAuthorizationCode({
    baseUrl: common.baseUrl,
    clientId: common.clientId,
    ...(common.clientSecret !== undefined ? { clientSecret: common.clientSecret } : {}),
    redirectUri: options.redirectUri,
    code: returned.code,
    codeVerifier: request.codeVerifier,
    tokenStore: common.tokenStore,
    http: common.http,
    clock: common.clock,
  });
}
