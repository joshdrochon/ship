/**
 * Detector 1 — stalled work.
 *
 * "This says it's being worked on. Is it?"
 *
 * An issue in `in_progress` whose `updated_at` has not moved for N business days.
 * PRESEARCH.md use case 1; the human decides whether it is blocked,
 * done-but-unmarked, or abandoned.
 *
 * ── Why `updated_at` and not `document_history` ─────────────────────────────
 * The obvious reading of "nothing has happened here" is "no history rows since".
 * That is wrong in this schema. `document_history` covers six TRACKED_FIELDS
 * written from three route files, the bulk-update path bypasses it entirely, and
 * collaboration content writes are throttled. An issue can therefore change
 * without producing a history row — and a detector keyed on history ABSENCE
 * would report live work as stalled. `updated_at` is written on every path.
 * (PRESEARCH.md Q1.)
 *
 * ── Why SQL narrows and JS decides ──────────────────────────────────────────
 * Business days are not expressible cleanly in Postgres without a calendar
 * table, and federal holidays live in `@ship/shared`. So SQL filters on CALENDAR
 * days and `businessDaysBetween` applies the real rule.
 *
 * The SQL bound must be the SMALLEST calendar gap that could satisfy the
 * business-day threshold, which is the threshold itself: N business days always
 * span at least N calendar days, and usually more once a weekend or holiday
 * falls inside. Filtering on anything larger silently drops true positives
 * before JS can see them.
 *
 * That is not hypothetical — the first version of this used a 2.2x multiplier,
 * reasoning that 5 business days is "about 11 calendar days". It is not: it is
 * *at least* 5. An issue idle 8 calendar days — comfortably past 5 business days
 * — was excluded by the query and the detector reported a clean workspace.
 * Caught by the fingerprint-stability test, which had no signals to compare.
 */
import type { Queryable } from '../data/queryable.js';
import { businessDaysBetween } from '@ship/shared';

import { THRESHOLDS, type Signal } from './types.js';
import { bucketOf, fingerprint } from './fingerprint.js';

type Db = Queryable;

export async function detectStalledWork(
  workspaceId: string,
  db: Db,
  now: Date = new Date()
): Promise<Signal[]> {
  // N business days span at least N calendar days. Anything larger here drops
  // true positives before businessDaysBetween can judge them.
  const calendarDays = THRESHOLDS.STALLED_WORK_DAYS;

  const { rows } = await db.query(
    `SELECT d.id,
            d.title,
            d.updated_at,
            d.started_at,
            d.properties->>'assignee_id' AS assignee_id,
            d.properties->>'priority'    AS priority
       FROM documents d
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.properties->>'state' = 'in_progress'
        AND d.archived_at IS NULL
        AND d.deleted_at IS NULL
        AND d.updated_at < $2::timestamptz - ($3 || ' days')::interval
      ORDER BY d.updated_at ASC`,
    [workspaceId, now.toISOString(), calendarDays]
  );

  const signals: Signal[] = [];
  const today = now.toISOString().slice(0, 10);

  for (const r of rows) {
    const idleSince = (r.updated_at as Date).toISOString().slice(0, 10);
    const idleBusinessDays = businessDaysBetween(idleSince, today);
    if (idleBusinessDays < THRESHOLDS.STALLED_WORK_DAYS) continue;

    const bucket = bucketOf(idleBusinessDays);
    signals.push({
      type: 'stalled_work',
      targetId: r.id,
      targetType: 'issue',
      targetTitle: r.title,
      measurement: idleBusinessDays,
      threshold: THRESHOLDS.STALLED_WORK_DAYS,
      bucket,
      fingerprint: fingerprint('stalled_work', r.id, bucket),
      context: {
        idle_business_days: idleBusinessDays,
        last_touched: idleSince,
        started_at: r.started_at ? (r.started_at as Date).toISOString().slice(0, 10) : null,
        priority: r.priority,
      },
      // Whoever is doing the work is accountable for saying it stopped.
      accountableUserId: r.assignee_id ?? null,
    });
  }

  return signals;
}
