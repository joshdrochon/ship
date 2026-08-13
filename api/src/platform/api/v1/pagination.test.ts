/**
 * S2 — the cursor codec and the keyset walk, against a real database.
 *
 * PF-217 (codec), PF-218 (rejection), PF-219 (keyset not OFFSET), PF-220
 * (immutable sort key), PF-221 (total order), PF-222 (index contract).
 *
 * The reorder and mid-walk-delete tests use Postgres rather than an array
 * because the properties under test are properties of the QUERY. A fake that
 * returns rows in a chosen order can be made to pass every assertion here while
 * the real predicate is wrong, which is the exact bug the tests exist to catch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../../../db/client.js';
import {
  encodeCursor,
  decodeCursor,
  cursorForRow,
  keysetPredicate,
  sliceToPage,
  KEYSET_ORDER_BY,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type CursorPayload,
} from './pagination.js';
import {
  assertKeysetIndexed,
  assertKeysetColumnsNotNull,
  KEYSET_INDEXED_TABLES,
  keysetIndexDdl,
} from './keysetIndex.js';

const RESOURCE = 'documents';

describe('PF-217 — the cursor is opaque, URL-safe, and round-trips', () => {
  it('1000 fuzzed payloads round-trip to deep equality', () => {
    for (let i = 0; i < 1000; i++) {
      const payload: CursorPayload = {
        id: randomUUID(),
        // Spread across a wide range including pre-epoch and sub-second values.
        timestamp: new Date(Math.floor(Math.random() * 4_000_000_000_000) - 1_000_000_000_000)
          .toISOString(),
        resource: RESOURCE,
      };
      const decoded = decodeCursor(encodeCursor(payload), RESOURCE);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.payload).toEqual(payload);
    }
  });

  it('every encoded cursor is base64url — no percent-encoding needed', () => {
    for (let i = 0; i < 200; i++) {
      const encoded = encodeCursor({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        resource: RESOURCE,
      });
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      // The property that actually matters to a consumer: it survives being put
      // in a query string by a client that URL-encodes everything.
      expect(encodeURIComponent(encoded)).toBe(encoded);
    }
  });

  it('the payload field is `timestamp`, per the PRD — not the spike\'s `ts`', () => {
    const decoded = JSON.parse(
      Buffer.from(
        encodeCursor({ id: 'x', timestamp: '2026-01-01T00:00:00.000Z', resource: RESOURCE }),
        'base64url',
      ).toString('utf8'),
    );
    expect(Object.keys(decoded).sort()).toEqual(['id', 'resource', 'timestamp']);
  });

  it('the page-size constants are the single source', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});

describe('PF-218 — a bad cursor is validation_failed, never a 500 and never a silent page 1', () => {
  it('rejects a non-base64 string', () => {
    const result = decodeCursor('not-base64!!', RESOURCE);
    expect(result).toEqual({ ok: false, reason: 'not-base64' });
  });

  it('rejects the empty string — and does NOT treat it as "no cursor"', () => {
    // `?cursor=` is the shape a client produces from an uninitialised variable.
    // Treating it as page 1 restarts the walk forever, which looks like a hang.
    expect(decodeCursor('', RESOURCE)).toEqual({ ok: false, reason: 'not-base64' });
  });

  it('rejects a base64 of {} — decodes fine, carries nothing', () => {
    const empty = Buffer.from('{}', 'utf8').toString('base64url');
    expect(decodeCursor(empty, RESOURCE)).toEqual({ ok: false, reason: 'missing-fields' });
  });

  it('rejects a FOREIGN cursor — a valid cursor minted for another resource', () => {
    // The case that matters. Every field is well-formed and the id is a real
    // UUID, so without the resource binding this returns a wrong-but-plausible
    // page of documents keyed off an issue's timestamp, and nobody notices.
    const foreign = encodeCursor({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      resource: 'issues',
    });
    expect(decodeCursor(foreign, 'documents')).toEqual({ ok: false, reason: 'foreign-resource' });
    // …and the same cursor is accepted by the endpoint that minted it.
    expect(decodeCursor(foreign, 'issues').ok).toBe(true);
  });

  it('rejects an unparseable timestamp', () => {
    const bad = Buffer.from(
      JSON.stringify({ id: randomUUID(), timestamp: 'yesterday', resource: RESOURCE }),
      'utf8',
    ).toString('base64url');
    expect(decodeCursor(bad, RESOURCE)).toEqual({ ok: false, reason: 'bad-timestamp' });
  });

  it('rejects an array and a bare JSON scalar', () => {
    const arr = Buffer.from('[]', 'utf8').toString('base64url');
    const num = Buffer.from('42', 'utf8').toString('base64url');
    expect(decodeCursor(arr, RESOURCE).ok).toBe(false);
    expect(decodeCursor(num, RESOURCE).ok).toBe(false);
  });
});

describe('PF-219 — keyset predicate composition', () => {
  it('emits no clause for the first page', () => {
    expect(keysetPredicate(null, 2)).toEqual({ sql: '', values: [] });
  });

  it('is a ROW COMPARISON, not an OR of two conditions', () => {
    const { sql } = keysetPredicate(
      { id: 'a', timestamp: '2026-01-01T00:00:00.000Z', resource: RESOURCE },
      2,
    );
    // The OR form is logically equivalent and plans completely differently —
    // usually a bitmap-or or a seq scan instead of an index range scan.
    expect(sql).toContain('(created_at, id) <');
    expect(sql).not.toMatch(/\bOR\b/i);
  });

  it('offsets its placeholders past the caller\'s own WHERE params', () => {
    const { sql, values } = keysetPredicate(
      { id: 'a', timestamp: '2026-01-01T00:00:00.000Z', resource: RESOURCE },
      4,
    );
    expect(sql).toContain('$5::timestamptz');
    expect(sql).toContain('$6::uuid');
    expect(values).toEqual(['2026-01-01T00:00:00.000Z', 'a']);
  });

  it('the ORDER BY matches the index direction', () => {
    expect(KEYSET_ORDER_BY).toBe('ORDER BY created_at DESC, id DESC');
  });
});

describe('PF-224 — sliceToPage decides the last page by fetching limit + 1', () => {
  const rows = (n: number, base = 0) =>
    Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(base + i).padStart(12, '0')}`,
      created_at: new Date(2026, 0, 1, 0, 0, base + i),
    }));

  it('exactly `limit` rows returns next_cursor: null in ONE request', () => {
    const page = sliceToPage(rows(25), 25, RESOURCE);
    expect(page.data).toHaveLength(25);
    expect('next_cursor' in page).toBe(true);
    expect(page.next_cursor).toBeNull();
  });

  it('limit + 1 rows returns a cursor and drops the extra row', () => {
    const page = sliceToPage(rows(26), 25, RESOURCE);
    expect(page.data).toHaveLength(25);
    expect(page.next_cursor).not.toBeNull();
    const decoded = decodeCursor(page.next_cursor!, RESOURCE);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.payload.id).toBe(page.data[24]!.id);
  });

  it('an empty result is data: [] with next_cursor present-and-null', () => {
    const page = sliceToPage([], 25, RESOURCE);
    expect(page.data).toEqual([]);
    expect('next_cursor' in page).toBe(true);
    expect(page.next_cursor).toBeNull();
  });

  it('THROWS rather than minting a cursor for a NULL created_at (F3)', () => {
    expect(() => cursorForRow({ id: 'abc', created_at: null }, RESOURCE)).toThrow(
      /created_at is NULL/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Against a real database. These properties are properties of the query.
// ─────────────────────────────────────────────────────────────────────────────

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

/** One page of ids, via the real keyset query. */
async function fetchPage(cursor: CursorPayload | null, limit: number): Promise<string[]> {
  const predicate = keysetPredicate(cursor, 1);
  const where = predicate.sql ? `AND ${predicate.sql}` : '';
  const result = await pool.query<{ id: string; created_at: Date }>(
    `SELECT id, created_at FROM documents
      WHERE workspace_id = $1 ${where}
      ${KEYSET_ORDER_BY} LIMIT ${limit + 1}`,
    [WORKSPACE, ...predicate.values],
  );
  return result.rows.map((r) => r.id);
}

/** Walks every page and returns the ids in order. */
async function walkAll(pageSize: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: CursorPayload | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const predicate = keysetPredicate(cursor, 1);
    const where = predicate.sql ? `AND ${predicate.sql}` : '';
    const result = await pool.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM documents
        WHERE workspace_id = $1 ${where}
        ${KEYSET_ORDER_BY} LIMIT ${pageSize + 1}`,
      [WORKSPACE, ...predicate.values],
    );
    const page = sliceToPage(result.rows, pageSize, RESOURCE);
    seen.push(...page.data.map((r) => r.id));
    if (page.next_cursor === null) return seen;
    const decoded = decodeCursor(page.next_cursor, RESOURCE);
    if (!decoded.ok) throw new Error(`walk produced an undecodable cursor: ${decoded.reason}`);
    cursor = decoded.payload;
  }
  throw new Error('walk did not terminate in 50 pages');
}

async function seedDocuments(count: number, sameTimestamp = false): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO documents (id, workspace_id, title, document_type, position, created_at, created_by)
       VALUES ($1, $2, $3, 'wiki', $4, $5, $6)`,
      [
        id,
        WORKSPACE,
        `doc ${i}`,
        i,
        sameTimestamp ? new Date('2026-03-01T00:00:00.000Z') : new Date(2026, 0, 1, 0, 0, i),
        USER,
      ],
    );
  }
  return ids;
}

describe('PF-219/PF-220/PF-221 — the walk, against Postgres', () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO workspaces (id, name) VALUES ($1, 'L08 keyset')
       ON CONFLICT (id) DO NOTHING`,
      [WORKSPACE],
    );
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, 'l08@example.test', 'L08')
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [WORKSPACE]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [WORKSPACE]);
  });

  it('PF-219 — 50 rows at page size 10 yields exactly the 50 ids, no dupes, no gaps', async () => {
    const ids = await seedDocuments(50);
    const walked = await walkAll(10);

    expect(walked).toHaveLength(50);
    expect(new Set(walked).size).toBe(50);
    expect([...walked].sort()).toEqual([...ids].sort());
  });

  it('PF-219 — DELETING A ROW MID-WALK skips nothing and repeats nothing', async () => {
    // The half an OFFSET implementation fails. With OFFSET 10, deleting a row on
    // page 1 shifts every later row up by one, so the first row of page 2 is
    // silently never returned.
    await seedDocuments(50);

    const page1 = await fetchPage(null, 10);
    const firstTen = page1.slice(0, 10);
    const cursorRow = await pool.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM documents WHERE id = $1',
      [firstTen[9]],
    );
    const cursor = cursorForRow(cursorRow.rows[0]!, RESOURCE);

    // Delete a row from page 1, after the cursor was minted.
    await pool.query('DELETE FROM documents WHERE id = $1', [firstTen[0]]);

    const rest: string[] = [];
    let c: CursorPayload | null = cursor;
    for (let guard = 0; guard < 20 && c; guard++) {
      const predicate = keysetPredicate(c, 1);
      const result = await pool.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM documents
          WHERE workspace_id = $1 AND ${predicate.sql}
          ${KEYSET_ORDER_BY} LIMIT 11`,
        [WORKSPACE, ...predicate.values],
      );
      const page = sliceToPage(result.rows, 10, RESOURCE);
      rest.push(...page.data.map((r) => r.id));
      if (page.next_cursor === null) break;
      const decoded = decodeCursor(page.next_cursor, RESOURCE);
      c = decoded.ok ? decoded.payload : null;
    }

    // 40 rows remained below the cursor; the deleted row was above it.
    expect(rest).toHaveLength(40);
    expect(new Set(rest).size).toBe(40);
    for (const id of firstTen) expect(rest).not.toContain(id);
  });

  it('PF-220 — MUTATING `position` across a page boundary shifts nothing', async () => {
    // "Cursors are stable across reordering operations" (p.3). `position` is what
    // drag-reorder rewrites and what the INTERNAL list sorts on. If the public
    // query touched it, this rewrite would move rows between pages.
    await seedDocuments(30);

    const firstPage = await fetchPage(null, 10);
    const boundary = firstPage.slice(0, 10);
    const cursorRow = await pool.query<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM documents WHERE id = $1',
      [boundary[9]],
    );
    const cursor = cursorForRow(cursorRow.rows[0]!, RESOURCE);

    // Rewrite `position` on three rows spanning the page boundary — exactly what
    // a drag-reorder in the sidebar does mid-walk.
    await pool.query(
      `UPDATE documents SET position = position * -1 WHERE id = ANY($1::uuid[])`,
      [[boundary[8], boundary[9], firstPage[10]]],
    );

    const predicate = keysetPredicate(cursor, 1);
    const after = await pool.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at FROM documents
        WHERE workspace_id = $1 AND ${predicate.sql}
        ${KEYSET_ORDER_BY} LIMIT 11`,
      [WORKSPACE, ...predicate.values],
    );
    const page2 = sliceToPage(after.rows, 10, RESOURCE).data.map((r) => r.id);

    for (const id of boundary) {
      expect(page2, `${id} appeared on page 2 after a reorder`).not.toContain(id);
    }
    expect(new Set(page2).size).toBe(page2.length);
  });

  it('PF-221 — 20 rows with an IDENTICAL created_at paginate into 4 disjoint pages', async () => {
    // `created_at` alone is not unique here: bulk seed and bulk import both
    // produce ties. Without the id tie-break the walk both repeats and drops rows.
    const ids = await seedDocuments(20, true);
    const walked = await walkAll(5);

    expect(walked).toHaveLength(20);
    expect(new Set(walked).size).toBe(20);
    expect([...walked].sort()).toEqual([...ids].sort());
  });
});

describe('PF-222 — the keyset index contract', () => {
  // PF-030 — this block asserts a QUERY PLAN, and a query plan is only meaningful
  // against statistics. `setup.ts` TRUNCATEs at every file boundary and the block
  // above deletes its own rows in `afterAll`, so without this the EXPLAIN below
  // ran against an EMPTY table: `ANALYZE` then tells the planner `rows=0`, every
  // candidate index costs the same rounding error, and which one wins is
  // arbitrary. Three overlapping indexes exist on `documents` — `idx_documents_
  // keyset` (063, timestamp-first), `idx_documents_workspace_keyset` (060,
  // tenant-first) and, until migration 068, a third that duplicated 060's column
  // list. On an empty table the planner picked among them by coin-flip; a
  // tenant-first index chosen for a query with no tenant predicate has to Sort,
  // and that is the failure this test kept reporting.
  //
  // It read as flake (F44) for exactly as long as the coin came up differently
  // between runs, and turned into a hard failure the moment a third candidate
  // shifted the odds. Both symptoms have one cause and it was never the schema.
  //
  // Fifty rows is enough — measured: at 50, 100, 300 and 1000 rows the plan is a
  // clean `Index Only Scan using idx_documents_keyset` with no Sort node, and
  // zero rows is the only input that fails. The margin here is for the planner's
  // benefit, not the assertion's.
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO workspaces (id, name) VALUES ($1, 'PF-222 plan stats')
       ON CONFLICT (id) DO NOTHING`,
      [WORKSPACE],
    );
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, 'pf222@example.test', 'PF-222')
       ON CONFLICT (id) DO NOTHING`,
      [USER],
    );
    await seedDocuments(200);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [WORKSPACE]);
  });

  it('the generated page query plans no Seq Scan and no Sort', async () => {
    const problems: string[] = [];
    for (const table of KEYSET_INDEXED_TABLES) {
      for (const problem of await assertKeysetIndexed(pool, table)) {
        problems.push(`${problem.problem} on ${problem.table}\n${problem.detail}\nFix: ${problem.fix}`);
      }
    }
    expect(problems.join('\n\n')).toBe('');
  });

  it('names the exact CREATE INDEX in its failure message, so L10 is told not guessing', () => {
    expect(keysetIndexDdl('issues')).toContain('CREATE INDEX IF NOT EXISTS idx_issues_keyset');
    expect(keysetIndexDdl('issues')).toContain('(created_at DESC, id DESC)');
  });

  it('F15 — the keyset columns are NOT NULL, so no row can be invisible', async () => {
    // FLIPPED BY L09, exactly as the previous version of this test instructed.
    //
    // It used to assert `['documents.created_at']` — the defect as a known,
    // named, owned condition — with a message saying that when L03/L09 shipped
    // the constraint this would start failing and the expectation should be
    // replaced. Migration 060 shipped it, so this is that replacement.
    //
    // Kept rather than deleted, and pointed at the whole `KEYSET_INDEXED_TABLES`
    // list: this is now the check that stops the constraint being dropped, and
    // the check L10's tables inherit for free as they are added to that list.
    const problems = await assertKeysetColumnsNotNull(pool, 'documents');

    expect(
      problems.map((p) => p.detail),
      'A keyset column on `documents` is nullable again. A row comparison ' +
        '`(created_at, id) < ($1,$2)` evaluates to NULL for such a row, so it is absent ' +
        'from every page rather than misordered — silent data loss through the public ' +
        'list. See migration 060.',
    ).toEqual([]);
  });

  it('a NULL created_at can no longer be inserted at all', async () => {
    // The constraint asserted from the write side, which is the half a metadata
    // query cannot see. `information_schema` can be right while a trigger or a
    // partition inherits the old definition.
    await expect(
      pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, created_at)
         VALUES ((SELECT id FROM workspaces LIMIT 1), 'wiki', 'null timestamp', NULL)`,
      ),
    ).rejects.toThrow(/null value in column "created_at"|violates not-null constraint/i);
  });
});
