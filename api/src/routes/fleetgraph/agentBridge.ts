/**
 * The seam between Ship's HTTP layer and the FleetGraph LangGraph graph.
 *
 * ── Why this file is one function and nothing else ──────────────────────────
 * The graph lives in `agent/`, a different package. Keeping the crossing to one
 * narrow function meant the route, its schema, its OpenAPI registration and its
 * tests could all be finished against a stable signature before the graph
 * existed — and it meant wiring the graph was a change to a single body.
 *
 * It also survived a problem the seam was not designed for. For most of this
 * build `api` COULD NOT import `agent` at all: the agent reached the circuit
 * breaker through `api/dist`, so an import in the other direction closed a
 * build cycle with no package able to compile first. This function threw
 * `agent_not_wired` throughout, and the chat endpoint returned a clean 503
 * while everything around it was finished and tested.
 *
 * That was fixed by moving `circuitBreaker.ts` into `@ship/shared`, which turns
 * the dependency graph from a loop into a line: shared -> agent -> api.
 *
 * ── Why the parameters are what they are (PRESEARCH.md Q7) ──────────────────
 * This takes a document *id*, a document *type* and the *active tab* — route
 * parameters. It does not take rendered content, editor HTML, or a DOM
 * snapshot, and it never will. Two reasons, and the second is the load-bearing
 * one:
 *
 *   1. Correctness. Sending rendered content makes the agent's view of a
 *      document depend on what the UI happened to render — truncation, lazy
 *      tabs, virtualised lists. Sending the id means the graph's context node
 *      resolves the same authoritative state whether the run was started by a
 *      user opening chat or by the proactive cron. That is what makes "both
 *      modes run through one graph" true rather than aspirational.
 *
 *   2. Privacy. This is a boundary, not a convention. Ship documents are
 *      workspace data; the model call leaves the process. Passing an id means
 *      the graph re-reads the document under the caller's own visibility rules
 *      and sends only what it decided to send. Passing rendered content would
 *      mean whatever the browser had on screen — including anything a future UI
 *      change happens to render next to it — is shipped to Bedrock, with no
 *      server-side check that the user was even allowed to see it.
 *
 * The request schema in `schemas.ts` is `.strict()` so this is enforced by a
 * 400, not by this comment. If someone adds a `content` field to the chat body,
 * the schema rejects it before the route ever runs.
 */

import { pool } from '../../db/client.js';

/** What the chat route hands to the graph. Route params only — see the header. */
export interface AgentChatRequest {
  /** The document in view. The id IS the context (Q7). */
  documentId: string;
  /** Ship `document_type` of that document — lets the graph pick its context node. */
  documentType: string;
  /** Active tab within the view, when the route has one (`sprints/:id/plan`). */
  tab: string | null;
  /** Who is asking. The graph resolves state under this user's visibility. */
  userId: string;
  /** The workspace the request was authenticated into. */
  workspaceId: string;
  /**
   * The user's question, when there is one.
   *
   * Absent means "tell me about this document's state" — use case 6 in Q9 is a
   * grounded answer about the document in view, which is well defined with no
   * question at all. Not a content channel: it is what the human typed, never
   * anything the page rendered.
   */
  message?: string;
}

export interface AgentChatResponse {
  answer: string;
  /** LangGraph thread id, so a follow-up turn can continue the same run. */
  threadId: string | null;
}

/**
 * Raised while the graph is not yet wired, and by the graph itself when it is
 * unreachable.
 *
 * A named class rather than a bare `Error` because the chat route has to tell
 * "the agent is not available" apart from "the agent threw" — the first is a
 * 503 the UI renders as a quiet unavailable state, the second is a bug that
 * must reach the logs as one.
 */
export class AgentUnavailableError extends Error {
  constructor(readonly reason: 'agent_not_wired' | 'agent_unreachable', message?: string) {
    super(message ?? `FleetGraph agent unavailable: ${reason}`);
    this.name = 'AgentUnavailableError';
  }
}

/**
 * Invoke the FleetGraph graph for an on-demand chat turn.
 *
 * ── One graph, two triggers ────────────────────────────────────────────────
 * This runs the SAME graph the cron runs, with `mode: 'on_demand'`. Not a
 * parallel implementation that happens to agree — the same nodes, the same
 * detectors, the same judgement. What differs is the trigger and the route
 * through the conditional edges, which is exactly the property the brief is
 * asking about when it says a standalone chatbot is not a graph agent.
 *
 * ── It cannot act, structurally ────────────────────────────────────────────
 * The on-demand path has no edge to any execute node (PRESEARCH.md Q3). Chat
 * cannot comment, reassign, or propose — not because this function withholds
 * an action client, but because the graph has no route from `compose_answer` to
 * one. `act` is still passed as a refusal so that a future miswiring fails
 * loudly here rather than doing something quietly.
 *
 * ── No checkpointer ────────────────────────────────────────────────────────
 * A chat turn answers and ends; there is no `interrupt()` on this path and
 * nothing to resume. Compiling without a checkpointer keeps a question from
 * writing checkpoint rows for a thread nobody will ever come back to.
 */
export async function invokeAgentChat(request: AgentChatRequest): Promise<AgentChatResponse> {
  const { compileGraph, makeJudge, makeAnswer } = await import('@ship/agent');

  const threadId = `fg:chat:${request.workspaceId}:${request.documentId}`;

  try {
    const graph = compileGraph({
      db: pool,
      judge: makeJudge(),
      answer: makeAnswer(),
      // Unreachable from this path. Present so a miswired edge throws instead
      // of acting.
      act: async () => ({
        ok: false,
        detail: 'on-demand chat cannot act (PRESEARCH.md Q3)',
      }),
    });

    const final = await graph.invoke(
      {
        mode: 'on_demand',
        scope: {
          workspaceId: request.workspaceId,
          documentId: request.documentId,
          documentType: request.documentType,
          tab: request.tab ?? undefined,
        },
        actor: request.userId,
        messages: [
          {
            role: 'user',
            content: request.message ?? 'What is the current state of this document?',
          },
        ],
      } as never,
      { recursionLimit: 50, configurable: { thread_id: threadId } }
    );

    if (final.outcome === 'ai_unavailable' || !final.answer) {
      // The graph ran and could not answer — a degraded model, not a bug here.
      // Surfaced as 503 so the UI shows its existing unavailable state rather
      // than an empty bubble that looks like a reply.
      throw new AgentUnavailableError(
        'agent_unreachable',
        final.errors?.join('; ') || 'the graph produced no answer'
      );
    }

    return { answer: final.answer, threadId };
  } catch (err) {
    if (err instanceof AgentUnavailableError) throw err;
    // Anything else is a genuine fault and must reach the logs as one rather
    // than being flattened into "unavailable".
    throw err;
  }
}
