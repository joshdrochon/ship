/**
 * Resume a run suspended at the human approval gate.
 *
 * ── Why this lives here and not in the API route ────────────────────────────
 * Resuming means handing LangGraph a `Command({ resume })` against a thread id.
 * That is graph vocabulary, and putting it in an Express handler would make
 * `api/` depend on `@langchain/langgraph` to deliver a button press. The route
 * knows a notification and a decision; this knows what LangGraph does with
 * them.
 *
 * ── The decision is already durable before this runs ────────────────────────
 * The route persists the resolution to `fleetgraph_observations` first, and
 * only then calls this. That ordering is deliberate and it is why this function
 * reports failure instead of throwing it: if the checkpointer is unreachable or
 * the thread has already been consumed, the human's decision is still recorded,
 * the finding is still suppressed, and the worst case is that a proposed
 * comment does not get posted.
 *
 * Losing the decision because the resume failed would be far worse — the
 * finding would resurface, and a human who dismissed something would be asked
 * again, which is the fastest way to get the agent muted (Q23).
 *
 * ── Why a fresh graph every time ────────────────────────────────────────────
 * The run being resumed was proposed by a different process, usually hours ago
 * and often a container that no longer exists. There is nothing in memory to
 * reuse. Everything comes back from the Postgres checkpointer, which is the
 * whole reason it is not optional (Q19).
 */
import { Command } from '@langchain/langgraph';

import { compileGraph } from './index.js';
import { getCheckpointer } from './checkpointer.js';
import type { Db, GraphDeps } from './deps.js';
import type { ApprovalDecision } from './nodes/awaitApproval.js';

export interface ResumeResult {
  resumed: boolean;
  /** Present when the resume did not happen. Never a reason to fail the request. */
  detail?: string;
}

export async function resumeApproval(params: {
  threadId: string | null;
  decision: ApprovalDecision;
  db: Db;
  judge: GraphDeps['judge'];
  answer: GraphDeps['answer'];
  act: GraphDeps['act'];
}): Promise<ResumeResult> {
  if (!params.threadId) {
    // Nothing suspended. Normal for a finding delivered as a notification with
    // no gated action behind it — most findings are additive and never
    // suspended at all.
    return { resumed: false, detail: 'no pending thread for this notification' };
  }

  try {
    const checkpointer = await getCheckpointer();

    // Is there actually a suspended run on this thread?
    //
    // Without this check, `invoke(new Command({resume}))` against a thread that
    // has no checkpoint does NOT fail — LangGraph treats it as a fresh run and
    // starts the graph from empty state. So a stale or fabricated thread id
    // would silently launch a brand-new scan with no scope, and the endpoint
    // would report `resumed: true` for a run that resumed nothing.
    //
    // Caught by an approval test that expected `resumed: false` and got `true`.
    const existing = await checkpointer.getTuple({
      configurable: { thread_id: params.threadId },
    });

    if (!existing) {
      return {
        resumed: false,
        detail: `no suspended run on thread ${params.threadId}`,
      };
    }

    const graph = compileGraph(
      {
        db: params.db,
        judge: params.judge,
        answer: params.answer,
        act: params.act,
      },
      checkpointer
    );

    await graph.invoke(new Command({ resume: params.decision }) as never, {
      recursionLimit: 50,
      configurable: { thread_id: params.threadId },
    });

    return { resumed: true };
  } catch (err) {
    // Reported, never thrown. See the header: the decision is already durable.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[fleetgraph] resume failed for thread ${params.threadId}:`, detail);
    return { resumed: false, detail };
  }
}
