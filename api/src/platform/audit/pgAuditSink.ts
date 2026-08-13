/**
 * PF-339 — the Postgres sink, and PF-343 — the query surface the portal reads.
 *
 * L12 PRODUCES; L22 CONSUMES. What crosses the seam is `listCalls` below, not a
 * React component. The portal renders `{data, next_cursor}` exactly as it would
 * for any other public collection, using the same opaque base64url cursor the
 * rest of `/api/v1` uses — a second pagination contract for one screen is a
 * second thing to get wrong.
 *
 * The table is `public_api_calls` (migration 057), deliberately not the internal
 * `audit_logs`. See the migration header for why.
 */
import {
  encodeCursor,
  decodeCursor,
  keysetPredicate,
  type CursorPayload,
  type Page,
} from '../api/v1/pagination.js';
import type { Database } from '../../db/client.js';
import type { IAuditSink, PublicApiCallRecord } from './audit.js';

/** The resource name bound into every cursor this module mints (PF-218). */
export const PUBLIC_API_CALLS_RESOURCE = 'public_api_calls';

/** The ordering column. `created_at` elsewhere; the same idea under a truer name. */
const ORDER_COLUMN = 'occurred_at';

/**
 * PF-339 — writes one row per public API call.
 *
 * `record()` returns a promise and the caller never awaits it: `recordSafely`
 * (audit.ts) attaches a `.catch` and returns immediately, so a slow or failed
 * insert delays no response and fails no request. That is the whole of PF-328
 * and it is the reason this class does no error handling of its own — swallowing
 * here would hide the failure from the one place that logs it with a request id.
 */
export class PgAuditSink implements IAuditSink {
  constructor(private readonly db: Database) {}

  async record(entry: PublicApiCallRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO public_api_calls
         (request_id, client_id, user_id, method, route, scope_used, status, latency_ms, occurred_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [
        entry.requestId,
        entry.clientId,
        entry.userId,
        entry.method,
        entry.route,
        entry.scopeUsed,
        entry.status,
        entry.latencyMs,
        entry.occurredAt.toISOString(),
      ],
    );
  }
}

/** One row as the portal reads it. Snake_case: this is the wire shape L22 renders. */
export interface PublicApiCallRow {
  id: string;
  request_id: string;
  client_id: string | null;
  user_id: string | null;
  method: string;
  route: string;
  scope_used: string | null;
  status: number;
  latency_ms: number;
  occurred_at: Date;
}

export interface ListCallsQuery {
  /** Scope the page to one app. Omitted ⇒ every app, which only an operator wants. */
  clientId?: string;
  /** Inclusive lower bound on `occurred_at`. */
  from?: Date;
  /** Exclusive upper bound on `occurred_at`. */
  to?: Date;
  /** Exact status match — `429` to answer "who is being throttled". */
  status?: number;
  /** Exact route-template match. Templates, not paths, so this is a real filter. */
  route?: string;
  /** Opaque cursor from a previous page's `next_cursor`. */
  cursor?: string | null;
  /** Page size. The caller validates it against the public limits. */
  limit: number;
}

/**
 * PF-343 — one page of the trail, newest first.
 *
 * Ordered by `(occurred_at DESC, id DESC)` — the exact index order of
 * `idx_public_api_calls_client_occurred`. The tie-breaker is not decoration: two
 * rows written in the same microsecond order arbitrarily without it, and a page
 * boundary landing between them either repeats a row or skips one. Audit rows
 * arrive in bursts, so same-microsecond ties are the normal case rather than the
 * pathological one.
 *
 * Stable under concurrent inserts, which is the property the walk actually needs.
 * A new row is always NEWER than the cursor, and the walk is descending, so it
 * lands on a page the walker has already passed and cannot shift the rows ahead
 * of it. An offset/limit pager has the opposite property and silently skips a
 * row per insert.
 *
 * Fetches `limit + 1` rather than issuing a `COUNT(*)`: the count doubles the
 * query load on every page and is racy anyway, and one extra row answers the
 * only question the response has — "is there more?".
 */
export async function listCalls(
  db: Database,
  query: ListCallsQuery,
): Promise<Page<PublicApiCallRow>> {
  const where: string[] = [];
  const values: unknown[] = [];

  if (query.clientId !== undefined) {
    values.push(query.clientId);
    where.push(`client_id = $${values.length}`);
  }
  if (query.from !== undefined) {
    values.push(query.from.toISOString());
    where.push(`occurred_at >= $${values.length}::timestamptz`);
  }
  if (query.to !== undefined) {
    values.push(query.to.toISOString());
    where.push(`occurred_at < $${values.length}::timestamptz`);
  }
  if (query.status !== undefined) {
    values.push(query.status);
    where.push(`status = $${values.length}`);
  }
  if (query.route !== undefined) {
    values.push(query.route);
    where.push(`route = $${values.length}`);
  }

  const payload = decodeCursorOrNull(query.cursor);
  // `ORDER_COLUMN` is a module constant, never anything from a request.
  const keyset = keysetPredicate(payload, values.length, ORDER_COLUMN);
  if (keyset.sql) {
    where.push(keyset.sql);
    values.push(...keyset.values);
  }

  values.push(query.limit + 1);
  const limitPlaceholder = `$${values.length}`;

  const { rows } = await db.query<PublicApiCallRow>(
    `SELECT id, request_id, client_id, user_id, method, route, scope_used,
            status, latency_ms, occurred_at
       FROM public_api_calls
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limitPlaceholder}`,
    values,
  );

  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const last = data[data.length - 1];
  if (!hasMore || !last) return { data, next_cursor: null };

  return {
    data,
    next_cursor: encodeCursor({
      id: last.id,
      timestamp:
        last.occurred_at instanceof Date
          ? last.occurred_at.toISOString()
          : String(last.occurred_at),
      resource: PUBLIC_API_CALLS_RESOURCE,
    }),
  };
}

/**
 * Decodes, or treats a bad cursor as no cursor.
 *
 * `listCalls` is a repository function, not an HTTP handler: turning a rejection
 * into a `validation_failed` is the route's job (L22's), and doing it here would
 * put HTTP semantics in a query builder. The route validates with
 * `parseCursor` before calling this; this is the belt for a caller that did not.
 */
function decodeCursorOrNull(cursor: string | null | undefined): CursorPayload | null {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor, PUBLIC_API_CALLS_RESOURCE);
  return decoded.ok ? decoded.payload : null;
}
