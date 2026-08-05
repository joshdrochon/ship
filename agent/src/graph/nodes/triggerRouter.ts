/**
 * Entry node. Normalises the invocation and records which way the run came in.
 *
 * ── Why this is a node and not just a conditional edge ──────────────────────
 * The branch on `mode` could read the input directly. Making it a node means
 * the trace opens with a step that states what kind of run this is, so a
 * proactive trace and an on-demand trace are distinguishable from their first
 * line rather than from inspecting which node ran third. That readability is
 * what MVP requirement 2 is asking for — two traces showing visibly different
 * paths.
 *
 * It also gives the invariants one place to fail loudly. An on-demand run with
 * no document id is a caller bug; catching it here beats a confusing empty
 * answer four nodes later.
 */
import type { GraphStateType, GraphUpdate } from '../state.js';

export function triggerRouter(state: GraphStateType): GraphUpdate {
  const mode = state.mode ?? 'proactive';

  if (!state.scope?.workspaceId) {
    // Every path needs this — detectors scope by it, notifications store it,
    // and the watermark is keyed on it. Failing here names the problem.
    throw new Error('[fleetgraph] triggerRouter: scope.workspaceId is required');
  }

  if (mode === 'on_demand' && !state.scope.documentId) {
    throw new Error(
      '[fleetgraph] triggerRouter: on-demand runs require scope.documentId — ' +
        'the chat endpoint sends route params, never rendered content (PRESEARCH.md Q7)'
    );
  }

  return { mode };
}

/**
 * Conditional edge 1 (FG-086): which path the run takes.
 *
 * Proactive runs go looking for problems. On-demand runs answer a question
 * about one document and never act — the read-only guarantee at Q3 is
 * structural here, since the on-demand path has no edge into any execute node.
 */
export function routeByMode(state: GraphStateType): 'proactive' | 'on_demand' {
  return state.mode === 'on_demand' ? 'on_demand' : 'proactive';
}
