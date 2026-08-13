/**
 * PF-214 / finding F1 — the internal rate limiter must not reach `/api/v1/*`.
 * PF-215 / finding F2 — the public 1 MB body limit must actually bind.
 *
 * Both defects had the same shape and the same fix: `app.use('/api/', apiLimiter)`
 * and `app.use(express.json({limit:'10mb'}))` are app-level mounts that matched
 * `/api/v1` by prefix, and the public router now mounts above both.
 *
 * These specs live beside `app.ts` rather than under `platform/` on purpose. The
 * bug is not in the public router — it is in what surrounds it — so a test built
 * on `createTestPublicApp` (which has no internal middleware at all) would pass
 * whether the defect was fixed or not. That is exactly how this class of bug
 * survives a green suite.
 *
 * `API_RATE_LIMIT_MAX` is set to 1 before `createApp` is imported, because
 * `apiLimiter` is constructed at module load.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/** The internal limiter's exact 429 body. Byte-for-byte, from app.ts. */
const INTERNAL_LIMITER_BODY = { error: 'Too many requests. Please slow down.' };

let app: Express;
let originalMax: string | undefined;

beforeAll(async () => {
  originalMax = process.env.API_RATE_LIMIT_MAX;
  // Ceiling of 1: the second internal request in this file is throttled, which is
  // what makes the negative assertion on the public side meaningful.
  process.env.API_RATE_LIMIT_MAX = '1';
  const { createApp } = await import('../app.js');
  app = createApp();
});

afterAll(() => {
  if (originalMax === undefined) delete process.env.API_RATE_LIMIT_MAX;
  else process.env.API_RATE_LIMIT_MAX = originalMax;
});

describe('PF-214 — driving /api/v1 past the internal ceiling never yields the internal 429', () => {
  it('no /api/v1 response body is ever the internal limiter message', async () => {
    const bodies: unknown[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app).get('/api/v1/documents');
      bodies.push(res.body);
    }

    for (const body of bodies) {
      expect(body).not.toEqual(INTERNAL_LIMITER_BODY);
    }
  });

  it('every /api/v1 response carries the envelope and a request_id, however many are sent', async () => {
    // The half that matters most. Under F1 the limiter short-circuited ABOVE the
    // public router, so a throttled call had no request_id, no envelope and no
    // audit row — the three things the public API contract is made of.
    for (let i = 0; i < 12; i++) {
      const res = await request(app).get('/api/v1/documents');
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(typeof res.body.code).toBe('string');
      expect(res.body.request_id).toBe(res.headers['x-request-id']);
      expect(res.body).not.toHaveProperty('error');
    }
  });

  it('no /api/v1 response carries the internal limiter headers without the platform ones', async () => {
    // express-rate-limit@8 with standardHeaders:true emits the `ratelimit-*`
    // family (no `X-` prefix). The platform limiter emits `X-RateLimit-*`. A v1
    // response carrying the former is the internal limiter having reached it.
    const res = await request(app).get('/api/v1/documents');
    const internalFamily = Object.keys(res.headers).filter(
      (h) => h === 'ratelimit-limit' || h === 'ratelimit-remaining' || h === 'ratelimit-reset',
    );
    expect(internalFamily).toEqual([]);
  });

  it('an unrouted /api/v1 path is the envelope 404, not the internal HTML 404', async () => {
    const res = await request(app).get('/api/v1/nothing-here');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.code).toBeDefined();
    expect(res.body.request_id).toBeTruthy();
  });

  it('THE INTERNAL LIMITER STILL WORKS — the fix did not disable it', async () => {
    // The other half of "internal /api is byte-for-byte what Part 1 shipped".
    // A fix that narrowed the limiter too far would pass every assertion above
    // and silently remove brute-force protection from the internal surface.
    let sawInternal429 = false;
    for (let i = 0; i < 6; i++) {
      const res = await request(app).get('/api/documents');
      if (res.status === 429) {
        expect(res.body).toEqual(INTERNAL_LIMITER_BODY);
        sawInternal429 = true;
        break;
      }
    }
    expect(
      sawInternal429,
      'The internal limiter no longer throttles /api. API_RATE_LIMIT_MAX=1 should throttle ' +
        'the second internal request — PF-214 must not weaken internal rate limiting.',
    ).toBe(true);
  });
});

describe('PF-215 — the public 1 MB ceiling binds; the internal 10 MB one is unchanged', () => {
  /** 2 MB of JSON — over the public ceiling, under the internal one. */
  const twoMegabyteBody = JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) });

  // PF-030 — this block gets its OWN app, with the rate limiter effectively off.
  //
  // These assertions are about BODY SIZE and nothing else, but they were running
  // against the module-level app above, whose limiter is deliberately built with
  // `API_RATE_LIMIT_MAX=1` so PF-214 can prove throttling works. PF-214 spends
  // that budget. By the time the 2 MB internal POST below runs, the bucket is
  // empty, express answers 429 and short-circuits WITHOUT draining the request
  // body — and the client, still writing two megabytes into a socket the server
  // has stopped reading, dies with `write EPIPE`.
  //
  // It is intermittent because it is a race: whether the 429 and the socket
  // teardown beat the client's write depends on scheduling, so it passes on an
  // idle machine and fails under load. That is why it read as flake for days
  // while passing in isolation — in isolation there is less to race against.
  //
  // The limiter's state is not part of what PF-215 asserts, so removing it from
  // the picture is not weakening the test. `vi.resetModules()` is what makes the
  // second `createApp` build a genuinely new limiter: `apiLimiter` is a
  // module-level const read at import time, so without a module-registry reset
  // the re-import returns the cached module and the old exhausted bucket.
  let bodyLimitApp: Express;

  beforeAll(async () => {
    const previous = process.env.API_RATE_LIMIT_MAX;
    process.env.API_RATE_LIMIT_MAX = '1000000';
    vi.resetModules();
    const { createApp } = await import('../app.js');
    bodyLimitApp = createApp();
    if (previous === undefined) delete process.env.API_RATE_LIMIT_MAX;
    else process.env.API_RATE_LIMIT_MAX = previous;
  });

  it('a 2 MB body on POST /api/v1/documents is rejected through the envelope', async () => {
    const res = await request(bodyLimitApp)
      .post('/api/v1/documents')
      .set('content-type', 'application/json')
      .send(twoMegabyteBody);

    expect(res.status).not.toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    // The envelope, not the internal HTML error page and not `{ error: … }`.
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.request_id).toBeTruthy();
    expect(res.body.details.fields[0].field).toBe('body');
  });

  it('the SAME 2 MB body on internal POST /api/documents is not rejected for size', async () => {
    // The internal ceiling is still 10 MB. This request fails on auth (401) —
    // what matters is that it is NOT a 413/422 body-size rejection, which is what
    // it would be if the public 1 MB parser had leaked onto the internal surface.
    const res = await request(bodyLimitApp)
      .post('/api/documents')
      .set('content-type', 'application/json')
      .send(twoMegabyteBody);

    expect(res.status).not.toBe(413);
    expect(res.body).not.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ fields: expect.anything() }) }),
    );
  });

  it('a small body on /api/v1 still parses — the ceiling is a ceiling, not a wall', async () => {
    const res = await request(bodyLimitApp)
      .post('/api/v1/documents')
      .set('content-type', 'application/json')
      .send({ title: 'small' });

    // 401 from the fail-closed bearer default, NOT a body error.
    expect(res.body.code).toBe('unauthorized');
  });
});
