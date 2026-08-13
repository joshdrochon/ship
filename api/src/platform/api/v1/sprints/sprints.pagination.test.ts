/**
 * PF-288 — the public sprints list paginates on `(created_at, id)`, and the
 * ordering it ABANDONED is named rather than quietly dropped.
 *
 * Ship's internal sprint queries order by `(d.properties->>'sprint_number')::int`
 * (Ship's internal sprint router). Three things are wrong with that as a cursor key:
 *
 *   1. It is a computed expression over JSONB with no supporting index, so every
 *      list is a sort over a scan.
 *   2. A keyset over an expression is not expressible as a row comparison — you
 *      cannot range-scan something the index does not hold.
 *   3. `sprint_number` is MUTABLE: `updateSprintSchema` accepts it.
 *
 * PRD p.3 requires cursors "stable across reordering operations", so the public
 * list uses `(created_at, id)`. **The consequence is stated in the test below
 * rather than hidden: sprints come back in creation order, not sprint order.**
 * That is the weakest user-facing decision in this lane and it is deliberate —
 * `sprint_number` is on every item, so a consumer that wants sprint order can
 * sort a page, and `?sort=` is a named 422 rather than a silent lie.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createSprintService } from '../../../../services/sprints.js';
import { mountSprints } from './routes.js';
import { KEYSET_ORDER_BY } from '../pagination.js';

const TOTAL = 24;
const PAGE = 10;

describe('/api/v1/sprints — keyset pagination', () => {
  let harness: BearerTestApp;
  let workspaceId: string;
  let userId: string;
  let seededIds: string[] = [];

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ws = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, '2026-01-05') RETURNING id`,
      [`L10 sprint paging ${runId}`],
    );
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Sprint Paging') RETURNING id`,
      [`l10-sprint-paging-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    // Sprint numbers are seeded in DESCENDING creation order relative to their
    // number — sprint 1 is created last. So creation order and sprint order are
    // deliberately DIFFERENT, which is what lets the test below assert which one
    // the endpoint actually uses instead of accidentally agreeing with both.
    //
    // Rows 8..11 share a `created_at` to the microsecond: the tie case that
    // catches a cursor minted from a parsed JS `Date`.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, properties, created_at)
       SELECT $1, 'sprint', 'Sprint ' || g, $2,
              jsonb_build_object('sprint_number', g),
              CASE WHEN g BETWEEN 8 AND 11
                   THEN now() - interval '30 seconds'
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
        mountSprints(router, { db: pool, service: createSprintService() }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  const token = async () => `Bearer ${(await harness.mint(['sprints:read'])).access_token}`;

  async function page(auth: string, cursor: string | null) {
    const url = cursor
      ? `/api/v1/sprints?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`
      : `/api/v1/sprints?limit=${PAGE}`;
    const res = await request(harness.app).get(url).set('Authorization', auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { data: { id: string; sprint_number: number }[]; next_cursor: string | null };
  }

  it('a full walk visits every sprint exactly once', async () => {
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

  it('PF-288’s stated consequence — the order is CREATION order, not sprint order', async () => {
    // Asserted rather than merely documented, because a reader deserves to see
    // that this was chosen rather than overlooked. The fixture seeds sprint 1
    // last, so the two orderings genuinely disagree and this test can tell them
    // apart.
    const body = await page(await token(), null);
    const numbers = body.data.map((s) => s.sprint_number);

    const sortedBySprintNumber = [...numbers].sort((a, b) => b - a);
    expect(
      numbers,
      'the list came back in sprint-number order, which would mean the endpoint is ' +
        'sorting on a mutable unindexed JSONB expression and its cursors cannot be stable',
    ).not.toEqual(sortedBySprintNumber);

    // And `sprint_number` IS present, which is what makes the tradeoff bearable:
    // a consumer that wants sprint order can sort a page itself.
    for (const n of numbers) expect(typeof n).toBe('number');
  });

  it('rows created in the same microsecond are not skipped at a page boundary', async () => {
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
        WHERE workspace_id = $1 AND document_type = 'sprint'
          AND created_at = (SELECT created_at FROM documents
                             WHERE workspace_id = $1 AND document_type = 'sprint'
                             GROUP BY created_at HAVING count(*) > 1 LIMIT 1)`,
      [workspaceId],
    );
    expect(tied.rows.length, 'the tie fixture did not produce tied rows').toBeGreaterThan(1);
    for (const row of tied.rows) {
      expect(seen, `tied row ${row.id} was skipped`).toContain(row.id);
    }
  });

  it('a cursor minted by /issues is rejected here', async () => {
    const foreign = Buffer.from(
      JSON.stringify({
        id: seededIds[0],
        timestamp: new Date().toISOString(),
        resource: 'issues',
      }),
      'utf8',
    ).toString('base64url');

    const res = await request(harness.app)
      .get(`/api/v1/sprints?cursor=${foreign}`)
      .set('Authorization', await token());

    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('cursor');
    expect(res.body.details.fields[0].message).toMatch(/different collection/i);
  });

  it('the last page carries next_cursor: null — present, not absent', async () => {
    const auth = await token();
    let body = await page(auth, null);
    while (body.next_cursor) body = await page(auth, body.next_cursor);
    expect(Object.prototype.hasOwnProperty.call(body, 'next_cursor')).toBe(true);
    expect(body.next_cursor).toBeNull();
  });

  it('the live page query rides migration 068’s partial index — no Seq Scan, no Sort', async () => {
    // F18's correction, applied to sprints. `assertKeysetIndexed` cannot help:
    // it runs `EXPLAIN SELECT … FROM sprints`, and there is no such relation.
    // Sprints are `documents` rows with `document_type='sprint'`, so the artifact
    // is `idx_documents_keyset_sprint` and the assertion must explain the real
    // predicate.
    const client = await pool.connect();
    let plan = '';
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      // Without ANALYZE the planner estimates rows=1 on a freshly-TRUNCATEd
      // table and a Sort wins on cost — the F44 artifact that masked a real
      // index defect in 063 for two lanes running.
      await client.query('ANALYZE documents');
      const explained = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN
         SELECT d.id, d.created_at FROM documents d
          WHERE d.workspace_id = $1
            AND d.document_type = 'sprint'
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
      `The live sprints page query plans a Seq Scan:\n${plan}\n\n` +
        `Fix: migration 068 — CREATE INDEX idx_documents_keyset_sprint ON documents ` +
        `(workspace_id, created_at DESC, id DESC) WHERE document_type = 'sprint' ` +
        `AND archived_at IS NULL AND deleted_at IS NULL;`,
    ).toBe(false);

    expect(
      /\bSort\b/i.test(plan),
      `The live sprints page query plans a Sort, so the index does not match the ` +
        `ORDER BY:\n${plan}`,
    ).toBe(false);
  });

  it('the ordering it replaced would have sorted over a JSONB expression', () => {
    // The measurement behind PF-288, kept as a live check rather than a claim in
    // a comment: `EXPLAIN` the INTERNAL ordering and confirm it does what the
    // ticket says. If someone ever adds an expression index on
    // `(properties->>'sprint_number')::int`, this test fails and the decision is
    // worth revisiting — which is exactly when it should be.
    return (async () => {
      const client = await pool.connect();
      let plan = '';
      try {
        await client.query('BEGIN');
        await client.query('ANALYZE documents');
        const explained = await client.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN
           SELECT d.id FROM documents d
            WHERE d.workspace_id = $1 AND d.document_type = 'sprint'
            ORDER BY (d.properties->>'sprint_number')::int
            LIMIT 11`,
          [workspaceId],
        );
        plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }

      expect(
        /\bSort\b/i.test(plan),
        `The internal sprint ordering no longer plans a Sort:\n${plan}\n\n` +
          `If an index on (properties->>'sprint_number')::int now exists, PF-288's ` +
          `tradeoff — creation order instead of sprint order — may no longer be ` +
          `necessary and should be re-decided rather than left in place by inertia.`,
      ).toBe(true);
    })();
  });
});
