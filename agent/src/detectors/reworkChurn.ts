/**
 * Detector 5 — rework churn.
 *
 * "Are we calling things done that aren't?"
 *
 * Issues that went to `done` and came back. PRESEARCH.md use case 5; the human —
 * a Director, at aggregate level — decides whether definition-of-done needs
 * attention.
 *
 * ── The one detector that legitimately reads document_history ───────────────
 * Every other detector was deliberately kept OFF document_history, because it
 * covers six TRACKED_FIELDS from three route files, the bulk path bypasses it,
 * and content writes are throttled — so ABSENCE of a history row proves nothing
 * (PRESEARCH.md Q1).
 *
 * This one is different, and the difference is the direction of the inference.
 * It counts the PRESENCE of `state` transitions. `state` is a tracked field, so
 * the rows that exist are real. An undercount from a missed write path makes
 * this detector quieter, never wrong — it can miss churn, but it cannot invent
 * it. Absence-based detectors have the opposite failure, which is why they use
 * `updated_at` instead.
 *
 * `reopened_at` is used as a second, independent source. It is a column on
 * documents written by getTimestampUpdates() on the done -> in_progress
 * transition, so it survives paths that skip history entirely.
 *
 * ── Aggregated to the project ───────────────────────────────────────────────
 * One signal per project, not per issue. A single reopened issue is noise; a
 * project where several bounce back is a definition-of-done problem, and that is
 * a Director-level conversation rather than a per-issue nudge.
 */
import type { Pool, PoolClient } from 'pg';

import { THRESHOLDS, type Signal } from './types.js';
import { countBucket, fingerprint } from './fingerprint.js';

type Db = Pool | PoolClient;

export async function detectReworkChurn(
  workspaceId: string,
  db: Db,
  now: Date = new Date()
): Promise<Signal[]> {
  const lookbackDays = 30;

  const { rows } = await db.query(
    `WITH reopened AS (
       -- Two independent sources, unioned so a write path that skips one is
       -- still caught by the other.
       SELECT DISTINCT i.id, i.title, i.properties->>'assignee_id' AS assignee_id
         FROM documents i
         JOIN document_history h ON h.document_id = i.id
        WHERE i.workspace_id = $1
          AND i.document_type = 'issue'
          AND i.archived_at IS NULL
          AND i.deleted_at IS NULL
          AND h.field = 'state'
          AND h.old_value = 'done'
          AND h.new_value IN ('in_progress', 'todo', 'in_review')
          AND h.created_at > $2::timestamptz - ($3 || ' days')::interval

       UNION

       SELECT DISTINCT i.id, i.title, i.properties->>'assignee_id' AS assignee_id
         FROM documents i
        WHERE i.workspace_id = $1
          AND i.document_type = 'issue'
          AND i.archived_at IS NULL
          AND i.deleted_at IS NULL
          AND i.reopened_at IS NOT NULL
          AND i.reopened_at > $2::timestamptz - ($3 || ' days')::interval
     )
     SELECT p.id           AS project_id,
            p.title        AS project_title,
            p.properties->>'owner_id' AS owner_id,
            COUNT(DISTINCT r.id)::int AS reopened_count,
            ARRAY_AGG(DISTINCT r.title) AS titles
       FROM reopened r
       JOIN document_associations da
         ON da.document_id = r.id AND da.relationship_type = 'project'
       JOIN documents p
         ON p.id = da.related_id AND p.document_type = 'project'
      WHERE p.workspace_id = $1
        AND p.archived_at IS NULL
        AND p.deleted_at IS NULL
      GROUP BY p.id, p.title, p.properties`,
    [workspaceId, now.toISOString(), lookbackDays]
  );

  const signals: Signal[] = [];

  for (const r of rows) {
    const count = r.reopened_count;
    if (count < THRESHOLDS.REWORK_CHURN_REOPENS) continue;

    const bucket = countBucket(count);
    signals.push({
      type: 'rework_churn',
      targetId: r.project_id,
      targetType: 'project',
      targetTitle: r.project_title,
      measurement: count,
      threshold: THRESHOLDS.REWORK_CHURN_REOPENS,
      bucket,
      fingerprint: fingerprint('rework_churn', r.project_id, bucket),
      context: {
        reopened_issues: count,
        lookback_days: lookbackDays,
        examples: (r.titles as string[]).slice(0, 3).join('; '),
      },
      // Project owner. A Director hears aggregates, never individual issues
      // (PRESEARCH.md Q6).
      accountableUserId: r.owner_id ?? null,
    });
  }

  return signals;
}
