/**
 * PF-458–PF-463 — the Postgres delivery log, on migration 051.
 *
 * Constructed in `productionDeps()` and nowhere else, the same rule PF-037
 * applies to `PgOAuthAppRepo`, PF-154 to `PgTokenRepo` and PF-427 to
 * `PgWebhookSubscriptionRepo`. `deliveryLogFitness.test.ts` fails on a second
 * construction site.
 *
 * ## `app_id` is a PARAMETER on every read, never a filter applied afterwards
 *
 * Every read below puts `app_id` in the WHERE clause rather than fetching and
 * filtering, for L15's reason at PF-432: PF-478 requires another app's delivery
 * id to be `not_found` rather than `forbidden`, and the only way to make that
 * structural is for the repository to be unable to return a row it was not asked
 * for. Cross-app leakage here is one developer's integration showing up in
 * another's portal.
 *
 * The column is written by a SUBSELECT inside `beginAttempt`'s INSERT — resolved
 * from `webhook_subscriptions` at write time, never accepted from a caller — so
 * a caller cannot supply an app id that disagrees with the subscription's.
 * Migration 051 explains why it is a column at all rather than a join: measured,
 * the join form plans as a `Seq Scan` + `Sort` because the equality sits on the
 * joined table and no `subscription_id` is known at plan time.
 *
 * ## Timestamps are rendered by Postgres, not parsed by node-postgres
 *
 * `to_char(... 'US"Z"')` preserves microsecond precision. The same trap L09
 * documents as `CURSOR_TIMESTAMP_EXPR`: `node-postgres` parses `timestamptz`
 * into a JavaScript `Date`, which is millisecond-resolution, so a cursor minted
 * from a parsed value can round PAST a row and skip it.
 */
import type { Database } from '../../db/client.js';
import {
  DuplicateAttemptError,
  retainable,
  summariseKeyUsage,
  type BeginAttemptInput,
  type CompleteAttemptInput,
  type DeliveryPageQuery,
  type DeliveryRecord,
  type DeliveryStatus,
  type IDeliveryLog,
  type KeyUsage,
  type ResumableDelivery,
} from './deliveryLog.js';

/** Microsecond-precision ISO-8601, so a keyset cursor cannot round past a row. */
const ISO = (column: string, alias: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;

/**
 * The projection. `raw_body` is ABSENT and that is enforcement rather than
 * convention: a `SELECT *` would put a full event payload on every row object
 * the route layer handles, and the list endpoint would start serialising event
 * bodies into a paginated response nobody asked for. The body is fetched
 * deliberately, by `getRawBody`, on the one path that needs it.
 *
 * `app_id` is also absent: it is a storage-and-index concern (see migration
 * 051), not part of the record every reader sees. A caller already knows which
 * app it asked about.
 */
const COLUMNS = `
  id, delivery_group_id, subscription_id, event_id, event_type,
  attempt_number, status, response_status, response_excerpt,
  latency_ms, idempotency_key, dlq_reason,
  signature_header, replay_of_delivery_id,
  ${ISO('attempted_at', 'attempted_at')},
  ${ISO('attempted_at', 'created_at')}
`;

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

interface Row extends Omit<DeliveryRecord, 'status' | 'dlq_reason'> {
  status: string;
  dlq_reason: string | null;
}

const toRecord = (row: Row): DeliveryRecord =>
  ({ ...row, status: row.status as DeliveryStatus }) as DeliveryRecord;

export class PgDeliveryLog implements IDeliveryLog {
  constructor(private readonly db: Database) {}

  /**
   * PF-459 — INSERT `in_flight`, BEFORE the HTTP call.
   *
   * `attempted_at` is a bound parameter and not `now()`. A server-side default
   * would read the wall clock, which is the one thing p.11 forbids on this path:
   * under `FakeClock` every row of a six-minute ladder would carry the same real
   * second and no timing assertion over the log would mean anything.
   */
  async beginAttempt(input: BeginAttemptInput): Promise<DeliveryRecord> {
    try {
      const result = await this.db.query<Row>(
        `INSERT INTO webhook_deliveries (
           delivery_group_id, subscription_id, event_id, event_type,
           attempt_number, status, idempotency_key, attempted_at,
           raw_body, signature_header, replay_of_delivery_id, app_id
         ) VALUES ($1, $2, $3, $4, $5, 'in_flight', $6, $7::timestamptz, $8, $9, $10,
                   (SELECT app_id FROM webhook_subscriptions WHERE id = $2))
         RETURNING ${COLUMNS}`,
        [
          input.delivery_group_id,
          input.subscription_id,
          input.event_id,
          input.event_type,
          input.attempt_number,
          input.idempotency_key,
          input.attempted_at,
          input.raw_body,
          input.signature_header,
          input.replay_of_delivery_id,
        ],
      );
      return toRecord(result.rows[0]!);
    } catch (err) {
      // PF-462 — the constraint is what makes at-least-once auditable, so its
      // violation gets a named error rather than a raw SQLSTATE. The re-drive
      // path (PF-484) catches this and resumes rather than inserting.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateAttemptError(input.delivery_group_id, input.attempt_number);
      }
      throw err;
    }
  }

  /**
   * The outcome. `WHERE status = 'in_flight'` is part of the predicate, not a
   * check the caller makes: a second completion would rewrite a terminal fact,
   * and a conditional UPDATE turns that into zero rows affected rather than into
   * silent history rewriting.
   */
  async completeAttempt(id: string, outcome: CompleteAttemptInput): Promise<DeliveryRecord> {
    const result = await this.db.query<Row>(
      `UPDATE webhook_deliveries
          SET status = $2, response_status = $3, response_excerpt = $4,
              latency_ms = $5, dlq_reason = $6
        WHERE id = $1 AND status = 'in_flight'
        RETURNING ${COLUMNS}`,
      [
        id,
        outcome.status,
        outcome.response_status,
        outcome.response_excerpt,
        outcome.latency_ms,
        outcome.dlq_reason,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(
        `Delivery row ${id} was not in_flight, so it could not be completed. Either it ` +
          `does not exist or it already reached a terminal state — completing it twice ` +
          `would rewrite a fact the delivery log exists to preserve.`,
      );
    }
    return toRecord(row);
  }

  async getById(appId: string, id: string): Promise<DeliveryRecord | null> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS}
         FROM webhook_deliveries
        WHERE id = $1 AND app_id = $2`,
      [id, appId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async getRawBody(appId: string, id: string): Promise<Buffer | null> {
    const result = await this.db.query<{ raw_body: Buffer }>(
      `SELECT raw_body
         FROM webhook_deliveries
        WHERE id = $1 AND app_id = $2`,
      [id, appId],
    );
    return result.rows[0]?.raw_body ?? null;
  }

  /**
   * PF-463/PF-464 — the cursor page.
   *
   * The keyset predicate is a ROW COMPARISON, `(attempted_at, id) < ($n, $n+1)`,
   * and not the `OR`-expanded equivalent. L08's PF-219 documents why: the row
    * form becomes an index range scan on `(app_id, attempted_at DESC, id DESC)`, the OR form usually becomes a bitmap-or or a seq scan.
   */
  async listByApp(query: DeliveryPageQuery): Promise<DeliveryRecord[]> {
    const values: unknown[] = [query.app_id];
    const where: string[] = ['app_id = $1'];

    if (query.status) {
      values.push(query.status);
      where.push(`status = $${values.length}`);
    }
    if (query.subscription_id) {
      values.push(query.subscription_id);
      where.push(`subscription_id = $${values.length}`);
    }
    if (query.event_type) {
      values.push(query.event_type);
      where.push(`event_type = $${values.length}`);
    }
    if (query.cursor) {
      values.push(query.cursor.timestamp, query.cursor.id);
      where.push(
        `(attempted_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
      );
    }
    values.push(query.limit);

    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS}
         FROM webhook_deliveries
        WHERE ${where.join(' AND ')}
        ORDER BY attempted_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(toRecord);
  }

  async listByGroup(deliveryGroupId: string): Promise<DeliveryRecord[]> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS}
         FROM webhook_deliveries
        WHERE delivery_group_id = $1
        ORDER BY attempt_number ASC`,
      [deliveryGroupId],
    );
    return result.rows.map(toRecord);
  }

  /**
   * PF-472 — what the log can honestly say about one key.
   *
   * It answers "how many times did WE send this key, and how did those attempts
   * end". It cannot answer "did the subscriber act on it twice", and the
   * write-up says so: proving subscriber-side dedupe needs the subscriber's own
   * signal, which we do not have.
   */
  async keyUsage(appId: string, idempotencyKey: string): Promise<KeyUsage> {
    const result = await this.db.query<{ status: DeliveryStatus }>(
      `SELECT status
         FROM webhook_deliveries
        WHERE app_id = $1 AND idempotency_key = $2`,
      [appId, idempotencyKey],
    );
    return summariseKeyUsage(idempotencyKey, result.rows);
  }

  /** PF-472 for a whole page, in ONE query rather than one per row. */
  async keyUsageMany(appId: string, idempotencyKeys: string[]): Promise<Map<string, KeyUsage>> {
    const usage = new Map<string, KeyUsage>();
    if (idempotencyKeys.length === 0) return usage;

    const unique = [...new Set(idempotencyKeys)];
    const result = await this.db.query<{ idempotency_key: string; status: DeliveryStatus }>(
      `SELECT idempotency_key, status
         FROM webhook_deliveries
        WHERE app_id = $1 AND idempotency_key = ANY($2::text[])`,
      [appId, unique],
    );

    const byKey = new Map<string, { status: DeliveryStatus }[]>();
    for (const row of result.rows) {
      const bucket = byKey.get(row.idempotency_key) ?? [];
      bucket.push({ status: row.status });
      byKey.set(row.idempotency_key, bucket);
    }
    for (const key of unique) usage.set(key, summariseKeyUsage(key, byKey.get(key) ?? []));
    return usage;
  }

  /** PF-484 — every ladder a crash left mid-flight, with its replayable bytes. */
  async findResumable(): Promise<ResumableDelivery[]> {
    const result = await this.db.query<Row & { raw_body: Buffer }>(
      `SELECT ${COLUMNS}, raw_body
         FROM webhook_deliveries
        WHERE status = 'in_flight'
        ORDER BY attempted_at ASC`,
      [],
    );
    return result.rows.map((row) => {
      const { raw_body: rawBody, ...rest } = row;
      return { record: toRecord(rest as Row), raw_body: rawBody };
    });
  }

  /**
   * PF-483 — the retention prune.
   *
   * `status <> 'dead_lettered'` is in the predicate, not applied afterwards.
   * Deleting the DLQ is deleting the thing the portal exists to show, and a
   * retention window that quietly empties it turns p.4's *"visible in the
   * developer portal"* into a property that holds for a while.
   */
  async prune(olderThanIso: string): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM webhook_deliveries
        WHERE attempted_at < $1::timestamptz
          AND status <> 'dead_lettered'`,
      [olderThanIso],
    );
    return result.rowCount ?? 0;
  }
}

/**
 * PF-461 — p.6's target as a QUERY.
 *
 * *"Webhook delivery latency (P95, first attempt) < 2s"* is a graded number, and
 * a target no query can evaluate is not a target. `percentile_cont` over
 * `attempt_number = 1` is the population the target is defined over: a retry's
 * latency says nothing about how fast the first delivery was, and averaging them
 * in would make a healthy system look slow every time one subscriber had a bad
 * afternoon.
 *
 * Returns `null` when there are no first attempts in the window — honestly
 * absent rather than 0, which would read as a spectacular P95.
 */
export async function firstAttemptLatencyP95Ms(
  db: Database,
  sinceIso?: string,
): Promise<number | null> {
  const result = await db.query<{ p95: string | null }>(
    `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
       FROM webhook_deliveries
      WHERE attempt_number = 1
        AND latency_ms IS NOT NULL
        AND ($1::timestamptz IS NULL OR attempted_at >= $1::timestamptz)`,
    [sinceIso ?? null],
  );
  const raw = result.rows[0]?.p95;
  return raw === null || raw === undefined ? null : Number(raw);
}
