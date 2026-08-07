/**
 * Nobody answered. Tell the person above them, once.
 *
 * A finding not acknowledged after 2 business days escalates one level up the
 * org chart via `properties->>'reports_to'` on the recipient's person document,
 * at most once (PRESEARCH.md Q6).
 *
 * ── Why this needs its own node at all ─────────────────────────────────────
 * The obvious place for escalation is `deliver`, and it cannot go there. A
 * finding that has been sitting unanswered for 2 business days was surfaced on
 * an earlier run, so its fingerprint is in the suppression set and `triage_gate`
 * removes it before anything downstream ever sees it. That is correct — the
 * agent must not re-judge or re-announce it — but it means the escalation clock
 * has to be read from stored observations rather than from this run's signals.
 * `deliver` also never runs on a quiet run, and a quiet run is exactly when an
 * old unanswered finding most needs escalating.
 *
 * ── Why it runs BEFORE the fetch fan-out rather than inside it ─────────────
 * Two reasons, one ordering and one mechanical.
 *
 * Ordering: this node asks "what happened to what I said last time", and the
 * fan-out asks "what is true now". Running them in that order means the trace
 * reads in the order the questions were asked.
 *
 * Mechanical: `fetch_prior_state` reads `escalation_count` out of the same rows
 * this node increments. Run in parallel, a run could report the pre-escalation
 * count for a finding it escalated in the same superstep — harmless today,
 * because nothing downstream consumes that number, and exactly the kind of
 * "harmless" that stops being true silently. Serialising costs one indexed
 * query on a path that already runs several, and the pool is sized for three
 * concurrent fetches (`data/pool.ts`), not four.
 *
 * ── Why it is not wired on the on-demand path ──────────────────────────────
 * Escalation creates a notification, which is an action, and chat cannot act
 * (Q3). The guarantee is the missing edge in `graph/index.ts`, not a check in
 * this file — a prompt instruction is a request; a missing edge is a guarantee.
 *
 * ── Business days, not runs ────────────────────────────────────────────────
 * At a 3-minute cron "two runs" is six minutes, which would escalate a finding
 * defined by five days of silence almost immediately. `businessDaysBetween`
 * from `@ship/shared` is the same helper the detectors measure with, holidays
 * included — deliberately reused rather than reimplemented, because two
 * business-day calendars that disagree is a bug nobody can see from either side.
 */
import { businessDaysBetween } from '@ship/shared';

import { escalateObservation, loadEscalationCandidates } from '../../data/boundary.js';
import type { GraphDeps } from '../deps.js';
import type { Escalation, GraphStateType, GraphUpdate } from '../state.js';

/**
 * Business days of silence before a finding escalates.
 *
 * Not in `detectors/types.ts` THRESHOLDS with the others because it is not a
 * detection threshold: nothing about the project has to be true for it to fire.
 * It measures the human's response time, not the work's.
 */
export const ESCALATION_BUSINESS_DAYS = 2;

export function makeEscalate(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  return async function escalate(state: GraphStateType): Promise<GraphUpdate> {
    let candidates;
    try {
      candidates = await loadEscalationCandidates(state.scope.workspaceId, deps.db);
    } catch (err) {
      // Degrade rather than abort. Losing an escalation delays one notification
      // by one cron interval; losing the run loses this window's detection
      // entirely, and the watermark would hold it back for the next run anyway.
      return {
        escalated: [],
        errors: [`escalate: ${err instanceof Error ? err.message : String(err)}`],
      };
    }

    const today = now().toISOString().slice(0, 10);
    const escalated: Escalation[] = [];
    const errors: string[] = [];

    for (const c of candidates) {
      const silentBusinessDays = businessDaysBetween(
        c.notifiedAt.toISOString().slice(0, 10),
        today
      );
      if (silentBusinessDays < ESCALATION_BUSINESS_DAYS) continue;

      // Top of the chain: `reports_to` is unset, or points back at the person
      // themselves. Defined behaviour, not an oversight — there is no hop to
      // make, so nothing is written and `escalation_count` stays 0. The finding
      // keeps its original recipient, and if an admin sets `reports_to` later
      // (it is admin-only, per routes/documents.ts) the next run escalates it.
      // Recorded in state so the trace distinguishes "nobody above them" from
      // "the node never looked".
      if (!c.escalateToUserId || c.escalateToUserId === c.recipientUserId) {
        escalated.push({
          observationId: c.observationId,
          fingerprint: c.fingerprint,
          fromUserId: c.recipientUserId,
          toUserId: null,
          silentBusinessDays,
        });
        continue;
      }

      try {
        const notificationId = await escalateObservation(
          {
            workspaceId: state.scope.workspaceId,
            observationId: c.observationId,
            escalateToUserId: c.escalateToUserId,
            // The escalation says what the original said plus who did not
            // answer. It is a routing change: same finding, same measurement,
            // different desk. Re-judging it would let the model contradict what
            // the first notification already told someone.
            title: `Escalated: ${c.title}`,
            body: escalationBody(c.recipientName, silentBusinessDays, c.body),
            targetId: c.targetId,
          },
          deps.db
        );

        // Null means the compare-and-set found `escalation_count` already
        // non-zero — another runner escalated this between the load and the
        // claim. Nothing was written and nothing is recorded, because nothing
        // happened here. The cron's per-workspace advisory lock makes this
        // unreachable in practice; the guard is what makes that lock an
        // optimisation rather than the only thing preventing a double hop.
        if (notificationId === null) continue;

        escalated.push({
          observationId: c.observationId,
          fingerprint: c.fingerprint,
          fromUserId: c.recipientUserId,
          toUserId: c.escalateToUserId,
          silentBusinessDays,
        });
      } catch (err) {
        // Per candidate, so one bad `reports_to` value — the property is
        // free-form JSONB and only validated by the uuid cast at insert — costs
        // one escalation rather than every escalation in the workspace.
        errors.push(
          `escalate: ${c.fingerprint} -> ${c.escalateToUserId}: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { escalated, ...(errors.length ? { errors } : {}) };
  };
}

/** Who did not answer, for how long, and what they were told. */
function escalationBody(
  recipientName: string | null,
  silentBusinessDays: number,
  original: string | null
): string {
  const who = recipientName ?? 'The accountable person';
  const days = silentBusinessDays === 1 ? '1 business day' : `${silentBusinessDays} business days`;
  const lead = `${who} was notified ${days} ago and has not responded.`;
  return original ? `${lead}\n\n${original}` : lead;
}
