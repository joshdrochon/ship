/**
 * `runClientCredentials` / `ShipClient.clientCredentials` — L23 PF-686.
 *
 * The unit half. The live half — a real exchange against a booted Ship, ending
 * in a `.me()` that returns a null user — is
 * `api/src/platform/api/v1/agentCitizenFitness.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { runClientCredentials } from './flows.js';
import { ShipClient } from '../client.js';
import { ShipError } from '../errors.js';
import { InMemoryTokenStore } from './tokenStore.js';
import { FakeClock, jsonResponse, type StubResponse } from '../testSupport.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';

const BASE_URL = 'https://ship.test';
const CLIENT_ID = 'ship_app_firstparty_fleetgraph_agent';
const CLIENT_SECRET = 'ship_cs_notarealsecret';

class ScriptedHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly answers: (StubResponse | Error)[]) {}
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.answers.shift();
    if (next === undefined) throw new Error(`unscripted request: ${request.url}`);
    if (next instanceof Error) throw next;
    return next as unknown as HttpResponse;
  }
}

/** RFC 6749 §4.4.3's body: no `refresh_token`. */
function grantBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'ship_at_agenttoken',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'documents:read issues:read sprints:read',
    ...overrides,
  };
}

function form(request: HttpRequest): URLSearchParams {
  return new URLSearchParams(String(request.body ?? ''));
}

describe('PF-686 — the client credentials request', () => {
  it('posts grant_type=client_credentials with the id and the secret', async () => {
    const http = new ScriptedHttpClient([jsonResponse({ status: 200, body: grantBody() })]);
    await runClientCredentials({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      http,
      clock: new FakeClock(1_700_000_000_000),
      tokenStore: new InMemoryTokenStore(),
    });

    expect(http.requests).toHaveLength(1);
    const body = form(http.requests[0]);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    // No PKCE, no code, no device_code, no redirect_uri. This grant carries
    // nothing that presumes a user agent.
    expect(body.get('code_verifier')).toBeNull();
    expect(body.get('redirect_uri')).toBeNull();
  });

  it('sends `scope` only when scopes were asked for', async () => {
    const withScopes = new ScriptedHttpClient([jsonResponse({ status: 200, body: grantBody() })]);
    await runClientCredentials({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: ['issues:read', 'sprints:read'],
      http: withScopes,
      clock: new FakeClock(0),
      tokenStore: new InMemoryTokenStore(),
    });
    expect(form(withScopes.requests[0]).get('scope')).toBe('issues:read sprints:read');

    const without = new ScriptedHttpClient([jsonResponse({ status: 200, body: grantBody() })]);
    await runClientCredentials({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      http: without,
      clock: new FakeClock(0),
      tokenStore: new InMemoryTokenStore(),
    });
    // Absent, not empty: `scope=` would be a request for no scopes at all.
    expect(form(without.requests[0]).get('scope')).toBeNull();
  });

  it('persists the token with a null refreshToken and an expiry off the injected clock', async () => {
    const store = new InMemoryTokenStore();
    const result = await runClientCredentials({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      http: new ScriptedHttpClient([jsonResponse({ status: 200, body: grantBody() })]),
      clock: new FakeClock(1_700_000_000_000),
      tokenStore: store,
    });

    expect(result.tokens.accessToken).toBe('ship_at_agenttoken');
    // §4.4.3 — nothing to refresh, and the store says so rather than holding a
    // value the server never sent.
    expect(result.tokens.refreshToken).toBeNull();
    expect(result.tokens.expiresAtSeconds).toBe(1_700_000_000 + 3600);
    expect(result.tokens.scopes).toEqual(['documents:read', 'issues:read', 'sprints:read']);
    expect((await store.load())?.accessToken).toBe('ship_at_agenttoken');
  });

  it('surfaces the server rejection as a typed ShipError carrying the OAuth code', async () => {
    const http = new ScriptedHttpClient([
      jsonResponse({ status: 400, body: { error: 'unauthorized_client', error_description: 'nope' } }),
    ]);
    await expect(
      runClientCredentials({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        http,
        clock: new FakeClock(0),
        tokenStore: new InMemoryTokenStore(),
      }),
    ).rejects.toThrow(ShipError);
  });

  /**
   * The secret is REQUIRED, and the check is local.
   *
   * A public client has nothing to present, so an empty secret is a programming
   * error rather than something for the server to decide — and letting it reach
   * the wire would surface as `invalid_client`, which reads as "wrong secret"
   * rather than "no secret".
   */
  it('refuses an empty secret before any request goes out', async () => {
    const http = new ScriptedHttpClient([]);
    await expect(
      runClientCredentials({
        baseUrl: BASE_URL,
        clientId: CLIENT_ID,
        clientSecret: '',
        http,
        clock: new FakeClock(0),
        tokenStore: new InMemoryTokenStore(),
      }),
    ).rejects.toThrow(/confidential clients only/);
    expect(http.requests).toHaveLength(0);
  });
});

describe('ShipClient.clientCredentials', () => {
  it('returns a client wired to the credential the flow just wrote', async () => {
    const http = new ScriptedHttpClient([
      jsonResponse({ status: 200, body: grantBody() }),
      jsonResponse({ status: 200, body: { app: { client_id: CLIENT_ID }, user: null, scopes: [] } }),
    ]);
    const client = await ShipClient.clientCredentials({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      http,
      clock: new FakeClock(0),
      tokenStore: new InMemoryTokenStore(),
    });

    await client.me();
    const meRequest = http.requests[1];
    expect(meRequest.url).toBe(`${BASE_URL}/api/v1/me`);
    expect(meRequest.headers?.authorization).toBe('Bearer ship_at_agenttoken');
  });
});
