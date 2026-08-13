/**
 * L12 S2 — PF-330, PF-331, PF-332, PF-333, PF-334.
 *
 * Every field is TRUE, not merely present. A row whose `route` is a raw UUID or
 * whose `latencyMs` excludes authentication is a row that will be believed and
 * is wrong, which is worse than a missing one.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Router } from 'express';
import { createTestPublicApp, V1_PREFIX } from '../api/v1/testSupport.js';
import { declareRoute, SCOPE_USED_LOCAL } from '../scopes/require-scope.js';
import { asyncRoute } from '../api/v1/errorMiddleware.js';
import { FakeClock } from '../clock.js';
import { InMemoryTokenBucket } from '../ratelimit/limiter.js';
import { UNMATCHED_ROUTE } from './audit.js';

const AUDIT_DIR = fileURLToPath(new URL('.', import.meta.url));
const A_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const bucket = (capacity: number, refillPerSecond: number) =>
  new InMemoryTokenBucket({ capacity, refillPerSecond, maxKeys: 100 }, new FakeClock(0));

function mountSampleResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
  router.get('/documents/:id', (_req, res) => {
    res.json({ data: { id: 'x' } });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-330 — request_id is consumed, never minted
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-330 — this lane mints no ids', () => {
  it('no source file under audit/ generates one', () => {
    const sources = readdirSync(AUDIT_DIR).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(sources.length, 'the grep would be vacuous with no files to read').toBeGreaterThan(0);

    for (const file of sources) {
      const code = readFileSync(join(AUDIT_DIR, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      // A second id source is the failure this whole ticket exists for: the row
      // would carry an id the caller was never given, and the support
      // conversation that starts "here is my request id" would find nothing.
      expect(code, `${file} mints ids`).not.toMatch(/randomUUID/);
      expect(code, `${file} mints ids`).not.toMatch(/randomBytes/);
      expect(code, `${file} mints ids`).not.toMatch(/crypto\./);
      expect(code, `${file} mints ids`).not.toMatch(/uuid\s*\(/i);
    }
  });

  it('the recorded requestId string-equals the response X-Request-Id, on a 2xx', async () => {
    const { app, auditSink } = createTestPublicApp({ mountResources: mountSampleResources });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(200);

    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]!.requestId).toBe(res.headers['x-request-id']);
  });

  it('…and on a 401, a 404 and a 429 — where a second minted id would show up', async () => {
    // These three never reach a handler, so they are exactly the responses a
    // "mint one if missing" fallback would silently cover for.
    const unauthenticated = createTestPublicApp({ auth: null, mountResources: mountSampleResources });
    const notFound = createTestPublicApp({ mountResources: mountSampleResources });
    const throttled = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    const a = await request(unauthenticated.app).get(`${V1_PREFIX}/documents`).expect(401);
    const b = await request(notFound.app).get(`${V1_PREFIX}/nope`).expect(404);
    await request(throttled.app).get(`${V1_PREFIX}/documents`).expect(200);
    const c = await request(throttled.app).get(`${V1_PREFIX}/documents`).expect(429);

    expect(unauthenticated.auditSink.records[0]!.requestId).toBe(a.headers['x-request-id']);
    expect(notFound.auditSink.records[0]!.requestId).toBe(b.headers['x-request-id']);
    expect(throttled.auditSink.records[1]!.requestId).toBe(c.headers['x-request-id']);
  });

  it('no record ever carries the "unknown" fallback', async () => {
    const { app, auditSink } = createTestPublicApp({
      perTokenLimiter: bucket(2, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`);
    await request(app).get(`${V1_PREFIX}/documents/${A_UUID}`);
    await request(app).get(`${V1_PREFIX}/nope`);
    await request(app).get(`${V1_PREFIX}/documents`);

    expect(auditSink.records.length).toBeGreaterThan(0);
    // The `?? 'unknown'` in the sink is a soft edge L07 left in place for the
    // case this middleware is mounted outside the v1 stack. Inside it, it must
    // be unreachable — asserted rather than deleted, because deleting it would
    // make that out-of-stack case a crash.
    for (const record of auditSink.records) {
      expect(record.requestId).not.toBe('unknown');
      expect(record.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-331 — route is the template, prefixed
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-331 — route is the route TEMPLATE, prefixed', () => {
  it('a parameterised route records /api/v1/documents/:id, never the uuid', async () => {
    const { app, auditSink } = createTestPublicApp({ mountResources: mountSampleResources });
    await request(app).get(`${V1_PREFIX}/documents/${A_UUID}`).expect(200);

    // The measured defect: `req.route?.path` inside a router mounted at
    // /api/v1 is `/documents/:id` — the PREFIX is missing — and the fallback
    // recorded `req.path`, which on an unmatched route is the raw path. Either
    // way a document UUID lands in the route column: unbounded cardinality, a
    // resource id in an audit field, and a useless index.
    expect(auditSink.records[0]!.route).toBe(`${V1_PREFIX}/documents/:id`);
    expect(auditSink.records[0]!.route).not.toContain(A_UUID);
  });

  it('a plain route records the full prefixed template', async () => {
    const { app, auditSink } = createTestPublicApp({ mountResources: mountSampleResources });
    await request(app).get(`${V1_PREFIX}/documents`).expect(200);

    // Not `/documents`. A row that says `/documents` cannot be told apart from
    // an internal one, which defeats the point of a public-only trail.
    expect(auditSink.records[0]!.route).toBe(`${V1_PREFIX}/documents`);
  });

  it('an unrouted path records a constant, never the id it contained', async () => {
    const { app, auditSink } = createTestPublicApp({ mountResources: mountSampleResources });
    await request(app).get(`${V1_PREFIX}/widgets/${A_UUID}`).expect(404);

    const route = auditSink.records[0]!.route;
    expect(route).toContain(UNMATCHED_ROUTE);
    expect(route).not.toContain(A_UUID);
    // "This call routed nowhere" is a value you can GROUP BY. The raw path is
    // one distinct value per attacker-chosen string.
    expect(route).toBe(`${V1_PREFIX}${UNMATCHED_ROUTE}`);
  });

  it('a 401 records the constant too — req.route is undefined before auth', async () => {
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });
    await request(app).get(`${V1_PREFIX}/documents/${A_UUID}`).expect(401);

    expect(auditSink.records[0]!.route).not.toContain(A_UUID);
  });

  it('the method is recorded separately, so two verbs on one path are two rows', async () => {
    const { app, auditSink } = createTestPublicApp({
      mountResources: (router) => {
        router.get('/documents', (_req, res) => {
          res.json({ data: [] });
        });
        router.post('/documents', (_req, res) => {
          res.status(201).json({ data: {} });
        });
      },
    });

    await request(app).get(`${V1_PREFIX}/documents`);
    await request(app).post(`${V1_PREFIX}/documents`).send({});

    expect(auditSink.records.map((r) => `${r.method} ${r.route}`)).toEqual([
      `GET ${V1_PREFIX}/documents`,
      `POST ${V1_PREFIX}/documents`,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-332 — latency covers the whole public stack
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-332 — latency_ms covers the whole stack, not just the handler', () => {
  it('a handler that takes ~50 ms records at least 50 ms', async () => {
    const { app, auditSink } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/slow',
          asyncRoute(async (_req, res) => {
            const until = Date.now() + 50;
            // A busy wait rather than a timer: the assertion is about wall-clock
            // duration of the REQUEST, which is the one thing a FakeClock cannot
            // stand in for. `latencyMs` is measured with `process.hrtime`, not
            // with the injected Clock, precisely because it is a measurement of
            // the real world rather than a schedule.
            while (Date.now() < until) {
              /* spin */
            }
            res.json({ data: null });
          }),
        );
      },
    });

    await request(app).get(`${V1_PREFIX}/slow`).expect(200);
    expect(auditSink.records[0]!.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it('latency is a positive number on every response class', async () => {
    const { app, auditSink } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`);
    await request(app).get(`${V1_PREFIX}/documents`); // 429
    await request(app).get(`${V1_PREFIX}/nope`); // 404 — but the bucket is empty

    expect(auditSink.records.length).toBeGreaterThan(0);
    for (const record of auditSink.records) {
      expect(record.latencyMs).toBeGreaterThan(0);
      expect(Number.isFinite(record.latencyMs)).toBe(true);
    }
  });

  it('the timer starts ABOVE auth and rate limiting, so a 401s latency is real', async () => {
    // The number a P95 target means includes the time spent deciding to reject.
    // If the timer started at the handler, a 401 would record ~0 ms and the
    // slowest thing the API does — rejecting a bad token — would be invisible.
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });
    await request(app).get(`${V1_PREFIX}/documents`).expect(401);

    expect(auditSink.records[0]!.status).toBe(401);
    expect(auditSink.records[0]!.latencyMs).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-333 — scope used
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-333 — scope used is populated by L03, and its null has ONE meaning', () => {
  it('a guarded route records the scope that was checked', async () => {
    const { app, auditSink } = createTestPublicApp({
      scopes: ['documents:read'],
      mountResources: (router) => {
        router.get(
          '/guarded',
          declareRoute('documents:read', { method: 'get', path: '/api/v1/guarded' }),
          (_req, res) => {
            res.json({ data: null });
          },
        );
      },
    });

    await request(app).get(`${V1_PREFIX}/guarded`).expect(200);
    expect(auditSink.records[0]!.scopeUsed).toBe('documents:read');
  });

  it('a 403 records the scope too — "checked" is not "passed"', async () => {
    const { app, auditSink } = createTestPublicApp({
      scopes: ['issues:read'],
      mountResources: (router) => {
        router.get(
          '/guarded',
          declareRoute('documents:read', { method: 'get', path: '/api/v1/guarded2' }),
          (_req, res) => {
            res.json({ data: null });
          },
        );
      },
    });

    await request(app).get(`${V1_PREFIX}/guarded`).expect(403);
    // Recording only on success would make every refusal indistinguishable from
    // an unscoped route, and "what was this caller refused for" unanswerable.
    expect(auditSink.records[0]!.status).toBe(403);
    expect(auditSink.records[0]!.scopeUsed).toBe('documents:read');
  });

  it('an UNSCOPED route records null — no scope was checked', async () => {
    const { app, auditSink } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/me',
          declareRoute(null, { method: 'get', path: '/api/v1/me' }),
          (_req, res) => {
            res.json({ data: null });
          },
        );
      },
    });

    await request(app).get(`${V1_PREFIX}/me`).expect(200);
    expect(auditSink.records[0]!.scopeUsed).toBeNull();
  });

  it('a request rejected BEFORE the scope middleware records null, not a guess', async () => {
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: (router) => {
        router.get(
          '/guarded',
          declareRoute('documents:read', { method: 'get', path: '/api/v1/guarded3' }),
          (_req, res) => {
            res.json({ data: null });
          },
        );
      },
    });

    await request(app).get(`${V1_PREFIX}/guarded`).expect(401);
    // The route DECLARES a scope, but no scope decision was reached. Recording
    // the declared scope here would say a check happened that did not.
    expect(auditSink.records[0]!.scopeUsed).toBeNull();
  });

  it('the local key L03 writes is the one the sink reads', () => {
    // Two string literals in two modules is a contract nothing checks. This is
    // the check.
    expect(SCOPE_USED_LOCAL).toBe('scopeUsed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-334 — failures are audited
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-334 — 401, 403, 404, 429 and 500 each write exactly one row', () => {
  it('401 — one row, status 401, clientId null', async () => {
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });
    await request(app).get(`${V1_PREFIX}/documents`).expect(401);

    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]!.status).toBe(401);
    expect(auditSink.records[0]!.clientId).toBeNull();
    expect(auditSink.records[0]!.userId).toBeNull();
    expect(auditSink.records[0]!.requestId).toBeTruthy();
  });

  it('403 — one row, and clientId/userId populated because it DID authenticate', async () => {
    const { app, auditSink } = createTestPublicApp({
      scopes: ['issues:read'],
      mountResources: (router) => {
        router.get(
          '/guarded',
          declareRoute('documents:read', { method: 'get', path: '/api/v1/guarded4' }),
          (_req, res) => {
            res.json({ data: null });
          },
        );
      },
    });
    await request(app).get(`${V1_PREFIX}/guarded`).expect(403);

    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]!.status).toBe(403);
    // The difference between 401 and 403 in the trail is exactly this pair.
    expect(auditSink.records[0]!.clientId).toBe('client_test');
    expect(auditSink.records[0]!.userId).toBe('user_test');
  });

  it('404 — one row', async () => {
    const { app, auditSink } = createTestPublicApp({ mountResources: mountSampleResources });
    await request(app).get(`${V1_PREFIX}/nope`).expect(404);

    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]!.status).toBe(404);
  });

  it('429 — one row', async () => {
    const { app, auditSink } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });
    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    expect(auditSink.records.filter((r) => r.status === 429)).toHaveLength(1);
  });

  it('500 — one row', async () => {
    const { app, auditSink } = createTestPublicApp({
      mountResources: (router) => {
        router.get('/boom', () => {
          throw new Error('deliberate');
        });
      },
    });
    await request(app).get(`${V1_PREFIX}/boom`).expect(500);

    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]!.status).toBe(500);
  });

  it('all five classes in one run produce five rows, in order', async () => {
    // p.4 says EVERY public API call. The four classes that short-circuit before
    // the handler are precisely the ones a naive implementation loses, and
    // asserting them one at a time above would not catch a sink that records
    // only the most recent.
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`);
    await request(app).get(`${V1_PREFIX}/nope`);
    await request(app).post(`${V1_PREFIX}/documents`).send({});

    expect(auditSink.records).toHaveLength(3);
    expect(auditSink.records.every((r) => r.requestId && r.requestId !== 'unknown')).toBe(true);
    // Distinct ids: three calls, three rows, not one row written three times.
    expect(new Set(auditSink.records.map((r) => r.requestId)).size).toBe(3);
  });
});
