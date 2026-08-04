/**
 * Suspend the run and wait for a human.
 *
 * ── Why this needs a durable checkpointer and not a polling loop ────────────
 * Approval takes hours. The Render cron container exits when the run ends —
 * that is what a cron job is. So the suspended run must survive the process
 * dying, which means the state has to be in Postgres, not in memory (Q19).
 *
 * LangGraph's `interrupt()` plus the Postgres checkpointer does exactly this:
 * the call throws a `GraphInterrupt`, the checkpointer has already written the
 * state, and a later invoke on the same thread id resumes from this line with
 * the human's answer as the return value. The container in between can be a
 * different container on a different machine.
 *
 * ── What was rejected ──────────────────────────────────────────────────────
 * A long-running service holding the run in memory would work, and would mean
 * paying for an always-on process to do nothing 99% of the time and losing
 * every pending approval on deploy. Storing the proposal in our own table and
 * replaying it later would work too, and would mean writing the resume logic
 * LangGraph already has — and getting "what did the graph know at that point"
 * subtly wrong.
 *
 * ── Why the notification is written BEFORE the interrupt ───────────────────
 * This is the part that is easy to get backwards. `interrupt()` does not
 * return; it throws. Anything written after it does not run until the resume,
 * which cannot happen until a human responds — and the human cannot respond to
 * a notification that has not been created yet. So the observation and the
 * notification are written first, and only then does the run suspend (FG-130).
 *
 * Recording the observation here also means the finding is suppressed on the
 * next scan while it sits awaiting approval. Without that, a proposal pending
 * for six hours would be re-detected and re-proposed 120 times.
 */
import { interrupt, getConfig } from '@langchain/langgraph';

import { createNotification, recordObservation } from '../../data/boundary.js';
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export type ApprovalDecision =
  | { decision: 'accept' }
  | { decision: 'dismiss' }
  | { decision: 'snooze'; businessDays: 1 | 3 | 5 };

export function makeAwaitApproval(deps: GraphDeps) {
  return async function awaitApproval(state: GraphStateType): Promise<GraphUpdate> {
    if (!state.pending) {
      return { outcome: 'quiet_nothing_survived_judgment' };
    }

    const finding = state.findings[state.pending.findingIndex];
    const signal = state.signals.find((s) => s.fingerprint === finding?.fingerprint);

    let observationId = state.pending.observationId;

    // Idempotent on (workspace_id, fingerprint) — the unique index that is the
    // suppression key. A resumed run re-entering this node must not create a
    // second observation for the same finding.
    if (!observationId && signal) {
      const obs = await recordObservation(
        {
          workspaceId: state.scope.workspaceId,
          fingerprint: signal.fingerprint,
          signalType: signal.type,
          targetId: signal.targetId,
          targetType: signal.targetType,
        },
        deps.db
      );
      observationId = obs.id;

      const recipient = state.pending.recipientUserId;
      if (recipient) {
        await createNotification(
          {
            workspaceId: state.scope.workspaceId,
            observationId,
            recipientUserId: recipient,
            title: state.pending.action.describe,
            body: finding?.phrasing ?? null,
            targetId: signal.targetId,
            // What the UI resumes. Without it the banner has a decision to
            // offer and nothing to send it to.
            pendingThreadId: currentThreadId(),
          },
          deps.db
        );
      }
    }

    // Everything the human needs to decide, and nothing they would have to go
    // look up. A gate that requires opening three tabs gets rubber-stamped.
    //
    // Does not return — throws, and the checkpointer has the state.
    const answer = interrupt<
      {
        describe: string;
        targetId: string;
        actionClass: string;
        kind: string;
        payload: Record<string, unknown>;
      },
      ApprovalDecision
    >({
      describe: state.pending.action.describe,
      targetId: state.pending.action.targetId,
      actionClass: state.pending.action.class,
      kind: state.pending.action.kind,
      payload: state.pending.action.payload,
    });

    // Reached only on resume — possibly hours later, in a different process.
    return {
      pending: { ...state.pending, observationId },
      outcome: 'awaiting_approval',
      messages: [{ role: 'user' as const, content: JSON.stringify(answer) }],
    };
  };
}

/**
 * The thread the checkpointer is actually writing to.
 *
 * Read from the runtime config rather than computed, and that distinction cost
 * a real bug: the first version derived a plausible-looking id from workspace
 * and fingerprint, stored it as `pending_thread_id`, and had nothing to do with
 * the thread LangGraph was checkpointing under. The approval endpoint would
 * have resumed an id that did not exist — and it would have failed only in
 * production, since the graph tests compile without a checkpointer and never
 * exercise a thread at all.
 *
 * Whatever the caller passed as `configurable.thread_id` is the only id that
 * can be resumed, so it is the only one worth storing.
 */
export function currentThreadId(): string | null {
  try {
    const cfg = getConfig();
    return (cfg?.configurable?.thread_id as string | undefined) ?? null;
  } catch {
    // Running outside a graph invocation, or compiled without a checkpointer.
    return null;
  }
}

/**
 * The thread id a proactive run should be invoked with.
 *
 * Per RUN, not per workspace. A single long-lived workspace thread would mean
 * the next scan resumes a thread still suspended at an approval, immediately
 * re-interrupting it and tangling two runs together. Suppression already stops
 * the same finding being re-proposed while it waits, so forking a fresh thread
 * costs nothing.
 */
export function proactiveThreadId(workspaceId: string, at: Date): string {
  return `fg:${workspaceId}:${at.toISOString()}`;
}
