/**
 * L12 S3 — PF-335, PF-336, PF-337, PF-338, PF-339.
 *
 * Where the audit middleware SITS, that it fires exactly once, and that the row
 * survives the process. Position is asserted by behaviour on the composed
 * router: a test that reads `router.ts` agrees with `router.ts`, which is not
 * the same as agreeing with the program.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import express, { Router, type Express } from 'express';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestPublicApp, V1_PREFIX } from '../api/v1/testSupport.js';
import { V1_ROUTER_LAYER_ORDER } from '../api/v1/middlewareOrder.js';
import { requestIdMiddleware } from '../api/v1/requestId.js';
import { FakeClock } from '../clock.js';
import { InMemoryTokenBucket } from '../ratelimit/limiter.js';
import { InMemoryAuditSink, publicAuditMiddleware } from './audit.js';
import { PgAuditSink, listCalls } from './pgAuditSink.js';
import { pool } from '../../db/client.js';
import { internalPathFor } from '../api/v1/resource-map.js';

const bucket = (capacity: number, refillPerSecond: number) =>
  new InMemoryTokenBucket({ capacity, refillPerSecond, maxKeys: 100 }, new FakeClock(0));

function mountSampleResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-335 / PF-336 — position
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-336 — audit is the SECOND layer: after requestId, before bearer auth', () => {
  it('a request with NO Authorization header still writes a row', async () => {
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });
    const res = await request(app).get(`${V1_PREFIX}/documents`).expect(401);

    // Any position after bearer auth silently loses EVERY unauthenticated call
    // — and "someone tried and was refused" is most of what an audit trail is
    // consulted for. The row has to exist, carry the real status, and carry the
    // id the caller was given.
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]!.status).toBe(401);
    expect(auditSink.records[0]!.clientId).toBeNull();
    expect(auditSink.records[0]!.requestId).toBe(res.headers['x-request-id']);
  });

  it('the row carries a REAL request id — so audit is below requestId, not above it', async () => {
    const { app, auditSink } = createTestPublicApp({
      auth: null,
      mountResources: mountSampleResources,
    });
    await request(app).get(`${V1_PREFIX}/documents`).expect(401);

    // Above `requestId`, `res.locals.requestId` would be unset and the row would
    // carry the `'unknown'` fallback. That is the other side of the position and
    // it is why "second", not "first", is the answer.
    expect(auditSink.records[0]!.requestId).not.toBe('unknown');
  });

  it('the declared order agrees: request_id, then audit, then everything that can reject', () => {
    const requestId = V1_ROUTER_LAYER_ORDER.indexOf('v1_request_id');
    const audit = V1_ROUTER_LAYER_ORDER.indexOf('v1_audit');

    expect(requestId).toBe(0);
    expect(audit).toBe(1);
    // Every layer that can terminate a request must be BELOW audit, or its
    // responses are invisible to the trail. p.4 says every public API call.
    for (const terminating of [
      'v1_body_parser',
      'v1_anon_rate_limit',
      'v1_bearer_auth',
      'v1_rate_limit',
      'v1_not_found',
    ]) {
      const index = V1_ROUTER_LAYER_ORDER.indexOf(terminating);
      expect(index, `${terminating} is not in the declared order`).toBeGreaterThanOrEqual(0);
      expect(index, `${terminating} sits above audit and would go unrecorded`).toBeGreaterThan(
        audit,
      );
    }
  });
});

describe('PF-335 — a 429 is audited, because the limiter is BELOW audit', () => {
  it('an exhausted bucket yields exactly one record with status 429', async () => {
    const { app, auditSink } = createTestPublicApp({
      perTokenLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // `rateLimitMiddleware` short-circuits with `next(err)`, so anything BELOW
    // it never runs. The sketch registered audit after the limiter, which meant
    // a rate-limited request wrote no row at all. L11's PF-318 asserts the same
    // invariant from the other side — deliberately, because either one landing
    // alone leaves the hole open.
    expect(auditSink.records.filter((r) => r.status === 429)).toHaveLength(1);
  });

  it('the anonymous backstop 429 is audited too, though it fires above bearer auth', async () => {
    const { app, auditSink } = createTestPublicApp({
      anonLimiter: bucket(1, 1 / 30),
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await request(app).get(`${V1_PREFIX}/documents`).expect(429);

    // L11 added `v1_anon_rate_limit` between the body parser and bearer auth.
    // It is still below audit, so it is still recorded — with `clientId: null`,
    // because it rejected the caller before anything resolved an identity.
    const throttled = auditSink.records.filter((r) => r.status === 429);
    expect(throttled).toHaveLength(1);
    expect(throttled[0]!.clientId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-337 / PF-338 — exactly once, including the aborted case
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-337 — an aborted request is recorded, not dropped', () => {
  it('a client that disconnects mid-response still writes exactly one row', async () => {
    // The sink itself is the signal, so nothing here waits on a duration. A
    // `setTimeout(50)` would be a guess about how fast a socket teardown
    // propagates, which is a flake with a 0% budget over 20 runs (p.9).
    const sink = new InMemoryAuditSink();
    let recorded!: () => void;
    const firstRecord = new Promise<void>((resolve) => {
      recorded = resolve;
    });
    const signalling = {
      record(entry: Parameters<InMemoryAuditSink['record']>[0]) {
        sink.record(entry);
        recorded();
      },
    };

    const app = express();
    app.use(requestIdMiddleware());
    app.use(publicAuditMiddleware(signalling));
    app.get('/slow', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"data":');
      // Never finished. The socket is destroyed below.
    });

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    await new Promise<void>((resolve) => {
      const req = httpRequest({ port, path: '/slow' }, (res) => {
        res.on('data', () => {
          // Headers are out and the first chunk arrived; now hang up.
          req.destroy();
          resolve();
        });
      });
      req.end();
    });

    // `res.on('finish')` does NOT fire for a connection the client dropped —
    // only `close` does. Listening to `finish` alone means the one class of
    // request most worth investigating is the one class with no row. If that
    // regressed, this await never settles and the test times out rather than
    // passing on a lucky sleep.
    await firstRecord;
    server.close();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]!.requestId).not.toBe('unknown');
  });

  it('a NORMAL response, which fires both finish and close, still writes one row', async () => {
    // The other half of the once-guard. Listening to both events without it
    // would double every ordinary row — which destroys the Epic 7 count as
    // effectively as missing rows do.
    const { app, auditSink } = createTestPublicApp({ mountResources: mountSampleResources });
    await request(app).get(`${V1_PREFIX}/documents`).expect(200);
    await new Promise((resolve) => setImmediate(resolve));

    expect(auditSink.records).toHaveLength(1);
  });
});

describe('PF-338 — exactly one record per request, under nesting and double-mount', () => {
  it('100 requests across mounted sub-routers produce exactly 100 records', async () => {
    const { app, auditSink } = createTestPublicApp({
      mountResources: (router) => {
        const nested = Router();
        nested.get('/deep', (_req, res) => {
          res.json({ data: null });
        });
        const deeper = Router();
        deeper.get('/deeper', (_req, res) => {
          res.json({ data: null });
        });
        nested.use('/inner', deeper);
        router.use('/nested', nested);
        router.get('/flat', (_req, res) => {
          res.json({ data: null });
        });
      },
    });

    const paths = [`${V1_PREFIX}/flat`, `${V1_PREFIX}/nested/deep`, `${V1_PREFIX}/nested/inner/deeper`];
    for (let i = 0; i < 100; i++) {
      await request(app).get(paths[i % paths.length]!);
    }

    expect(auditSink.records).toHaveLength(100);
  });

  it('mounting the middleware TWICE does not double the rows', async () => {
    const sink = new InMemoryAuditSink();
    const app = express();
    app.use(requestIdMiddleware());
    app.use(publicAuditMiddleware(sink));
    // The realistic version of this is not a copy-pasted line: it is a
    // sub-router that composes the public router, or a test wiring that adds the
    // middleware next to one that already had it.
    app.use(publicAuditMiddleware(sink));
    app.get('/thing', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/thing').expect(200);
    expect(sink.records).toHaveLength(1);
  });

  it('the once-guard is per REQUEST, not per process', async () => {
    // A `WeakSet` or a module-level flag would make the guard leak across
    // requests and record only the first one ever.
    const sink = new InMemoryAuditSink();
    const app = express();
    app.use(requestIdMiddleware());
    app.use(publicAuditMiddleware(sink));
    app.use(publicAuditMiddleware(sink));
    app.get('/thing', (_req, res) => {
      res.json({ ok: true });
    });

    for (let i = 0; i < 5; i++) await request(app).get('/thing').expect(200);
    expect(sink.records).toHaveLength(5);
    expect(new Set(sink.records.map((r) => r.requestId)).size).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-339 — persistence, and the internal surface writing nothing
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-339 — the Postgres sink and the public_api_calls table', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE public_api_calls');
  });

  it('the table exists with the nine columns the record carries', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'public_api_calls'`,
    );
    const columns = new Map(rows.map((r) => [r.column_name, r.is_nullable]));

    for (const name of [
      'id',
      'request_id',
      'client_id',
      'user_id',
      'method',
      'route',
      'scope_used',
      'status',
      'latency_ms',
      'occurred_at',
    ]) {
      expect(columns.has(name), `public_api_calls.${name} is missing`).toBe(true);
    }

    // The three documented nullables, and only those. A NOT NULL on `client_id`
    // would make an unauthenticated call unrecordable — i.e. would delete the
    // 401s from the trail by way of a constraint violation.
    expect(columns.get('client_id')).toBe('YES');
    expect(columns.get('user_id')).toBe('YES');
    expect(columns.get('scope_used')).toBe('YES');
    expect(columns.get('status')).toBe('NO');
    expect(columns.get('request_id')).toBe('NO');
  });

  it('it is NOT the internal audit_logs table', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN
         ('audit_logs', 'public_api_calls')`,
    );
    const names = rows.map((r) => r.table_name).sort();
    // Both exist, separately. `audit_logs` is Part 1's compliance log with AU-9
    // triggers forbidding DELETE; sharing it would apply L12's 30-day retention
    // to rows that must never be pruned.
    expect(names).toEqual(['audit_logs', 'public_api_calls']);
  });

  it('carries the indexes the portal query and the pruner both need', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'public_api_calls'`,
    );
    const defs = rows.map((r) => r.indexdef).join('\n');

    expect(defs, 'the portal query is (client_id, occurred_at desc)').toMatch(/client_id.*occurred_at/s);
    expect(defs, 'support lookup by request_id').toMatch(/\(request_id\)/);
    // The pruner deletes by age across ALL apps, so an index leading with
    // client_id does not serve it. At p.9's top tier that is 20M rows a day.
    expect(defs).toMatch(/\(occurred_at\)/);
  });

  it('a record round-trips through the sink and back out of listCalls', async () => {
    const sink = new PgAuditSink(pool);
    await sink.record({
      occurredAt: new Date('2026-08-12T10:00:00.000Z'),
      clientId: 'client_round_trip',
      userId: null,
      method: 'GET',
      route: '/api/v1/documents/:id',
      scopeUsed: 'documents:read',
      status: 200,
      latencyMs: 12.5,
      requestId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });

    const page = await listCalls(pool, { clientId: 'client_round_trip', limit: 10 });
    expect(page.data).toHaveLength(1);
    const row = page.data[0]!;
    expect(row.route).toBe('/api/v1/documents/:id');
    expect(row.scope_used).toBe('documents:read');
    expect(row.status).toBe(200);
    // A sub-millisecond public call is normal (a 401 touches no database), so an
    // integer column here would round the fast end of a P95 to zero.
    expect(row.latency_ms).toBeCloseTo(12.5, 5);
    expect(row.user_id).toBeNull();
  });

  it('an insert with a NULL client_id succeeds — the 401 case must be recordable', async () => {
    const sink = new PgAuditSink(pool);
    await sink.record({
      occurredAt: new Date(),
      clientId: null,
      userId: null,
      method: 'GET',
      route: '/api/v1/documents',
      scopeUsed: null,
      status: 401,
      latencyMs: 0.4,
      requestId: '11111111-1111-4111-8111-111111111111',
    });

    const page = await listCalls(pool, { status: 401, limit: 10 });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]!.client_id).toBeNull();
  });
});

describe('PF-339 — the INTERNAL surface writes zero rows', () => {
  let app: Express;

  beforeAll(async () => {
    const { createApp } = await import('../../app.js');
    const { productionDeps } = await import('../../deps.js');
    // The real production sink, deliberately: a test that swaps in the in-memory
    // one would prove nothing about what the internal routes write to Postgres.
    app = createApp(productionDeps());
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE public_api_calls');
  });

  it('internal /api requests produce no public_api_calls rows', async () => {
    for (const path of [
      '/api/documents',
      '/api/issues',
      // Via `internalPathFor` rather than spelled out: PF-077 keeps Ship's
      // internal sprint vocabulary in exactly one file, and a hardcoded path in
      // a test is the same leak as one in production code.
      internalPathFor('sprints')!,
      '/api/csrf-token',
      '/health',
    ]) {
      await request(app).get(path);
    }

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public_api_calls',
    );
    // The audit insert is a PER-CALL query. MVP-9's +10% per-route query-count
    // budget is measured on the Part 1 internal routes, and one extra INSERT on
    // every internal request would spend a chunk of it on a table those routes
    // have no business writing to. p.12 puts this middleware at the public layer
    // only, and this is that sentence as an assertion.
    expect(rows[0]!.count).toBe('0');
  });

  it('…while a /api/v1 request does write one, so the assertion above is not vacuous', async () => {
    await request(app).get('/api/v1/documents');

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public_api_calls',
    );
    // Without this, "zero rows" would also pass on a build where the sink was
    // broken, unwired, or writing to the wrong table.
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
  });
});
