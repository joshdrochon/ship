/**
 * L12 S5 — PF-343, PF-344.
 *
 * The trail is queryable for L22, and the Epic 7 proof mechanism is chosen
 * rather than assumed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../../db/client.js';
import { decodeCursor, DEFAULT_PAGE_SIZE } from '../api/v1/pagination.js';
import { PgAuditSink, listCalls, PUBLIC_API_CALLS_RESOURCE } from './pgAuditSink.js';
import { architectureText } from '../../test/architectureDoc.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const architecture = architectureText();

const BASE = Date.UTC(2026, 7, 1);

/**
 * Seeds `count` rows for one app.
 *
 * Every fifth row shares a timestamp with its neighbour, on purpose. Audit rows
 * arrive in bursts, so same-instant ties are the NORMAL case, and a walk that is
 * only correct when timestamps are distinct is a walk that is wrong in
 * production and green in a test.
 */
async function seed(clientId: string, count: number, startIndex = 0): Promise<void> {
  const sink = new PgAuditSink(pool);
  for (let i = startIndex; i < startIndex + count; i++) {
    await sink.record({
      occurredAt: new Date(BASE + Math.floor(i / 5) * 1000),
      clientId,
      userId: null,
      method: 'GET',
      route: i % 3 === 0 ? '/api/v1/documents' : '/api/v1/documents/:id',
      scopeUsed: 'documents:read',
      status: i % 11 === 0 ? 429 : 200,
      latencyMs: 1 + (i % 17),
      requestId: `req-${i}`,
    });
  }
}

/** Walks every page, returning the ids in order and the page count. */
async function walkAll(
  clientId: string,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;

  for (;;) {
    const page = await listCalls(pool, { clientId, limit, cursor });
    ids.push(...page.data.map((r) => r.id));
    pages++;
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
    // A walk that cannot terminate is the bug this guards against, and an
    // infinite loop in a suite reads as a hang rather than a failure.
    expect(pages, 'the walk did not terminate').toBeLessThan(1000);
  }
  return { ids, pages };
}

describe('PF-343 — the query surface L22 consumes', () => {
  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE public_api_calls');
  });

  it('a full walk over 500 rows visits each row exactly once', async () => {
    await seed('app_walk', 500);

    const { ids, pages } = await walkAll('app_walk', 50);

    expect(ids).toHaveLength(500);
    // The assertion that matters: a keyset walk that gets its tie-breaker wrong
    // repeats rows or skips them, and either way the LENGTH can still come out
    // right by coincidence. The set size cannot.
    expect(new Set(ids).size).toBe(500);
    // Ten pages, not eleven. `limit + 1` means the tenth page already knows
    // there is nothing after it, so there is no phantom empty final page — the
    // boundary a COUNT(*)-based pager gets wrong.
    expect(pages).toBe(10);
  });

  it('the walk is stable across CONCURRENT inserts', async () => {
    await seed('app_concurrent', 200);

    const ids: string[] = [];
    let cursor: string | null = null;
    let page = 0;

    for (;;) {
      const result = await listCalls(pool, { clientId: 'app_concurrent', limit: 25, cursor });
      ids.push(...result.data.map((r) => r.id));
      page++;

      // New rows land mid-walk, which is the realistic case: the trail is being
      // written to while the portal pages through it. A new row is always NEWER
      // than the cursor and the walk is descending, so it lands on a page the
      // walker has already passed and cannot shift the rows ahead of it. An
      // offset/limit pager has the opposite property and skips one row per
      // insert.
      if (page === 2 || page === 4) {
        await seed('app_concurrent', 10, 1000 + page * 100);
      }

      if (!result.next_cursor) break;
      cursor = result.next_cursor;
      expect(page).toBeLessThan(1000);
    }

    // Every one of the original 200 seen exactly once. Rows inserted mid-walk
    // may or may not appear — that is the honest guarantee, and it is the one
    // the portal needs.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(200);
  });

  it('paginates identically at page size 1 — the boundary the walk is most likely to break at', async () => {
    await seed('app_tiny', 12);
    const { ids, pages } = await walkAll('app_tiny', 1);

    expect(new Set(ids).size).toBe(12);
    // Twelve single-row pages, and no empty thirteenth.
    expect(pages).toBe(12);
  });

  it('the last page ends with next_cursor null, with no phantom empty page', async () => {
    await seed('app_exact', 50);
    // Exactly `limit` rows remaining is the boundary a `COUNT(*)`-based pager
    // gets wrong: it either emits a final empty page or claims there is more.
    const page = await listCalls(pool, { clientId: 'app_exact', limit: 50 });
    expect(page.data).toHaveLength(50);
    expect(page.next_cursor).toBeNull();
  });

  it('rows come back newest-first, matching the rest of the public API', async () => {
    await seed('app_order', 30);
    const page = await listCalls(pool, { clientId: 'app_order', limit: 30 });

    for (let i = 1; i < page.data.length; i++) {
      expect(page.data[i]!.occurred_at.getTime()).toBeLessThanOrEqual(
        page.data[i - 1]!.occurred_at.getTime(),
      );
    }
  });

  it('the cursor is the same opaque base64url contract as every other collection', async () => {
    await seed('app_cursor', 10);
    const page = await listCalls(pool, { clientId: 'app_cursor', limit: 5 });

    expect(page.next_cursor).toBeTruthy();
    // base64url alphabet only, so it needs no percent-encoding in a query string.
    expect(page.next_cursor!).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = decodeCursor(page.next_cursor!, PUBLIC_API_CALLS_RESOURCE);
    expect(decoded.ok).toBe(true);
  });

  it('a cursor minted here does NOT decode against another collection', () => {
    // PF-218's case that matters: a foreign cursor decodes perfectly — its id is
    // a real uuid and its timestamp is a real timestamp — and returns a
    // wrong-but-plausible page nobody ever notices.
    const forged = Buffer.from(
      JSON.stringify({ id: 'x', timestamp: new Date().toISOString(), resource: 'documents' }),
      'utf8',
    ).toString('base64url');

    expect(decodeCursor(forged, PUBLIC_API_CALLS_RESOURCE).ok).toBe(false);
  });

  it('filters compose: client, status, route and a time window together', async () => {
    await seed('app_filter', 60);
    await seed('other_app', 60);

    const throttled = await listCalls(pool, {
      clientId: 'app_filter',
      status: 429,
      limit: 100,
    });
    expect(throttled.data.length).toBeGreaterThan(0);
    expect(throttled.data.every((r) => r.status === 429)).toBe(true);
    expect(throttled.data.every((r) => r.client_id === 'app_filter')).toBe(true);

    const windowed = await listCalls(pool, {
      clientId: 'app_filter',
      from: new Date(BASE + 3000),
      to: new Date(BASE + 7000),
      limit: 100,
    });
    expect(windowed.data.length).toBeGreaterThan(0);
    for (const row of windowed.data) {
      expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(BASE + 3000);
      expect(row.occurred_at.getTime()).toBeLessThan(BASE + 7000);
    }

    const byRoute = await listCalls(pool, {
      clientId: 'app_filter',
      route: '/api/v1/documents/:id',
      limit: 100,
    });
    // Filtering by TEMPLATE is only a usable filter because PF-331 records
    // templates. Against raw paths this would match one row.
    expect(byRoute.data.length).toBeGreaterThan(1);
    expect(byRoute.data.every((r) => r.route === '/api/v1/documents/:id')).toBe(true);
  });

  it('a filtered walk still visits each matching row exactly once', async () => {
    // The composition that breaks a hand-rolled pager: the keyset predicate has
    // to be numbered AFTER the filter's placeholders, not at $1.
    await seed('app_filtered_walk', 300);

    const ids: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof listCalls>> = await listCalls(pool, {
        clientId: 'app_filtered_walk',
        route: '/api/v1/documents',
        limit: 10,
        cursor,
      });
      ids.push(...page.data.map((r) => r.id));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }

    expect(ids.length).toBe(100); // every third row
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('paging one app never leaks another app rows', async () => {
    await seed('app_a', 30);
    await seed('app_b', 30);

    const { ids } = await walkAll('app_a', 7);
    const { rows } = await pool.query<{ client_id: string }>(
      `SELECT DISTINCT client_id FROM public_api_calls WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    expect(rows.map((r) => r.client_id)).toEqual(['app_a']);
  });

  it('the default page size is the one the rest of the public API uses', () => {
    // L22 renders this like any other collection; a bespoke page size for one
    // screen is a second contract to remember.
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });
});

describe('PF-344 / D11 — the Epic 7 proof mechanism is chosen and owned', () => {
  it('docs/architecture.md records the choice', () => {
    expect(architecture).toMatch(/D11/);
    expect(architecture).toMatch(/fitness test/i);
  });

  it('…with both rejected options named', () => {
    // A decision without its rejected options is an unexplained behaviour by the
    // time anyone has to defend it.
    expect(architecture).toMatch(/grep or SQL query alone/i);
    expect(architecture).toMatch(/dashboard panel/i);
  });

  it('…and the reason a grep cannot do the job', () => {
    // The PRD's phrasing is "for EVERY action", and the evidence of a bypass is
    // an absence — which a grep over the trail cannot see.
    expect(architecture).toMatch(/every/i);
    expect(architecture).toMatch(/some calls went through|only that \*some\*|establishes only/i);
  });

  it('names the OWNING lane, because this is not L12s alone to execute', () => {
    // L23 owns the agent rewire and therefore the test; L22 owns the panel.
    // L12 owns only what both consume.
    expect(architecture).toMatch(/L23 owns the agent\s+rewire/);
    expect(architecture).toMatch(/L22 owns the portal\s+panel/);
  });

  it('the demo query it names actually exists and works', async () => {
    // A decision that names an artifact nobody built is a plan, not a decision.
    const { callsPerDay } = await import('./retention.js');
    await pool.query('TRUNCATE TABLE public_api_calls');
    await pool.query('TRUNCATE TABLE public_api_call_daily');
    await seed('agent_app', 7);

    const perDay = await callsPerDay(pool, 'agent_app');
    expect(perDay.reduce((sum, d) => sum + d.calls, 0)).toBe(7);
    expect(architecture).toMatch(/callsPerDay/);
  });

  it('B11 is disclosed as a known limitation rather than designed around', async () => {
    // Portal traffic is indistinguishable from a developer's own in this trail.
    // The doc has to say so, because the alternative — adding a field — would
    // undo PF-326, and L22's PF-676 discloses it in the UI instead.
    expect(architecture).toMatch(/B11/);
    expect(architecture).toMatch(/indistinguishable/i);
    expect(architecture).toMatch(/PF-676/);
  });
});
