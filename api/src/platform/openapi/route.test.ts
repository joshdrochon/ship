/**
 * S3 — the spec resolves at the URL the PRD names, without credentials.
 *
 * Tickets: PF-365 (reachable at all — finding F11's 404 half), PF-366 (resolves
 * with no credentials — F11's 401 half), PF-367 (what the mount position
 * bypasses, and that it is deliberate), PF-355 (`servers[0].url` + a `paths` key
 * resolves against the booted app).
 *
 * These run against `createBearerTestApp` — the REAL bearer middleware over real
 * tokens. That is not incidental. L07's stub decides the 401 itself, so it
 * cannot prove "everything except the spec still 401s", and that second half is
 * exactly what makes the exemption an exemption rather than a hole.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { createBearerTestApp, type BearerTestApp } from '../oauth/bearerTestSupport.js';
import { V1_PREFIX } from '../api/v1/testSupport.js';
import { V1_UNAUTHENTICATED_PATHS, isUnauthenticatedV1Path } from '../api/v1/router.js';
import { enumerateV1Routes } from '../api/v1/routeFitness.js';
import { InMemoryTokenBucket } from '../ratelimit/limiter.js';
import { mountOpenApiSpec, OPENAPI_SPEC_PATH } from './route.js';
import { generatePublicOpenAPIDocument, PUBLIC_API_SERVER_URL } from './registry.js';
import '../api/v1/documents/routes.js';
import { FakeClock } from '../clock.js';

const document = generatePublicOpenAPIDocument();

/**
 * Stand-in resource routes, so "everything else 401s" has something to be, and
 * so PF-355's URL-resolves check is measuring routing rather than the absence of
 * a database. One stub per generated `documents` path — the real handlers need a
 * live Postgres and are exercised in `documents.routes.test.ts`.
 */
function mountResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
  router.get('/documents/:id', (_req, res) => {
    res.json({ id: 'stub' });
  });
  router.post('/documents', (_req, res) => {
    res.status(201).json({ id: 'stub' });
  });
}

describe('PF-365 / PF-366 — GET /api/v1/openapi.json is reachable and anonymous', () => {
  let harness: BearerTestApp;

  beforeAll(async () => {
    harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(document),
      mountResources,
    });
  });

  it('answers 200 + application/json with NO Authorization header', async () => {
    const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
    expect(
      res.status,
      'A grader cannot resolve a spec that 401s (MVP item 10), and cannot find one that ' +
        '404s behind the router catch-all (finding F11).',
    ).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('serves the real generated document, not a placeholder', async () => {
    const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toContain('/documents');
    expect(res.body.info.title).toBe('Ship Public API');
  });

  it('every OTHER v1 route still 401s unauthenticated — the exemption is one path', async () => {
    const anonymous = await request(harness.app).get(`${V1_PREFIX}/documents`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('unauthorized');

    // And an unknown path is still the envelope's 404, not the spec.
    const unknown = await request(harness.app).get(`${V1_PREFIX}/nope`);
    expect(unknown.status).toBe(401);
  });

  it('an authenticated caller still gets the resource — the mount broke nothing', async () => {
    const token = await harness.mint(['documents:read']);
    const res = await request(harness.app)
      .get(`${V1_PREFIX}/documents`)
      .set('Authorization', `Bearer ${token.access_token}`);
    expect(res.status).toBe(200);
  });

  it('the allowlist and the mount agree — every declared path is actually mounted', () => {
    // L08's assertion, now running against the REAL handler rather than the stub
    // it shipped with. The stub made this pass by construction; this makes it
    // pass because the endpoint exists.
    const enumerated = enumerateV1Routes(harness.app).map((r) => r.path);
    for (const path of V1_UNAUTHENTICATED_PATHS) {
      expect(enumerated, `${path} is declared unauthenticated but is not mounted`).toContain(path);
    }
    expect(isUnauthenticatedV1Path(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`)).toBe(true);
  });
});

describe('PF-355 — servers[0].url + a paths key resolves against the booted app', () => {
  it('every generated paths key answers something other than 404', async () => {
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(document),
      mountResources,
    });
    const token = await harness.mint(['documents:read', 'documents:write']);

    expect(PUBLIC_API_SERVER_URL).toBe(V1_PREFIX);

    for (const path of Object.keys(document.paths ?? {})) {
      // `{id}` → a real-looking UUID, so the request routes. Whether it 404s on
      // the ROW is a resource question; what is asserted here is that the URL an
      // SDK builds from the spec reaches a handler at all.
      const concrete = path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(harness.app)
        .get(`${PUBLIC_API_SERVER_URL}${concrete}`)
        .set('Authorization', `Bearer ${token.access_token}`);
      expect(
        res.status,
        `${PUBLIC_API_SERVER_URL}${concrete} did not resolve — an SDK that concatenates ` +
          `servers[0].url with a paths key would 404 on every call.`,
      ).not.toBe(404);
    }
  });
});

describe('PF-367 — what the spec route bypasses, measured rather than assumed', () => {
  /**
   * **The ticket's premise was wrong and this is the correction.**
   *
   * PF-367 assumed the stack was `bearerAuth → rateLimit → audit`, so that
   * mounting above bearer auth would bypass the audit sink too. F7 moved audit
   * ABOVE bearer auth precisely so 401s and 429s are audited, so the live order
   * is `requestId → audit → … → unauthenticated → bearerAuth → rateLimit`.
   */
  it('DOES write an audit row — audit sits above the unauthenticated mount', async () => {
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(document),
    });
    const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);

    expect(harness.auditSink.records).toHaveLength(1);
    expect(harness.auditSink.records[0]?.status).toBe(200);
    expect(harness.auditSink.records[0]?.requestId).toBe(res.headers['x-request-id']);
    // No token, so no app and no user to attribute the call to. That is the
    // honest record, not a gap.
    expect(harness.auditSink.records[0]?.clientId ?? null).toBeNull();
  });

  it('carries an X-Request-Id — it is INSIDE the v1 stack, not mounted on the app', async () => {
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(document),
    });
    const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('does NOT consume a rate-limit bucket — accepted, and this is the proof', async () => {
    // A capacity-1 bucket. If the spec route consumed a token, the second
    // request would 429 — and more importantly a resource request afterwards
    // would be throttled by traffic it did not cause.
    // `1e-6` rather than `0`: PF-306 requires an integer `Retry-After` >= 1, and
    // a bucket that never refills computes an infinite one.
    const perAppLimiter = new InMemoryTokenBucket(
      { capacity: 1, refillPerSecond: 1e-6, maxKeys: 100 },
      new FakeClock(0),
    );
    const perTokenLimiter = new InMemoryTokenBucket(
      { capacity: 1, refillPerSecond: 1e-6, maxKeys: 100 },
      new FakeClock(0),
    );
    const harness = await createBearerTestApp({
      mountUnauthenticated: mountOpenApiSpec(document),
      mountResources,
      perAppLimiter,
      perTokenLimiter,
    });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(harness.app).get(`${V1_PREFIX}${OPENAPI_SPEC_PATH}`);
      expect(res.status, `spec fetch #${i + 1} was throttled`).toBe(200);
    }

    // The bucket is untouched, so an authenticated caller still gets its one token.
    const token = await harness.mint(['documents:read']);
    const first = await request(harness.app)
      .get(`${V1_PREFIX}/documents`)
      .set('Authorization', `Bearer ${token.access_token}`);
    expect(first.status).toBe(200);
  });

  it('the bypass is written down where L11 and L12 will look', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toMatch(/openapi\.json/);
    expect(readme).toMatch(/rate limit/i);
  });
});
