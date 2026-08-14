/**
 * PF-495, PF-502, PF-510 – PF-513 — the request pipeline.
 *
 * Every test here injects `FakeClock`, so the retry ladder is asserted by
 * reading what the client ASKED to wait rather than by measuring elapsed time.
 * `noSetTimeout` in `fitness.test.ts` is what keeps that true.
 */
import { describe, expect, it } from 'vitest';
import { ShipClient } from './client.js';
import { ShipError } from './errors.js';
import { MAX_RETRY_DELAY_MS, NEVER_RETRY_STATUSES, RETRY_POLICY } from './retry.js';
import { FakeClock, StubHttpClient } from './testSupport.js';

const BASE = 'https://ship.test/ship';

function clientWith(http: StubHttpClient, clock = new FakeClock()) {
  return {
    client: new ShipClient({ token: 'access-token-value', baseUrl: BASE, http, clock }),
    clock,
  };
}

describe('PF-495 · one transport — auth, URL and body all happen in one place', () => {
  it('sends the bearer header, the accept header and the SDK user-agent', async () => {
    const http = new StubHttpClient([{ status: 200, body: { app: {}, user: null, scopes: [] } }]);
    const { client } = clientWith(http);
    await client.me();

    const request = http.requests[0];
    expect(request?.url).toBe('https://ship.test/ship/api/v1/me');
    expect(request?.headers.authorization).toBe('Bearer access-token-value');
    expect(request?.headers.accept).toBe('application/json');
    expect(request?.headers['user-agent']).toMatch(/^ship-sdk-js\//);
    // No body, so no content-type — a GET with `content-type: application/json`
    // and no body makes some proxies wait for one.
    expect(request?.headers['content-type']).toBeUndefined();
  });

  it('the resource client goes through the SAME transport — no second fetch path', async () => {
    const http = new StubHttpClient([{ status: 200, body: { data: [], next_cursor: null } }]);
    const { client } = clientWith(http);
    await client.documents.list({ limit: 5 });
    expect(http.requests[0]?.url).toBe('https://ship.test/ship/api/v1/documents?limit=5');
    expect(http.requests[0]?.headers.authorization).toBe('Bearer access-token-value');
  });

  it('serialises a body and sets content-type only then', async () => {
    const http = new StubHttpClient([{ status: 201, body: { id: 'd1' } }]);
    const { client } = clientWith(http);
    await client.documents.create({ title: 'Untitled' });
    expect(http.requests[0]?.headers['content-type']).toBe('application/json');
    expect(http.requests[0]?.body).toBe(JSON.stringify({ title: 'Untitled' }));
  });

  it('a 204 with no body resolves rather than throwing on JSON.parse("")', async () => {
    const http = new StubHttpClient([{ status: 204, raw: '' }]);
    const { client } = clientWith(http);
    await expect(client.me()).resolves.toBeUndefined();
  });
});

describe('PF-495 (second assertion) · a token never reaches a message, a stack, or a log', () => {
  const SECRET = 'tok_THIS_MUST_NOT_APPEAR_ANYWHERE';

  it('not on the error path', async () => {
    const http = new StubHttpClient([
      { status: 500, body: { code: 'server_error', message: 'boom', request_id: 'r1' } },
      { status: 500, body: { code: 'server_error', message: 'boom', request_id: 'r1' } },
      { status: 500, body: { code: 'server_error', message: 'boom', request_id: 'r1' } },
    ]);
    const client = new ShipClient({
      token: SECRET,
      baseUrl: BASE,
      http,
      clock: new FakeClock(),
    });

    const error = await client.me().catch((e: unknown) => e as ShipError);
    const serialised = [
      error.message,
      error.stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      String(error),
    ].join('\n');
    expect(serialised).not.toContain(SECRET);
  });

  it('not on the transport-failure path either — `cause` holds the original, the message does not', async () => {
    const http = new StubHttpClient([new Error(`connect ECONNREFUSED (while sending ${SECRET})`)]);
    const client = new ShipClient({ token: SECRET, baseUrl: BASE, http, clock: new FakeClock() });
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.message).not.toContain(SECRET);
    expect(error.kind).toBe('server');
    expect(error.status).toBe(0);
  });
});

describe('PF-510 · retry policy is data, and the attempt counts match it', () => {
  it('exports the policy a consumer can read without reading the client', () => {
    expect(RETRY_POLICY.maxAttempts).toBe(3);
    expect([...RETRY_POLICY.retryableStatuses]).toEqual([429, 502, 503, 504]);
    expect(RETRY_POLICY.neverRetryStatuses).toContain(500);
  });

  it.each([429, 502, 503, 504])('%i is retried up to maxAttempts', async (status) => {
    const http = new StubHttpClient([{ status, body: { code: 'server_error', message: 'x' } }]);
    const { client } = clientWith(http);
    await expect(client.me()).rejects.toBeInstanceOf(ShipError);
    expect(http.requests).toHaveLength(RETRY_POLICY.maxAttempts);
  });

  it.each(NEVER_RETRY_STATUSES)('%i is attempted exactly ONCE', async (status) => {
    const http = new StubHttpClient([{ status, body: null }]);
    const { client } = clientWith(http);
    await expect(client.me()).rejects.toBeInstanceOf(ShipError);
    expect(http.requests).toHaveLength(1);
  });

  it('a bare 500 does not retry — the decision this ticket names', async () => {
    // Industry default is "all 5xx retry". A Ship 500 is a handler bug: the same
    // request fails the same way, and three attempts turn one alert into three.
    const http = new StubHttpClient([
      { status: 500, body: { code: 'server_error', message: 'handler threw' } },
    ]);
    const { client } = clientWith(http);
    await expect(client.me()).rejects.toMatchObject({ kind: 'server', code: 'server_error' });
    expect(http.requests).toHaveLength(1);
  });

  it('a transport failure retries, and succeeds when the next attempt lands', async () => {
    const http = new StubHttpClient([
      new Error('ECONNRESET'),
      { status: 200, body: { app: { client_id: 'c' }, user: null, scopes: [] } },
    ]);
    const { client } = clientWith(http);
    await expect(client.me()).resolves.toMatchObject({ app: { client_id: 'c' } });
    expect(http.requests).toHaveLength(2);
  });

  it('stops after maxAttempts of transport failures and throws the typed error', async () => {
    const http = new StubHttpClient([new Error('EAI_AGAIN')]);
    const { client } = clientWith(http);
    await expect(client.me()).rejects.toMatchObject({ kind: 'server', status: 0 });
    expect(http.requests).toHaveLength(RETRY_POLICY.maxAttempts);
  });
});

describe('PF-511 · Retry-After wins over the computed backoff, and is clamped', () => {
  it('a numeric header is honoured exactly', async () => {
    const http = new StubHttpClient([
      { status: 429, body: { code: 'rate_limited', message: 'x' }, headers: { 'Retry-After': '7' } },
    ]);
    const { client, clock } = clientWith(http);
    await expect(client.me()).rejects.toBeInstanceOf(ShipError);
    expect(clock.sleeps).toEqual([7000, 7000]);
  });

  it('an HTTP-date header is honoured, against the injected clock', async () => {
    const clock = new FakeClock(Date.parse('2026-08-12T10:00:00Z'));
    const http = new StubHttpClient([
      {
        status: 429,
        body: { code: 'rate_limited', message: 'x' },
        headers: { 'Retry-After': 'Wed, 12 Aug 2026 10:00:03 GMT' },
      },
      { status: 200, body: { app: {}, user: null, scopes: [] } },
    ]);
    const { client } = clientWith(http, clock);
    await client.me();
    expect(clock.sleeps).toEqual([3000]);
  });

  it('an absurd header is clamped to MAX_RETRY_DELAY_MS', async () => {
    const http = new StubHttpClient([
      {
        status: 429,
        body: { code: 'rate_limited', message: 'x' },
        headers: { 'Retry-After': '86400' },
      },
    ]);
    const { client, clock } = clientWith(http);
    await expect(client.me()).rejects.toBeInstanceOf(ShipError);
    for (const slept of clock.sleeps) expect(slept).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS);
    expect(clock.sleeps).toEqual([MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS]);
  });

  it('with no header, the exponential ladder is used', async () => {
    const http = new StubHttpClient([{ status: 503, body: null }]);
    // random() === 1, so full jitter is the identity and the ladder is exact.
    const { client, clock } = clientWith(http, new FakeClock(0, 1));
    await expect(client.me()).rejects.toBeInstanceOf(ShipError);
    expect(clock.sleeps).toEqual([250, 500]);
  });

  it('jitter scales the computed delay down, never the server-specified one', async () => {
    const http = new StubHttpClient([{ status: 503, body: null }]);
    const { client, clock } = clientWith(http, new FakeClock(0, 0.5));
    await expect(client.me()).rejects.toBeInstanceOf(ShipError);
    expect(clock.sleeps).toEqual([125, 250]);
  });
});

describe('PF-512 · rate-limit headers, on the success path AND the error path', () => {
  it('round-trip from a 200', async () => {
    const http = new StubHttpClient([
      {
        status: 200,
        body: { app: {}, user: null, scopes: [] },
        headers: {
          'X-RateLimit-Limit': '1000',
          'X-RateLimit-Remaining': '997',
          'X-RateLimit-Reset': '1786000000',
        },
      },
    ]);
    const { client } = clientWith(http);
    await client.me();
    expect(client.rateLimit).toEqual({ limit: 1000, remaining: 997, resetAtSeconds: 1786000000 });
  });

  it('round-trip from a 429 — and attached to the thrown error', async () => {
    const http = new StubHttpClient([
      {
        status: 429,
        body: { code: 'rate_limited', message: 'Slow down.' },
        headers: {
          'Retry-After': '1',
          'X-RateLimit-Limit': '60',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': '1786000060',
        },
      },
    ]);
    const { client } = clientWith(http);
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('rate_limit');
    expect(error.rateLimit).toEqual({ limit: 60, remaining: 0, resetAtSeconds: 1786000060 });
    expect(client.rateLimit?.remaining).toBe(0);
  });

  it('missing headers give null, never NaN and never a 0 that means "unknown"', async () => {
    const http = new StubHttpClient([{ status: 200, body: {} }]);
    const { client } = clientWith(http);
    await client.me();
    expect(client.rateLimit).toBeNull();
  });

  it('a partially-reported triple keeps the reported values and nulls the rest', async () => {
    const http = new StubHttpClient([
      { status: 200, body: {}, headers: { 'X-RateLimit-Remaining': '42' } },
    ]);
    const { client } = clientWith(http);
    await client.me();
    expect(client.rateLimit).toEqual({ limit: null, remaining: 42, resetAtSeconds: null });
  });

  it('a garbage header is null, not NaN', async () => {
    const http = new StubHttpClient([
      {
        status: 200,
        body: {},
        headers: { 'X-RateLimit-Limit': 'lots', 'X-RateLimit-Remaining': '' },
      },
    ]);
    const { client } = clientWith(http);
    await client.me();
    expect(client.rateLimit).toBeNull();
  });
});

describe('PF-501 (integration) · a proxy body between the SDK and Ship', () => {
  it('a 400 carrying HTML is `validation`, not `server`, and is not retried', async () => {
    const http = new StubHttpClient([
      { status: 400, raw: '<html><body>400 Bad Request</body></html>' },
    ]);
    const { client } = clientWith(http);
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('validation');
    expect(error.code).toBeNull();
    expect(http.requests).toHaveLength(1);
  });

  it('a 502 carrying HTML is `server` and IS retried', async () => {
    const http = new StubHttpClient([{ status: 502, raw: '<html>502</html>' }]);
    const { client } = clientWith(http);
    await expect(client.me()).rejects.toMatchObject({ kind: 'server' });
    expect(http.requests).toHaveLength(RETRY_POLICY.maxAttempts);
  });

  it('a truncated JSON body falls back to the status rather than throwing a SyntaxError', async () => {
    const http = new StubHttpClient([{ status: 404, raw: '{"code":"not_fou' }]);
    const { client } = clientWith(http);
    await expect(client.me()).rejects.toMatchObject({ kind: 'not_found', code: null });
  });
});
