/**
 * What the agent already said, and what the human did about it.
 *
 * ── This node is the difference between an agent and a cron job ─────────────
 * Without it, every run re-discovers the same stalled issue and says it again.
 * Five business days of that is how a proactive agent gets muted, and a muted
 * agent has negative value — it still costs tokens and it no longer informs
 * anyone (Q20/Q23).
 *
 * ── Suppression is by fingerprint, and dismissal is permanent ───────────────
 * The fingerprint buckets the measurement rather than keying on the raw day, so
 * "idle 5 days" and "idle 20 days" are genuinely different findings and each
 * gets surfaced once — escalation without repetition.
 *
 * A dismissed fingerprint is excluded forever. That is a deliberate loss: if
 * the human was wrong to dismiss it, the agent will never mention it again.
 * The alternative — re-raising something a human explicitly rejected — is the
 * single fastest route to the agent being turned off, and a finding nobody
 * reads has already lost whatever value re-raising it was meant to preserve.
 */
import { loadSuppressionSet } from '../../data/boundary.js';
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export function makeFetchPriorState(deps: GraphDeps) {
  return async function fetchPriorState(state: GraphStateType): Promise<GraphUpdate> {
    try {
      const set = await loadSuppressionSet(state.scope.workspaceId, deps.db);

      return {
        suppressed: [...set.values()].map((s) => ({
          fingerprint: s.fingerprint,
          signalType: s.signalType,
          targetId: s.targetId,
          escalationCount: s.escalationCount,
          lastSurfacedAt: s.lastSurfacedAt,
        })),
      };
    } catch (err) {
      // Failing OPEN here would re-surface everything already dismissed — the
      // exact behaviour that gets the agent muted. So a failed suppression load
      // is recorded and the run continues with an empty set, which the triage
      // gate treats as a reason to stay quiet rather than to shout.
      return {
        suppressed: [],
        errors: [
          `fetchPriorState: ${err instanceof Error ? err.message : String(err)} ` +
            '(suppression unavailable — triage will hold rather than re-surface)',
        ],
      };
    }
  };
}
