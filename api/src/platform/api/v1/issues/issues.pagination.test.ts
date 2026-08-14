/**
 * PF-281 — the public issues list orders by `(created_at, id)`, and that
 * ordering survives the write the internal ordering could not.
 *
 * ## The claim being tested, stated exactly
 *
 * The internal list is
 *
 *     ORDER BY CASE d.properties->>'priority' … END, d.updated_at DESC
 *
 * (`api/src/routes/issues.ts`). BOTH keys are mutable: `priority` is a field any
 * user can edit from the board, and `updated_at` is rewritten by *every* PATCH,
 * not merely a reorder. A keyset cursor over that ordering does not just return
 * rows out of order — it SKIPS rows and REPEATS rows, because the position a
 * cursor names has moved by the time the next page is requested.
 *
 * That is worse than `documents.position`, which finding F3 already rejected:
 * `position` changes only on a deliberate drag-reorder, while `updated_at`
 * changes on every write in the system.
 *
 * PRD p.3 requires cursors *"stable across reordering operations"*. So the
 * public list sorts on `(created_at, id)`, which nothing rewrites, and the test
 * below is the proof: it PATCHes rows spanning a page boundary in the middle of
 * a walk and asserts the walk is still gapless and duplicate-free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createIssueService } from '../../../../services/issues.js';
import { mountIssues } from './routes.js';
import { KEYSET_ORDER_BY } from '../pagination.js';

const TOTAL = 30;
const PAGE = 10;

describe('/api/v1/issues — keyset pagination', () => {
  let harness: BearerTestApp;
  let workspaceId: string;
  let userId: string;
  let seededIds: string[] = [];

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L10 issue paging ${runId}`,
    ]);
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Paging User') RETURNING id`,
      [`l10-paging-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    // 30 issues with DISTINCT created_at values one second apart, plus — this is
    // the part that matters — a tie block. Rows 10..13 share one `created_at` to
    // the microsecond, which is the case that catches a cursor minted from a
    // JavaScript `Date`: node-postgres truncates `…:00.123456Z` to `…:00.123Z`,
    // and the resulting bound excludes rows strictly older than the cursor's own
    // row. With rows a second apart it never fires.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, ticket_number,
                              properties, created_at)
       SELECT $1, 'issue', 'Issue ' || g, $2, g,
              jsonb_build_object('state','backlog','priority','medium','source','internal'),
              CASE WHEN g BETWEEN 10 AND 13
                   THEN now() - interval '20 seconds'
                   ELSE now() - (g || ' seconds')::interval
              END
       FROM generate_series(1, ${TOTAL}) g
       RETURNING id`,
      [workspaceId, userId],
    );
    seededIds = seeded.rows.map((r) => r.id);

    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountIssues(router, { db: pool, service: createIssueService() }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM document_history WHERE document_id = ANY($1::uuid[])`, [seededIds]);
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  const token = async () => `Bearer ${(await harness.mint(['issues:read'])).access_token}`;
  const writeToken = async () => `Bearer ${(await harness.mint(['issues:write'])).access_token}`;

  async function page(auth: string, cursor: string | null) {
    const url = cursor
      ? `/api/v1/issues?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`
      : `/api/v1/issues?limit=${PAGE}`;
    const res = await request(harness.app).get(url).set('Authorization', auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { data: { id: string }[]; next_cursor: string | null };
  }

  it('a full walk visits every issue exactly once', async () => {
    const auth = await token();
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let i = 0; i < 10; i++) {
      const body = await page(auth, cursor);
      seen.push(...body.data.map((d) => d.id));
      cursor = body.next_cursor;
      if (cursor === null) break;
    }

    expect(cursor, 'the walk did not terminate').toBeNull();
    expect(new Set(seen).size, 'the walk repeated an id').toBe(seen.length);
    expect(seen.length, 'the walk lost rows').toBe(TOTAL);
    expect([...seen].sort()).toEqual([...seededIds].sort());
  });

  it('the last page carries next_cursor: null — present, not absent', async () => {
    // `{data}` and `{data, next_cursor: null}` are different to every typed SDK
    // consumer: the first deserialises to `undefined` in TS, `KeyError` in
    // Python and a nil pointer in Go.
    const auth = await token();
    const body = await page(auth, null);
    let cursor = body.next_cursor;
    let last = body;
    while (cursor) {
      last = await page(auth, cursor);
      cursor = last.next_cursor;
    }
    expect(Object.prototype.hasOwnProperty.call(last, 'next_cursor')).toBe(true);
    expect(last.next_cursor).toBeNull();
  });

  // ── PF-281's headline case ────────────────────────────────────────────────

  it('PATCHing priority and state mid-walk loses no rows and repeats none', async () => {
    const read = await token();
    const write = await writeToken();

    // Page 1.
    const first = await page(read, null);
    expect(first.data).toHaveLength(PAGE);
    expect(first.next_cursor).not.toBeNull();

    // Now mutate BOTH internal sort keys on three rows that span the page-1/
    // page-2 boundary — two from the page just read, one from the page about to
    // be read. Under the internal ordering these three would jump to the front
    // (`priority: 'urgent'` sorts first, and the PATCH rewrites `updated_at`),
    // so a cursor over that ordering would re-serve the two already seen and
    // skip whatever fell into their vacated slots.
    const straddling = [
      first.data[PAGE - 2]!.id,
      first.data[PAGE - 1]!.id,
      seededIds.find((id) => !first.data.some((d) => d.id === id))!,
    ];

    for (const id of straddling) {
      const res = await request(harness.app)
        .patch(`/api/v1/issues/${id}`)
        .set('Authorization', write)
        .send({ priority: 'urgent', state: 'in_progress' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    // `updated_at` really moved — otherwise this test would pass for the wrong
    // reason, and the whole point is that it moved and the walk did not care.
    const moved = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents
        WHERE id = ANY($1::uuid[]) AND updated_at > created_at`,
      [straddling],
    );
    expect(moved.rows[0]!.n, 'the PATCHes did not actually rewrite updated_at').toBe(3);

    // Resume the walk from the cursor minted BEFORE the writes.
    const seen = first.data.map((d) => d.id);
    let cursor: string | null = first.next_cursor;
    for (let i = 0; i < 10 && cursor; i++) {
      const body = await page(read, cursor);
      seen.push(...body.data.map((d) => d.id));
      cursor = body.next_cursor;
    }

    expect(cursor).toBeNull();
    expect(new Set(seen).size, 'a row was served twice across the mutation').toBe(seen.length);
    expect(seen.length, 'a row was skipped across the mutation').toBe(TOTAL);
    expect([...seen].sort()).toEqual([...seededIds].sort());
  });

  it('rows created in the same microsecond are not skipped at a page boundary', async () => {
    // The tie block seeded above. If the cursor were minted from a parsed JS
    // `Date` these four rows would collapse and the walk would end short — the
    // failure is silent, which is why it is asserted rather than assumed.
    const auth = await token();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const body = await page(auth, cursor);
      seen.push(...body.data.map((d) => d.id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }

    const tied = await pool.query<{ id: string }>(
      `SELECT id FROM documents
        WHERE workspace_id = $1 AND document_type = 'issue'
          AND created_at = (SELECT created_at FROM documents
                             WHERE workspace_id = $1 AND document_type = 'issue'
                             GROUP BY created_at HAVING count(*) > 1 LIMIT 1)`,
      [workspaceId],
    );
    expect(tied.rows.length, 'the tie fixture did not produce tied rows').toBeGreaterThan(1);
    for (const row of tied.rows) {
      expect(seen, `tied row ${row.id} was skipped by the walk`).toContain(row.id);
    }
  });

  // ── PF-218 — cursors are bound to the collection that minted them ─────────

  it('a cursor minted by /documents is rejected here, not silently honoured', async () => {
    // It would decode perfectly: a real UUID and a real timestamp. Without the
    // resource binding this returns a plausible wrong page that nobody notices.
    const foreign = Buffer.from(
      JSON.stringify({
        id: seededIds[0],
        timestamp: new Date().toISOString(),
        resource: 'documents',
      }),
      'utf8',
    ).toString('base64url');

    const res = await request(harness.app)
      .get(`/api/v1/issues?cursor=${foreign}`)
      .set('Authorization', await token());

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('cursor');
    expect(res.body.details.fields[0].message).toMatch(/different collection/i);
  });

  // ── PF-222 / F18 — the index, asserted by asking Postgres ────────────────

  it('the live page query rides migration 068’s partial index — no Seq Scan, no Sort', async () => {
    // `assertKeysetIndexed` cannot be reused here and that is finding F18's
    // correction: it runs `EXPLAIN SELECT … FROM ${table}`, and `issues` is not
    // a table. Issues are `documents` rows with `document_type='issue'`, so the
    // artifact is a PARTIAL index and the assertion has to explain the real
    // predicate.
    const client = await pool.connect();
    let plan: string;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      // Without this the planner estimates rows=1 against freshly inserted rows
      // — `setup.ts` TRUNCATEs between files and nothing has ANALYZEd since — so
      // every plan is a rounding error and a Sort wins on cost. That is the F44
      // artifact that masked a real index defect in 063 for two lanes.
      await client.query('ANALYZE documents');
      const explained = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN
         SELECT id, created_at FROM documents d
          WHERE d.workspace_id = $1
            AND d.document_type = 'issue'
            AND d.archived_at IS NULL
            AND d.deleted_at IS NULL
            AND (d.visibility = 'workspace' OR d.created_by = $2
                 OR (SELECT wm.role FROM workspace_memberships wm
                      WHERE wm.workspace_id = $1 AND wm.user_id = $2) = 'admin')
            AND (d.created_at, d.id) < ($3::timestamptz, $4::uuid)
          ${KEYSET_ORDER_BY}
          LIMIT 11`,
        [workspaceId, userId, new Date().toISOString(), '00000000-0000-4000-8000-000000000000'],
      );
      plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    expect(
      /Seq Scan on documents/i.test(plan),
      `The live issues page query plans a Seq Scan:\n${plan}\n\n` +
        `Fix: the partial index in migration 068 — CREATE INDEX idx_documents_keyset_issue ` +
        `ON documents (workspace_id, created_at DESC, id DESC) ` +
        `WHERE document_type = 'issue' AND archived_at IS NULL AND deleted_at IS NULL;`,
    ).toBe(false);

    // A `Sort` node means an index exists but its column ORDER or DIRECTION does
    // not match the ORDER BY, so the planner reads everything and re-sorts. That
    // is the subtler failure, and the one an "is there an index on created_at?"
    // check misses entirely — it is exactly what 067 had to correct.
    expect(
      /\bSort\b/i.test(plan),
      `The live issues page query plans a Sort, so the index does not match the ` +
        `ORDER BY:\n${plan}`,
    ).toBe(false);
  });
});
