/**
 * Run an additive action without asking.
 *
 * ── What "without asking" is allowed to mean ───────────────────────────────
 * Only what a human can undo without knowing what the agent did: a comment, a
 * history note, a notification (Q3). Nothing here changes issue state, assignee,
 * priority, or sprint membership — those cannot reach this node, because
 * `routeByBlastRadius` sends every mutation to the approval gate.
 *
 * ── The audit trail is not optional ────────────────────────────────────────
 * Every autonomous action logs to `document_history` with
 * `automated_by = 'fleetgraph'`. The schema already anticipated this — the
 * column exists and `logDocumentChange` takes it as a parameter — so the agent
 * is using a facility Ship built rather than inventing a parallel log.
 *
 * The consequence is that "what did the agent do last week" is answerable with
 * a query, by anyone, without agent-specific tooling. An agent whose actions
 * are only visible in its own tables is one nobody can audit.
 *
 * ── Why it never calls the bulk endpoint ───────────────────────────────────
 * `POST /api/issues/bulk` takes up to 100 ids and bypasses `document_history`
 * entirely (Q4). An agent-driven bulk update would therefore leave no trace at
 * all — the worst possible combination of wide blast radius and no audit. Until
 * that endpoint logs, FleetGraph does not call it.
 *
 * ── Failure is not fatal ───────────────────────────────────────────────────
 * A failed comment costs this finding, not the run. It is recorded as an error,
 * the notification still goes out, and the watermark still advances — because
 * the finding WAS delivered, just without the comment attached.
 */
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export function makeExecuteAutonomous(deps: GraphDeps) {
  return async function executeAutonomous(state: GraphStateType): Promise<GraphUpdate> {
    if (!state.pending) return {};

    if (state.pending.action.class !== 'additive') {
      // Unreachable via the edges. Kept because the cost of being wrong here is
      // an unapproved mutation, and a thrown error is a far better outcome than
      // a silent one.
      throw new Error(
        `[fleetgraph] executeAutonomous reached with a ${state.pending.action.class} action ` +
          `(${state.pending.action.kind}) — the blast-radius edge is miswired`
      );
    }

    try {
      const result = await deps.act(state.pending.action);
      if (!result.ok) {
        return { errors: [`executeAutonomous: ${result.detail ?? 'action reported failure'}`] };
      }
      return {};
    } catch (err) {
      return {
        errors: [`executeAutonomous: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };
}
