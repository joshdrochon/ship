/**
 * The seam between Ship's HTTP layer and the FleetGraph LangGraph graph.
 *
 * ── Why this file is one function and nothing else ──────────────────────────
 * The graph lives in `agent/`, in a different package, and is being built in
 * parallel with this route. If the chat route imported the graph directly, the
 * route could not be written, reviewed or tested until the graph existed, and
 * the two lanes would have to land in one commit. One narrow function means the
 * route, its schema, its OpenAPI registration and its tests are all finished
 * against a stable signature, and wiring the graph is a change to a single
 * function body.
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
 * IMPLEMENTATION PENDING — the graph is under construction at `agent/src/graph/`.
 * Replace this body; do not change the signature, and do not widen
 * `AgentChatRequest` to carry document content (see the header).
 */
export async function invokeAgentChat(_request: AgentChatRequest): Promise<AgentChatResponse> {
  throw new AgentUnavailableError(
    'agent_not_wired',
    'FleetGraph chat graph is not wired yet (agent/src/graph/)'
  );
}
