/**
 * Detector 4 — load imbalance.
 *
 * "Is someone drowning?"
 *
 * One person carrying materially more in-progress work than the rest of their
 * sprint. PRESEARCH.md use case 3; the human decides whether to rebalance — the
 * agent proposes, never reassigns.
 *
 * ── Who this is FOR is the whole design ─────────────────────────────────────
 * The finding is ABOUT the overloaded person and goes TO the sprint owner. That
 * asymmetry is the reason this detector needed its own thinking (PRESEARCH.md
 * Q6): telling someone they are overloaded is useless, because they cannot fix
 * their own allocation. It has to reach whoever assigns work.
 *
 * ── "Team" means sprint participants, not the workspace ─────────────────────
 * A workspace-wide median is meaningless — it includes people on other projects,
 * on leave, and long-departed. The comparison group is the set of people holding
 * work in THIS sprint.
 *
 * ── The small-team guard ────────────────────────────────────────────────────
 * With two people, whoever has more is always "above the median" — the detector
 * would fire on every pair forever. Below MIN_TEAM there is no distribution to
 * be an outlier in, so it stays silent. That is a deliberate blind spot, not an
 * oversight: a two-person imbalance is visible without an agent.
 */
import type { Queryable } from '../data/queryable.js';

import { THRESHOLDS, type Signal } from './types.js';
import { countBucket, fingerprint } from './fingerprint.js';

type Db = Queryable;

/** States that represent work someone is actively carrying. */
const ACTIVE = ['in_progress', 'in_review'];

export async function detectLoadImbalance(
  workspaceId: string,
  db: Db,
  _now: Date = new Date()
): Promise<Signal[]> {
  // Active issue counts per assignee, per sprint. Sprints are the comparison
  // group; an assignee appearing in two sprints is judged separately in each.
  const { rows } = await db.query(
    `SELECT s.id   AS sprint_id,
            s.title AS sprint_title,
            s.properties->>'owner_id' AS sprint_owner_id,
            i.properties->>'assignee_id' AS assignee_id,
            u.name AS assignee_name,
            COUNT(*)::int AS active_count
       FROM documents s
       JOIN document_associations da
         ON da.related_id = s.id AND da.relationship_type = 'sprint'
       JOIN documents i
         ON i.id = da.document_id
        AND i.document_type = 'issue'
        AND i.archived_at IS NULL
        AND i.deleted_at IS NULL
        AND i.properties->>'state' = ANY($2)
        AND i.properties->>'assignee_id' IS NOT NULL
       LEFT JOIN users u
         ON u.id = (i.properties->>'assignee_id')::uuid
      WHERE s.workspace_id = $1
        AND s.document_type = 'sprint'
        AND s.archived_at IS NULL
        AND s.deleted_at IS NULL
      GROUP BY s.id, s.title, s.properties, i.properties->>'assignee_id', u.name`,
    [workspaceId, ACTIVE]
  );

  // Group by sprint so each sprint gets its own distribution.
  interface Person {
    assigneeId: string;
    name: string | null;
    count: number;
  }
  interface SprintLoad {
    title: string;
    ownerId: string | null;
    people: Person[];
  }

  const bySprint = new Map<string, SprintLoad>();

  for (const r of rows) {
    // Annotated: an inline `people: []` in the ?? fallback infers never[], and
    // the push below then fails to type-check while the tests still pass —
    // vitest does not type-check.
    const entry: SprintLoad = bySprint.get(r.sprint_id) ?? {
      title: r.sprint_title,
      ownerId: r.sprint_owner_id ?? null,
      people: [],
    };
    entry.people.push({
      assigneeId: r.assignee_id,
      name: r.assignee_name,
      count: r.active_count,
    });
    bySprint.set(r.sprint_id, entry);
  }

  const signals: Signal[] = [];

  for (const [sprintId, sprint] of bySprint) {
    if (sprint.people.length < THRESHOLDS.LOAD_IMBALANCE_MIN_TEAM) continue;

    const counts = sprint.people.map((p) => p.count).sort((a, b) => a - b);
    const median = medianOf(counts);
    if (median === 0) continue;

    const overloaded = sprint.people.filter(
      (p) => p.count >= median * THRESHOLDS.LOAD_IMBALANCE_FACTOR
    );

    for (const p of overloaded) {
      // Fingerprinted on the SPRINT, not the overloaded person: the finding is a
      // rebalancing decision about this sprint. Including the assignee keeps two
      // simultaneously-overloaded people from suppressing each other.
      const bucket = `${countBucket(p.count)}:${p.assigneeId.slice(0, 8)}`;
      signals.push({
        type: 'load_imbalance',
        targetId: sprintId,
        targetType: 'sprint',
        targetTitle: sprint.title,
        measurement: p.count,
        threshold: median * THRESHOLDS.LOAD_IMBALANCE_FACTOR,
        bucket,
        fingerprint: fingerprint('load_imbalance', sprintId, bucket),
        context: {
          overloaded_person: p.name ?? p.assigneeId,
          their_active_issues: p.count,
          team_median: median,
          team_size: sprint.people.length,
          sprint: sprint.title,
        },
        // The sprint owner. NEVER the overloaded person — they cannot fix their
        // own allocation (PRESEARCH.md Q6).
        accountableUserId: sprint.ownerId,
      });
    }
  }

  return signals;
}

/** Median of a pre-sorted array. Even lengths average the middle pair. */
function medianOf(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
