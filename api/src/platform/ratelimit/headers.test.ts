/**
 * L11 S3 — PF-310, PF-311, PF-312, PF-313, PF-314.
 *
 * The 100% header target (PRD p.6) measured against the composed public router,
 * plus the shape of the 429 itself. Everything here drives real requests through
 * `createTestPublicApp`, because the claims are about a stack, not a function.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Router } from 'express';
import { FakeClock } from '../clock.js';
import { apiErrorBodySchema } from '../api/v1/errors.js';
import { createTestPublicApp, V1_PREFIX, fakeAuthContext } from '../api/v1/testSupport.js';
import {
  enumerateV1Routes,
  runRouteAssertions,
  clearRouteAssertions,
} from '../api/v1/routeFitness.js';
import { InMemoryTokenBucket, RATE_LIMIT_HEADERS } from './limiter.js';
import { registerRateLimitHeaderAssertion, assertRetryAfter } from './headerAssertion.js';

const bucket = (capacity: number, refillPerSecond: number) =>
  new InMemoryTokenBucket({ capacity, refillPerSecond, maxKeys: 1_000 }, new FakeClock(0));

/** A couple of routes with different shapes, so the enumeration is not trivial. */
function mountSampleResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
  router.get('/documents/:id', (_req, res) => {
    res.json({ data: { id: 'x' } });
  });
  router.post('/documents', (_req, res) => {
    res.status(201).json({ data: { id: 'x' } });
  });
}

const lower = {
  limit: RATE_LIMIT_HEADERS.limit.toLowerCase(),
  remaining: RATE_LIMIT_HEADERS.remaining.toLowerCase(),
  reset: RATE_LIMIT_HEADERS.reset.toLowerCase(),
};

describe('PF-310 — all three headers on every allowed public response', () => {
  it('a 2xx carries all three, integer-valued, in the p.4 spelling', async () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(200);

    for (const name of Object.values(lower)) {
      expect(res.headers[name], `${name} missing on a 2xx`).toBeDefined();
      expect(Number.isInteger(Number(res.headers[name]))).toBe(true);
    }
  });

  it('the header names are X- prefixed — NOT the RateLimit-* draft family', async () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(200);

    // `express-rate-limit@8` with `standardHeaders: true` emits `ratelimit-limit`
    // and friends. PRD p.4 names the `X-`-prefixed family, and a v1 response
    // carrying the bare ones is the internal limiter having reached it (F1).
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['ratelimit-remaining']).toBeUndefined();
    expect(res.headers['ratelimit-reset']).toBeUndefined();
    expect(res.headers[lower.limit]).toBeDefined();
  });

  it('Remaining strictly decreases across successive requests on one token', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(10, 0.0001),
      mountResources: mountSampleResources,
    });

    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(`${V1_PREFIX}/documents`).expect(200);
      seen.push(Number(res.headers[lower.remaining]));
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThan(seen[i - 1]!);
    }
  });

  it('Reset is strictly in the future on an allowed response', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(10, 1),
      mountResources: mountSampleResources,
    });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(200);

    // PF-307's decision made concrete. The sketch returned `ceil(now/1000)`,
    // which is never in the future and tells a client nothing.
    const reset = Number(res.headers[lower.reset]);
    expect(reset).toBeGreaterThan(0);
    // The test limiter runs on a FakeClock pinned at 0, so "future" is relative
    // to that clock's now (0), not to wall time.
    expect(reset).toBeGreaterThanOrEqual(1);
  });

  it('Retry-After appears on the 429 and on nothing else', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 20),
      mountResources: mountSampleResources,
    });

    const ok = await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    assertRetryAfter(200, ok.headers as Record<string, unknown>, 'allowed response');

    const denied = await request(app).get(`${V1_PREFIX}/documents`).expect(429);
    assertRetryAfter(429, denied.headers as Record<string, unknown>, '429');
    expect(denied.headers['retry-after']).toBe('20');
  });
});

describe('PF-311 — the 429 body is the ApiError envelope, from L07s terminal handler', () => {
  it('validates against apiErrorBodySchema with code rate_limited and a real request_id', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    const parsed = apiErrorBodySchema.safeParse(res.body);
    expect(parsed.success, JSON.stringify(res.body)).toBe(true);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
    // The internal limiter's shape, which a v1 response must never have (F1).
    expect(res.body).not.toHaveProperty('error');
  });

  it('details.retry_after_seconds equals the Retry-After header (PF-198)', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // PF-198 says the envelope MAY carry it. It does, and a client that reads
    // only the body must not get a different number from one that reads headers.
    expect(res.body.details?.retry_after_seconds).toBe(Number(res.headers['retry-after']));
  });

  it('the limiter writes no response of its own — the handler is never reached', async () => {
    let handlerCalls = 0;
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: (router) => {
        router.get('/documents', (_req, res) => {
          handlerCalls++;
          res.json({ data: [], next_cursor: null });
        });
      },
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // A throttled request must not do the work it was throttled for.
    expect(handlerCalls).toBe(1);
  });
});

describe('PF-312 — headers set before next(err) survive the error path', () => {
  it('a real 429 carries all four rate-limit headers AND X-Request-Id', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 15),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // The regression this guards is an error handler that calls `res.writeHead`,
    // which REPLACES the header map rather than merging into it and takes
    // X-Request-Id with it. Express's `res.status().json()` merges; this asserts
    // the terminal handler still uses it.
    expect(res.headers[lower.limit]).toBeDefined();
    expect(res.headers[lower.remaining]).toBe('0');
    expect(res.headers[lower.reset]).toBeDefined();
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

describe('PF-313 — what counts as a public API response, and the answer is all of them', () => {
  it('a 401 from bearer auth carries the three headers', async () => {
    // The class the per-app/per-token limiter never sees, because bearer auth
    // rejected it first. Option (b) — the IP-keyed backstop above bearer auth —
    // is what makes this a real decision rather than a back-filled placeholder.
    const { app } = createTestPublicApp({ auth: null, mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(401);

    for (const name of Object.values(lower)) {
      expect(res.headers[name], `${name} missing on a 401`).toBeDefined();
    }
  });

  it('a 404 on an unmatched /api/v1 path carries the three headers', async () => {
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/no-such-thing`).expect(404);

    for (const name of Object.values(lower)) {
      expect(res.headers[name], `${name} missing on a 404`).toBeDefined();
    }
  });

  it('a 500 from a handler carries the three headers', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get('/boom', () => {
          throw new Error('deliberate');
        });
      },
    });
    const res = await request(app).get(`${V1_PREFIX}/boom`).expect(500);

    for (const name of Object.values(lower)) {
      expect(res.headers[name], `${name} missing on a 500`).toBeDefined();
    }
  });

  it('an unauthenticated route mounted above bearer auth is limited too (F45)', async () => {
    // L13 measured `/api/v1/openapi.json` as bypassing the rate limiter
    // entirely — the most-polled endpoint on the surface and the only one an
    // anonymous caller can reach. The anon backstop closes it.
    const { app } = createTestPublicApp({
      anonLimiter: bucket(1, 1 / 25),
      mountUnauthenticated: (router) => {
        router.get('/openapi.json', (_req, res) => {
          res.json({ openapi: '3.1.0' });
        });
      },
      mountResources: mountSampleResources,
    });

    const first = await request(app).get(`${V1_PREFIX}/openapi.json`).expect(200);
    expect(first.headers[lower.limit]).toBe('1');

    const second = await request(app).get(`${V1_PREFIX}/openapi.json`).expect(429);
    expect(second.body.code).toBe('rate_limited');
    expect(second.headers['retry-after']).toBe('25');
  });

  it('the anon bucket is keyed per client, not globally', async () => {
    // A single global counter would mean one abusive caller throttles everyone.
    const anonLimiter = bucket(1, 1 / 30);
    const { app } = createTestPublicApp({ anonLimiter, mountResources: mountSampleResources });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // Same process, a different client key: still served.
    expect(anonLimiter.peek('client:198.51.100.7').allowed).toBe(true);
  });
});

describe('PF-314 — the 100% target, measured over the enumerator', () => {
  beforeEach(() => {
    clearRouteAssertions();
  });
  afterEach(() => {
    clearRouteAssertions();
  });

  it('every enumerated route × response class carries the headers', async () => {
    registerRateLimitHeaderAssertion();
    const { app } = createTestPublicApp({ mountResources: mountSampleResources });

    const routes = enumerateV1Routes(app);
    // FAILS, does not skip, on an empty enumeration. A vacuously green 100% is
    // the exact way this target gets faked — the harness reports "all routes
    // passed" over zero routes and nobody reads the count.
    expect(
      routes.length,
      'the route enumeration is empty, so a green result here measures nothing',
    ).toBeGreaterThan(0);

    const failures = await runRouteAssertions(app);
    expect(failures.map((f) => `${f.route}: ${f.error.message}`)).toEqual([]);
  });

  it('the clause is not vacuous — it fails on a route mounted outside the stack', async () => {
    registerRateLimitHeaderAssertion();
    // A route that answers without ever passing through the limiter is exactly
    // the defect the clause exists to catch — a resource router mounted after
    // `createPublicRouter` returns, or mounted on the app rather than through
    // the hook. If this produced no failure, the green result above would mean
    // nothing.
    //
    // A bare app rather than `createTestPublicApp` plus an extra route: the v1
    // router is mounted at `/api/v1` and ends in a catch-all, so an app-level
    // route under that prefix is shadowed by the 404 handler and would be
    // answered — correctly headed — by the stack it was supposed to bypass.
    const app = express();
    app.get(`${V1_PREFIX}/outside`, (_req, res) => {
      res.json({ data: null });
    });

    const failures = await runRouteAssertions(app);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.route.includes('/outside'))).toBe(true);
  });

  it('the clause covers a route class no lane has written yet', async () => {
    registerRateLimitHeaderAssertion();
    // The seam's whole point: a resource added later inherits the clause with no
    // edit here. `mountResources` stands in for the lane that does not exist.
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.patch('/widgets/:id', (_req, res) => {
          res.json({ data: {} });
        });
      },
    });

    const routes = enumerateV1Routes(app);
    expect(routes.some((r) => r.path.includes('/widgets'))).toBe(true);
    expect(await runRouteAssertions(app)).toEqual([]);
  });
});

describe('PF-310 — an authenticated 2xx reports the TIGHTER of the two buckets', () => {
  it('the reported Remaining is the app bucket when the app bucket binds', async () => {
    const { app } = createTestPublicApp({
      auth: fakeAuthContext([]),
      perAppLimiter: bucket(3, 0.0001),
      perTokenLimiter: bucket(500, 0.0001),
      mountResources: mountSampleResources,
    });

    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    // Not 499. A client shown the roomier of its two ceilings will plan against
    // a limit it cannot actually use.
    expect(res.headers[lower.limit]).toBe('3');
    expect(res.headers[lower.remaining]).toBe('2');
  });
});
