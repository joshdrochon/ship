/**
 * OAuth helpers — PF-537 – PF-541.
 *
 * Every wait here goes through `FakeClock`, so the suite runs in milliseconds
 * and asserts what the client ASKED to wait rather than how long it actually
 * waited. p.11 is categorical that timing-based tests are flaky tests, and
 * `fitness.test.ts` greps every SDK test for `setTimeout`.
 *
 * The live half — a scripted device flow against a booted Ship, resolving to a
 * client whose `.me()` succeeds — is
 * `api/src/platform/api/v1/sdkOAuthFlows.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  runDeviceLogin,
  runAuthorizationCodeFlow,
  buildAuthorizationRequest,
  parseAuthorizationRedirect,
  exchangeAuthorizationCode,
  oauthErrorCode,
  SLOW_DOWN_INCREMENT_SECONDS,
} from './flows.js';
import { deriveCodeChallenge, generateCodeVerifier, base64UrlEncode } from './pkce.js';
import { ShipClient } from '../client.js';
import { ShipError } from '../errors.js';
import { InMemoryTokenStore, type ITokenStore, type StoredTokens } from './tokenStore.js';
import { FakeClock, jsonResponse, type StubResponse } from '../testSupport.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';

const BASE_URL = 'https://ship.test';
const CLIENT_ID = 'ship_app_cli';

/** Routes a scripted answer by URL, so a flow's two legs can be scripted apart. */
class RoutingHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly queues: Map<string, (StubResponse | Error)[]>;

  constructor(queues: Record<string, (StubResponse | Error)[]>) {
    this.queues = new Map(Object.entries(queues));
  }

  /** Requests whose URL contains `fragment`. */
  to(fragment: string): HttpRequest[] {
    return this.requests.filter((request) => request.url.includes(fragment));
  }

  /** The parsed form body of the nth request to `fragment`. */
  formTo(fragment: string, index = 0): URLSearchParams {
    const request = this.to(fragment)[index];
    return new URLSearchParams(typeof request?.body === 'string' ? request.body : '');
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    for (const [fragment, queue] of this.queues) {
      if (!request.url.includes(fragment)) continue;
      const priorCalls = this.requests.filter((r) => r.url.includes(fragment)).length - 1;
      const next = queue[Math.min(priorCalls, queue.length - 1)];
      if (next === undefined) break;
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(jsonResponse(next));
    }
    return Promise.resolve(jsonResponse({ status: 404, body: { error: 'not_found' } }));
  }
}

/** Counts `save()` — PF-540's assertion surface. */
class CountingStore implements ITokenStore {
  saveCalls = 0;
  clearCalls = 0;
  saved: StoredTokens | null = null;

  load(): Promise<StoredTokens | null> {
    return Promise.resolve(this.saved);
  }
  save(tokens: StoredTokens): Promise<void> {
    this.saveCalls += 1;
    this.saved = tokens;
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.clearCalls += 1;
    return Promise.resolve();
  }
}

const DEVICE_ISSUED: StubResponse = {
  status: 200,
  body: {
    device_code: 'dc-abc',
    user_code: 'ACDE-FGHJ',
    verification_uri: 'https://ship.test/oauth/device/verify',
    verification_uri_complete: 'https://ship.test/oauth/device/verify?user_code=ACDE-FGHJ',
    expires_in: 600,
    interval: 5,
  },
};

const TOKEN_GRANTED: StubResponse = {
  status: 200,
  body: {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'documents:read documents:write',
  },
};

// ─────────────────────────────────────────────────────────────────────────────

describe('PF-537 · deviceLogin — p.7’s exact static signature', () => {
  it('is a STATIC on ShipClient, taking p.7’s option bag', () => {
    // There is no authenticated client to call it on — that is what the helper
    // is for. An instance method would require the credential it produces.
    expect(typeof ShipClient.deviceLogin).toBe('function');
    expect(typeof ShipClient.authorizationCodeFlow).toBe('function');
    // Not on the prototype: `new ShipClient({token}).deviceLogin` is nothing.
    expect(
      (new ShipClient({ token: 't', baseUrl: BASE_URL }) as unknown as Record<string, unknown>)
        .deviceLogin,
    ).toBeUndefined();
  });

  it('`onUserCode` receives BOTH the code and the verification URL', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [TOKEN_GRANTED],
    });
    const received: [string, string][] = [];

    await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock: new FakeClock(),
      onUserCode: (code, verifyUrl) => received.push([code, verifyUrl]),
    });

    // Called exactly once, with both values. A callback given only the code
    // forces the caller to hard-code a verification URL, which is the one thing
    // a multi-deployment SDK must never make them do.
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]).toBe('ACDE-FGHJ');
    // `verification_uri_complete` is preferred when present (RFC 8628 §3.3.1):
    // it carries the code, so the user follows a link instead of typing eight
    // characters.
    expect(received[0]?.[1]).toBe('https://ship.test/oauth/device/verify?user_code=ACDE-FGHJ');
  });

  it('falls back to `verification_uri` when the server sends no complete form', async () => {
    const { verification_uri_complete: _omitted, ...withoutComplete } = DEVICE_ISSUED.body as Record<
      string,
      unknown
    >;
    const http = new RoutingHttpClient({
      '/oauth/device/code': [{ status: 200, body: withoutComplete }],
      '/oauth/token': [TOKEN_GRANTED],
    });
    let url = '';
    await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock: new FakeClock(),
      onUserCode: (_code, verifyUrl) => {
        url = verifyUrl;
      },
    });
    expect(url).toBe('https://ship.test/oauth/device/verify');
  });

  it('resolves to a client wired to the store the flow wrote to', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [TOKEN_GRANTED],
      '/api/v1/me': [{ status: 200, body: { app: { client_id: CLIENT_ID, name: 'CLI' }, user: null, scopes: [] } }],
    });
    const tokenStore = new InMemoryTokenStore();

    const client = await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      tokenStore,
      http,
      clock: new FakeClock(),
      onUserCode: () => {},
    });

    expect(client).toBeInstanceOf(ShipClient);
    // The credential is in the store the caller passed, and the client reads
    // through it — so its first expiry refreshes rather than sending the user
    // back through the flow.
    expect((await tokenStore.load())?.accessToken).toBe('at-1');
    expect((await tokenStore.load())?.refreshToken).toBe('rt-1');

    const me = await client.me();
    expect(me.app.client_id).toBe(CLIENT_ID);
    expect(http.to('/api/v1/me')[0]?.headers.authorization).toBe('Bearer at-1');
  });

  it('defaults to an in-memory store when none is given', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [TOKEN_GRANTED],
    });
    const result = await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock: new FakeClock(),
      onUserCode: () => {},
    });
    expect(result.tokenStore).toBeInstanceOf(InMemoryTokenStore);
    expect((await result.tokenStore.load())?.accessToken).toBe('at-1');
  });

  it('sends the RFC 8628 grant type and the device code, and no secret when there is none', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [TOKEN_GRANTED],
    });
    await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      scopes: ['documents:read', 'documents:write'],
      http,
      clock: new FakeClock(),
      onUserCode: () => {},
    });

    expect(http.formTo('/oauth/device/code').get('client_id')).toBe(CLIENT_ID);
    expect(http.formTo('/oauth/device/code').get('scope')).toBe('documents:read documents:write');

    const poll = http.formTo('/oauth/token');
    expect(poll.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(poll.get('device_code')).toBe('dc-abc');
    expect(poll.get('client_id')).toBe(CLIENT_ID);
    // A CLI is a public client (RFC 6749 §2.1). No secret is invented for it.
    expect(poll.has('client_secret')).toBe(false);
  });
});

describe('PF-538 · polling honours the server’s interval and backs off on slow_down', () => {
  it('waits the ADVERTISED interval before the first poll, not zero', async () => {
    // RFC 8628 §3.5: the interval is the minimum between polls and the server
    // throttles from the first one. Polling immediately earns a `slow_down`
    // before the user has finished typing.
    const clock = new FakeClock();
    const http = new RoutingHttpClient({
      '/oauth/device/code': [{ status: 200, body: { ...(DEVICE_ISSUED.body as object), interval: 7 } }],
      '/oauth/token': [TOKEN_GRANTED],
    });

    await runDeviceLogin({ baseUrl: BASE_URL, clientId: CLIENT_ID, http, clock, onUserCode: () => {} });

    expect(clock.sleeps).toEqual([7000]);
  });

  it('adds exactly 5 seconds per slow_down, and KEEPS the raised interval', async () => {
    const clock = new FakeClock();
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        TOKEN_GRANTED,
      ],
    });

    await runDeviceLogin({ baseUrl: BASE_URL, clientId: CLIENT_ID, http, clock, onUserCode: () => {} });

    // 5 · pending → 5 · slow_down → 10 · pending → 10 · slow_down → 15 · granted
    //
    // The KEPT interval is the half that matters: a client that reverts to 5 on
    // the next poll earns another `slow_down` immediately, which is the loop
    // this ticket exists to prevent.
    expect(clock.sleeps).toEqual([5000, 5000, 10_000, 10_000, 15_000]);
    expect(SLOW_DOWN_INCREMENT_SECONDS).toBe(5);
    expect(http.to('/oauth/token')).toHaveLength(5);
  });

  it('never polls faster than told — every gap is at least the current interval', async () => {
    const clock = new FakeClock();
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'authorization_pending' } },
        TOKEN_GRANTED,
      ],
    });

    await runDeviceLogin({ baseUrl: BASE_URL, clientId: CLIENT_ID, http, clock, onUserCode: () => {} });
    for (const slept of clock.sleeps) expect(slept).toBeGreaterThanOrEqual(5000);
  });

  it('falls back to 5s when the server advertises no interval', async () => {
    const { interval: _dropped, ...noInterval } = DEVICE_ISSUED.body as Record<string, unknown>;
    const clock = new FakeClock();
    await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http: new RoutingHttpClient({
        '/oauth/device/code': [{ status: 200, body: noInterval }],
        '/oauth/token': [TOKEN_GRANTED],
      }),
      clock,
      onUserCode: () => {},
    });
    expect(clock.sleeps).toEqual([5000]);
  });

  const terminals: [string, string][] = [
    ['access_denied', 'the user said no'],
    ['expired_token', 'the code aged out'],
    ['invalid_grant', 'the device code is not ours'],
  ];

  for (const [code, why] of terminals) {
    it(`stops on \`${code}\` with a typed error — ${why}`, async () => {
      const clock = new FakeClock();
      const http = new RoutingHttpClient({
        '/oauth/device/code': [DEVICE_ISSUED],
        '/oauth/token': [{ status: 400, body: { error: code, error_description: why } }],
      });

      const error = (await runDeviceLogin({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        http,
        clock,
        onUserCode: () => {},
      }).catch((e: unknown) => e)) as ShipError;

      expect(error).toBeInstanceOf(ShipError);
      expect(error.kind).toBe('auth');
      expect(oauthErrorCode(error)).toBe(code);
      // Terminal means terminal: exactly one poll, no retry. Hammering a token
      // endpoint that has said no is how a client gets throttled.
      expect(http.to('/oauth/token')).toHaveLength(1);
    });
  }

  it('gives up when the device code’s own expiry passes, without waiting for the server', async () => {
    const clock = new FakeClock();
    const http = new RoutingHttpClient({
      '/oauth/device/code': [
        { status: 200, body: { ...(DEVICE_ISSUED.body as object), expires_in: 12, interval: 5 } },
      ],
      '/oauth/token': [{ status: 400, body: { error: 'authorization_pending' } }],
    });

    const error = (await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock,
      onUserCode: () => {},
    }).catch((e: unknown) => e)) as ShipError;

    expect(oauthErrorCode(error)).toBe('expired_token');
    // 5s, 10s → both inside 12s; the third wait crosses it and the loop stops.
    expect(http.to('/oauth/token')).toHaveLength(2);
  });
});

describe('PF-539 · Authorization Code + PKCE', () => {
  it('the challenge is the S256 of the verifier — not `plain`', async () => {
    const request = await buildAuthorizationRequest({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      scopes: ['documents:read'],
    });

    const url = new URL(request.url);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/cb');
    expect(url.searchParams.get('scope')).toBe('documents:read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    // Derived independently, from the verifier the helper generated.
    expect(url.searchParams.get('code_challenge')).toBe(
      await deriveCodeChallenge(request.codeVerifier),
    );
    // and it is NOT the verifier itself, which is what `plain` would send.
    expect(url.searchParams.get('code_challenge')).not.toBe(request.codeVerifier);
  });

  it('the verifier is RFC 7636-shaped and never repeats', async () => {
    const verifiers = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const verifier = generateCodeVerifier();
      // §4.1: 43–128 characters from the unreserved set.
      expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
      verifiers.add(verifier);
    }
    expect(verifiers.size).toBe(200);
  });

  it('base64url is padless and URL-safe — the encoding §4.2 requires', () => {
    const encoded = base64UrlEncode(new Uint8Array([251, 255, 190, 0, 1, 2]));
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('`state` is generated, sent, and CHECKED on return', async () => {
    const http = new RoutingHttpClient({ '/oauth/token': [TOKEN_GRANTED] });
    let sentState = '';

    await runAuthorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      http,
      clock: new FakeClock(),
      authorize: (url, state) => {
        sentState = new URL(url).searchParams.get('state') as string;
        expect(state).toBe(sentState);
        return Promise.resolve(`https://app.test/cb?code=ac-1&state=${state}`);
      },
    });

    expect(sentState).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(http.formTo('/oauth/token').get('code')).toBe('ac-1');
  });

  it('a MISMATCHED state is refused before the code is spent', async () => {
    const http = new RoutingHttpClient({ '/oauth/token': [TOKEN_GRANTED] });
    const store = new CountingStore();

    const error = (await runAuthorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      tokenStore: store,
      http,
      clock: new FakeClock(),
      authorize: () => Promise.resolve('https://app.test/cb?code=ac-1&state=attacker'),
    }).catch((e: unknown) => e)) as ShipError;

    expect(error.kind).toBe('auth');
    expect(error.message).toContain('state');
    // BEFORE, not after: the exchange never happened, so an attacker's
    // authorization was never bound to this user's store.
    expect(http.to('/oauth/token')).toHaveLength(0);
    expect(store.saveCalls).toBe(0);
  });

  it('a WRONG verifier surfaces the server’s `invalid_grant` as a TYPED error', async () => {
    // p.5 makes this negative case mandatory, not optional.
    const http = new RoutingHttpClient({
      '/oauth/token': [
        {
          status: 400,
          body: { error: 'invalid_grant', error_description: 'PKCE verification failed' },
        },
      ],
    });

    const error = (await exchangeAuthorizationCode({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      code: 'ac-1',
      codeVerifier: 'the-wrong-verifier',
      http,
      clock: new FakeClock(),
    }).catch((e: unknown) => e)) as ShipError;

    // A typed error, not an unhandled rejection two frames up.
    expect(error).toBeInstanceOf(ShipError);
    expect(error.kind).toBe('auth');
    expect(oauthErrorCode(error)).toBe('invalid_grant');
    expect(error.message).toContain('PKCE verification failed');
  });

  it('the redirect’s `error` parameter is surfaced — a denied consent is not a crash', async () => {
    const error = (await runAuthorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      http: new RoutingHttpClient({}),
      clock: new FakeClock(),
      authorize: () =>
        Promise.resolve('https://app.test/cb?error=access_denied&error_description=User+said+no'),
    }).catch((e: unknown) => e)) as ShipError;

    expect(oauthErrorCode(error)).toBe('access_denied');
  });

  it('parses a full redirect URL, a bare query string, and drops a fragment', () => {
    expect(parseAuthorizationRedirect('https://app.test/cb?code=a&state=b').code).toBe('a');
    expect(parseAuthorizationRedirect('code=a&state=b').state).toBe('b');
    expect(parseAuthorizationRedirect('https://app.test/cb?code=a&state=b#frag').state).toBe('b');
    expect(parseAuthorizationRedirect('https://app.test/cb').code).toBeNull();
  });

  it('the verifier is sent ONLY at exchange — it is in no other request', async () => {
    const http = new RoutingHttpClient({ '/oauth/token': [TOKEN_GRANTED] });
    let authorizeUrl = '';

    await runAuthorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      http,
      clock: new FakeClock(),
      authorize: (url, state) => {
        authorizeUrl = url;
        return Promise.resolve(`https://app.test/cb?code=ac-1&state=${state}`);
      },
    });

    const verifier = http.formTo('/oauth/token').get('code_verifier') as string;
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // The authorize URL carries the CHALLENGE and never the verifier. That is
    // the whole point of RFC 7636: the value that proves possession does not
    // travel through the user agent.
    expect(authorizeUrl).not.toContain(verifier);
  });
});

describe('PF-540 · both helpers persist through ITokenStore, and write NOTHING on failure', () => {
  it('device: success writes the full StoredTokens exactly once', async () => {
    const store = new CountingStore();
    const clock = new FakeClock(1_700_000_000_000);

    await runDeviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      tokenStore: store,
      http: new RoutingHttpClient({
        '/oauth/device/code': [DEVICE_ISSUED],
        '/oauth/token': [TOKEN_GRANTED],
      }),
      clock,
      onUserCode: () => {},
    });

    expect(store.saveCalls).toBe(1);
    // access + refresh + expiry + granted scopes — L17's PF-504 shape, whole.
    expect(store.saved).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAtSeconds: Math.floor(clock.now() / 1000) + 3600,
      scopes: ['documents:read', 'documents:write'],
    });
  });

  it('auth code: success writes exactly once', async () => {
    const store = new CountingStore();
    await runAuthorizationCodeFlow({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: 'https://app.test/cb',
      tokenStore: store,
      http: new RoutingHttpClient({ '/oauth/token': [TOKEN_GRANTED] }),
      clock: new FakeClock(),
      authorize: (_u, state) => Promise.resolve(`https://app.test/cb?code=ac-1&state=${state}`),
    });
    expect(store.saveCalls).toBe(1);
  });

  it('EVERY failure path calls save() zero times', async () => {
    // p.12's Failure Modes contract: *"no partial credential is ever written
    // back"*, applied at the only point in the system that writes credentials.
    const cases: { name: string; run: (store: CountingStore) => Promise<unknown> }[] = [
      {
        name: 'device: consent denied',
        run: (store) =>
          runDeviceLogin({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            tokenStore: store,
            http: new RoutingHttpClient({
              '/oauth/device/code': [DEVICE_ISSUED],
              '/oauth/token': [{ status: 400, body: { error: 'access_denied' } }],
            }),
            clock: new FakeClock(),
            onUserCode: () => {},
          }),
      },
      {
        name: 'device: code expired',
        run: (store) =>
          runDeviceLogin({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            tokenStore: store,
            http: new RoutingHttpClient({
              '/oauth/device/code': [DEVICE_ISSUED],
              '/oauth/token': [{ status: 400, body: { error: 'expired_token' } }],
            }),
            clock: new FakeClock(),
            onUserCode: () => {},
          }),
      },
      {
        name: 'device: issuance itself refused',
        run: (store) =>
          runDeviceLogin({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            tokenStore: store,
            http: new RoutingHttpClient({
              '/oauth/device/code': [{ status: 401, body: { error: 'invalid_client' } }],
            }),
            clock: new FakeClock(),
            onUserCode: () => {},
          }),
      },
      {
        name: 'device: network error mid-exchange',
        run: (store) =>
          runDeviceLogin({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            tokenStore: store,
            http: new RoutingHttpClient({
              '/oauth/device/code': [DEVICE_ISSUED],
              '/oauth/token': [new Error('ECONNRESET')],
            }),
            clock: new FakeClock(),
            onUserCode: () => {},
          }),
      },
      {
        name: 'device: 200 with no access_token',
        run: (store) =>
          runDeviceLogin({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            tokenStore: store,
            http: new RoutingHttpClient({
              '/oauth/device/code': [DEVICE_ISSUED],
              '/oauth/token': [{ status: 200, body: { token_type: 'Bearer' } }],
            }),
            clock: new FakeClock(),
            onUserCode: () => {},
          }),
      },
      {
        name: 'auth code: state mismatch',
        run: (store) =>
          runAuthorizationCodeFlow({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            redirectUri: 'https://app.test/cb',
            tokenStore: store,
            http: new RoutingHttpClient({ '/oauth/token': [TOKEN_GRANTED] }),
            clock: new FakeClock(),
            authorize: () => Promise.resolve('https://app.test/cb?code=ac-1&state=wrong'),
          }),
      },
      {
        name: 'auth code: wrong verifier → invalid_grant',
        run: (store) =>
          runAuthorizationCodeFlow({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            redirectUri: 'https://app.test/cb',
            tokenStore: store,
            http: new RoutingHttpClient({
              '/oauth/token': [{ status: 400, body: { error: 'invalid_grant' } }],
            }),
            clock: new FakeClock(),
            authorize: (_u, state) =>
              Promise.resolve(`https://app.test/cb?code=ac-1&state=${state}`),
          }),
      },
      {
        name: 'auth code: user denied at the consent screen',
        run: (store) =>
          runAuthorizationCodeFlow({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            redirectUri: 'https://app.test/cb',
            tokenStore: store,
            http: new RoutingHttpClient({}),
            clock: new FakeClock(),
            authorize: () => Promise.resolve('https://app.test/cb?error=access_denied'),
          }),
      },
      {
        name: 'auth code: redirect with no code at all',
        run: (store) =>
          runAuthorizationCodeFlow({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            redirectUri: 'https://app.test/cb',
            tokenStore: store,
            http: new RoutingHttpClient({}),
            clock: new FakeClock(),
            authorize: (_u, state) => Promise.resolve(`https://app.test/cb?state=${state}`),
          }),
      },
    ];

    for (const { name, run } of cases) {
      const store = new CountingStore();
      const outcome = await run(store).then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(outcome, `${name} did not fail`).toBe('rejected');
      expect(store.saveCalls, `${name} wrote a credential`).toBe(0);
      // and it does not `clear()` either: clearing is a write, and a store the
      // flow never touched must be left exactly as it was found.
      expect(store.clearCalls, `${name} cleared the store`).toBe(0);
      expect(store.saved, `${name} left something behind`).toBeNull();
    }

    expect(cases).toHaveLength(9);
  });
});

describe('PF-541 · a helper-issued client refreshes ONCE on 401, then stops', () => {
  it('one 401 → one refresh → one retry, and the call succeeds', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      // 1: the login exchange. 2: the refresh.
      '/oauth/token': [
        TOKEN_GRANTED,
        { status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'documents:read' } },
      ],
      '/api/v1/me': [
        { status: 401, body: { code: 'unauthorized', message: 'expired', details: { reason: 'expired' } } },
        { status: 200, body: { app: { client_id: CLIENT_ID, name: 'CLI' }, user: null, scopes: [] } },
      ],
    });

    const client = await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock: new FakeClock(),
      onUserCode: () => {},
    });

    const me = await client.me();
    expect(me.app.client_id).toBe(CLIENT_ID);

    // EXACT counts. Two `/me` calls (the 401 and the retry), and exactly two
    // `/oauth/token` calls — the login and ONE refresh.
    expect(http.to('/api/v1/me')).toHaveLength(2);
    expect(http.to('/oauth/token')).toHaveLength(2);
    expect(http.formTo('/oauth/token', 1).get('grant_type')).toBe('refresh_token');
    expect(http.to('/api/v1/me')[1]?.headers.authorization).toBe('Bearer at-2');
  });

  it('a SECOND 401 after refreshing throws kind:auth and does NOT loop', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [
        TOKEN_GRANTED,
        { status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 } },
      ],
      '/api/v1/me': [
        { status: 401, body: { code: 'unauthorized', message: 'no', details: { reason: 'invalid' } } },
      ],
    });

    const client = await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock: new FakeClock(),
      onUserCode: () => {},
    });

    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(401);

    // Two `/me` attempts and ONE refresh, then it stops. A refresh loop is the
    // failure this ticket exists to make impossible — and under p.3's
    // one-time-use refresh tokens a loop does not merely spin, it presents a
    // spent token and REVOKES THE FAMILY, logging the user out mid-drill.
    expect(http.to('/api/v1/me')).toHaveLength(2);
    expect(http.to('/oauth/token')).toHaveLength(2);
  });

  it('and a failed REFRESH is logged-out, not retried', async () => {
    const http = new RoutingHttpClient({
      '/oauth/device/code': [DEVICE_ISSUED],
      '/oauth/token': [TOKEN_GRANTED, { status: 400, body: { error: 'invalid_grant' } }],
      '/api/v1/me': [
        { status: 401, body: { code: 'unauthorized', message: 'expired', details: { reason: 'expired' } } },
      ],
    });

    const client = await ShipClient.deviceLogin({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      http,
      clock: new FakeClock(),
      onUserCode: () => {},
    });

    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    // ONE refresh attempt. A second presentation of a token the server has
    // already rejected is the same destructive pattern one level up.
    expect(http.to('/oauth/token')).toHaveLength(2);
  });
});
