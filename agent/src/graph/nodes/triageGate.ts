/**
 * The gate. The most important node in the graph, and it calls nothing.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 * On a healthy project this node ends the run, having spent zero tokens and
 * touched no model. That is not an optimisation bolted on afterwards — it is
 * the entire reason 480 scans a day is affordable (Q17/Q30/Q32). Every scan
 * that reaches `judge_signals` costs money; almost none of them should.
 *
 * ── It also produces the evidence ──────────────────────────────────────────
 * MVP requirement 2 asks for two traces showing visibly different paths through
 * the same graph. This node is where they diverge: a quiet run's trace stops
 * here, a drifting run's continues to the model and possibly suspends at a
 * human gate. Same graph, same code, different shape — which is the difference
 * between an agent and a pipeline.
 *
 * ── Suppression is applied here, not in the detectors ──────────────────────
 * Detectors measure; they should not know what was said last week. Filtering
 * here keeps the measurement layer reproducible from the database alone, and
 * keeps the trace showing HOW MANY signals were measured before suppression
 * removed them. A detector that silently pre-filtered would make "quiet because
 * healthy" and "quiet because suppressed" look identical.
 */
import type { GraphStateType, GraphUpdate } from '../state.js';

export function triageGate(state: GraphStateType): GraphUpdate {
  const suppressed = new Set(state.suppressed.map((s) => s.fingerprint));
  const fresh = state.signals.filter((s) => !suppressed.has(s.fingerprint));

  // The two quiet outcomes are recorded separately on purpose. "Nothing is
  // wrong" and "everything wrong is already on someone's desk" are different
  // states of the world, and only one of them is good news.
  const outcome =
    state.signals.length === 0
      ? ('quiet_no_signals' as const)
      : fresh.length === 0
        ? ('quiet_all_suppressed' as const)
        : null;

  return { signals: fresh, ...(outcome ? { outcome } : {}) };
}

/**
 * Conditional edge 2 (FG-087): the zero-signal branch.
 *
 * Returning `quiet` terminates the run. Nothing downstream of here is free.
 */
export function routeAfterTriage(state: GraphStateType): 'quiet' | 'judge' {
  return state.signals.length === 0 ? 'quiet' : 'judge';
}
