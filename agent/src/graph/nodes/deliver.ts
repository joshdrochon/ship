/**
 * The last node. Tell the human, remember what was said, close the window.
 *
 * Three writes, in this order, and the order is the point:
 *
 *   1. record the observation   — so it is suppressed next run
 *   2. create the notification  — so a human hears about it
 *   3. advance the watermark    — so the window is closed
 *
 * ── Why the watermark goes LAST ────────────────────────────────────────────
 * It is what makes the proactive path crash-safe with no retry logic at all
 * (Q24). The mark only moves once delivery has actually happened, so a crash
 * anywhere upstream leaves it where it was and the next scan re-covers the same
 * window. Advancing optimistically and retrying failures would lose findings
 * permanently on a crash between the advance and the delivery — and lose them
 * silently, which is worse than losing them loudly.
 *
 * The cost of this ordering is duplicate work after a crash, not duplicate
 * notifications: the observation upsert on `(workspace_id, fingerprint)` makes
 * re-detection idempotent.
 *
 * ── Why the gated path does not re-notify here ─────────────────────────────
 * On the gated path `await_approval` already wrote both the observation and the
 * notification before suspending — it had to, since the human cannot answer a
 * notification that does not exist yet. By the time the resumed run reaches
 * this node the human has already responded, so notifying again would be
 * telling them about a decision they just made.
 */
import { createNotification, recordObservation, setWatermark } from '../../data/boundary.js';
import type { GraphDeps } from '../deps.js';
import type { GraphStateType, GraphUpdate } from '../state.js';

export function makeDeliver(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  return async function deliver(state: GraphStateType): Promise<GraphUpdate> {
    const errors: string[] = [];

    // `delivered` is set by executeApproved, which only runs on the resumed
    // gated path. Its presence is how this node knows the human has already
    // been told.
    const alreadyNotified = state.outcome === 'delivered';

    if (!alreadyNotified && state.pending) {
      const finding = state.findings[state.pending.findingIndex];
      const signal = state.signals.find((s) => s.fingerprint === finding?.fingerprint);

      if (signal) {
        try {
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

          const recipient = state.pending.recipientUserId;
          if (recipient) {
            await createNotification(
              {
                workspaceId: state.scope.workspaceId,
                observationId: obs.id,
                recipientUserId: recipient,
                title: state.pending.action.describe,
                body: finding?.phrasing ?? null,
                targetId: signal.targetId,
              },
              deps.db
            );
          } else {
            // No accountable person could be resolved. Recorded rather than
            // dropped: a finding delivered to nobody is invisible, and the
            // absence should be diagnosable from the trace rather than
            // inferred from a notification that never appeared.
            errors.push(
              `deliver: no recipient for ${signal.type} on ${signal.targetId} — ` +
                'observation recorded, nobody notified'
            );
          }
        } catch (err) {
          errors.push(`deliver: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Recorded even when the notification failed. The scan itself completed —
    // holding the watermark back would make the next run re-detect everything
    // to fix one delivery, and the observation upsert would suppress it anyway.
    try {
      await setWatermark(
        state.scope.workspaceId,
        state.scannedThrough ?? now(),
        state.signals.length,
        deps.db
      );
    } catch (err) {
      errors.push(`deliver: watermark not advanced — ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      outcome: state.outcome === 'awaiting_approval' ? 'awaiting_approval' : 'delivered',
      ...(errors.length ? { errors } : {}),
    };
  };
}

/**
 * Terminal node for every quiet path.
 *
 * Exists so the trace ends at a named node rather than trailing off, and so the
 * watermark advances on quiet runs too — a healthy workspace still has to close
 * its scan window, or the next run re-covers ground it already cleared.
 */
export function makeCloseQuiet(deps: GraphDeps) {
  const now = deps.now ?? (() => new Date());

  return async function closeQuiet(state: GraphStateType): Promise<GraphUpdate> {
    try {
      await setWatermark(
        state.scope.workspaceId,
        state.scannedThrough ?? now(),
        state.signals.length,
        deps.db
      );
    } catch (err) {
      return { errors: [`closeQuiet: ${err instanceof Error ? err.message : String(err)}`] };
    }
    return {};
  };
}
