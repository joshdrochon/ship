/**
 * Run the detectors. The only node in the proactive path that measures.
 *
 * ── Everything deterministic happens here ───────────────────────────────────
 * After this node the graph holds measurements, and no model has been
 * consulted. That ordering is deliberate: it is what makes the triage gate able
 * to terminate a healthy run having spent nothing (Q17), and it is what makes a
 * wrong finding diagnosable — either the number here was wrong, or the
 * judgement downstream was.
 *
 * ── On-demand runs measure too, and that surprises people ───────────────────
 * A question about a document is better answered knowing the document is
 * stalled. So detectors run in both modes; what differs is what happens next.
 * On-demand, the signals feed the answer prompt and no action is ever proposed.
 */
import { runDetectors } from '../../detectors/index.js';
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export function makeFetchSignals(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  return async function fetchSignals(state: GraphStateType): Promise<GraphUpdate> {
    try {
      const run = await runDetectors(
        state.scope.workspaceId,
        deps.db,
        state.scannedThrough ?? now()
      );

      // On-demand runs care only about the document being asked about. Filtering
      // here rather than in the detectors keeps the detectors mode-agnostic —
      // they measure a workspace, and the graph decides what is relevant.
      const signals =
        state.mode === 'on_demand' && state.scope.documentId
          ? run.signals.filter((s) => s.targetId === state.scope.documentId)
          : run.signals;

      return { signals };
    } catch (err) {
      // Degrade, do not crash (engineering requirement 4). A failed scan makes
      // this run blind, not fatal — the watermark does not advance, so the next
      // run re-covers the same window and nothing is lost (Q24).
      return {
        signals: [],
        errors: [`fetchSignals: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };
}
