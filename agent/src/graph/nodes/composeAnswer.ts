/**
 * The on-demand terminal node. Answers a question and does nothing else.
 *
 * ── Read-only is structural, not a promise ─────────────────────────────────
 * There is no edge from this node to any execute node. The on-demand path
 * cannot reach `execute_autonomous` or `await_approval` — not because the
 * prompt is told not to act, but because the graph has no route. A prompt
 * instruction is a request; a missing edge is a guarantee (Q3).
 *
 * The answer prompt is also given no tools, so the model cannot query for
 * anything it was not handed. It receives resolved facts (Q31): the document,
 * its associations, its recent history, its participants, and any signals
 * already measured against it.
 *
 * ── Why the signals are included ───────────────────────────────────────────
 * "Why is this behind?" is answerable badly from the document alone and well
 * with the measurement in hand. Passing the detector output into the answer is
 * what makes the response grounded rather than plausible.
 */
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export function makeComposeAnswer(deps: GraphDeps) {
  return async function composeAnswer(state: GraphStateType): Promise<GraphUpdate> {
    const lastUserTurn = [...state.messages].reverse().find((m) => m.role === 'user');

    if (!lastUserTurn) {
      return {
        answer: null,
        outcome: 'answered',
        errors: ['composeAnswer: no user message in state'],
      };
    }

    try {
      const answer = await deps.answer({
        scope: state.scope,
        question: lastUserTurn.content,
        participants: state.participants,
        signals: state.signals,
      });

      return {
        answer,
        messages: [{ role: 'agent' as const, content: answer }],
        outcome: 'answered',
      };
    } catch (err) {
      // The UI has an `ai_unavailable` state already; degrade into it rather
      // than returning a half-answer the user cannot tell is degraded.
      return {
        answer: null,
        outcome: 'ai_unavailable',
        errors: [`composeAnswer: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  };
}
