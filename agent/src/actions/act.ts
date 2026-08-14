/**
 * `ProposedAction` in, HTTP out. The `ActFn` the graph is injected with.
 *
 * ── The division of labour, and why it is worth a file boundary ────────────
 * `graph/nodes/routeAction.ts` decides WHETHER an action may run — the
 * blast-radius table, the additive/mutation line, the whole Q3/Q4 safety
 * argument. This decides HOW: which endpoint, what body, what happens when it
 * fails. Keeping them apart means the safety boundary is reviewable without
 * reading any HTTP code, which matters because `api_tokens` has no scope column
 * and cannot enforce that boundary for us (Q3).
 *
 * It also means this file can be pessimistic without being paranoid. It
 * re-checks the class rather than trusting the caller, because the cost of
 * being wrong here is an unapproved mutation.
 *
 * ── Every autonomous write leaves a `document_history` row ─────────────────
 * FG-127. A comment alone is visible to whoever opens the document; the history
 * row is what makes "what did the agent do last week" answerable with one query
 * by someone who does not know which documents to look at. `automated_by` is
 * fixed at `'fleetgraph'` inside the client, so no caller can write an
 * unattributable row.
 *
 * The audit note failing after the comment posted is reported as a failure even
 * though the comment succeeded. Silently returning ok would make the one
 * property the autonomy argument rests on — that every automated write is
 * attributable — quietly untrue. It is non-fatal: `executeAutonomous` records
 * the error, the notification still goes out, and the run still delivers.
 *
 * ── Why mutations are refused here, today ──────────────────────────────────
 * Q23 says an accepted proposal executes via the Ship HTTP API. It cannot yet,
 * and the reason is worth writing down rather than papering over: Ship's
 * `PATCH /api/issues/:id` attributes automated edits through
 * `claude_metadata.updated_by`, which its zod schema types as
 * `z.literal('claude')`. FleetGraph has no way to spell its own name on that
 * route. Executing an approved reassignment through it would produce a
 * `document_history` row that is either unattributed or attributed to Claude —
 * a false audit entry, which is worse than no action at all.
 *
 * Separately, `routeAction` builds mutation payloads that describe the problem
 * ("someone is drowning in this sprint") rather than naming a concrete change,
 * so there is nothing here that could be applied even if attribution worked.
 *
 * So an approved mutation returns a refusal with the reason in it. The human's
 * decision is still recorded, the observation is still resolved `accepted`, and
 * the error names exactly what needs to change in the API. Guessing at the
 * change and mislabelling who made it are both worse.
 */
import type { ProposedAction } from '../graph/state.js';
import { createShipClient, type ShipClient, type ShipResult } from './client.js';

/**
 * Mirrors `GraphDeps['act']` structurally rather than importing it.
 *
 * TypeScript is structural, so this satisfies the seam without a runtime import
 * from `graph/` — which keeps the action layer loadable on its own, the same
 * property `llm/judge.ts` keeps for judgement.
 */
export type ActResult = { ok: boolean; detail?: string };

export function makeShipAct(client: ShipClient = createShipClient()) {
  return async function act(action: ProposedAction): Promise<ActResult> {
    if (action.class === 'mutation') {
      return {
        ok: false,
        detail:
          `refused: ${action.kind} on ${action.targetId} is a state mutation. Ship's ` +
          "PATCH /api/issues/:id types automated attribution as z.literal('claude'), so " +
          'FleetGraph cannot mark the change as its own; an unattributable or mislabelled ' +
          'document_history row is worse than no action (PRESEARCH.md Q3).',
      };
    }

    switch (action.kind) {
      case 'comment':
        return postCommentWithAudit(client, action);

      case 'history_note':
        return summarise(
          await logNote(client, action, 'fleetgraph_note'),
          `history note on ${action.targetId}`
        );

      case 'notify':
        // Notifications are rows in `fleetgraph_notifications`, written by
        // `awaitApproval` and `deliver` through `data/boundary.ts` — the agent's
        // own tables, reached over SQL, not over HTTP. Nothing to send.
        return { ok: true, detail: 'notification is written by the delivery node, not over HTTP' };

      default:
        // Unreachable: the three mutation kinds are caught above and the three
        // additive kinds are handled. Explicit because a new `kind` added to
        // the union without a case here must fail loudly rather than silently
        // succeed.
        return { ok: false, detail: `refused: unhandled additive kind "${action.kind}"` };
    }
  };
}

/**
 * FG-126 + FG-127 together, in that order.
 *
 * Comment first, audit note second: if the process dies between them the
 * failure mode is a visible comment with no history row, which someone can see
 * and reconcile. The other order leaves a history row claiming a comment that
 * does not exist, which nobody can reconcile because there is nothing to find.
 */
async function postCommentWithAudit(
  client: ShipClient,
  action: ProposedAction
): Promise<ActResult> {
  const comment = await client.postComment(action.targetId, commentBody(action));
  if (!comment.ok) {
    return { ok: false, detail: `comment on ${action.targetId}: ${comment.detail}` };
  }

  const note = await logNote(client, action, 'fleetgraph_comment');
  if (note === 'skipped') {
    // The history route verifies `document_type = 'issue'`, so a sprint or
    // project target has no attributable row available at all. Reported rather
    // than swallowed — a comment on a sprint really is less auditable than one
    // on an issue, and pretending otherwise hides a gap in Ship, not in us.
    return {
      ok: true,
      detail:
        `commented on ${action.targetId}; no document_history row — ` +
        'POST /api/issues/:id/history only accepts issue targets',
    };
  }

  if (!note.ok) {
    return {
      ok: false,
      detail:
        `commented on ${action.targetId} but the audit note failed: ${note.detail} ` +
        '(the comment is live and unattributed in document_history)',
    };
  }

  return { ok: true };
}

/** Returns `'skipped'` when the target is not an issue. See above. */
async function logNote(
  client: ShipClient,
  action: ProposedAction,
  field: string
): Promise<ShipResult | 'skipped'> {
  if (action.payload.targetType !== 'issue') return 'skipped';

  return client.logHistoryNote(action.targetId, {
    field,
    oldValue: null,
    // The measurement, not the prose. A history row is read in a list of
    // dozens; it has to say what happened in one line without the reader
    // opening anything.
    newValue: auditLine(action),
  });
}

/**
 * What the agent actually says on the document.
 *
 * The model's phrasing, plus the measurement that triggered it. The number is
 * included deliberately: a comment that says "this looks stalled" invites an
 * argument, and one that says "no movement in 14 business days, threshold is 5"
 * does not. The measurement is also the part a human can check.
 */
export function commentBody(action: ProposedAction): string {
  const phrasing = str(action.payload.phrasing) ?? action.describe;
  const measurement = num(action.payload.measurement);
  const threshold = num(action.payload.threshold);

  const evidence =
    measurement !== null && threshold !== null
      ? `\n\nMeasured ${measurement} against a threshold of ${threshold} (${str(action.payload.signalType) ?? 'signal'}).`
      : '';

  return `${phrasing}${evidence}\n\n— FleetGraph`;
}

/**
 * One line, for a history list.
 *
 * Exported for L23's read-only path (PF-700), which carries this exact string
 * into the recommendation row instead of into `document_history`. Exported
 * rather than copied so the two can never say different things about the same
 * measurement — a hand-written literal on the recommendation side is what
 * PF-699's "compared against the flag-off run's own output" exists to forbid.
 */
export function auditLine(action: ProposedAction): string {
  const type = str(action.payload.signalType) ?? action.kind;
  const measurement = num(action.payload.measurement);
  const threshold = num(action.payload.threshold);
  return measurement !== null && threshold !== null
    ? `${type}: measured ${measurement}, threshold ${threshold}`
    : `${type}: ${action.describe}`;
}

function summarise(result: ShipResult | 'skipped', what: string): ActResult {
  if (result === 'skipped') {
    return { ok: true, detail: `${what} skipped — history is issue-only` };
  }
  return result.ok ? { ok: true } : { ok: false, detail: `${what}: ${result.detail}` };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
