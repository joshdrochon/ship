/**
 * Detector 3 — review bottleneck.
 *
 * "Who's sitting on this?"
 *
 * An issue in `in_review` whose `updated_at` has not moved for N business days:
 * work that is finished but stuck at the gate. PRESEARCH.md use case 4.
 *
 * ── The caveat this detector ships with ─────────────────────────────────────
 * Ship has NO reviewer field. An issue in `in_review` records who it is assigned
 * to, not who is meant to review it. So the accountable party here is the
 * assignee — true and useful ("your work is stuck") but not directly actionable
 * by them, since they are not the blocker.
 *
 * The alternatives are worse. Inferring a reviewer from comment history is
 * fabrication. Adding a reviewer column is a schema change to the issue model to
 * serve one detector. We ship the weaker version and name the limit, in
 * PRESEARCH.md Q6 and here. If a reviewer field ever exists, this is the one
 * line that changes.
 *
 * Threshold is lower than stalled work (2 business days vs 5) because a review
 * is a handoff: the work is done and someone is waiting. Two days of silence
 * there means something different from two days on work in progress.
 */
import type { Queryable } from '../data/queryable.js';
import { businessDaysBetween } from '@ship/shared';

import { THRESHOLDS, type Signal } from './types.js';
import { bucketOf, fingerprint } from './fingerprint.js';

type Db = Queryable;

export async function detectReviewBottleneck(
  workspaceId: string,
  db: Db,
  now: Date = new Date()
): Promise<Signal[]> {
  // N business days span at least N calendar days — see stalledWork.ts for why
  // anything larger here silently drops true positives.
  const calendarDays = THRESHOLDS.REVIEW_BOTTLENECK_DAYS;

  const { rows } = await db.query(
    `SELECT d.id,
            d.title,
            d.updated_at,
            d.properties->>'assignee_id' AS assignee_id,
            d.properties->>'priority'    AS priority
       FROM documents d
      WHERE d.workspace_id = $1
        AND d.document_type = 'issue'
        AND d.properties->>'state' = 'in_review'
        AND d.archived_at IS NULL
        AND d.deleted_at IS NULL
        AND d.updated_at < $2::timestamptz - ($3 || ' days')::interval
      ORDER BY d.updated_at ASC`,
    [workspaceId, now.toISOString(), calendarDays]
  );

  const signals: Signal[] = [];
  const today = now.toISOString().slice(0, 10);

  for (const r of rows) {
    const waitingSince = (r.updated_at as Date).toISOString().slice(0, 10);
    const waitingBusinessDays = businessDaysBetween(waitingSince, today);
    if (waitingBusinessDays < THRESHOLDS.REVIEW_BOTTLENECK_DAYS) continue;

    const bucket = bucketOf(waitingBusinessDays);
    signals.push({
      type: 'review_bottleneck',
      targetId: r.id,
      targetType: 'issue',
      targetTitle: r.title,
      measurement: waitingBusinessDays,
      threshold: THRESHOLDS.REVIEW_BOTTLENECK_DAYS,
      bucket,
      fingerprint: fingerprint('review_bottleneck', r.id, bucket),
      context: {
        waiting_business_days: waitingBusinessDays,
        in_review_since: waitingSince,
        priority: r.priority,
        // Stated explicitly so the judgment prompt does not imply the recipient
        // is the one holding it up.
        reviewer_known: 0,
      },
      accountableUserId: r.assignee_id ?? null,
    });
  }

  return signals;
}
