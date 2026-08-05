/**
 * Decide what to propose, and whether it may run without asking.
 *
 * ── The model does not get a vote here ─────────────────────────────────────
 * Q4 is explicit: confirmation tracks blast radius, and blast radius is
 * observable from the request itself before the action runs. Asking the model
 * to assess its own impact is the one thing you cannot trust it on, so the
 * action and its class are derived HERE, from the signal type, by a table that
 * a reviewer can read in ten seconds.
 *
 * The model's output — severity, recipient, phrasing — shapes what the message
 * says. It never widens what the agent is permitted to do.
 *
 * ── Why the boundary lives in the graph at all ─────────────────────────────
 * Because `api_tokens` cannot enforce it. A token inherits the full permissions
 * of whoever created it, so there is no platform ceiling on an agent token
 * (Q3). Migration 038 adds `api_tokens.scopes` and FleetGraph's token is issued
 * read-only, but that is defence in depth — this table is the boundary.
 *
 * ── The line ──────────────────────────────────────────────────────────────
 *   additive   a comment, a history note, a notification. A human can ignore
 *              or delete it, and nothing about the project changed.
 *   mutation   issue state, assignee, priority, sprint membership. Proposed,
 *              never executed. Even when the agent is right.
 */
import type { SignalType } from '../../detectors/types.js';
import type { GraphStateType, GraphUpdate, ProposedAction } from '../state.js';

/**
 * Signal type to proposed action.
 *
 * Four of the five propose a comment: the finding is information, and the human
 * decides what to do about it. Only `load_imbalance` proposes a state change,
 * because "someone is drowning" has an obvious remedy the agent can spell out —
 * and that remedy moves work between people, which is exactly the kind of thing
 * that must never happen without a human saying yes.
 */
const ACTION_BY_SIGNAL: Record<SignalType, { class: ProposedAction['class']; kind: ProposedAction['kind'] }> = {
  stalled_work: { class: 'additive', kind: 'comment' },
  sprint_miss_risk: { class: 'additive', kind: 'comment' },
  review_bottleneck: { class: 'additive', kind: 'comment' },
  rework_churn: { class: 'additive', kind: 'comment' },
  // The only mutation the agent proposes. Always gated.
  load_imbalance: { class: 'mutation', kind: 'reassign' },
};

export function routeAction(state: GraphStateType): GraphUpdate {
  if (state.findings.length === 0) return {};

  // One finding is escalated per run, deliberately. A run that delivers eight
  // notifications at once is a run whose notifications get bulk-dismissed; the
  // rest are recorded as observations and surface on later scans if they
  // persist. Ordering is by severity so the worst goes first.
  const ranked = [...state.findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity)
  );
  const top = ranked[0]!;
  const findingIndex = state.findings.indexOf(top);

  const signal = state.signals.find((s) => s.fingerprint === top.fingerprint);
  if (!signal) {
    // A finding whose signal cannot be found is a judgment that invented a
    // fingerprint. Do not act on it — acting on a target the measurement layer
    // never named is the failure mode this separation exists to prevent.
    return {
      errors: [`routeAction: finding ${top.fingerprint} has no matching signal — dropped`],
      outcome: 'quiet_nothing_survived_judgment',
    };
  }

  const shape = ACTION_BY_SIGNAL[signal.type];

  const action: ProposedAction = {
    class: shape.class,
    kind: shape.kind,
    targetId: signal.targetId,
    describe:
      shape.class === 'additive'
        ? `Post a comment on "${signal.targetTitle}": ${top.phrasing}`
        : `Propose rebalancing work in "${signal.targetTitle}": ${top.phrasing}`,
    payload: {
      signalType: signal.type,
      targetType: signal.targetType,
      measurement: signal.measurement,
      threshold: signal.threshold,
      phrasing: top.phrasing,
      context: signal.context,
    },
  };

  return {
    pending: {
      findingIndex,
      action,
      recipientUserId: top.recipientUserId ?? signal.accountableUserId,
      observationId: null,
    },
  };
}

/**
 * Conditional edge 4 (FG-089): autonomous or gated.
 *
 * The single most consequential line in the graph. Everything about the safety
 * argument reduces to this branch being correct and being readable.
 */
export function routeByBlastRadius(state: GraphStateType): 'autonomous' | 'gated' | 'quiet' {
  if (!state.pending) return 'quiet';
  return state.pending.action.class === 'additive' ? 'autonomous' : 'gated';
}

function severityRank(s: string): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}
