/**
 * F113 — `GET /api/v1/audit`, the HTTP contract.
 *
 * PRD p.4: the trail must be *"Queryable in the developer portal"*, and p.10
 * requires the portal to reuse the public API like any other client. What is
 * only observable at THIS layer is the wire contract — the seven recorded
 * fields, the cursor protocol, filter validation, and what a caller cannot ask
 * for. `pgAuditSink`'s own suites already prove the query and the ordering
 * against Postgres, so none of that is re-proved here.
 *
 * Runs against the real `public_api_calls` table because `listCalls` is a SQL
 * function with no in-memory double; the rows are seeded through `PgAuditSink`,
 * which is the same writer production uses.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createTestPublicApp, fakeAuthContext, V1_PREFIX } from '../testSupport.js';
import { PgAuditSink } from '../../../audit/pgAuditSink.js';
import { encodeCursor } from '../pagination.js';
import { auditResources } from './routes.js';
import { auditCallSchema, AUDIT_RESOURCE } from './audit.schema.js';
import { pageSchema } from '../page.js';

const CLIENT = 'client_test'; // what `fakeAuthContext()` puts on the context

const T0 = Date.UTC(2026, 7, 1, 12, 0, 0);
const at = (offsetSeconds: number): Date => new Date(T0 + offsetSeconds * 1000);

let sink: PgAuditSink;

/** Seeds one row exactly as the audit middleware would. */
async function seed(
  overrides: Partial<{
    clientId: string;
    userId: string | null;
    method: string;
    route: string;
    scopeUsed: string | null;
    status: number;
    latencyMs: number;
    occurredAt: Date;
    requestId: string;
  }> = {},
): Promise<void> {
  await sink.record({
    requestId: overrides.requestId ?? `req_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? CLIENT,
    userId: overrides.userId === undefined ? 'user_test' : overrides.userId,
    method: overrides.method ?? 'GET',
    route: overrides.route ?? '/api/v1/documents',
    scopeUsed: overrides.scopeUsed === undefined ? 'documents:read' : overrides.scopeUsed,
    status: overrides.status ?? 200,
    latencyMs: overrides.latencyMs ?? 12,
    occurredAt: overrides.occurredAt ?? at(0),
  });
}

/** The app under test, with the audit route mounted and a caller identity. */
function harness(auth = fakeAuthContext()) {
  return createTestPublicApp({
    auth,
    mountResources: auditResources({ db: pool }),
  });
}

function get(query = '', auth = fakeAuthContext()) {
  const { app } = harness(auth);
  return request(app).get(`${V1_PREFIX}/audit${query}`);
}

beforeEach(async () => {
  sink = new PgAuditSink(pool);
  // The suite-wide TRUNCATE in `test/setup.ts` runs once per FILE, not per test,
  // so each test clears the table it asserts row counts over. Without this the
  // second test in the file inherits the first one's rows and every count is off
  // by however many tests ran before it.
  await pool.query('TRUNCATE TABLE public_api_calls CASCADE');
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F113 — the seven fields PRD p.4 names are all on the wire', () => {
  it('returns a row carrying timestamp, client_id, user_id, route, scope, status and latency', async () => {
    await seed({
      requestId: 'req_known',
      method: 'PATCH',
      route: '/api/v1/issues/:id',
      scopeUsed: 'issues:write',
      status: 204,
      latencyMs: 37,
    });

    const res = await get();
    expect(res.status).toBe(200);

    const [row] = res.body.data;
    expect(row).toMatchObject({
      request_id: 'req_known',
      client_id: CLIENT,
      user_id: 'user_test',
      method: 'PATCH',
      route: '/api/v1/issues/:id',
      scope_used: 'issues:write',
      status: 204,
      latency_ms: 37,
    });
    // p.4's "timestamp", as ISO 8601 rather than a Date that JSON would stringify
    // inconsistently across drivers.
    expect(row.occurred_at).toBe(at(0).toISOString());
  });

  it('the body parses against the declared schema — the spec cannot lie about it', async () => {
    await seed();
    const res = await get();

    // `.strict()` all the way down: an extra field the handler invented would
    // fail here, which is the same check L13's `responseContract` applies live.
    expect(() => pageSchema(auditCallSchema).parse(res.body)).not.toThrow();
  });

  it('a machine-to-machine row reports user_id: null rather than omitting it', async () => {
    await seed({ userId: null, scopeUsed: null });
    const res = await get();

    expect(res.body.data[0].user_id).toBeNull();
    expect(res.body.data[0].scope_used).toBeNull();
    expect('user_id' in res.body.data[0]).toBe(true);
  });

  it('orders newest first', async () => {
    await seed({ requestId: 'req_oldest', occurredAt: at(0) });
    await seed({ requestId: 'req_newest', occurredAt: at(60) });
    await seed({ requestId: 'req_middle', occurredAt: at(30) });

    const res = await get();
    expect(res.body.data.map((r: { request_id: string }) => r.request_id)).toEqual([
      'req_newest',
      'req_middle',
      'req_oldest',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F113 — cursor pagination, per PRD p.5', () => {
  it('walks every row exactly once across pages, with no repeats and no gaps', async () => {
    for (let i = 0; i < 7; i += 1) {
      await seed({ requestId: `req_${i}`, occurredAt: at(i) });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded, so a cursor that never advances fails as a test rather than
    // hanging the suite.
    for (let page = 0; page < 10; page += 1) {
      const query: string = cursor
        ? `?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '?limit=2';
      const res: request.Response = await get(query);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.map((r: { request_id: string }) => r.request_id));
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('the last page carries next_cursor: null — present, not absent (PF-224)', async () => {
    await seed();
    const res = await get('?limit=50');

    expect(res.body.next_cursor).toBeNull();
    expect('next_cursor' in res.body).toBe(true);
  });

  it('rejects a cursor minted for ANOTHER collection', async () => {
    await seed();
    // PF-218: cursors are bound to the collection that minted them. A delivery
    // cursor walking the audit table would silently return the wrong rows.
    const foreign = encodeCursor({
      id: '11111111-1111-4111-8111-111111111111',
      timestamp: at(0).toISOString(),
      resource: 'webhooks_deliveries',
    });

    const res = await get(`?cursor=${encodeURIComponent(foreign)}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
  });

  it('accepts its OWN cursor — the binding matches on the way in and out', async () => {
    // The regression this guards: `listCalls` mints cursors bound to
    // `public_api_calls` by default, while this ROUTE validates them as `audit`.
    // Page one would work and page two would 422 — invisible to any test that
    // fetches a single page.
    for (let i = 0; i < 3; i += 1) await seed({ requestId: `req_${i}`, occurredAt: at(i) });

    const first = await get('?limit=1');
    expect(first.body.next_cursor).toBeTruthy();

    const second = await get(`?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].request_id).not.toBe(first.body.data[0].request_id);
  });

  it('the minted cursor names THIS route\'s resource, not the table', async () => {
    await seed({ occurredAt: at(0) });
    await seed({ occurredAt: at(1) });

    const res = await get('?limit=1');
    const decoded = JSON.parse(
      Buffer.from(res.body.next_cursor, 'base64url').toString('utf8'),
    );
    expect(decoded.resource ?? decoded.r).toBe(AUDIT_RESOURCE);
  });

  it('rejects an out-of-range limit rather than clamping it (PF-225)', async () => {
    const res = await get('?limit=99999');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F113 — filters, and the errors they produce', () => {
  it('?status= selects exactly that status', async () => {
    await seed({ status: 200, requestId: 'req_ok' });
    await seed({ status: 429, requestId: 'req_throttled' });

    const res = await get('?status=429');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].request_id).toBe('req_throttled');
  });

  it('?route= matches the route TEMPLATE', async () => {
    await seed({ route: '/api/v1/documents', requestId: 'req_docs' });
    await seed({ route: '/api/v1/issues', requestId: 'req_issues' });

    const res = await get(`?route=${encodeURIComponent('/api/v1/issues')}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].request_id).toBe('req_issues');
  });

  it('?from and ?to bound the window', async () => {
    await seed({ occurredAt: at(0), requestId: 'req_before' });
    await seed({ occurredAt: at(600), requestId: 'req_inside' });
    await seed({ occurredAt: at(1200), requestId: 'req_after' });

    const res = await get(
      `?from=${encodeURIComponent(at(300).toISOString())}&to=${encodeURIComponent(at(900).toISOString())}`,
    );
    expect(res.body.data.map((r: { request_id: string }) => r.request_id)).toEqual(['req_inside']);
  });

  // ── the negative half ──────────────────────────────────────────────────────

  it('an unparseable ?from is a 422 naming the field, NOT an empty page', async () => {
    await seed();
    const res = await get('?from=last-tuesday');

    // An empty page would read as "you made no calls" when it actually means
    // "that is not a date" — the silent-success failure PF-226 exists to prevent.
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields.map((f: { field: string }) => f.field)).toContain('from');
  });

  it('an out-of-range ?status is a 422, not an empty page', async () => {
    const res = await get('?status=200000');
    expect(res.status).toBe(422);
    expect(res.body.details.fields.map((f: { field: string }) => f.field)).toContain('status');
  });

  it('a non-numeric ?status is a 422', async () => {
    const res = await get('?status=fine');
    expect(res.status).toBe(422);
  });

  it('an unknown parameter is REJECTED, so a typo is never silently ignored', async () => {
    const res = await get('?rout=/api/v1/issues');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
  });

  it('?offset= is rejected — this API has no offset paging', async () => {
    const res = await get('?offset=10');
    expect(res.status).toBe(422);
  });

  it('every failure carries the ApiError shape (MVP gate item 5)', async () => {
    const res = await get('?from=nonsense');
    expect(res.body).toHaveProperty('code');
    expect(res.body).toHaveProperty('message');
    expect(res.body).toHaveProperty('request_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('F113 — auth', () => {
  it('401s without a token', async () => {
    const { app } = createTestPublicApp({
      auth: null,
      mountResources: auditResources({ db: pool }),
    });

    const res = await request(app).get(`${V1_PREFIX}/audit`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('a token with NO scopes still reads its own trail — the point of `scope: null`', async () => {
    await seed();
    // A developer debugging a scope problem is exactly the caller who holds no
    // useful scopes, and their own 403s are the rows they most need to see.
    const res = await get('', fakeAuthContext([]));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
