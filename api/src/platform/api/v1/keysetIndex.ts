/**
 * PF-222 — the keyset index contract, checked by asking Postgres.
 *
 * A keyset predicate is only O(1) at depth if an index covers it. Without one it
 * is a sequential scan plus a sort, which is strictly WORSE than the `OFFSET`
 * implementation it replaced — same cost, more code. That failure is invisible
 * in a test with fifty rows and obvious in production with fifty thousand, which
 * is the worst possible place to find it.
 *
 * So the check is not "does an index exist" (an index can exist and not be used)
 * but "does the planner USE one for the query we actually generate". `EXPLAIN`
 * on the real page query is the only thing that answers that.
 *
 * Every resource L10 adds gets a row in `KEYSET_INDEXED_TABLES` and a line in
 * the migration. The failure message names the exact `CREATE INDEX` to write, so
 * a lane that forgets is told rather than left to guess.
 */
import type { Database } from '../../../db/client.js';
import { KEYSET_ORDER_BY } from './pagination.js';

/**
 * Tables whose public list endpoint paginates by keyset.
 *
 * `documents` is the only one today. L10's resources are listed as they land;
 * the point of the list is that `keysetIndex.test.ts` iterates it, so adding a
 * row is what makes the assertion cover a new table.
 */
export const KEYSET_INDEXED_TABLES: readonly string[] = ['documents'];

/** The index every keyset table needs. One definition — migration and message. */
export function keysetIndexDdl(table: string): string {
  return (
    `CREATE INDEX IF NOT EXISTS idx_${table}_keyset ` +
    `ON ${table} (created_at DESC, id DESC);`
  );
}

interface ExplainRow {
  'QUERY PLAN': string;
}

/**
 * The page query, exactly as `keysetPredicate` composes it. `EXPLAIN` has to run
 * against the real thing — a simplified stand-in can use an index the real query
 * does not.
 */
function pageQuery(table: string): string {
  return (
    `SELECT id, created_at FROM ${table} ` +
    `WHERE (created_at, id) < ($1::timestamptz, $2::uuid) ` +
    `${KEYSET_ORDER_BY} LIMIT 26`
  );
}

export interface KeysetPlanProblem {
  table: string;
  problem: 'seq-scan' | 'sort' | 'nullable-keyset-column';
  detail: string;
  fix: string;
}

/**
 * PF-222 — fails if the generated page query does not ride an index.
 *
 * Returns problems rather than throwing so a caller checking six tables gets all
 * six, the same discipline as `runRouteAssertions`.
 *
 * `Seq Scan` and `Sort` are checked separately because they mean different
 * things. A `Seq Scan` means no usable index at all. A `Sort` node over the
 * keyset columns means an index exists but its column ORDER or DIRECTION does not
 * match the ORDER BY, so the planner reads everything and re-sorts — the subtler
 * bug, and the one an "is there an index on created_at?" check misses entirely.
 */
export async function assertKeysetIndexed(
  db: Database,
  table: string,
): Promise<KeysetPlanProblem[]> {
  const problems: KeysetPlanProblem[] = [];

  // Planner choices depend on statistics; on a small table Postgres will
  // reasonably prefer a seq scan whatever indexes exist, so a bare EXPLAIN here
  // measures the row count rather than the schema. `enable_seqscan = off` asks
  // the question we actually mean: "IS there a usable index", not "would you use
  // it on fifty rows".
  //
  // It must run on the SAME connection as the EXPLAIN, inside a transaction —
  // `SET LOCAL` outside one is a no-op with a warning, and a pooled `db.query`
  // pair can land on two different backends. That subtlety is why this reaches
  // for a client instead of using the pool directly.
  const client = await db.connect();
  let plan: string;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    // Bitmap scans are also disabled, and this one is not obvious. A bitmap index
    // scan DOES use the index — but it returns rows in heap order, so the planner
    // has to add a Sort to satisfy the ORDER BY, and the page query is back to
    // sorting the whole matching set. The property this contract is really about
    // is an ORDERED index scan: read `limit + 1` rows and stop. Leaving bitmap
    // scans enabled would let a plan that sorts 50,000 rows pass as "indexed".
    await client.query('SET LOCAL enable_bitmapscan = off');
    const explained = await client.query<ExplainRow>(`EXPLAIN ${pageQuery(table)}`, [
      new Date().toISOString(),
      '00000000-0000-4000-8000-000000000000',
    ]);
    plan = explained.rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    // Always roll back: this transaction exists only to scope a planner GUC and
    // must never be able to leave anything behind.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  if (/Seq Scan on \w*\b/i.test(plan) && plan.includes(table)) {
    problems.push({
      table,
      problem: 'seq-scan',
      detail: `The keyset page query on "${table}" plans a Seq Scan:\n${plan}`,
      fix: keysetIndexDdl(table),
    });
  }

  if (/\bSort\b/i.test(plan)) {
    problems.push({
      table,
      problem: 'sort',
      detail:
        `The keyset page query on "${table}" plans a Sort node, so an index exists but its ` +
        `column order or direction does not match "${KEYSET_ORDER_BY}":\n${plan}`,
      fix: keysetIndexDdl(table),
    });
  }

  return problems;
}

/**
 * F3, second half — a nullable keyset column makes rows INVISIBLE, not misordered.
 *
 * `(NULL, id) < (x, y)` evaluates to NULL, and a NULL predicate excludes the row.
 * So a row with `created_at IS NULL` appears on page 1 (where there is no
 * predicate at all, and `ORDER BY created_at DESC` puts NULLs first) and then
 * vanishes from every subsequent page. A consumer walking pages sees it once and
 * never again; a consumer resuming from a cursor never sees it at all.
 *
 * `documents.created_at` is `TIMESTAMPTZ DEFAULT now()` with no NOT NULL
 * (`api/src/db/schema.sql:153`), so this is live, not theoretical.
 *
 * ## Whose ticket is the constraint
 *
 * NOT this lane's. `api/src/db/migrations/RESERVATIONS.md` allocates block
 * 060–062 to **L03/L09** with the subject "scope grant storage,
 * `documents.created_at NOT NULL` (F15)" — the constraint was already assigned
 * before this lane started, and PF-222 ships only the index. Writing it here
 * would put two lanes' DDL in one migration and take a number from someone
 * else's block.
 *
 * What this lane owes instead is that the defect cannot be silent, which is what
 * this function is: it fails the suite, names the owner, and names the block.
 */
export async function assertKeysetColumnsNotNull(
  db: Database,
  table: string,
): Promise<KeysetPlanProblem[]> {
  const result = await db.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = ANY($2::text[])`,
    [table, ['created_at', 'id']],
  );

  return result.rows
    .filter((row) => row.is_nullable === 'YES')
    .map((row) => ({
      table,
      problem: 'nullable-keyset-column' as const,
      detail:
        `${table}.${row.column_name} is NULLABLE. A keyset row comparison excludes NULL rows ` +
        `from every page after the first, so such a row is INVISIBLE to a paginating consumer ` +
        `rather than merely out of order.`,
      fix:
        `ALTER TABLE ${table} ALTER COLUMN ${row.column_name} SET NOT NULL; — after a backfill. ` +
        `This belongs to L03/L09's migration block 060-062 (RESERVATIONS.md, finding F15), ` +
        `NOT to L08: PF-222 ships the index only.`,
    }));
}
