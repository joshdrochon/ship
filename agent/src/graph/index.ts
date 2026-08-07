/**
 * The graph.
 *
 * ── Four conditional edges, and why that number matters ────────────────────
 * The brief is explicit that a graph taking the same path on every run is a
 * pipeline wearing a graph's clothes. These four are what make a quiet run and
 * a drifting run produce visibly different traces from identical code (Q17):
 *
 *   1  after resolve_scope   invocation mode        proactive / on-demand
 *   2  after triage_gate     signals.length === 0   terminate quiet / judge
 *   3  after judge_signals   findings.length === 0  terminate quiet / act
 *   4  after route_action    blast radius (Q3/Q4)   autonomous / human gate
 *
 * Edge 2 is the one that carries the cost argument. On a healthy project the
 * run ends there having spent zero tokens, which is the only reason scanning
 * every three minutes is affordable (Q30/Q32).
 *
 * Edges 2 and 3 both terminate quietly and are still separate edges on purpose.
 * "The database found nothing" and "the model judged nothing worth saying" look
 * identical in the outcome and completely different in the trace, and telling
 * them apart is how you know whether a silent week means a healthy project or a
 * miscalibrated prompt.
 *
 * ── Where this differs from PRESEARCH.md Q17, and why ───────────────────────
 * Q17 lists edge 1 as firing after `trigger_router`. It fires one node later,
 * after `resolve_scope`, because scope resolution is common to both modes and
 * `scannedThrough` has to be captured before any query runs — putting the
 * branch first would mean duplicating that capture on both sides. Same
 * condition, same two branches, one node later.
 *
 * ── The fan-out ────────────────────────────────────────────────────────────
 * The three proactive fetches are independent reads with no ordering
 * dependency, so `escalate` fans out to all three at once and LangGraph runs
 * them in one superstep, joining at `triage_gate` (Q16). Their combined latency
 * is the slowest of the three rather than the sum.
 *
 * `escalate` is deliberately AHEAD of the fan-out rather than a fourth member
 * of it. It writes to the same `fleetgraph_observations` rows that
 * `fetch_prior_state` reads, and it answers a different question — what became
 * of what the last run said, before this one measures anything. Its header has
 * the full argument.
 *
 * On-demand runs need signals and participants but not prior state — there is
 * nothing to suppress in a conversation. Those two are registered under
 * separate node names running the same functions, so a trace names the path it
 * took in its node list rather than requiring you to infer it.
 *
 * ── The one-way structural guarantee ───────────────────────────────────────
 * There is no edge from the on-demand path to any execute node. Chat cannot
 * act, not because the prompt is told not to, but because the graph has no
 * route (Q3). A prompt instruction is a request; a missing edge is a guarantee.
 */
import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

import type { GraphDeps } from './deps.js';
import { GraphState } from './state.js';
import { triggerRouter, routeByMode } from './nodes/triggerRouter.js';
import { makeResolveScope } from './nodes/resolveScope.js';
import { makeFetchSignals } from './nodes/fetchSignals.js';
import { makeFetchParticipants } from './nodes/fetchParticipants.js';
import { makeFetchPriorState } from './nodes/fetchPriorState.js';
import { triageGate, routeAfterTriage } from './nodes/triageGate.js';
import { makeJudgeSignals, routeAfterJudgment } from './nodes/judgeSignals.js';
import { makeComposeAnswer } from './nodes/composeAnswer.js';
import { routeAction, routeByBlastRadius } from './nodes/routeAction.js';
import { makeExecuteAutonomous } from './nodes/executeAutonomous.js';
import { makeAwaitApproval } from './nodes/awaitApproval.js';
import { makeExecuteApproved } from './nodes/executeApproved.js';
import { makeEscalate } from './nodes/escalate.js';
import { makeDeliver, makeCloseQuiet } from './nodes/deliver.js';

/**
 * Node names, in one place.
 *
 * They are what a LangSmith trace shows, so they are written to be read by
 * someone who has not seen this file — `triage_gate` rather than `node3`
 * (FG-180). Centralised so a rename cannot leave an edge pointing at a name
 * that no longer exists.
 */
export const NODES = {
  triggerRouter: 'trigger_router',
  resolveScope: 'resolve_scope',
  escalate: 'escalate',
  fetchSignals: 'fetch_signals',
  fetchParticipants: 'fetch_participants',
  fetchPriorState: 'fetch_prior_state',
  odFetchSignals: 'on_demand_fetch_signals',
  odFetchParticipants: 'on_demand_fetch_participants',
  triageGate: 'triage_gate',
  judgeSignals: 'judge_signals',
  composeAnswer: 'compose_answer',
  routeAction: 'route_action',
  executeAutonomous: 'execute_autonomous',
  awaitApproval: 'await_approval',
  executeApproved: 'execute_approved',
  deliver: 'deliver',
  closeQuiet: 'close_quiet',
} as const;

export function buildGraph(deps: GraphDeps) {
  const fetchSignals = makeFetchSignals(deps);
  const fetchParticipants = makeFetchParticipants(deps);

  return (
    new StateGraph(GraphState)
      .addNode(NODES.triggerRouter, triggerRouter)
      .addNode(NODES.resolveScope, makeResolveScope(deps))

      // Proactive only. Acts on what the LAST run said, before this one
      // measures anything — see the header of nodes/escalate.ts for why it is
      // ahead of the fan-out rather than inside it.
      .addNode(NODES.escalate, makeEscalate(deps))

      // Proactive fan-out.
      .addNode(NODES.fetchSignals, fetchSignals)
      .addNode(NODES.fetchParticipants, fetchParticipants)
      .addNode(NODES.fetchPriorState, makeFetchPriorState(deps))

      // On-demand fetches. Same functions, separate names so the trace names
      // the path rather than making you infer it.
      .addNode(NODES.odFetchSignals, fetchSignals)
      .addNode(NODES.odFetchParticipants, fetchParticipants)

      .addNode(NODES.triageGate, triageGate)
      .addNode(NODES.judgeSignals, makeJudgeSignals(deps))
      .addNode(NODES.composeAnswer, makeComposeAnswer(deps))
      .addNode(NODES.routeAction, routeAction)
      .addNode(NODES.executeAutonomous, makeExecuteAutonomous(deps))
      .addNode(NODES.awaitApproval, makeAwaitApproval(deps))
      .addNode(NODES.executeApproved, makeExecuteApproved(deps))
      .addNode(NODES.deliver, makeDeliver(deps))
      .addNode(NODES.closeQuiet, makeCloseQuiet(deps))

      .addEdge(START, NODES.triggerRouter)
      .addEdge(NODES.triggerRouter, NODES.resolveScope)

      // ── Conditional edge 1: invocation mode (FG-086) ────────────────────
      // The proactive side goes to `escalate` first, which then fans out. The
      // on-demand side never reaches it: escalation writes a notification, and
      // chat cannot act (Q3). That is the same one-way structural guarantee as
      // the execute nodes — enforced by the absent edge, not by a check.
      .addConditionalEdges(
        NODES.resolveScope,
        (state) =>
          routeByMode(state) === 'on_demand'
            ? [NODES.odFetchSignals, NODES.odFetchParticipants]
            : [NODES.escalate],
        [NODES.odFetchSignals, NODES.odFetchParticipants, NODES.escalate]
      )

      // The fan-out (Q16): three independent reads in one superstep, so their
      // combined latency is the slowest of the three rather than the sum.
      .addEdge(NODES.escalate, NODES.fetchSignals)
      .addEdge(NODES.escalate, NODES.fetchParticipants)
      .addEdge(NODES.escalate, NODES.fetchPriorState)

      // The fan-out joins here. LangGraph waits for all three.
      .addEdge(NODES.fetchSignals, NODES.triageGate)
      .addEdge(NODES.fetchParticipants, NODES.triageGate)
      .addEdge(NODES.fetchPriorState, NODES.triageGate)

      // On-demand terminates without ever reaching an execute node.
      .addEdge(NODES.odFetchSignals, NODES.composeAnswer)
      .addEdge(NODES.odFetchParticipants, NODES.composeAnswer)
      .addEdge(NODES.composeAnswer, END)

      // ── Conditional edge 2: zero signals (FG-087) ───────────────────────
      // Nothing downstream of here is free.
      .addConditionalEdges(NODES.triageGate, routeAfterTriage, {
        quiet: NODES.closeQuiet,
        judge: NODES.judgeSignals,
      })

      // ── Conditional edge 3: nothing survived judgment (FG-088) ──────────
      .addConditionalEdges(NODES.judgeSignals, routeAfterJudgment, {
        quiet: NODES.closeQuiet,
        act: NODES.routeAction,
      })

      // ── Conditional edge 4: blast radius (FG-089) ───────────────────────
      // The single most consequential branch in the graph.
      .addConditionalEdges(NODES.routeAction, routeByBlastRadius, {
        autonomous: NODES.executeAutonomous,
        gated: NODES.awaitApproval,
        quiet: NODES.closeQuiet,
      })

      .addEdge(NODES.executeAutonomous, NODES.deliver)
      .addEdge(NODES.awaitApproval, NODES.executeApproved)
      .addEdge(NODES.executeApproved, NODES.deliver)
      .addEdge(NODES.deliver, END)
      .addEdge(NODES.closeQuiet, END)
  );
}

/**
 * Compile with a checkpointer.
 *
 * The checkpointer is a parameter rather than resolved inside, because the
 * approval interrupt is the one thing tests must exercise across a simulated
 * process boundary — and because compiling without one would silently produce a
 * graph whose `interrupt()` cannot be resumed.
 */
export function compileGraph(deps: GraphDeps, checkpointer?: BaseCheckpointSaver) {
  return buildGraph(deps).compile(checkpointer ? { checkpointer } : undefined);
}

export * from './state.js';
export * from './deps.js';
export { getCheckpointer, resetCheckpointer } from './checkpointer.js';
export { currentThreadId, proactiveThreadId } from './nodes/awaitApproval.js';
export type { ApprovalDecision } from './nodes/awaitApproval.js';
