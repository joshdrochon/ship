/**
 * L12 S4 — PF-340, PF-341, PF-342.
 *
 * No secrets in a row; a retention window that is a recorded decision with
 * arithmetic behind it; and a pruner that enforces the recorded number rather
 * than a number someone typed into a cron job.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { Router } from 'express';
import { createTestPublicApp, V1_PREFIX } from '../api/v1/testSupport.js';
import { pool } from '../../db/client.js';
import { PUBLIC_API_CALL_FIELDS, type IAuditSink } from './audit.js';
import { PgAuditSink, listCalls } from './pgAuditSink.js';
import { RAW_RETENTION_DAYS, pruneRawCalls, callsPerDay } from './retention.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ARCHITECTURE_DOC = join(HERE, '..', '..', '..', '..', 'docs', 'architecture.md');
const architecture = readFileSync(ARCHITECTURE_DOC, 'utf8');

const A_SECRET = 'cs_live_thisisaclientsecretnobodyshouldeversee';
const A_TOKEN = 'at_live_thisisanaccesstokennobodyshouldeversee';

function mountSampleResources(router: Router): void {
  router.get('/documents', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
}

const day = (offsetDays: number): Date =>
  new Date(Date.UTC(2026, 6, 1) + offsetDays * 24 * 60 * 60 * 1000);

async function insert(sink: PgAuditSink, at: Date, clientId: string, status = 200): Promise<void> {
  await sink.record({
    occurredAt: at,
    clientId,
    userId: null,
    method: 'GET',
    route: '/api/v1/documents',
    scopeUsed: 'documents:read',
    status,
    latencyMs: 5,
    requestId: crypto.randomUUID(),
  });
}

/**
 * `PgAuditSink.record` is fire-and-forget by design (PF-328), so a test that
 * asserts on the persisted row has to wait for the write rather than for the
 * response. This wraps the real sink and hands back a promise that settles when
 * it has actually inserted — no polling, no sleep, and it fails by timing out
 * rather than by passing on a lucky delay.
 */
function awaitableSink(): { sink: IAuditSink; written: Promise<void> } {
  const inner = new PgAuditSink(pool);
  let done!: () => void;
  const written = new Promise<void>((resolve) => {
    done = resolve;
  });
  return {
    sink: {
      async record(entry) {
        await inner.record(entry);
        done();
      },
    },
    written,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-340 — no secrets, no bodies, no headers
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-340 — nothing sensitive reaches a row', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE public_api_calls');
  });

  it('a request carrying a bearer token and a client_secret leaks neither', async () => {
    const { sink, written } = awaitableSink();
    const { app } = createTestPublicApp({
      auditSink: sink,
      mountResources: mountSampleResources,
    });

    await request(app)
      .get(`${V1_PREFIX}/documents?client_secret=${A_SECRET}&other=1`)
      .set('Authorization', `Bearer ${A_TOKEN}`)
      .set('X-Custom-Header', 'a header value')
      .expect(200);
    await written;

    // Serialise the WHOLE row and search it, rather than checking the fields we
    // remembered to check. Pre-Search 1.4 (p.15) treats a log line as a leakage
    // path, and the way a secret gets into one is a field nobody thought about.
    const { rows } = await pool.query('SELECT * FROM public_api_calls');
    expect(rows).toHaveLength(1);
    const serialised = JSON.stringify(rows[0]);

    expect(serialised).not.toContain(A_SECRET);
    expect(serialised).not.toContain(A_TOKEN);
    expect(serialised).not.toContain('a header value');
    expect(serialised).not.toContain('Bearer');
    expect(serialised).not.toContain('client_secret');
  });

  it('the query string does not survive into `route` at all', async () => {
    const { sink, written } = awaitableSink();
    const { app } = createTestPublicApp({
      auditSink: sink,
      mountResources: mountSampleResources,
    });

    await request(app).get(`${V1_PREFIX}/documents?client_secret=${A_SECRET}`).expect(200);
    await written;

    const page = await listCalls(pool, { limit: 10 });
    // `route` is the TEMPLATE, so a query string cannot ride along even in
    // principle — which is a stronger guarantee than stripping one.
    expect(page.data[0]!.route).toBe(`${V1_PREFIX}/documents`);
    expect(page.data[0]!.route).not.toContain('?');
  });

  it('the record type has no field a body, header or secret could land in', () => {
    // The structural half. Redaction is a thing you can forget to apply; a field
    // that does not exist is a thing you cannot forget.
    const shapes = ['body', 'header', 'secret', 'token', 'password', 'authorization', 'query'];
    for (const field of PUBLIC_API_CALL_FIELDS) {
      for (const shape of shapes) {
        expect(
          field.toLowerCase().includes(shape),
          `${field} looks like it could carry ${shape} material`,
        ).toBe(false);
      }
    }
  });

  it('the persisted table has no such column either', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'public_api_calls'`,
    );
    const names = rows.map((r) => r.column_name);
    for (const forbidden of ['body', 'headers', 'authorization', 'client_secret', 'token']) {
      expect(names, `public_api_calls.${forbidden} must not exist`).not.toContain(forbidden);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-341 — the retention decision, recorded and enforced
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-341 / D10 — the retention window is recorded, with rejected options', () => {
  it('docs/architecture.md states BOTH windows and why each is set there', () => {
    // p.10 asks for both windows and the reason for each; a number with no
    // rationale is a number the next person changes without knowing what breaks.
    expect(architecture).toMatch(/30 days of raw rows/i);
    expect(architecture).toMatch(/indefinitely/i);
    expect(architecture).toMatch(/Epic 7/);
    // The rejected options, named.
    expect(architecture).toMatch(/7 days raw only/i);
    expect(architecture).toMatch(/Indefinite raw/i);
  });

  it('the shipped constant equals the documented number', () => {
    // The doc and the pruner disagreeing is the failure this catches: prose that
    // says 30 while a job deletes at 7 is worse than no policy, because someone
    // will plan against the prose.
    expect(RAW_RETENTION_DAYS).toBe(30);
    expect(architecture).toContain('30 days of raw rows');
  });

  it('what is LOST at the boundary is stated, not glossed', () => {
    expect(architecture).toMatch(/per-route or per-request detail/i);
  });
});

describe('PF-341 — pruning is against the recorded number, and rolls up first', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE public_api_calls');
    await pool.query('TRUNCATE TABLE public_api_call_daily');
  });

  it('rows inside the window survive; rows outside it are rolled up and deleted', async () => {
    const sink = new PgAuditSink(pool);
    const now = day(100);

    // Two days well outside the window, one day inside it.
    await insert(sink, day(10), 'app_a');
    await insert(sink, day(10), 'app_a', 429);
    await insert(sink, day(11), 'app_a', 500);
    await insert(sink, day(99), 'app_a'); // one day old — inside

    const result = await pruneRawCalls(pool, now);

    expect(result.rowsPruned).toBe(3);
    expect(result.daysRolledUp).toBe(2);

    const remaining = await listCalls(pool, { limit: 100 });
    expect(remaining.data).toHaveLength(1);

    const { rows } = await pool.query<{
      day: string;
      calls: string;
      throttled: string;
      server_errors: string;
    }>('SELECT day::text, calls::text, throttled::text, server_errors::text FROM public_api_call_daily ORDER BY day');

    expect(rows).toHaveLength(2);
    expect(rows[0]!.calls).toBe('2');
    // Split out at rollup time rather than derived later, because the rows they
    // would be derived from are the rows being deleted.
    expect(rows[0]!.throttled).toBe('1');
    expect(rows[1]!.server_errors).toBe('1');
  });

  it('a re-run corrects the counts rather than keeping the first, smaller answer', async () => {
    const sink = new PgAuditSink(pool);
    const now = day(100);

    await insert(sink, day(10), 'app_a');
    await pruneRawCalls(pool, now);

    // A row for the same day arrives late — a request that was in flight when
    // the job ran, or a backfill.
    await insert(sink, day(10), 'app_a');
    await pruneRawCalls(pool, now);

    const { rows } = await pool.query<{ calls: string }>(
      'SELECT calls::text FROM public_api_call_daily',
    );
    // `ON CONFLICT DO NOTHING` would leave this at 1 and the rollup would
    // permanently under-report the day.
    expect(rows[0]!.calls).toBe('2');
  });

  it('the anonymous bucket rolls up as its own row rather than being dropped', async () => {
    const sink = new PgAuditSink(pool);
    await sink.record({
      occurredAt: day(10),
      clientId: null,
      userId: null,
      method: 'GET',
      route: '/api/v1/documents',
      scopeUsed: null,
      status: 401,
      latencyMs: 0.5,
      requestId: crypto.randomUUID(),
    });

    await pruneRawCalls(pool, day(100));

    const { rows } = await pool.query<{ client_id: string | null; calls: string }>(
      'SELECT client_id, calls::text FROM public_api_call_daily',
    );
    // "How many anonymous calls hit the public API" is a real operational
    // question and the denominator for the 401 rate. A GROUP BY that dropped
    // NULLs would silently delete it.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.client_id).toBeNull();
    expect(rows[0]!.calls).toBe('1');
  });

  it('Epic 7 stays provable after the raw rows are gone', async () => {
    const sink = new PgAuditSink(pool);
    for (let i = 0; i < 5; i++) await insert(sink, day(10), 'agent_app');
    await insert(sink, day(99), 'agent_app'); // today, still raw

    await pruneRawCalls(pool, day(100));

    const perDay = await callsPerDay(pool, 'agent_app');
    // This is the whole reason the rollup exists. The raw rows for day 10 are
    // deleted and the claim "the agent went through the front door on that day,
    // five times" survives.
    const total = perDay.reduce((sum, d) => sum + d.calls, 0);
    expect(total).toBe(6);
    expect(perDay.length).toBe(2);
  });

  it('callsPerDay reads BOTH tables — a rollup-only query would report zero for today', async () => {
    const sink = new PgAuditSink(pool);
    await insert(sink, day(99), 'app_today');

    // Nothing pruned: everything is inside the window and lives only in raw.
    const perDay = await callsPerDay(pool, 'app_today');
    expect(perDay).toHaveLength(1);
    expect(perDay[0]!.calls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-342 — the arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-342 — the retention number has a denominator', () => {
  it('docs/architecture.md records MEASURED bytes per row, not an estimate', () => {
    expect(architecture).toMatch(/bytes\/row/i);
    expect(architecture).toMatch(/356/);
    // The heap/index split matters: the indexes cost more than the data here,
    // and an arithmetic that used the heap alone would understate by 60%.
    expect(architecture).toMatch(/141/);
    expect(architecture).toMatch(/214/);
    expect(architecture).toMatch(/measured, not estimated/i);
  });

  it('it records storage per retention window at p.9s tiers', () => {
    expect(architecture).toMatch(/100 000 users/);
    expect(architecture).toMatch(/20 000 000/);
    expect(architecture).toMatch(/214 GB/);
  });

  it('the documented per-row figure is still true of the shipped table', async () => {
    // The number in the doc was measured on this schema. If a later migration
    // adds a column or an index, the doc silently becomes wrong — so the shape
    // it was measured against is pinned here.
    const { rows: cols } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_name = 'public_api_calls'`,
    );
    const { rows: idx } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_indexes WHERE tablename = 'public_api_calls'`,
    );
    // 10 columns (9 record fields + the surrogate id), 4 indexes (the primary
    // key plus the three declared in migration 057).
    expect(cols[0]!.count).toBe('10');
    expect(idx[0]!.count).toBe('4');
  });
});
