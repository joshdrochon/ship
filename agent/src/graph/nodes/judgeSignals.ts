/**
 * Where determinism ends.
 *
 * Everything upstream is SQL against stated thresholds and is reproducible from
 * the database alone. From this node on, a model decides whether a crossed
 * threshold is worth a human's attention and who should hear about it. The
 * state object keeps `signals` and `findings` apart precisely so that boundary
 * is visible in a trace rather than buried here (Q18).
 *
 * ── One call for the whole batch ───────────────────────────────────────────
 * Not one per signal. Q32 names the per-signal version as the largest cost
 * cliff in the design: a workspace with forty stalled issues would make forty
 * calls per scan, 480 scans a day. Batching also gives the model something it
 * genuinely needs — seeing all forty at once is what lets it say "this sprint
 * is in trouble" instead of forty times "this issue is stalled."
 *
 * ── Fewer findings than signals is success, not failure ────────────────────
 * The model dropping a measurement is the node working. A threshold crossing
 * that nobody needs to hear about is the ordinary case, and surfacing it anyway
 * is how the agent gets muted.
 *
 * ── When the model is unavailable ──────────────────────────────────────────
 * The run ends `ai_unavailable` with no findings and the watermark does not
 * advance, so the next scan re-covers the window. It does NOT fall back to
 * surfacing raw signals: an unjudged measurement delivered to a human is
 * exactly the noise the judgment step exists to prevent, and delivering it
 * under a degraded-mode banner does not make it less noisy.
 */
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export function makeJudgeSignals(deps: GraphDeps) {
  return async function judgeSignals(state: GraphStateType): Promise<GraphUpdate> {
    if (state.signals.length === 0) {
      // Defensive. The gate should have terminated already; if the edge is ever
      // rewired wrongly this keeps a stray call from being billed.
      return { findings: [], outcome: 'quiet_no_signals' };
    }

    try {
      const findings = await deps.judge({
        signals: state.signals,
        participants: state.participants,
        scope: state.scope,
      });

      const surfacing = findings.filter((f) => f.worthSurfacing);

      return {
        findings: surfacing,
        ...(surfacing.length === 0
          ? { outcome: 'quiet_nothing_survived_judgment' as const }
          : {}),
      };
    } catch (err) {
      return {
        findings: [],
        outcome: 'ai_unavailable',
        errors: [`judgeSignals: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };
}

/**
 * Conditional edge 3 (FG-088): did anything survive judgment.
 *
 * Distinct from edge 2 even though both terminate quietly. Edge 2 means the
 * database found nothing; this means the model found nothing worth saying. In a
 * trace those look the same at the end and completely different in the middle,
 * and telling them apart is how you know whether a silent week is a healthy
 * project or a miscalibrated prompt.
 */
export function routeAfterJudgment(state: GraphStateType): 'quiet' | 'act' {
  return state.findings.length === 0 ? 'quiet' : 'act';
}
