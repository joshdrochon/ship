/**
 * Detector 2 — sprint-miss risk.
 *
 * "Are we going to make it?"
 *
 * A sprint whose end date is within N business days while issues attached to it
 * are still `todo` or `backlog` — work that has not started with almost no time
 * left. PRESEARCH.md use case 2; the human decides whether to descope, reassign,
 * or move the date.
 *
 * ── The signal is about the SPRINT, not the issues ──────────────────────────
 * One signal per sprint carrying a count, not one per unstarted issue. A sprint
 * with nine unstarted issues is one decision for one person, not nine
 * notifications. This is also why the accountable party here is the sprint owner
 * rather than any assignee (PRESEARCH.md Q6) — the issues may have no assignee
 * at all, which is frequently the point.
 *
 * ── Associations, not legacy columns ────────────────────────────────────────
 * Issue→sprint is resolved through `document_associations` with
 * relationship_type = 'sprint'. The legacy `sprint_id` column was dropped by
 * migration 027 and `program_id`/`project_id` by 029. A detector reading those
 * would find nothing and cheerfully report every sprint as clean.
 */
import type { Queryable } from '../data/queryable.js';
import { businessDaysBetween } from '@ship/shared';

import { THRESHOLDS, type Signal } from './types.js';
import { countBucket, fingerprint } from './fingerprint.js';

type Db = Queryable;

/** States that mean work has not been picked up. */
const UNSTARTED = ['todo', 'backlog'];

export async function detectSprintMissRisk(
  workspaceId: string,
  db: Db,
  now: Date = new Date()
): Promise<Signal[]> {
  const today = now.toISOString().slice(0, 10);

  const { rows } = await db.query(
    `SELECT s.id,
            s.title,
            s.properties->>'end_date' AS end_date,
            s.properties->>'owner_id' AS owner_id,
            COUNT(i.id) FILTER (WHERE i.properties->>'state' = ANY($3)) AS unstarted,
            COUNT(i.id) AS total
       FROM documents s
       LEFT JOIN document_associations da
         ON da.related_id = s.id AND da.relationship_type = 'sprint'
       LEFT JOIN documents i
         ON i.id = da.document_id
        AND i.document_type = 'issue'
        AND i.archived_at IS NULL
        AND i.deleted_at IS NULL
      WHERE s.workspace_id = $1
        AND s.document_type = 'sprint'
        AND s.archived_at IS NULL
        AND s.deleted_at IS NULL
        AND s.properties->>'end_date' IS NOT NULL
        -- Ends in the future (or today) but not far off. The business-day rule
        -- is applied below; this is only a cheap calendar-day narrowing.
        AND (s.properties->>'end_date')::date >= $2::date
        AND (s.properties->>'end_date')::date <= $2::date + INTERVAL '14 days'
      GROUP BY s.id, s.title, s.properties`,
    [workspaceId, today, UNSTARTED]
  );

  const signals: Signal[] = [];

  for (const r of rows) {
    const unstarted = Number(r.unstarted);
    if (unstarted === 0) continue;

    const daysLeft = businessDaysBetween(today, r.end_date);
    if (daysLeft > THRESHOLDS.SPRINT_MISS_DAYS) continue;

    const bucket = countBucket(unstarted);
    signals.push({
      type: 'sprint_miss_risk',
      targetId: r.id,
      targetType: 'sprint',
      targetTitle: r.title,
      measurement: unstarted,
      threshold: THRESHOLDS.SPRINT_MISS_DAYS,
      bucket,
      fingerprint: fingerprint('sprint_miss_risk', r.id, bucket),
      context: {
        unstarted_issues: unstarted,
        total_issues: Number(r.total),
        business_days_left: daysLeft,
        end_date: r.end_date,
      },
      accountableUserId: r.owner_id ?? null,
    });
  }

  return signals;
}
