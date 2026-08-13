/**
 * PF-458/PF-459/PF-473 — the delivery log: its row type, its port, and the
 * in-memory implementation.
 *
 * PRD p.4, Delivery Log: *"webhook_deliveries table records every attempt with
 * subscription_id, event_id, attempt_number, response_status, response_excerpt,
 * latency_ms. Queryable per app."*
 *
 * The Postgres implementation and the migration are in `pgDeliveryLog.ts` and
 * migration 051. This file is the port and the double, and both go through one
 * shared contract suite (`deliveryLogContract.ts`) — the same discipline L15 used
 * for `IWebhookSubscriptionRepo`, and for the same reason: a double that agrees
 * with its production sibling only by coincidence proves nothing about the tests
 * written against it.
 *
 * ─── `status` has FIVE values, and PF-473's list of four was one short ───────
 *
 * The ticket says `status IN ('in_flight','delivered','dead_lettered','cancelled')`.
 * That set has no value for the row that Testing Scenario 7 asserts on: attempts
 * 1–3 of a 500/500/500/200 run each failed, none of them is terminal, and none of
 * them is `in_flight` any more. Under the one-row-per-attempt model p.4 requires,
 * `failed` is not an extra state — it is the state most rows in a retrying
 * delivery are in.
 *
 * So: `failed` = this attempt failed and another is scheduled; `dead_lettered` =
 * this attempt failed and there will not be another. The DLQ is still exactly
 * `WHERE status = 'dead_lettered'`, which is what PF-473 was protecting, and it is
 * still a column rather than a second table.
 *
 * ─── Finding F53 ─────────────────────────────────────────────────────────────
 *
 * `DeliveryStatus` and `WebhookDelivery` were stale sketch types in
 * `platform/apps/types.ts` with zero consumers. Both directories are re-exported
 * through `platform/index.ts`, so declaring `DeliveryStatus` here made the
 * duplicate name a TS2308 BUILD failure rather than a style problem. L15 removed
 * the one that collided with its own work and left these two, correctly, for this
 * lane. They are deleted in the same commit as this file.
 */
import type { KeysetRow } from '../api/v1/pagination.js';

/**
 * PF-473. See the header for why there are five and not four.
 *
 * `cancelled` is deliberately distinct from `dead_lettered`: an operator who
 * switched a subscription off did not get a delivery failure, and a DLQ that
 * fills up with their own deactivations is a DLQ nobody reads.
 */
export type DeliveryStatus =
  | 'in_flight'
  | 'delivered'
  | 'failed'
  | 'dead_lettered'
  | 'cancelled';

/**
 * PF-474 — exactly three ways into the DLQ, and the column records which.
 *
 * The ticket names two; `circuit_open` is the third and arrives with PF-482's
 * per-subscription breaker. It is in the union from the start rather than added
 * later, because the CHECK constraint in migration 051 is what enumerates them
 * and widening a CHECK is a migration.
 *
 * Why the distinction is worth a column: "this subscriber has been down for six
 * minutes", "this subscriber returned 410 and is never coming back" and "this
 * subscriber is broken badly enough that we stopped trying at all" are three
 * different operator actions.
 */
export type DlqReason = 'max_attempts_exhausted' | 'permanent_status' | 'circuit_open';

export const DLQ_REASONS: readonly DlqReason[] = [
  'max_attempts_exhausted',
  'permanent_status',
  'circuit_open',
];

export const DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'in_flight',
  'delivered',
  'failed',
  'dead_lettered',
  'cancelled',
];

/**
 * One attempt. One row.
 *
 * `created_at` is present alongside `attempted_at` and carries the same value:
 * `KeysetRow` (L08's PF-217 codec) requires the name `created_at`, and PF-458
 * requires the column to be called `attempted_at` because that is what the
 * retention prune reads. Aliasing in the projection rather than renaming either
 * one keeps both contracts literal.
 */
export interface DeliveryRecord extends KeysetRow {
  id: string;
  /**
   * The ladder this attempt belongs to. See `beginAttempt` — it is what makes
   * `UNIQUE (delivery_group_id, attempt_number)` a correct constraint for a
   * replay, which restarts at attempt 1 against the same (subscription, event).
   */
  delivery_group_id: string;
  subscription_id: string;
  event_id: string;
  /**
   * Denormalised from the subscription, so `?event_type=` on PF-464 is a filter
   * and not a join. It also survives the subscription being cascade-deleted with
   * its app, which is the case where a delivery log is most worth having.
   */
  event_type: string;
  attempt_number: number;
  status: DeliveryStatus;
  /** NULL means no response arrived — a timeout has no status. */
  response_status: number | null;
  /** PF-460. First 256 chars of the BODY, `''` for an empty body, NULL for none. */
  response_excerpt: string | null;
  /** PF-461. NULL until the attempt completes. */
  latency_ms: number | null;
  /** PF-470. Written at attempt 1 and READ thereafter — never recomputed. */
  idempotency_key: string;
  dlq_reason: DlqReason | null;
  attempted_at: string;
  created_at: string;
  /**
   * Finding B9 (L19). The `Ship-Signature` value actually sent on THIS attempt.
   *
   * L19's `ship webhooks tail --poll` cannot honestly print "signature verified
   * ✓" without it: the long-poll path has the body and the secret but no header
   * to check them against, because the signature is minted per attempt (L15
   * PF-442) and is not derivable from the row. One nullable column is what B9
   * asked for; the alternative it offered was the CLI printing "not verifiable
   * in poll mode", which is strictly worse for the same storage.
   *
   * It is not a secret: it is the MAC that already went over the wire, and it
   * discloses nothing the subscriber does not already hold.
   */
  signature_header: string | null;
  /** PF-477. Set on a replay's rows; NULL on an original delivery's. */
  replay_of_delivery_id: string | null;
}

export interface BeginAttemptInput {
  delivery_group_id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  attempt_number: number;
  idempotency_key: string;
  signature_header: string | null;
  replay_of_delivery_id: string | null;
  /**
   * PF-475 — the exact signed bytes, stored on EVERY attempt's row.
   *
   * The ticket asks for it on the attempt-1 row only. Stored on all of them
   * instead, because "read the body off attempt 1" is a second lookup that the
   * re-drive path (PF-484) and the replay path both have to remember, and
   * because at 6 attempts the duplication is bounded by the same fanout PF-483
   * already sizes. The alternative — a nullable column populated on one row per
   * group — makes every reader handle a NULL that means "look somewhere else".
   */
  raw_body: Buffer;
  /** From the injected `Clock`, never `now()` in SQL — see PF-456. */
  attempted_at: string;
}

export interface CompleteAttemptInput {
  status: Exclude<DeliveryStatus, 'in_flight'>;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  dlq_reason: DlqReason | null;
}

/** PF-464's filters. Every field is optional; all present fields AND together. */
export interface DeliveryPageQuery {
  app_id: string;
  limit: number;
  cursor: { timestamp: string; id: string } | null;
  status?: DeliveryStatus;
  subscription_id?: string;
  event_type?: string;
}

/** PF-472 — what the delivery log can honestly say about one idempotency key. */
export interface KeyUsage {
  idempotency_key: string;
  /** How many times we SENT this key. Not how many times it was processed. */
  attempt_count: number;
  /** The distinct terminal statuses those attempts reached, sorted. */
  terminal_statuses: DeliveryStatus[];
}

/** PF-484 — an interrupted ladder, as the boot-time re-drive needs it. */
export interface ResumableDelivery {
  record: DeliveryRecord;
  raw_body: Buffer;
}

export class DuplicateAttemptError extends Error {
  constructor(
    readonly deliveryGroupId: string,
    readonly attemptNumber: number,
  ) {
    super(
      `Attempt ${attemptNumber} of delivery group ${deliveryGroupId} is already ` +
        `recorded. PF-462: one row per attempt is what makes at-least-once auditable — ` +
        `a second row for the same attempt makes every count derived from this log ` +
        `(attempts-until-success, DLQ eligibility, the p.6 retry success rate) quietly ` +
        `wrong. The re-drive path resumes from the stored attempt rather than inserting.`,
    );
    this.name = 'DuplicateAttemptError';
  }
}

/**
 * The port. Two implementations: `InMemoryDeliveryLog` below and
 * `PgDeliveryLog` on migration 051.
 *
 * No `pg` and no Express in any signature, for L15's reason: the scheduler runs
 * from a bus handler with no request in sight, and a port that returned a
 * `QueryResult` would put node-postgres in the type of every consumer.
 */
export interface IDeliveryLog {
  /** PF-459 — INSERT `in_flight`, BEFORE the HTTP call. */
  beginAttempt(input: BeginAttemptInput): Promise<DeliveryRecord>;
  /** UPDATE with the outcome. Throws if the row is not `in_flight`. */
  completeAttempt(id: string, outcome: CompleteAttemptInput): Promise<DeliveryRecord>;
  /** PF-478 — app-scoped. `app_id` is a PARAMETER, so a foreign id cannot return. */
  getById(appId: string, id: string): Promise<DeliveryRecord | null>;
  /** The stored signed bytes for a delivery id, app-scoped. PF-475. */
  getRawBody(appId: string, id: string): Promise<Buffer | null>;
  /** PF-463/PF-464 — cursor page, newest first, joined to the owning app. */
  listByApp(query: DeliveryPageQuery): Promise<DeliveryRecord[]>;
  /** Every row of one ladder, oldest first. Used by replay and by the tests. */
  listByGroup(deliveryGroupId: string): Promise<DeliveryRecord[]>;
  /** PF-472 — attempts and terminal statuses per key, app-scoped. */
  keyUsage(appId: string, idempotencyKey: string): Promise<KeyUsage>;
  /** PF-484 — ladders left `in_flight` by a crash. */
  findResumable(): Promise<ResumableDelivery[]>;
  /** PF-483 — delete rows older than the window, never an unreplayed DLQ row. */
  prune(olderThanIso: string): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The in-memory implementation
// ─────────────────────────────────────────────────────────────────────────────

interface StoredRow extends DeliveryRecord {
  raw_body: Buffer;
  app_id: string;
}

/**
 * The double. Records rows in an array and answers the same questions.
 *
 * It needs an `app_id` per subscription to answer `listByApp`, and it has no
 * database to join through — so it takes a resolver. That is the honest shape:
 * the Postgres implementation joins `webhook_deliveries → webhook_subscriptions`,
 * and the double is told the same fact rather than inventing one.
 */
export class InMemoryDeliveryLog implements IDeliveryLog {
  private readonly rows: StoredRow[] = [];
  private counter = 0;

  constructor(
    /** subscription id → owning app id. PF-463's join, as a function. */
    private readonly appIdFor: (subscriptionId: string) => string,
  ) {}

  private nextId(): string {
    this.counter += 1;
    // A syntactically valid UUID so a test can round-trip it through a route
    // that validates `:id` as one.
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }

  beginAttempt(input: BeginAttemptInput): Promise<DeliveryRecord> {
    const clash = this.rows.find(
      (r) =>
        r.delivery_group_id === input.delivery_group_id &&
        r.attempt_number === input.attempt_number,
    );
    if (clash) {
      return Promise.reject(
        new DuplicateAttemptError(input.delivery_group_id, input.attempt_number),
      );
    }
    const row: StoredRow = {
      id: this.nextId(),
      delivery_group_id: input.delivery_group_id,
      subscription_id: input.subscription_id,
      event_id: input.event_id,
      event_type: input.event_type,
      attempt_number: input.attempt_number,
      status: 'in_flight',
      response_status: null,
      response_excerpt: null,
      latency_ms: null,
      idempotency_key: input.idempotency_key,
      dlq_reason: null,
      attempted_at: input.attempted_at,
      created_at: input.attempted_at,
      signature_header: input.signature_header,
      replay_of_delivery_id: input.replay_of_delivery_id,
      raw_body: input.raw_body,
      app_id: this.appIdFor(input.subscription_id),
    };
    this.rows.push(row);
    return Promise.resolve(project(row));
  }

  completeAttempt(id: string, outcome: CompleteAttemptInput): Promise<DeliveryRecord> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.reject(new Error(`No delivery row ${id}.`));
    if (row.status !== 'in_flight') {
      return Promise.reject(
        new Error(
          `Delivery row ${id} is already ${row.status}; only an in_flight attempt can be ` +
            `completed. A second completion would rewrite a terminal fact.`,
        ),
      );
    }
    row.status = outcome.status;
    row.response_status = outcome.response_status;
    row.response_excerpt = outcome.response_excerpt;
    row.latency_ms = outcome.latency_ms;
    row.dlq_reason = outcome.dlq_reason;
    return Promise.resolve(project(row));
  }

  getById(appId: string, id: string): Promise<DeliveryRecord | null> {
    const row = this.rows.find((r) => r.id === id && r.app_id === appId);
    return Promise.resolve(row ? project(row) : null);
  }

  getRawBody(appId: string, id: string): Promise<Buffer | null> {
    const row = this.rows.find((r) => r.id === id && r.app_id === appId);
    return Promise.resolve(row ? row.raw_body : null);
  }

  listByApp(query: DeliveryPageQuery): Promise<DeliveryRecord[]> {
    const filtered = this.rows
      .filter((r) => r.app_id === query.app_id)
      .filter((r) => (query.status ? r.status === query.status : true))
      .filter((r) => (query.subscription_id ? r.subscription_id === query.subscription_id : true))
      .filter((r) => (query.event_type ? r.event_type === query.event_type : true))
      .filter((r) => {
        if (!query.cursor) return true;
        // The same row comparison the SQL uses: (attempted_at, id) < (t, id).
        if (r.attempted_at !== query.cursor.timestamp) {
          return r.attempted_at < query.cursor.timestamp;
        }
        return r.id < query.cursor.id;
      })
      .sort((a, b) =>
        a.attempted_at === b.attempted_at
          ? b.id.localeCompare(a.id)
          : b.attempted_at.localeCompare(a.attempted_at),
      );
    return Promise.resolve(filtered.slice(0, query.limit).map(project));
  }

  listByGroup(deliveryGroupId: string): Promise<DeliveryRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.delivery_group_id === deliveryGroupId)
        .sort((a, b) => a.attempt_number - b.attempt_number)
        .map(project),
    );
  }

  keyUsage(appId: string, idempotencyKey: string): Promise<KeyUsage> {
    const matching = this.rows.filter(
      (r) => r.app_id === appId && r.idempotency_key === idempotencyKey,
    );
    return Promise.resolve(summariseKeyUsage(idempotencyKey, matching));
  }

  findResumable(): Promise<ResumableDelivery[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.status === 'in_flight')
        .map((r) => ({ record: project(r), raw_body: r.raw_body })),
    );
  }

  prune(olderThanIso: string): Promise<number> {
    const doomed = this.rows.filter((r) => r.attempted_at < olderThanIso && retainable(r));
    for (const row of doomed) this.rows.splice(this.rows.indexOf(row), 1);
    return Promise.resolve(doomed.length);
  }

  /** Every row, for assertions that want the whole log. Tests only. */
  all(): DeliveryRecord[] {
    return this.rows.map(project);
  }
}

/**
 * PF-483's retention rule, shared by both implementations so they cannot
 * disagree about what is prunable.
 *
 * A `dead_lettered` row that has NOT been replayed is never pruned. Deleting the
 * DLQ is deleting the thing the portal exists to show, and a retention window
 * that quietly empties it turns "visible in the developer portal" (p.4) into a
 * property that holds for a while.
 */
export function retainable(row: Pick<DeliveryRecord, 'status'>): boolean {
  return row.status !== 'dead_lettered';
}

/** Terminal statuses, sorted and deduplicated. Shared by both implementations. */
export function summariseKeyUsage(
  idempotencyKey: string,
  rows: Pick<DeliveryRecord, 'status'>[],
): KeyUsage {
  const terminal = rows
    .map((r) => r.status)
    .filter((s): s is DeliveryStatus => s !== 'in_flight');
  return {
    idempotency_key: idempotencyKey,
    attempt_count: rows.length,
    terminal_statuses: [...new Set(terminal)].sort(),
  };
}

/** Strips `raw_body` and `app_id`. The body is fetched deliberately, never leaked. */
function project(row: StoredRow): DeliveryRecord {
  const { raw_body: _body, app_id: _app, ...rest } = row;
  return { ...rest };
}
