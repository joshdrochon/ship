/**
 * Run every detector for a workspace.
 *
 * ── Why this returns zero signals so often, and why that matters ────────────
 * On a healthy project this returns an empty array, the graph terminates at the
 * triage gate, and the run spends ZERO tokens (PRESEARCH.md Q2/Q17). That is not
 * an edge case to tolerate — it is the ordinary case, and it is the entire cost
 * argument. 480 scans a day are affordable precisely because almost all of them
 * end here.
 *
 * ── The watermark is a scoping hint, not a filter ───────────────────────────
 * Detectors measure conditions that have persisted, not events that just
 * happened: "idle for five business days" is true of a row that has NOT changed.
 * Filtering by `updated_at > watermark` would therefore hide exactly what we are
 * looking for — the rows nobody has touched.
 *
 * So the watermark bounds the RUN, not the query. It records how far the last
 * completed scan got, and is advanced only on completion so a crash re-covers
 * the window (Q24). `scannedThrough` is captured BEFORE the detectors run: any
 * row written while they execute must be picked up next time rather than being
 * silently skipped by a watermark that has already moved past it.
 *
 * ── Sequential, not parallel ────────────────────────────────────────────────
 * Five queries against one pool capped at four connections. Parallelising would
 * saturate it and gain milliseconds on queries that are already indexed range
 * scans. The parallelism that matters is at the graph's fetch nodes (Q16), where
 * the work is genuinely independent.
 */
import type { Pool, PoolClient } from 'pg';

import type { DetectorRun, Signal } from './types.js';
import { detectStalledWork } from './stalledWork.js';
import { detectSprintMissRisk } from './sprintMissRisk.js';
import { detectReviewBottleneck } from './reviewBottleneck.js';
import { detectLoadImbalance } from './loadImbalance.js';
import { detectReworkChurn } from './reworkChurn.js';

type Db = Pool | PoolClient;

export const DETECTORS = [
  { name: 'stalled_work', run: detectStalledWork },
  { name: 'sprint_miss_risk', run: detectSprintMissRisk },
  { name: 'review_bottleneck', run: detectReviewBottleneck },
  { name: 'load_imbalance', run: detectLoadImbalance },
  { name: 'rework_churn', run: detectReworkChurn },
] as const;

export async function runDetectors(
  workspaceId: string,
  db: Db,
  now: Date = new Date()
): Promise<DetectorRun> {
  // Captured before any query runs. See the note above on why this cannot be
  // taken at the end.
  const scannedThrough = now;

  const signals: Signal[] = [];

  for (const d of DETECTORS) {
    // One detector failing must not lose the others' findings. A malformed row
    // or a schema drift in one query should degrade the scan, not void it — the
    // brief's "degrade gracefully" applied inside the scan rather than only at
    // its edges.
    try {
      signals.push(...(await d.run(workspaceId, db, now)));
    } catch (err) {
      console.error(
        `[fleetgraph] detector ${d.name} failed for workspace ${workspaceId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { workspaceId, scannedThrough, signals };
}

export { detectStalledWork, detectSprintMissRisk, detectReviewBottleneck, detectLoadImbalance, detectReworkChurn };
export * from './types.js';
export * from './fingerprint.js';
