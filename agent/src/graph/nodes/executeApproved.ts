/**
 * Resume after a human answered the gate.
 *
 * Reached only via `awaitApproval`'s `interrupt()`, so by definition this runs
 * in a later process than the one that proposed the action — possibly hours
 * later, on a different container. Everything it needs comes from the
 * checkpointed state, never from memory.
 *
 * ── The three answers, and why dismiss is the interesting one ──────────────
 *
 *   accept    run the proposal, record the outcome
 *   dismiss   never raise this fingerprint again. Ever.
 *   snooze    hide it for 1/3/5 BUSINESS days, then re-run the detector
 *
 * Dismiss is permanent by design (Q23). A dismissed finding that reappears next
 * week teaches the human that dismissing does not work, and the next thing they
 * do is mute the agent — at which point every future finding is lost too. The
 * cost of honouring a wrong dismissal is one missed finding. The cost of
 * ignoring it is all of them.
 *
 * ── Snooze re-runs the detector rather than replaying the finding ──────────
 * This is the subtle one (FG-134). When a snooze expires, the stored finding is
 * NOT re-delivered. The detector runs again, and only if the condition still
 * holds does anything surface. Otherwise the agent would announce a problem
 * that was fixed three days ago — which reads as the agent not paying
 * attention, and is worse than saying nothing.
 *
 * So a snoozed finding that self-resolves never returns, and no code has to
 * detect that it resolved. The absence of a signal does the work.
 */
import { resolveObservation } from '../../data/boundary.js';
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';
import type { ApprovalDecision } from './awaitApproval.js';

/**
 * Add N business days to a date.
 *
 * Business days, not calendar days — a Friday snooze for 1 day means Monday,
 * not Saturday, and a snooze that expires on a weekend surfaces to nobody and
 * then looks stale on Monday.
 *
 * Note the direction of the relationship, because getting it backwards has
 * already cost this project once: N business days always span AT LEAST N
 * calendar days, never fewer. Any code that converts between them with a
 * multiplier is wrong in one direction or the other.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    out.setDate(out.getDate() + 1);
    const dow = out.getDay();
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return out;
}

export function makeExecuteApproved(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  return async function executeApproved(state: GraphStateType): Promise<GraphUpdate> {
    if (!state.pending) return { outcome: 'quiet_nothing_survived_judgment' };

    const last = [...state.messages].reverse().find((m) => m.role === 'user');
    let answer: ApprovalDecision;
    try {
      answer = JSON.parse(last?.content ?? '{}') as ApprovalDecision;
    } catch {
      return { errors: ['executeApproved: resume payload was not valid JSON'] };
    }

    const observationId = state.pending.observationId;

    // `pending` is deliberately NOT cleared on any branch. It is what the trace
    // shows was acted on, and `deliver` reads `outcome === 'delivered'` to know
    // the human has already been notified and must not be notified again.

    if (answer.decision === 'dismiss') {
      if (observationId) await resolveObservation(observationId, 'dismissed', null, deps.db);
      return { outcome: 'delivered' };
    }

    if (answer.decision === 'snooze') {
      const until = addBusinessDays(now(), answer.businessDays ?? 3);
      if (observationId) await resolveObservation(observationId, 'snoozed', until, deps.db);
      return { outcome: 'delivered' };
    }

    // accept
    try {
      const result = await deps.act(state.pending.action);
      if (observationId) await resolveObservation(observationId, 'accepted', null, deps.db);
      return {
        outcome: 'delivered',
        ...(result.ok
          ? {}
          : { errors: [`executeApproved: ${result.detail ?? 'action reported failure'}`] }),
      };
    } catch (err) {
      return {
        outcome: 'delivered',
        errors: [`executeApproved: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };
}
