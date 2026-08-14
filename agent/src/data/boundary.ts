/**
 * The agent/Ship data boundary. Every query that touches BOTH FleetGraph tables
 * and Ship tables lives in this file and nowhere else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS — read before adding a query elsewhere
 *
 * FleetGraph stores its state in Ship's database rather than its own. That was a
 * deliberate choice (PRESEARCH.md Q19): the state is small, relational, and
 * joins to `documents` and `users`, so a separate store would mean giving up
 * those joins and maintaining a second backup story for no gain.
 *
 * It is a reversible choice ONLY while the joins are contained. If
 * `fleetgraph_observations JOIN documents` gets written inline across detector
 * and delivery code, splitting the database later stops being a config change
 * and becomes an archaeology exercise. Forty scattered joins is forty places to
 * find, and the risk is missing three.
 *
 * So: cross-boundary queries go here. Detector SQL that only reads Ship tables
 * belongs in `detectors/`. Pure agent-table bookkeeping could live anywhere, but
 * keeping it here too means one file answers "what does the agent touch".
 *
 * THE REVERSAL PATH, concretely. To move agent state to its own database:
 *   1. every function below takes a second pool, or this module is split in two
 *   2. the joins in `loadSuppressionSet` and `listOpenNotifications` become
 *      two queries and an in-memory stitch
 *   3. nothing outside this file changes
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Queryable } from './queryable.js';
import { getPool } from './pool.js';

type Db = Queryable;

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

export interface Watermark {
  workspaceId: string;
  lastScannedAt: Date | null;
  lastRunCompletedAt: Date | null;
}

/**
 * Where the last COMPLETED scan got to. A null `lastScannedAt` means this
 * workspace has never been scanned; callers bound the first run by a lookback
 * window rather than scanning all history.
 */
export async function getWatermark(workspaceId: string, db: Db = getPool()): Promise<Watermark> {
  const { rows } = await db.query(
    `SELECT workspace_id, last_scanned_at, last_run_completed_at
       FROM fleetgraph_watermarks
      WHERE workspace_id = $1`,
    [workspaceId]
  );
  const row = rows[0];
  return {
    workspaceId,
    lastScannedAt: row?.last_scanned_at ?? null,
    lastRunCompletedAt: row?.last_run_completed_at ?? null,
  };
}

/**
 * Advance the watermark. Call this ONLY after a run has fully completed —
 * delivery included.
 *
 * This is what makes the proactive path crash-safe with no retry logic
 * (PRESEARCH.md Q24). An aborted run leaves the mark where it was, so the next
 * scan re-covers the same window. Advancing optimistically and retrying failures
 * would lose findings permanently on a crash between the advance and delivery.
 */
export async function setWatermark(
  workspaceId: string,
  scannedThrough: Date,
  signalCount: number,
  db: Db = getPool()
): Promise<void> {
  await db.query(
    `INSERT INTO fleetgraph_watermarks
       (workspace_id, last_scanned_at, last_run_completed_at, last_run_signal_count, updated_at)
     VALUES ($1, $2, NOW(), $3, NOW())
     ON CONFLICT (workspace_id) DO UPDATE
       SET last_scanned_at = EXCLUDED.last_scanned_at,
           last_run_completed_at = EXCLUDED.last_run_completed_at,
           last_run_signal_count = EXCLUDED.last_run_signal_count,
           updated_at = NOW()`,
    [workspaceId, scannedThrough, signalCount]
  );
}

// ---------------------------------------------------------------------------
// Observations — the agent's memory
// ---------------------------------------------------------------------------

export type Resolution = 'accepted' | 'dismissed' | 'resolved' | 'snoozed';

export interface SuppressedFinding {
  fingerprint: string;
  signalType: string;
  targetId: string;
  targetTitle: string | null;
  firstSeenAt: Date;
  lastSurfacedAt: Date | null;
  escalationCount: number;
}

/**
 * Findings already surfaced and still open, so the graph does not re-judge them.
 *
 * CROSS-BOUNDARY: joins fleetgraph_observations to documents for the title.
 * The title is here rather than fetched separately because the judgment prompt
 * needs it and a second round-trip per finding is the wrong trade at this size.
 *
 * Dismissed findings are excluded permanently and deliberately: a dismissed
 * finding that returns next week is the fastest route to the agent being turned
 * off (PRESEARCH.md Q23). Snoozed ones are excluded only until their horizon.
 */
export async function loadSuppressionSet(
  workspaceId: string,
  db: Db = getPool()
): Promise<Map<string, SuppressedFinding>> {
  const { rows } = await db.query(
    `SELECT o.fingerprint,
            o.signal_type,
            o.target_id,
            d.title AS target_title,
            o.first_seen_at,
            o.last_surfaced_at,
            o.escalation_count
       FROM fleetgraph_observations o
       LEFT JOIN documents d ON d.id = o.target_id
      WHERE o.workspace_id = $1
        AND (
          o.resolution IS NULL
          OR o.resolution = 'dismissed'
          OR (o.resolution = 'snoozed' AND o.snooze_until > NOW())
        )`,
    [workspaceId]
  );

  return new Map(
    rows.map((r) => [
      r.fingerprint as string,
      {
        fingerprint: r.fingerprint,
        signalType: r.signal_type,
        targetId: r.target_id,
        targetTitle: r.target_title,
        firstSeenAt: r.first_seen_at,
        lastSurfacedAt: r.last_surfaced_at,
        escalationCount: r.escalation_count,
      },
    ])
  );
}

/**
 * Record that a finding was surfaced.
 *
 * Upsert on the unique (workspace_id, fingerprint) index — the suppression key.
 * If that index is ever dropped this silently becomes an insert-every-run, one
 * finding turns into 480 model calls a day, and the only symptom is a cost
 * graph. PRESEARCH.md Q32 names it as the largest cliff in the design; the
 * constraint and its regression test are what hold it.
 */
export async function recordObservation(
  params: {
    workspaceId: string;
    fingerprint: string;
    signalType: string;
    targetId: string;
    targetType: string;
  },
  db: Db = getPool()
): Promise<{ id: string; isNew: boolean }> {
  const { rows } = await db.query(
    `INSERT INTO fleetgraph_observations
       (workspace_id, fingerprint, signal_type, target_id, target_type, last_surfaced_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (workspace_id, fingerprint) DO UPDATE
       SET last_surfaced_at = NOW(), updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
    [params.workspaceId, params.fingerprint, params.signalType, params.targetId, params.targetType]
  );
  return { id: rows[0].id, isNew: rows[0].is_new };
}

/**
 * A finding whose notification is still sitting unanswered, with the one hop up
 * `reports_to` already resolved.
 *
 * CROSS-BOUNDARY: joins fleetgraph_observations and fleetgraph_notifications to
 * `documents` (the recipient's person document, for `reports_to`) and to
 * `users` (for the name the escalation body has to say out loud). Resolving the
 * hop here rather than in the node keeps the whole org-chart walk in the one
 * file that is allowed to know both schemas.
 *
 * Three predicates, and each is load-bearing:
 *
 *   o.resolution IS NULL   the human has not accepted, dismissed, or snoozed it
 *   n.state = 'pending'    they were told and have not acknowledged
 *   o.escalation_count = 0 it has not already made its one hop (Q6)
 *
 * The last one is what makes "at most once" a property of the query rather than
 * of a caller remembering to check.
 *
 * `DISTINCT ON (o.id) ... ORDER BY n.created_at ASC` picks the FIRST pending
 * notification for a finding. That is the clock the 2-business-day rule runs
 * against — when the accountable person was told, not when the observation was
 * first recorded, which can be earlier if the notification write failed on a
 * previous run.
 *
 * `reports_to` comes back as text, not `::uuid`. It is a free-form JSONB
 * property that only an admin can set (`routes/documents.ts`), and casting it
 * in the query would let one malformed row take down the escalation scan for
 * the whole workspace. Cast at the point of use, where the blast radius is one
 * finding.
 */
export interface EscalationCandidate {
  observationId: string;
  fingerprint: string;
  signalType: string;
  targetId: string;
  notificationId: string;
  title: string;
  body: string | null;
  recipientUserId: string;
  recipientName: string | null;
  /** When the accountable person was told. The escalation clock starts here. */
  notifiedAt: Date;
  /** One hop up. Null when nobody is above them — the top of the chain. */
  escalateToUserId: string | null;
}

export async function loadEscalationCandidates(
  workspaceId: string,
  db: Db = getPool()
): Promise<EscalationCandidate[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (o.id)
            o.id            AS observation_id,
            o.fingerprint,
            o.signal_type,
            o.target_id,
            n.id            AS notification_id,
            n.title,
            n.body,
            n.recipient_user_id,
            n.created_at    AS notified_at,
            u.name          AS recipient_name,
            person.properties->>'reports_to' AS escalate_to_user_id
       FROM fleetgraph_observations o
       JOIN fleetgraph_notifications n
         ON n.observation_id = o.id
        AND n.state = 'pending'
       LEFT JOIN users u ON u.id = n.recipient_user_id
       LEFT JOIN documents person
         ON person.workspace_id = o.workspace_id
        AND person.document_type = 'person'
        AND person.deleted_at IS NULL
        AND person.properties->>'user_id' = n.recipient_user_id::text
      WHERE o.workspace_id = $1
        AND o.resolution IS NULL
        AND o.escalation_count = 0
      ORDER BY o.id, n.created_at ASC`,
    [workspaceId]
  );

  return rows.map((r) => ({
    observationId: r.observation_id,
    fingerprint: r.fingerprint,
    signalType: r.signal_type,
    targetId: r.target_id,
    notificationId: r.notification_id,
    title: r.title,
    body: r.body,
    recipientUserId: r.recipient_user_id,
    recipientName: r.recipient_name,
    notifiedAt: r.notified_at,
    escalateToUserId: r.escalate_to_user_id,
  }));
}

/**
 * Make the one hop: claim the escalation and notify the person above, in a
 * single statement.
 *
 * ── Why one statement rather than two calls ────────────────────────────────
 * The two halves must not come apart. Increment first and crash, and the
 * finding is marked escalated with nobody told — permanently, because
 * `escalation_count = 0` will never match again. Notify first and crash, and
 * the next run escalates the same finding a second time, which is the one thing
 * "at most once" forbids.
 *
 * A transaction is not available here: `Queryable` is satisfied by a `Pool`,
 * where consecutive queries may land on different connections, so `BEGIN` and
 * `COMMIT` would not necessarily bracket the same session. A single statement
 * with the INSERT fed from the UPDATE's `RETURNING` is atomic by construction
 * and needs no connection pinning.
 *
 * ── Why it is idempotent under the watermark model ─────────────────────────
 * `WHERE escalation_count = 0` is a compare-and-set. A rerun of the same window
 * — which is exactly what `deliver` guarantees will happen after a crash, since
 * the watermark only advances on completion (Q24) — matches zero rows, inserts
 * nothing, and returns null. Same reasoning as the observation upsert: the
 * re-run is duplicate work, never a duplicate notification.
 *
 * @returns the new notification's id, or null if it had already escalated.
 */
export async function escalateObservation(
  params: {
    workspaceId: string;
    observationId: string;
    escalateToUserId: string;
    title: string;
    body?: string | null;
    targetId?: string | null;
  },
  db: Db = getPool()
): Promise<string | null> {
  const { rows } = await db.query(
    `WITH claimed AS (
       UPDATE fleetgraph_observations
          SET escalation_count = escalation_count + 1,
              updated_at = NOW()
        WHERE id = $2
          AND workspace_id = $1
          AND resolution IS NULL
          AND escalation_count = 0
       RETURNING id
     )
     INSERT INTO fleetgraph_notifications
       (workspace_id, observation_id, recipient_user_id, title, body, target_id)
     SELECT $1, claimed.id, $3::uuid, $4, $5, $6
       FROM claimed
     RETURNING id`,
    [
      params.workspaceId,
      params.observationId,
      params.escalateToUserId,
      params.title,
      params.body ?? null,
      params.targetId ?? null,
    ]
  );
  return rows[0]?.id ?? null;
}

/** Close a finding. `dismissed` is permanent for this fingerprint. */
export async function resolveObservation(
  id: string,
  resolution: Resolution,
  snoozeUntil: Date | null = null,
  db: Db = getPool()
): Promise<void> {
  await db.query(
    `UPDATE fleetgraph_observations
        SET resolution = $2,
            resolved_at = CASE WHEN $2 = 'snoozed' THEN NULL ELSE NOW() END,
            snooze_until = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [id, resolution, snoozeUntil]
  );
}

// ---------------------------------------------------------------------------
// Notifications — the delivery channel Ship has never had
// ---------------------------------------------------------------------------

export interface OpenNotification {
  id: string;
  title: string;
  body: string | null;
  targetId: string | null;
  targetTitle: string | null;
  targetType: string | null;
  pendingThreadId: string | null;
  createdAt: Date;
}

/**
 * Create a notification for exactly one accountable person.
 *
 * The recipient is resolved by accountability for the signal, not proximity to
 * it (PRESEARCH.md Q6) — that resolution happens in the graph; this only stores
 * the result. One recipient, never a list: a notification everyone receives is
 * one nobody closes.
 */
export async function createNotification(
  params: {
    workspaceId: string;
    observationId: string;
    recipientUserId: string;
    title: string;
    body?: string | null;
    targetId?: string | null;
    pendingThreadId?: string | null;
    /**
     * L23 PF-702 — `'finding'` (default) or `'recommendation'`.
     *
     * Optional, and defaulting to the column's own default, so every existing
     * caller means exactly what it meant before this parameter existed. The
     * only caller that passes `'recommendation'` is the read-only act
     * implementation, which is the whole population the distinction exists for.
     */
    kind?: 'finding' | 'recommendation';
  },
  db: Db = getPool()
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO fleetgraph_notifications
       (workspace_id, observation_id, recipient_user_id, title, body, target_id,
        pending_thread_id, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.workspaceId,
      params.observationId,
      params.recipientUserId,
      params.title,
      params.body ?? null,
      params.targetId ?? null,
      params.pendingThreadId ?? null,
      params.kind ?? 'finding',
    ]
  );
  return rows[0].id;
}

/**
 * A user's open notifications.
 *
 * CROSS-BOUNDARY: joins fleetgraph_notifications to documents so the UI can name
 * and link the thing each finding is about without a second call per row.
 */
export async function listOpenNotifications(
  recipientUserId: string,
  workspaceId: string,
  db: Db = getPool()
): Promise<OpenNotification[]> {
  const { rows } = await db.query(
    `SELECT n.id, n.title, n.body, n.target_id, n.pending_thread_id, n.created_at,
            d.title AS target_title,
            d.document_type AS target_type
       FROM fleetgraph_notifications n
       LEFT JOIN documents d ON d.id = n.target_id
      WHERE n.recipient_user_id = $1
        AND n.workspace_id = $2
        AND n.state = 'pending'
      ORDER BY n.created_at DESC`,
    [recipientUserId, workspaceId]
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    targetId: r.target_id,
    targetTitle: r.target_title,
    targetType: r.target_type,
    pendingThreadId: r.pending_thread_id,
    createdAt: r.created_at,
  }));
}

/** Mark a notification acknowledged. Idempotent. */
export async function acknowledgeNotification(id: string, db: Db = getPool()): Promise<void> {
  await db.query(
    `UPDATE fleetgraph_notifications
        SET state = 'acknowledged', acknowledged_at = NOW()
      WHERE id = $1 AND state = 'pending'`,
    [id]
  );
}
