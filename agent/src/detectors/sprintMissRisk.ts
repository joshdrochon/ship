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
 * ── The end date is COMPUTED, never stored ──────────────────────────────────
 * Ship stores `sprint_number` on the sprint and nothing else date-shaped; the
 * window is derived from `workspaces.sprint_start_date` (`schema.sql:9`) at read
 * time. `weeks.ts:185` and `documents.ts:87,386,743,1116` all say so, and the
 * only implementation of the formula is `computeSprintDates` in
 * `web/src/components/week/WeekTimeline.tsx:20-28`:
 *
 *     start = sprint_start_date + (sprint_number - 1) * 7 days
 *     end   = start + 6 days                        (one-week sprints)
 *
 * This detector used to read `properties->>'end_date'`, a field Ship never
 * writes. It passed its tests only because the fixture wrote that field too, so
 * it was green in CI and permanently silent against real data. The SQL below
 * recomputes the same expression rather than persisting a copy, because a stored
 * end date would drift from the one the UI shows the moment sprint_start_date
 * moves.
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
    `WITH sprint_window AS (
       SELECT s.id,
              s.title,
              s.properties->>'owner_id' AS owner_id,
              -- CASE, not a bare cast: it is the only construct whose evaluation
              -- order Postgres guarantees, so a row whose sprint_number is absent
              -- or non-numeric yields NULL and drops out of the range test below
              -- instead of failing the whole scan with an invalid-input error.
              (w.sprint_start_date
                 + (CASE WHEN s.properties->>'sprint_number' ~ '^[0-9]+$'
                         THEN (s.properties->>'sprint_number')::int - 1 END) * 7
                 + 6)::text AS end_date
         FROM documents s
         JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.workspace_id = $1
          AND s.document_type = 'sprint'
          AND s.archived_at IS NULL
          AND s.deleted_at IS NULL
     )
     SELECT s.id,
            s.title,
            s.end_date,
            s.owner_id,
            COUNT(i.id) FILTER (WHERE i.properties->>'state' = ANY($3)) AS unstarted,
            COUNT(i.id) AS total
       FROM sprint_window s
       LEFT JOIN document_associations da
         ON da.related_id = s.id AND da.relationship_type = 'sprint'
       LEFT JOIN documents i
         ON i.id = da.document_id
        AND i.document_type = 'issue'
        AND i.archived_at IS NULL
        AND i.deleted_at IS NULL
      WHERE s.end_date IS NOT NULL
        -- Ends in the future (or today) but not far off. The business-day rule
        -- is applied below; this is only a cheap calendar-day narrowing.
        AND s.end_date::date >= $2::date
        AND s.end_date::date <= $2::date + INTERVAL '14 days'
      GROUP BY s.id, s.title, s.end_date, s.owner_id`,
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
