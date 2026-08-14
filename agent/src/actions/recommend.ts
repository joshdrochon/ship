/**
 * The read-only `ActFn` — D5b, PF-699, PF-700, PF-701.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND WHY IT HAD TO EXIST.
 * ---------------------------------------------------------------------------
 * Under decision D5b the agent holds `documents:read`, `issues:read` and
 * `sprints:read`, and nothing else. Its two Ship-facing write actions —
 * `comment` (`POST /api/documents/:id/comments`) and `history_note`
 * (`POST /api/issues/:id/history`) — have **no public route and no scope on
 * PRD p.3**, so under the rewire there is nowhere for them to go.
 *
 * That is not a gap to be filled. Adding those two routes to `/api/v1` would be
 * exactly the sprawl p.2 warns against (*"A small public API that matches its
 * spec beats a sprawling public API that contradicts it"*), and inventing two
 * write scopes the PRD never registers would break L03's exactly-seven
 * assertion, which MVP gate item 6 resolves through.
 *
 * So the actions become RECOMMENDATIONS: the same information, reaching the
 * same person, through the agent's own `fleetgraph_notifications` table. And
 * that is precisely what makes Epic 7's claim literally true rather than
 * approximately true — with no write path, every byte the agent exchanges with
 * Ship is a read under its own `client_id`, so the audit trail has no holes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LOST, STATED RATHER THAN GLOSSED (PF-700).
 * ---------------------------------------------------------------------------
 * This is NOT a neutral swap and the write-up must not pretend it is.
 *
 * A comment is visible to anyone who opens the document. A `document_history`
 * row is rendered in Ship's own UI and makes *"what did the agent do last
 * week"* answerable with one query by someone who does not know which documents
 * to look at — `act.ts`'s own header says so, and that property was the reason
 * FG-127 exists.
 *
 * A recommendation row is in neither place. The trail moves from
 * `document_history` to `public_api_calls` + `fleetgraph_notifications`, so the
 * query a reader would have run CHANGES. `docs/architecture.md` says this in
 * prose; this paragraph is the version a maintainer reads.
 *
 * The information itself is not lost. The row carries `commentBody()`'s model
 * phrasing plus the measurement and threshold — *"the part a human can check"*,
 * in that function's own words — and `auditLine()`'s one-line summary. Both are
 * IMPORTED from `act.ts` rather than restated, so the flag-on and flag-off
 * paths cannot say different things about the same measurement.
 *
 * ---------------------------------------------------------------------------
 * `notify` IS UNTOUCHED, AND THAT IS DELIBERATE (PF-701).
 * ---------------------------------------------------------------------------
 * `act('notify')` already sends no HTTP: the row is written by the delivery
 * node, and the action returns a description of that fact. So the one action of
 * three that was never a Ship write is also the one D5b does not change, and
 * this implementation returns the byte-identical result the flag-off one does.
 *
 * It is worth a test rather than a comment because this file is the natural
 * place for a refactor to accidentally route notifications through the
 * recommendation path — which would double every delivery, silently, in a way
 * that looks like the agent got chattier rather than like a bug.
 */
import type { ProposedAction } from '../graph/state.js';
import type { Queryable } from '../data/queryable.js';
import { createNotification, recordObservation } from '../data/boundary.js';
import { commentBody, auditLine, type ActResult } from './act.js';

/** Signal types, as `recordObservation` spells them. */
type SignalTypeish = Parameters<typeof recordObservation>[0]['signalType'];
type TargetTypeish = Parameters<typeof recordObservation>[0]['targetType'];

/**
 * The three fields `routeAction` puts on the payload for this implementation.
 *
 * Read defensively rather than typed onto `ProposedAction`, because
 * `ProposedAction.payload` is `Record<string, unknown>` by design — it is
 * serialised into the checkpointer and resumed hours later, so anything read
 * out of it has already been through JSON and back.
 */
interface RecommendationContext {
  workspaceId: string;
  fingerprint: string;
  recipientUserId: string;
  signalType: SignalTypeish;
  targetType: TargetTypeish;
}

function contextOf(action: ProposedAction): RecommendationContext | null {
  const p = action.payload;
  const workspaceId = typeof p.workspaceId === 'string' ? p.workspaceId : null;
  const fingerprint = typeof p.fingerprint === 'string' ? p.fingerprint : null;
  const recipientUserId = typeof p.recipientUserId === 'string' ? p.recipientUserId : null;
  if (!workspaceId || !fingerprint || !recipientUserId) return null;
  return {
    workspaceId,
    fingerprint,
    recipientUserId,
    signalType: p.signalType as SignalTypeish,
    targetType: p.targetType as TargetTypeish,
  };
}

export interface RecommendActDeps {
  db: Queryable;
}

/**
 * The flag-on `ActFn`.
 *
 * Structurally identical to `makeShipAct`'s return — same input, same output —
 * so the selector in the composition root is one ternary and the graph cannot
 * tell which one it got. That is PF-693's property, applied to the write half.
 */
export function makeRecommendAct(deps: RecommendActDeps) {
  return async function act(action: ProposedAction): Promise<ActResult> {
    /**
     * The mutation refusal is FIRST and IDENTICAL to `act.ts`'s (PF-703).
     *
     * Not shared by import, deliberately: `act.ts`'s refusal string names
     * `PATCH /api/issues/:id`'s attribution problem, which is a fact about the
     * INTERNAL API and is true on both paths. Copying it here rather than
     * extracting it keeps `act.ts` byte-for-byte the Part 2 file (PF-708), and
     * `readOnlyAct.test.ts` asserts the two strings are equal — so the
     * duplication cannot drift even though it is duplication.
     */
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
        // PF-699. The comment's own text, unchanged, into a row instead of onto
        // a document. Zero HTTP requests leave this process.
        return recommend(deps, action, commentBody(action), 'comment');

      case 'history_note':
        // PF-700. `auditLine()`'s one line — the same string the
        // `document_history` row would have carried.
        return recommend(deps, action, auditLine(action), 'history note');

      case 'notify':
        // PF-701. Byte-identical to the flag-off path. See the header.
        return { ok: true, detail: 'notification is written by the delivery node, not over HTTP' };

      default:
        return { ok: false, detail: `refused: unhandled additive kind "${action.kind}"` };
    }
  };
}

/**
 * Writes one recommendation row.
 *
 * The observation is recorded first because `fleetgraph_notifications.
 * observation_id` is `NOT NULL` and the delivery node has not run yet — it runs
 * AFTER the act. `recordObservation` upserts on `(workspace_id, fingerprint)`,
 * so the later call from `deliver` finds the same row rather than creating a
 * second one. That idempotence is not incidental; it is the property that makes
 * the whole proactive path crash-safe (Q24), and this reuses it rather than
 * adding a second write path to the same table.
 */
async function recommend(
  deps: RecommendActDeps,
  action: ProposedAction,
  body: string,
  what: string,
): Promise<ActResult> {
  const context = contextOf(action);
  if (!context) {
    // Loud, not silent. A recommendation with no recipient is a finding
    // delivered to nobody — which is exactly the failure `deliver` already
    // reports rather than swallows, for the same reason.
    return {
      ok: false,
      detail:
        `refused: ${what} on ${action.targetId} carries no workspace, fingerprint or ` +
        'recipient — nothing to address the recommendation to (PF-699)',
    };
  }

  try {
    const observation = await recordObservation(
      {
        workspaceId: context.workspaceId,
        fingerprint: context.fingerprint,
        signalType: context.signalType,
        targetId: action.targetId,
        targetType: context.targetType,
      },
      deps.db,
    );

    await createNotification(
      {
        workspaceId: context.workspaceId,
        observationId: observation.id,
        recipientUserId: context.recipientUserId,
        title: action.describe,
        body,
        targetId: action.targetId,
        // PF-702 — the one column that makes this countable and renderable as
        // something other than a finding.
        kind: 'recommendation',
      },
      deps.db,
    );

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: `${what} recommendation on ${action.targetId}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
