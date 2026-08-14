/**
 * PF-509 — the ticket's own fitness test: **ten concurrent calls against a
 * server whose access token has expired produce exactly ONE `/oauth/token`
 * refresh request and ten successful responses.**
 *
 * The reason this number matters is in `refresh.ts`'s header and it is worth
 * restating: PRD p.3's refresh tokens are one-time-use with family revocation,
 * so ten parallel refreshes present the same token ten times and nine of them
 * REVOKE THE FAMILY. A naive client is not slow, it is destructive.
 */
import { describe, expect, it } from 'vitest';
import { ShipClient } from '../client.js';
import type { ShipError } from '../errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http.js';
import { FakeClock, headersOf, StubHttpClient } from '../testSupport.js';
import { InMemoryTokenStore, type StoredTokens } from './tokenStore.js';
import { hasInFlightRefresh, singleFlight } from './refresh.js';

const EXPIRED: StoredTokens = {
  accessToken: 'expired-access',
  refreshToken: 'refresh-generation-1',
  expiresAtSeconds: null,
  scopes: ['documents:read'],
};

/**
 * A server that 401s the expired access token, rotates once, and then accepts
 * the new one. Presenting a SPENT refresh token revokes the family — exactly
 * what L06 does — so a second refresh makes every subsequent call fail.
 */
class RotatingServer implements HttpClient {
  readonly requests: HttpRequest[] = [];
  // Deliberately NOT the token in the store: `expired-access` is the credential
  // the client holds, and the server has already stopped honouring it. A double
  // that accepted it would make every assertion below pass vacuously.
  private currentAccess = 'access-generation-1';
  private liveRefresh: string | null = 'refresh-generation-1';
  private familyRevoked = false;
  private generation = 1;

  get refreshRequests(): HttpRequest[] {
    return this.requests.filter((r) => r.url.includes('/oauth/token'));
  }

  get apiRequests(): HttpRequest[] {
    return this.requests.filter((r) => !r.url.includes('/oauth/token'));
  }

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);

    if (request.url.includes('/oauth/token')) {
      const presented = new URLSearchParams(request.body ?? '').get('refresh_token');
      if (this.familyRevoked || presented !== this.liveRefresh) {
        // The destructive case, modelled honestly.
        this.familyRevoked = true;
        return Promise.resolve(
          json(400, { error: 'invalid_grant', error_description: 'Refresh token reuse detected.' }),
        );
      }
      this.generation += 1;
      this.currentAccess = `access-generation-${this.generation}`;
      this.liveRefresh = `refresh-generation-${this.generation}`;
      return Promise.resolve(
        json(200, {
          access_token: this.currentAccess,
          refresh_token: this.liveRefresh,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'documents:read',
        }),
      );
    }

    const presented = request.headers.authorization?.replace(/^Bearer /, '');
    if (this.familyRevoked || presented !== this.currentAccess) {
      return Promise.resolve(
        json(401, { code: 'unauthorized', message: 'expired', request_id: 'r', details: { reason: 'expired' } }),
      );
    }
    return Promise.resolve(json(200, { data: [], next_cursor: null }));
  }
}

function json(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: headersOf({ 'content-type': 'application/json' }),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('PF-509 · refresh is single-flight per token store', () => {
  it('TEN concurrent expired calls → ONE refresh request and ten successes', async () => {
    const store = new InMemoryTokenStore({ ...EXPIRED });
    const server = new RotatingServer();
    const client = new ShipClient({
      tokenStore: store,
      baseUrl: 'https://ship.test',
      http: server,
      clock: new FakeClock(),
      clientId: 'client-abc',
      clientSecret: 'secret-abc',
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.documents.list()),
    );

    expect(results).toHaveLength(10);
    for (const page of results) expect(page).toEqual({ data: [], next_cursor: null });

    // THE assertion. Two refreshes would have revoked the family and every one
    // of those ten calls would have failed instead.
    expect(server.refreshRequests).toHaveLength(1);
    // 10 initial 401s + 10 retries.
    expect(server.apiRequests).toHaveLength(20);

    // The rotated pair was written back exactly once, complete.
    const stored = await store.load();
    expect(stored?.accessToken).toBe('access-generation-2');
    expect(stored?.refreshToken).toBe('refresh-generation-2');
    expect(stored?.scopes).toEqual(['documents:read']);
  });

  it('TWO CLIENTS sharing one store share one refresh — the key is the store, not the client', async () => {
    const store = new InMemoryTokenStore({ ...EXPIRED });
    const server = new RotatingServer();
    const make = () =>
      new ShipClient({
        tokenStore: store,
        baseUrl: 'https://ship.test',
        http: server,
        clock: new FakeClock(),
        clientId: 'client-abc',
      });

    const [a, b] = [make(), make()];
    await Promise.all([a.documents.list(), b.documents.list()]);
    expect(server.refreshRequests).toHaveLength(1);
  });

  it('a proactive refresh fires before the token expires, not after a 401', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const nowSeconds = Math.floor(clock.now() / 1000);
    const store = new InMemoryTokenStore({
      ...EXPIRED,
      // Inside the 60s skew window.
      expiresAtSeconds: nowSeconds + 30,
    });
    const server = new RotatingServer();
    const client = new ShipClient({
      tokenStore: store,
      baseUrl: 'https://ship.test',
      http: server,
      clock,
      clientId: 'client-abc',
    });

    await client.documents.list();
    expect(server.refreshRequests).toHaveLength(1);
    // No wasted 401: the refresh happened first, so the API saw one request.
    expect(server.apiRequests).toHaveLength(1);
  });

  it('refresh is attempted ONCE per request — a second 401 is not a second rotation', async () => {
    // A server that 401s even a freshly-minted token. Hammering it with
    // rotations is the pattern that revokes the family.
    const http = new StubHttpClient([
      { status: 401, body: { code: 'unauthorized', message: 'x', details: { reason: 'expired' } } },
      { status: 200, body: { access_token: 'new', refresh_token: 'r2', expires_in: 60 } },
      { status: 401, body: { code: 'unauthorized', message: 'x', details: { reason: 'invalid' } } },
    ]);
    const client = new ShipClient({
      tokenStore: new InMemoryTokenStore({ ...EXPIRED }),
      baseUrl: 'https://ship.test',
      http,
      clock: new FakeClock(),
      clientId: 'client-abc',
    });

    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('unauthorized');
    expect(error.reason).toBe('invalid');
    expect(http.refreshRequests).toHaveLength(1);
  });

  it('a refresh that fails is logged-out, and the failure is NOT retried', async () => {
    const store = new InMemoryTokenStore({ ...EXPIRED, refreshToken: 'already-spent' });
    const server = new RotatingServer();
    const client = new ShipClient({
      tokenStore: store,
      baseUrl: 'https://ship.test',
      http: server,
      clock: new FakeClock(),
      clientId: 'client-abc',
    });

    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.message).toMatch(/invalid_grant|no longer usable/);
    expect(server.refreshRequests).toHaveLength(1);
  });

  it('refreshing without a clientId is an auth error, not a malformed POST', async () => {
    const client = new ShipClient({
      tokenStore: new InMemoryTokenStore({ ...EXPIRED }),
      baseUrl: 'https://ship.test',
      http: new RotatingServer(),
      clock: new FakeClock(),
    });
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.message).toMatch(/clientId/);
  });

  it('the refresh POST is RFC 6749 form-encoded, and carries the client credentials', async () => {
    const store = new InMemoryTokenStore({ ...EXPIRED });
    const server = new RotatingServer();
    const client = new ShipClient({
      tokenStore: store,
      baseUrl: 'https://ship.test/prefix',
      http: server,
      clock: new FakeClock(),
      clientId: 'client-abc',
      clientSecret: 'secret-abc',
    });
    await client.documents.list();

    const request = server.refreshRequests[0];
    // The prefix survives here too (PF-494), and /oauth is a SIBLING of /api/v1.
    expect(request?.url).toBe('https://ship.test/prefix/oauth/token');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(request?.body ?? '');
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-generation-1');
    expect(params.get('client_id')).toBe('client-abc');
    expect(params.get('client_secret')).toBe('secret-abc');
    // Never a bearer header on the token endpoint — client auth is not token auth.
    expect(request?.headers.authorization).toBeUndefined();
  });

  it('a rotation response with no refresh_token stores null, never the spent one', async () => {
    // Storing the presented token back would guarantee a family revocation on
    // the next use.
    const store = new InMemoryTokenStore({ ...EXPIRED });
    const http = new StubHttpClient([
      { status: 401, body: { code: 'unauthorized', message: 'x', details: { reason: 'expired' } } },
      { status: 200, body: { access_token: 'new-access', expires_in: 60, scope: 'documents:read' } },
      { status: 200, body: { data: [], next_cursor: null } },
    ]);
    const client = new ShipClient({
      tokenStore: store,
      baseUrl: 'https://ship.test',
      http,
      clock: new FakeClock(),
      clientId: 'client-abc',
    });
    await client.documents.list();
    const stored = await store.load();
    expect(stored?.accessToken).toBe('new-access');
    expect(stored?.refreshToken).toBeNull();
  });

  it('a static token disables refresh entirely — the caller said where it comes from', async () => {
    const http = new StubHttpClient([
      { status: 401, body: { code: 'unauthorized', message: 'x', details: { reason: 'expired' } } },
    ]);
    const client = new ShipClient({
      token: 'static',
      tokenStore: new InMemoryTokenStore({ ...EXPIRED }),
      baseUrl: 'https://ship.test',
      http,
      clock: new FakeClock(),
      clientId: 'client-abc',
    });
    await expect(client.me()).rejects.toMatchObject({ kind: 'auth' });
    expect(http.refreshRequests).toHaveLength(0);
  });
});

describe('singleFlight, directly', () => {
  it('runs the exchange once and hands the same promise to every caller', async () => {
    const store = new InMemoryTokenStore();
    let runs = 0;
    const exchange = async (): Promise<StoredTokens> => {
      runs += 1;
      await Promise.resolve();
      return { accessToken: 'a', refreshToken: 'r', expiresAtSeconds: null, scopes: [] };
    };

    const promises = Array.from({ length: 5 }, () => singleFlight(store, exchange));
    expect(hasInFlightRefresh(store)).toBe(true);
    const results = await Promise.all(promises);
    expect(runs).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it('releases after settling, so a LATER call refreshes again', async () => {
    const store = new InMemoryTokenStore();
    let runs = 0;
    const exchange = (): Promise<StoredTokens> => {
      runs += 1;
      return Promise.resolve({ accessToken: `a${runs}`, refreshToken: null, expiresAtSeconds: null, scopes: [] });
    };

    await singleFlight(store, exchange);
    // Let the release microtask run.
    await Promise.resolve();
    expect(hasInFlightRefresh(store)).toBe(false);
    await singleFlight(store, exchange);
    expect(runs).toBe(2);
  });

  it('a rejection reaches every waiter and does not poison the next attempt', async () => {
    const store = new InMemoryTokenStore();
    let runs = 0;
    const failing = (): Promise<StoredTokens> => {
      runs += 1;
      return Promise.reject(new Error('nope'));
    };

    const waiters = Array.from({ length: 3 }, () => singleFlight(store, failing).catch((e: unknown) => e));
    const outcomes = await Promise.all(waiters);
    expect(runs).toBe(1);
    for (const outcome of outcomes) expect(outcome).toBeInstanceOf(Error);

    await Promise.resolve();
    expect(hasInFlightRefresh(store)).toBe(false);
  });
});
