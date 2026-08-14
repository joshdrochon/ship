/**
 * Opaque cursor pagination for every public list endpoint.
 *
 * PRD p.3, verbatim: *"Opaque base64 cursors over { id, timestamp }. List
 * responses always return { data, next_cursor }. Cursors are stable across
 * reordering operations."*
 *
 * Tickets: PF-217 (codec), PF-218 (rejection), PF-219 (keyset predicate),
 * PF-220 (immutable sort key), PF-221 (total order), PF-222 (index contract).
 *
 * ## Three properties, and what each one costs to give up
 *
 * **Opaque.** The cursor is base64url over JSON. Nothing consumer-facing
 * documents the payload, and `cursor.test.ts` asserts a three-page walk works
 * without importing `decodeCursor`. The moment a consumer decodes it, the payload
 * is a public API and we can never change it.
 *
 * **Keyset, not OFFSET.** `OFFSET 40` re-counts forty rows on every page (O(n) at
 * depth) and, worse, silently skips a row when something above the window is
 * deleted mid-walk. A keyset predicate is O(1) with the right index and cannot
 * skip: it asks for "rows after this exact one", which is still a well-defined
 * question after a delete.
 *
 * **Immutable sort key.** `documents.position` is what the INTERNAL list sorts on
 * (`api/src/routes/documents.ts:120`, `ORDER BY position ASC, created_at DESC`)
 * and drag-reorder rewrites it. Paginating on it means a user reordering a
 * sidebar corrupts a concurrent API walk — which is precisely what "cursors are
 * stable across reordering operations" forbids. The public list sorts on
 * `(created_at, id)`, which nothing rewrites. That divergence from the internal
 * list is deliberate; it is finding F3.
 *
 * ## Decisions that are ours, not the PRD's
 *
 * The PRD names no page-size parameter, no default, no maximum, and no sort
 * direction. All four are this lane's calls, cited `—` rather than given a
 * manufactured page reference:
 *
 *   `limit`             the parameter name (over `per_page` / `page_size`)
 *   25                  default page size
 *   100                 maximum
 *   newest-first        `created_at DESC, id DESC`
 *
 * Newest-first matches the internal list's tiebreak direction, and is what a
 * consumer polling for new rows wants. If L13's spec or L17's SDK has already
 * assumed different names, they win — the cost is a rename, not a redesign.
 */

/** Default page size when `limit` is absent. Ours; the PRD names none. */
export const DEFAULT_PAGE_SIZE = 25;

/** Maximum accepted `limit`. Over this is REJECTED, not clamped — see PF-225. */
export const MAX_PAGE_SIZE = 100;

/** The query parameter carrying page size. Ours; the PRD names none. */
export const PAGE_SIZE_PARAM = 'limit';

/** The query parameter carrying the cursor. */
export const CURSOR_PARAM = 'cursor';

/**
 * The keyset columns, in order. One definition — the ORDER BY, the predicate,
 * the index migration and the `EXPLAIN` assertion all read it, so they cannot
 * disagree about what "the keyset" is.
 */
export const KEYSET_COLUMNS = ['created_at', 'id'] as const;

/** `ORDER BY` for a newest-first keyset page. Must match the index, exactly. */
export const KEYSET_ORDER_BY = 'ORDER BY created_at DESC, id DESC';

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * The cursor payload — field names taken from the PRD's `{ id, timestamp }`.
 *
 * The spike in this file called the second field `ts`. Renamed rather than kept:
 * the payload is JSON that an SDK author WILL eventually look at while debugging,
 * whatever the opacity contract says, and matching the brief costs nothing now
 * and is a breaking change later.
 */
export interface CursorPayload {
  /** Tie-breaker id of the last row on the previous page. */
  id: string;
  /** ISO-8601 timestamp of the last row on the previous page. */
  timestamp: string;
  /**
   * Which resource minted this cursor.
   *
   * PF-218's case that matters. A cursor minted for `/documents` decodes
   * perfectly against `/issues` — its `id` is a real UUID and its timestamp is a
   * real timestamp — and would return a wrong-but-plausible page that nobody ever
   * notices. Binding the resource makes that a `validation_failed` instead.
   */
  resource: string;
}

/** Everything that can be wrong with a cursor. The list is the error message. */
export type CursorRejection =
  | 'not-base64'
  | 'not-json'
  | 'not-an-object'
  | 'missing-fields'
  | 'bad-timestamp'
  | 'foreign-resource';

export type CursorDecodeResult =
  | { ok: true; payload: CursorPayload }
  | { ok: false; reason: CursorRejection };

/**
 * PF-217 — encode. base64url, so the result needs no percent-encoding in a query
 * string: the alphabet is `[A-Za-z0-9_-]` with no `+`, `/` or `=`.
 *
 * A consumer that URL-encodes it anyway gets the same string back, which is the
 * point — a cursor that changes under `encodeURIComponent` produces bug reports
 * nobody can reproduce.
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * PF-218 — decode, or say precisely why not.
 *
 * Returns a reason rather than throwing, because the caller has to turn this into
 * a `validation_failed` naming the `cursor` field and it needs the reason to
 * write a message. Throwing an `ApiError` from here would put HTTP semantics in
 * a codec.
 *
 * `expectedResource` is REQUIRED, not optional. An optional resource check is a
 * check that is skipped, and the foreign-cursor case is the one that produces a
 * plausible wrong answer rather than a visible failure.
 */
export function decodeCursor(cursor: string, expectedResource: string): CursorDecodeResult {
  if (cursor.length === 0) return { ok: false, reason: 'not-base64' };

  // `Buffer.from(x, 'base64url')` is famously permissive — it ignores characters
  // outside the alphabet instead of failing — so the charset is checked first.
  // Without this, `?cursor=not-base64!!` decodes to garbage and falls through to
  // 'not-json', which is a true but unhelpful answer.
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return { ok: false, reason: 'not-base64' };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'not-json' };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'not-an-object' };
  }

  const candidate = raw as Partial<CursorPayload>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.timestamp !== 'string' ||
    typeof candidate.resource !== 'string' ||
    candidate.id.length === 0 ||
    candidate.resource.length === 0
  ) {
    return { ok: false, reason: 'missing-fields' };
  }

  // A timestamp that parses to NaN would become `NULL` in the predicate, and a
  // NULL in a row comparison yields NULL — so every subsequent page would be
  // empty and the walk would end silently. Caught here instead.
  if (Number.isNaN(Date.parse(candidate.timestamp))) {
    return { ok: false, reason: 'bad-timestamp' };
  }

  if (candidate.resource !== expectedResource) {
    return { ok: false, reason: 'foreign-resource' };
  }

  return {
    ok: true,
    payload: {
      id: candidate.id,
      timestamp: candidate.timestamp,
      resource: candidate.resource,
    },
  };
}

/** Human-readable reason, for the `details.fields[].message` of a 422. */
export const CURSOR_REJECTION_MESSAGE: Record<CursorRejection, string> = {
  'not-base64': 'Cursor is not a valid base64url string.',
  'not-json': 'Cursor does not decode to JSON.',
  'not-an-object': 'Cursor does not decode to an object.',
  'missing-fields': 'Cursor is missing required fields.',
  'bad-timestamp': 'Cursor carries an unparseable timestamp.',
  'foreign-resource':
    'Cursor was issued for a different collection. Cursors are not portable between endpoints.',
};

/** The row shape any keyset-paginated resource must expose. */
export interface KeysetRow {
  id: string;
  created_at: Date | string | null;
}

/**
 * PF-219 — the keyset predicate, as a ROW COMPARISON.
 *
 * `(created_at, id) < ($n, $n+1)` and not
 * `created_at < $n OR (created_at = $n AND id < $n+1)`. The two are logically
 * equivalent and the planner treats them completely differently: the row form
 * becomes an index range scan on `(created_at DESC, id DESC)`, the OR form
 * usually becomes a bitmap-or of two scans or a seq scan. PF-222's `EXPLAIN`
 * assertion is what keeps anyone from "simplifying" this back.
 *
 * `paramOffset` is the count of placeholders already used by the caller's own
 * WHERE clause, so this composes with a filtered query instead of owning `$1`.
 *
 * `timestampColumn` defaults to `created_at`, which is what every
 * document-backed resource uses. It is a parameter rather than a constant
 * because L12's `public_api_calls` orders on `occurred_at` — a different name
 * for the same idea — and the alternative was a second copy of the row
 * comparison, which is precisely the thing PF-222's EXPLAIN assertion exists to
 * protect. The column name is interpolated, so it must never come from a
 * request; both call sites pass a literal.
 *
 * Returns an empty clause for the first page — no cursor, no predicate.
 */
export function keysetPredicate(
  payload: CursorPayload | null,
  paramOffset: number,
  timestampColumn: string = KEYSET_COLUMNS[0],
): { sql: string; values: string[] } {
  if (!payload) return { sql: '', values: [] };
  const a = paramOffset + 1;
  const b = paramOffset + 2;
  return {
    // Explicit casts: node-postgres sends both as text, and without them Postgres
    // compares `timestamptz` to `text`, which does not use the index.
    sql: `(${timestampColumn}, id) < ($${a}::timestamptz, $${b}::uuid)`,
    values: [payload.timestamp, payload.id],
  };
}

/**
 * PF-224 — the last-page decision, made by fetching one extra row.
 *
 * `limit + 1` rather than a second `COUNT(*)`: a count doubles the query load on
 * every page and is racy anyway (rows can be inserted between the two queries,
 * so `total` describes a database state that never existed). One extra row
 * answers the only question the response actually needs — "is there more?".
 *
 * The boundary case this gets right: exactly `limit` rows remaining returns
 * `next_cursor: null` in ONE request, with no phantom empty final page.
 */
export function sliceToPage<T extends KeysetRow>(
  rows: T[],
  limit: number,
  resource: string,
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  if (!hasMore || !last) return { data, next_cursor: null };

  return { data, next_cursor: encodeCursor(cursorForRow(last, resource)) };
}

/**
 * The cursor that would resume AFTER this row.
 *
 * Throws on a null `created_at` rather than emitting a cursor that cannot work.
 * That is finding F3's second half, discovered by L09: `documents.created_at` is
 * NULLABLE (`api/src/db/schema.sql:153`). A row with a null timestamp is not
 * merely mis-ordered by a keyset walk — `(NULL, id) < (x, y)` evaluates to NULL,
 * so the row is EXCLUDED from every page after the first and is invisible rather
 * than out of order.
 *
 * The `NOT NULL` constraint that fixes it is allocated to L03/L09's migration
 * block 060–062 (`api/src/db/migrations/RESERVATIONS.md`, finding F15), not to
 * this lane. Until it lands, `assertKeysetColumnsNotNull` fails loudly at test
 * time and this throws loudly at request time. Both are better than a silently
 * short page.
 */
export function cursorForRow(row: KeysetRow, resource: string): CursorPayload {
  if (row.created_at === null || row.created_at === undefined) {
    throw new Error(
      `Cannot mint a cursor for ${resource} row ${row.id}: created_at is NULL. ` +
        `A keyset row comparison excludes NULL rows from every page, so this row would be ` +
        `invisible rather than misordered. The fix is the NOT NULL constraint allocated to ` +
        `L03/L09 in migrations/RESERVATIONS.md block 060-062 (finding F15).`,
    );
  }
  const timestamp =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return { id: row.id, timestamp, resource };
}
