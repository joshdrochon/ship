/**
 * PF-256 – PF-259 — Cursor Pagination (PRD p.3) on a real endpoint.
 *
 * *"Opaque base64 cursors over { id, timestamp }. List responses always return
 * { data, next_cursor }. Cursors are stable across reordering operations."*
 *
 * This is the first route where L08's envelope meets real rows, so Testing
 * Scenario 4 clause (d) finally has a subject. Everything here goes over HTTP
 * and nothing imports `decodeCursor` — a walk that decodes the cursor is testing
 * the codec, not the contract, and the contract is that the cursor is opaque.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountDocuments } from './routes.js';
import { assertLastPageShape, pageSchema } from '../page.js';
import { documentSchema } from './documents.schema.js';
import { KEYSET_ORDER_BY } from '../pagination.js';

const SEEDED = 50;

describe('/api/v1/documents — cursor pagination', () => {
  let harness: BearerTestApp;
  let workspaceId: string;
  let userId: string;
  let seededIds: string[] = [];

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 pagination ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Pagination User') RETURNING id`,
      [`l09-pagination-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    // 50 rows with DISTINCT timestamps one second apart. Distinct on purpose:
    // ties are exercised separately below, and a fixture where every row shares
    // a timestamp would make the id tiebreak carry the whole walk and hide a
    // broken timestamp comparison.
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, created_at)
       SELECT $1, 'wiki', 'Doc ' || g, $2, now() - (g || ' seconds')::interval
       FROM generate_series(1, $3) g
       RETURNING id`,
      [workspaceId, userId, SEEDED],
    );
    seededIds = inserted.rows.map((r) => r.id);

    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountDocuments(router, { db: pool, service: createDocumentService() }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  async function read() {
    return `Bearer ${(await harness.mint(['documents:read'])).access_token}`;
  }

  /** Walks every page at `limit`, over HTTP, without decoding a cursor. */
  async function walkAllPages(limit: number, token: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    for (;;) {
      const url: string = cursor
        ? `/api/v1/documents?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
        : `/api/v1/documents?limit=${limit}`;
      const res = await request(harness.app).get(url).set('Authorization', token);
      expect(res.status, `page ${pages + 1} of the walk`).toBe(200);

      ids.push(...res.body.data.map((d: { id: string }) => d.id));
      cursor = res.body.next_cursor;
      pages += 1;

      if (cursor === null) break;
      // A walk that cannot terminate is a hang, and a hang in CI reads as an
      // infrastructure problem rather than as this bug.
      expect(pages, 'the page walk did not terminate').toBeLessThan(SEEDED + 5);
    }

    return ids;
  }

  // ── PF-257 · the envelope, on real rows ───────────────────────────────────

  describe('PF-257 · { data, next_cursor } and nothing else', () => {
    it('the body parses against pageSchema(documentSchema), which is .strict()', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents?limit=10')
        .set('Authorization', await read());

      const parsed = pageSchema(documentSchema).safeParse(res.body);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
      // No `total`, no `page`, no `has_more`, no `meta` — each of those would be
      // a second, undocumented pagination protocol that a consumer would start
      // depending on.
      expect(Object.keys(res.body).sort()).toEqual(['data', 'next_cursor']);
    });

    it('`next_cursor` is PRESENT and null on the last page, never absent', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', await read());

      // `body.next_cursor == null` is true for both an explicit null and a
      // missing key, which is exactly why it is the wrong check. To a typed SDK
      // consumer the two differ: `undefined` in TS, `KeyError` in Python, a
      // nil-pointer in Go.
      expect(() => assertLastPageShape(res.body)).not.toThrow();
      expect(res.body.next_cursor).toBeNull();
      expect('next_cursor' in res.body).toBe(true);
    });

    it('`data` is [] and never null for a workspace with no documents', async () => {
      const empty = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
        `L09 empty ${Date.now().toString(36)}`,
      ]);
      const emptyHarness = await createBearerTestApp({
        workspaceId: empty.rows[0].id,
        userId,
        mountResources: (router) =>
          mountDocuments(router, { db: pool, service: createDocumentService() }),
      });

      const res = await request(emptyHarness.app)
        .get('/api/v1/documents')
        .set('Authorization', `Bearer ${(await emptyHarness.mint(['documents:read'])).access_token}`);

      expect(res.status).toBe(200);
      // A consumer writing `for (const x of body.data)` must never need a guard.
      expect(res.body.data).toEqual([]);
      expect(res.body.next_cursor).toBeNull();

      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [empty.rows[0].id]);
    });

    it('walking every page at ?limit=10 yields exactly the 50 ids, no dupe, no omission', async () => {
      const ids = await walkAllPages(10, await read());

      expect(ids).toHaveLength(SEEDED);
      expect(new Set(ids).size, 'a duplicated id means the predicate re-included a row').toBe(SEEDED);
      expect([...ids].sort()).toEqual([...seededIds].sort());
    });

    it('the walk is gapless at every page size, including ones that divide unevenly', async () => {
      // 7 and 13 do not divide 50. The boundary case that matters is "exactly
      // `limit` rows remain": it must return `next_cursor: null` in ONE request
      // rather than producing a phantom empty final page.
      const token = await read();
      for (const limit of [1, 7, 13, 25, 50]) {
        const ids = await walkAllPages(limit, token);
        expect(new Set(ids).size, `limit=${limit}`).toBe(SEEDED);
      }
    });

    it('the sort is newest-first, by (created_at DESC, id DESC)', async () => {
      const ids = await walkAllPages(10, await read());
      const rows = await pool.query<{ id: string }>(
        `SELECT id FROM documents WHERE workspace_id = $1 ${KEYSET_ORDER_BY}`,
        [workspaceId],
      );
      expect(ids).toEqual(rows.rows.map((r) => r.id));
    });
  });

  // ── PF-258 · stability across a real reorder ──────────────────────────────

  describe('PF-258 · cursors survive a drag-reorder', () => {
    it('mutating `position` across the page boundary shifts nothing', async () => {
      // p.3, literally: "Cursors are stable across reordering operations."
      // PF-220 asserts this at the query-builder level; this asserts it end to
      // end through the two surfaces that actually collide. The internal PATCH
      // accepts `position`, and drag-reorder rewrites it — which is precisely
      // why the public sort is on `(created_at, id)` and not on `position`.
      const token = await read();

      const first = await request(harness.app)
        .get('/api/v1/documents?limit=10')
        .set('Authorization', token);
      expect(first.status).toBe(200);
      const pageOne: string[] = first.body.data.map((d: { id: string }) => d.id);
      const cursor: string = first.body.next_cursor;
      expect(cursor).toBeTruthy();

      // Three rows spanning the page-1/page-2 boundary get new positions,
      // written directly because the reorder is what the internal PATCH does.
      const spanning = [pageOne[8]!, pageOne[9]!, seededIds[10]!];
      await pool.query(
        `UPDATE documents SET position = 999 WHERE id = ANY($1::uuid[])`,
        [spanning],
      );
      // And the reverse: everything else moved to the front of the internal sort.
      await pool.query(`UPDATE documents SET position = 1 WHERE workspace_id = $1 AND position <> 999`, [
        workspaceId,
      ]);

      const second = await request(harness.app)
        .get(`/api/v1/documents?limit=10&cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', token);
      expect(second.status).toBe(200);
      const pageTwo: string[] = second.body.data.map((d: { id: string }) => d.id);

      const overlap = pageTwo.filter((id) => pageOne.includes(id));
      expect(overlap, 'an id appeared on two pages after a reorder').toEqual([]);

      // And nothing was skipped: continue the walk and confirm all 50 are seen.
      const seen = new Set([...pageOne, ...pageTwo]);
      let next: string | null = second.body.next_cursor;
      while (next) {
        const res = await request(harness.app)
          .get(`/api/v1/documents?limit=10&cursor=${encodeURIComponent(next)}`)
          .set('Authorization', token);
        for (const d of res.body.data) seen.add(d.id);
        next = res.body.next_cursor;
      }
      expect(seen.size, 'a row was skipped across the reorder').toBe(SEEDED);
    });

    it('rows separated by MICROseconds are not skipped — the cursor keeps full precision', async () => {
      // The bug this test exists for, found by the tie case below.
      //
      // `timestamptz` stores microseconds; a JS `Date` holds milliseconds. Mint
      // the cursor with `row.created_at.toISOString()` and `…00.123456Z` becomes
      // `…00.123Z`, so the bound `(created_at, id) < ('…00.123Z', id)` excludes
      // every row between `.123000` and `.123456` — rows strictly older than the
      // cursor's own row, which the caller should have received next. Skipped
      // silently, on every page boundary.
      //
      // Rows one second apart never expose it. These are 100 microseconds apart.
      const micro = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
        `L09 micro ${Date.now().toString(36)}`,
      ]);
      const microWs = micro.rows[0].id;
      await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_at)
         SELECT $1, 'wiki', 'Micro ' || g, timestamptz '2026-01-01 00:00:00Z' + (g * interval '100 microseconds')
         FROM generate_series(1, 20) g`,
        [microWs],
      );

      const microHarness = await createBearerTestApp({
        workspaceId: microWs,
        userId,
        mountResources: (router) =>
          mountDocuments(router, { db: pool, service: createDocumentService() }),
      });
      const token = `Bearer ${(await microHarness.mint(['documents:read'])).access_token}`;

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 30; page++) {
        const url: string = cursor
          ? `/api/v1/documents?limit=3&cursor=${encodeURIComponent(cursor)}`
          : '/api/v1/documents?limit=3';
        const res = await request(microHarness.app).get(url).set('Authorization', token);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.map((d: { id: string }) => d.id));
        cursor = res.body.next_cursor;
        if (cursor === null) break;
      }

      expect(
        new Set(seen).size,
        'Rows microseconds apart were skipped. The cursor timestamp lost precision — ' +
          'it must be rendered by Postgres (CURSOR_TIMESTAMP_EXPR), not by Date#toISOString.',
      ).toBe(20);

      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [microWs]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [microWs]);
    });

    it('rows sharing a created_at are still totally ordered by the id tiebreak', async () => {
      // The tie case the row comparison exists for. With `created_at` alone,
      // ties make the resume point ambiguous and rows are skipped or repeated.
      await pool.query(
        `UPDATE documents SET created_at = now() WHERE workspace_id = $1`,
        [workspaceId],
      );

      const ids = await walkAllPages(7, await read());
      expect(new Set(ids).size).toBe(SEEDED);
      expect([...ids].sort()).toEqual([...seededIds].sort());
    });
  });

  // ── PF-259 · the index covers the real predicate ──────────────────────────

  describe('PF-259 · the plan, on the query this route actually issues', () => {
    it('no Seq Scan and no Sort for the FULL public predicate', async () => {
      // `assertKeysetIndexed` (PF-222) explains a simplified page query. This
      // explains the real one — workspace, type set, archived, deleted,
      // visibility and the keyset predicate together — because a simplified
      // stand-in can ride an index the real query does not.
      const client = await pool.connect();
      let plan: string;
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_bitmapscan = off');
        const explained = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN
           SELECT id, created_at FROM documents
            WHERE workspace_id = $1
              AND archived_at IS NULL
              AND deleted_at IS NULL
              AND (visibility = 'workspace' OR created_by = $2
                   OR (SELECT wm.role FROM workspace_memberships wm
                        WHERE wm.workspace_id = $1 AND wm.user_id = $2) = 'admin')
              AND document_type = ANY($3::document_type[])
              AND (created_at, id) < ($4::timestamptz, $5::uuid)
            ${KEYSET_ORDER_BY}
            LIMIT 26`,
          [
            workspaceId,
            userId,
            ['wiki', 'weekly_plan', 'weekly_retro', 'standup', 'weekly_review'],
            new Date().toISOString(),
            '00000000-0000-4000-8000-000000000000',
          ],
        );
        plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }

      expect(
        /Seq Scan on documents/i.test(plan),
        `The live page query plans a Seq Scan on documents:\n${plan}\n\n` +
          `Fix: CREATE INDEX idx_documents_workspace_keyset ON documents ` +
          `(workspace_id, created_at DESC, id DESC); — see migration 060.`,
      ).toBe(false);

      expect(
        /\bSort\b/i.test(plan),
        `The live page query plans a Sort node, so an index exists but its column ` +
          `order or direction does not match "${KEYSET_ORDER_BY}":\n${plan}`,
      ).toBe(false);
    });

    it('the workspace-leading index exists and is the one that covers it', async () => {
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'documents'`,
      );
      expect(indexes.rows.map((r) => r.indexname)).toContain('idx_documents_workspace_keyset');
    });
  });
});
