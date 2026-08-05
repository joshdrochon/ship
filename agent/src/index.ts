/**
 * FleetGraph — a project intelligence agent for Ship.
 *
 * Ship shows you what is happening; it does not tell you what is wrong. This
 * package watches project state, decides what is worth a human's attention, and
 * knows when to act and when to stay quiet.
 *
 * Architecture and the reasoning behind it: PRESEARCH.md at the repo root.
 * Execution plan: TICKETS.md.
 *
 * Two entrypoints, one graph. The difference is the trigger, not the graph:
 *
 *   src/entrypoints/cron.ts   proactive — Render cron, every 3 minutes
 *   (API route)               on-demand — invoked from chat in the Ship UI
 *
 * Both converge at the context node, which is what keeps "one graph, two
 * triggers" true rather than aspirational.
 */

export const FLEETGRAPH_VERSION = '0.0.0';

/**
 * The public surface, and it exists for exactly one consumer: `api/`, which
 * invokes the graph on-demand from the chat endpoint and resumes it from the
 * approval routes.
 *
 * This export barrel could not exist until `circuitBreaker.ts` moved to
 * `@ship/shared`. Before that the agent reached into `api/dist`, so `api`
 * importing the agent would have closed a build cycle.
 *
 * Entrypoints are deliberately NOT re-exported. `entrypoints/cron.ts` runs
 * `main()` on import when invoked directly, and a package barrel that could
 * start a scan as a side effect of being imported is a trap.
 */
export { compileGraph, buildGraph, NODES, proactiveThreadId, currentThreadId } from './graph/index.js';
export { getCheckpointer, resetCheckpointer } from './graph/checkpointer.js';
export { resumeApproval } from './graph/resume.js';
export type { ResumeResult } from './graph/resume.js';
export type { GraphDeps, JudgeFn, AnswerFn, ActFn, Db } from './graph/deps.js';
export type { GraphStateType, Scope, Mode, Participant, ProposedAction, Pending } from './graph/state.js';
export type { ApprovalDecision } from './graph/index.js';
export { makeJudge, makeAnswer, JudgementUnavailableError } from './llm/index.js';
export { makeShipAct } from './actions/index.js';
export { runDetectors } from './detectors/index.js';
export type { Signal, SignalType } from './detectors/types.js';
