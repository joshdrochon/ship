/**
 * L11 S4 — PF-316, PF-317, PF-318, PF-319, PF-320, and finding F29.
 *
 * Where the limiter SITS, rather than what it computes. Every assertion is on a
 * composed router or a full `createApp()`, never on the source: a test that
 * reads a file agrees with the file, which is not the same as agreeing with the
 * program.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express, Router } from 'express';
import { FakeClock } from '../clock.js';
import { apiErrorBodySchema } from '../api/v1/errors.js';
import { createTestPublicApp, V1_PREFIX } from '../api/v1/testSupport.js';
import { V1_ROUTER_LAYER_ORDER } from '../api/v1/middlewareOrder.js';
import { oauthErrorBodySchema } from '../oauth/oauthErrors.js';
import { InMemoryTokenBucket, RATE_LIMIT_HEADERS } from './limiter.js';
import { oauthRateLimitedBody } from './oauthThrottle.js';

/** The internal limiter's exact 429 body, byte-for-byte from app.ts. */
const INTERNAL_LIMITER_BODY = { error: 'Too many requests. Please slow down.' };

const bucket = (capacity: number, refillPerSecond: number) =>
  new InMemoryTokenBucket({ capacity, refillPerSecond, maxKeys: 1_000 }, new FakeClock(0));

function mountSampleResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-316 / PF-317 — the boundary between the two limiters
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-316 — a REAL v1 429 is the platform 429, never the internal one', () => {
  it('carries the ApiError envelope and the X- header family, not the draft one', async () => {
    // The half `internal-limiter-scope.test.ts` cannot cover: that spec drives
    // 401s, because it has no token. This drives a real 429 out of OUR limiter
    // and asserts it did not pick up the internal limiter's shape on the way.
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 10),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    expect(res.body).not.toEqual(INTERNAL_LIMITER_BODY);
    expect(res.body).not.toHaveProperty('error');
    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);

    // `express-rate-limit@8` with `standardHeaders: true` emits these three.
    // A v1 429 carrying them is the internal limiter having reached the public
    // surface — the whole of finding F1.
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['ratelimit-remaining']).toBeUndefined();
    expect(res.headers['ratelimit-reset']).toBeUndefined();
    expect(res.headers['ratelimit-policy']).toBeUndefined();
    expect(res.headers[RATE_LIMIT_HEADERS.limit.toLowerCase()]).toBeDefined();
  });
});

describe('PF-316 / PF-317 — measured against the full createApp, at volume', () => {
  let app: Express;
  let originalMax: string | undefined;

  beforeAll(async () => {
    originalMax = process.env.API_RATE_LIMIT_MAX;
    // A ceiling of 1 means the internal limiter fires on the SECOND internal
    // request in this file. Set before importing `app.js`, because `apiLimiter`
    // is constructed at module load.
    process.env.API_RATE_LIMIT_MAX = '1';
    const { createApp } = await import('../../app.js');
    app = createApp();
  });

  afterAll(() => {
    if (originalMax === undefined) delete process.env.API_RATE_LIMIT_MAX;
    else process.env.API_RATE_LIMIT_MAX = originalMax;
  });

  it('F1 re-measured: 40 v1 requests past the internal ceiling, never the internal 429', async () => {
    // Re-run rather than trusted. The lane file says the finding was confirmed
    // by execution against express@4.22.1 / express-rate-limit@8.2.1 and that
    // L08 moved the public router above the `app.use('/api/', apiLimiter)`
    // line. This is the assertion that the fix is still in place — the mount is
    // one edit away from regressing and the symptom would be a public 429 with
    // an internal body and no request_id.
    for (let i = 0; i < 40; i++) {
      const res = await request(app).get('/api/v1/documents');
      expect(res.body).not.toEqual(INTERNAL_LIMITER_BODY);
      expect(res.headers['x-request-id'], 'a v1 response with no request_id').toBeTruthy();
      expect(res.headers['ratelimit-limit']).toBeUndefined();
      // Every one of them carries the three platform headers — the p.6 target,
      // measured on the real app rather than a test double.
      for (const name of Object.values(RATE_LIMIT_HEADERS)) {
        expect(res.headers[name.toLowerCase()], `${name} missing`).toBeDefined();
      }
    }
  });

  it('PF-317 — the internal surface still meets its own limiter, unchanged', async () => {
    // The other direction, and it is the half that makes PF-317 more than a
    // promise: fixing the public side by loosening the internal one would pass
    // every assertion above.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app).get('/api/documents');
      statuses.push(res.status);
    }

    const throttled = statuses.filter((s) => s === 429);
    expect(throttled.length, 'internal /api is no longer rate limited').toBeGreaterThan(0);
  });

  it('PF-317 — the internal 429 keeps its own body and its own header family', async () => {
    for (let i = 0; i < 6; i++) await request(app).get('/api/documents');
    const res = await request(app).get('/api/documents');

    if (res.status === 429) {
      // Byte-for-byte what Part 1 shipped: the `{error}` shape and the draft
      // `ratelimit-*` headers from `standardHeaders: true`.
      expect(res.body).toEqual(INTERNAL_LIMITER_BODY);
      expect(res.headers['ratelimit-limit']).toBeDefined();
      // And NOT the platform family — the two surfaces must stay distinguishable.
      expect(res.headers[RATE_LIMIT_HEADERS.limit.toLowerCase()]).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-318 / PF-319 — position, asserted by behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-318 — a 429 is audited, because audit sits ABOVE the limiter', () => {
  it('exhausting a bucket produces exactly one audit record with status 429', async () => {
    const { app, auditSink } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // `rateLimitMiddleware` short-circuits with `next(err)`, so anything
    // registered BELOW it never runs. The router sketch had audit below the
    // limiter, which meant a rate-limited request wrote no row at all — and a
    // 429 is precisely the traffic an audit trail exists to record.
    const throttled = auditSink.records.filter((r) => r.status === 429);
    expect(throttled).toHaveLength(1);
    expect(auditSink.records).toHaveLength(2);
  });

  it('every 429 in a burst is audited, not just the first', async () => {
    const { app, auditSink } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    for (let i = 0; i < 5; i++) await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    expect(auditSink.records.filter((r) => r.status === 429)).toHaveLength(5);
  });
});

describe('PF-319 — limiter position proved on the composed router, not read off source', () => {
  it('an invalid token yields 401 and consumes NO per-token allowance', async () => {
    const perTokenLimiter = bucket(3, 0.0001);
    const { app } = createTestPublicApp({
      auth: null,
      perTokenLimiter,
      mountResources: mountSampleResources,
    });

    const before = perTokenLimiter.peek('token:token_test').remaining;
    for (let i = 0; i < 5; i++) {
      await request(app).get(`${V1_PREFIX}/documents`).expect(401);
    }

    // Auth is UPSTREAM of the limiter. If it were not, an unauthenticated
    // caller could drain a bucket keyed on an identity that was never resolved
    // — or, worse, on `undefined`, which is one global bucket for every
    // anonymous request in the process.
    expect(perTokenLimiter.peek('token:token_test').remaining).toBe(before);
  });

  it('a valid token over the limit never reaches the handler', async () => {
    let handlerCalls = 0;
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(2, 0.0001),
      mountResources: (router) => {
        router.get('/documents', (_req, res) => {
          handlerCalls++;
          res.json({ data: [], next_cursor: null });
        });
      },
    });

    for (let i = 0; i < 6; i++) await request(app).get(`${V1_PREFIX}/documents`);

    // The limiter is above the handlers, which is what "a throttled request must
    // not do work" means operationally.
    expect(handlerCalls).toBe(2);
  });

  it('the declared order answers p.13s question: audit, then authN, then rate limit', () => {
    // p.13 asks verbatim where AuthN, AuthZ, rate-limit, audit and webhook
    // publication attach. This is that answer in a form a test can check, and
    // L08 owns the constant — this lane owns only the assertion that our two
    // positions inside it are the ones the behaviour above depends on.
    const audit = V1_ROUTER_LAYER_ORDER.indexOf('v1_audit');
    const anonLimit = V1_ROUTER_LAYER_ORDER.indexOf('v1_anon_rate_limit');
    const bearer = V1_ROUTER_LAYER_ORDER.indexOf('v1_bearer_auth');
    const rateLimit = V1_ROUTER_LAYER_ORDER.indexOf('v1_rate_limit');

    expect(audit).toBeGreaterThanOrEqual(0);
    expect(anonLimit).toBeGreaterThanOrEqual(0);
    expect(audit, 'audit below the limiter loses every 429 (PF-318)').toBeLessThan(rateLimit);
    expect(anonLimit, 'the anon backstop must sit above bearer auth (PF-313)').toBeLessThan(bearer);
    expect(bearer, 'the bucket key is the identity auth resolved').toBeLessThan(rateLimit);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-320 — the negative case, live
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-320 — rate_limited, produced by a real request (TS-4 clause c)', () => {
  it('capacity 1, two requests: 429 + envelope + Retry-After + Remaining 0', async () => {
    const { app } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 12),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.request_id).toBe(res.headers['x-request-id']);
    expect(res.headers['retry-after']).toBe('12');
    expect(res.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()]).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F29 — /oauth/*
// ─────────────────────────────────────────────────────────────────────────────

describe('F29 — /oauth/* is throttled, and keeps the RFC 6749 error surface', () => {
  it('the 429 body validates against oauthErrorBodySchema, not the ApiError one', () => {
    const body = oauthRateLimitedBody(30);

    // Two specs, two surfaces. An OAuth client library looks for `error`; giving
    // it `code` would make a throttled token exchange indistinguishable from a
    // malformed response. This is settled at L99 U3 / PF-106 / PF-172 and this
    // lane does not get to re-open it just because it owns the other surface.
    const parsed = oauthErrorBodySchema.safeParse(body);
    expect(parsed.success, JSON.stringify(body)).toBe(true);
    expect(body.error).toBe('slow_down');
    expect(apiErrorBodySchema.safeParse(body).success).toBe(false);
  });

  it('slow_down needs no widening of the closed OAuth code set', () => {
    // RFC 8628 §3.5 defines it for a client polling the token endpoint too fast,
    // which is what this is. RFC 6749 registers no rate-limit code at all, so
    // the alternative was a seventh member of a union two lanes assert is closed.
    expect(oauthErrorBodySchema.safeParse({ error: 'slow_down' }).success).toBe(true);
  });

  it('a real /oauth/token burst is throttled by the composition root', async () => {
    const { createApp } = await import('../../app.js');
    const { testDeps } = await import('../../deps.js');

    const oauthLimiter = bucket(2, 1 / 20);
    const app = createApp(testDeps({ oauthLimiter }));

    // Two requests get through to the grant dispatcher (and fail there, on
    // their merits — that is fine, this is about the throttle).
    const first = await request(app).post('/oauth/token').type('form').send({ grant_type: 'x' });
    expect(first.status).not.toBe(429);
    await request(app).post('/oauth/token').type('form').send({ grant_type: 'x' });

    const throttled = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'x' })
      .expect(429);

    expect(throttled.body.error).toBe('slow_down');
    expect(oauthErrorBodySchema.safeParse(throttled.body).success).toBe(true);
    expect(throttled.headers['retry-after']).toBe('20');
    expect(throttled.headers[RATE_LIMIT_HEADERS.limit.toLowerCase()]).toBe('2');
    // A cached 429 would outlive the condition that produced it.
    expect(throttled.headers['cache-control']).toContain('no-store');
  });

  it('the throttle runs BEFORE the body is parsed and before any credential check', async () => {
    const { createApp } = await import('../../app.js');
    const { testDeps } = await import('../../deps.js');

    const oauthLimiter = bucket(1, 1 / 20);
    const app = createApp(testDeps({ oauthLimiter }));

    await request(app).post('/oauth/token').type('form').send({ grant_type: 'x' });
    // A malformed body still 429s rather than 400s: the limiter answered first,
    // which is the point. A limiter that only counts requests it has already
    // done the work for has already done the work.
    const res = await request(app).post('/oauth/token').type('form').send('%%%not-form-data');
    expect(res.status).toBe(429);
  });

  it('the /oauth bucket is separate from the /api/v1 anon bucket', async () => {
    const { productionDeps } = await import('../../deps.js');
    const deps = productionDeps();

    // Sharing one would mean a busy integration's API traffic throttles its own
    // token refresh — a client that gets rate limited and then cannot renew the
    // credential it needs to back off correctly.
    expect(deps.oauthLimiter).not.toBe(deps.anonLimiter);
    expect(deps.oauthLimiter).not.toBe(deps.perAppLimiter);
  });
});
