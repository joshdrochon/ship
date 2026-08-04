/**
 * FleetGraph HTTP surface — the six endpoints the UI talks to.
 *
 *   GET  /api/fleetgraph/notifications              this user's open findings
 *   POST /api/fleetgraph/notifications/:id/acknowledge
 *   POST /api/fleetgraph/approvals/:id/accept
 *   POST /api/fleetgraph/approvals/:id/dismiss
 *   POST /api/fleetgraph/approvals/:id/snooze
 *   POST /api/fleetgraph/chat                       on-demand invocation (Q7)
 *
 * ── Why these routes hold their own SQL ─────────────────────────────────────
 * `agent/src/data/boundary.ts` owns every agent↔Ship join on the AGENT side,
 * and says so at length. These routes deliberately do not import it: `agent/`
 * is a separate package with its own pool, and having the API process reach
 * across would make the reversal path in that file's header a lie — "nothing
 * outside this file changes" cannot hold if a second package imports it.
 * The queries here read the same tables and must keep the same semantics; the
 * ones that matter are called out inline.
 *
 * ── `:id` on the approve-path routes is a NOTIFICATION id ───────────────────
 * Not an observation id. Q22 puts the confirmation in the document the finding
 * is about, found by `idx_fleetgraph_notif_target (target_id) WHERE state =
 * 'pending'` — so what the UI is holding when the human clicks Accept is a
 * notification row. That row already carries `observation_id` and
 * `pending_thread_id`, which is everything the resume path needs. Keying on the
 * observation instead would make the UI carry a second id for no gain.
 *
 * ── Why accept/dismiss/snooze write to the database at all ──────────────────
 * They resume a durable LangGraph `interrupt()` (Q21). The graph is not wired
 * yet, so each endpoint persists its decision to `fleetgraph_observations` and
 * `fleetgraph_notifications` and the resume path picks the decision up from
 * there. That ordering is correct even once the graph exists: the human's
 * answer must be durable BEFORE the resume runs, or a crash mid-resume loses
 * the decision and re-asks — and re-asking a dismissed finding is the single
 * fastest way to get the agent switched off (Q23).
 */
import { Router, Request, Response } from 'express';
import { ZodError } from 'zod';
import { addBusinessDays } from '@ship/shared';

import { pool } from '../../db/client.js';
import type { ApprovalDecision } from '@ship/agent';
import { authMiddleware, requireAuth } from '../../middleware/auth.js';
import { getVisibilityContext, VISIBILITY_FILTER_SQL } from '../../middleware/visibility.js';
import { checkRateLimit } from '../../services/ai-analysis.js';
import { AgentUnavailableError, invokeAgentChat } from './agentBridge.js';
import {
  chatBodySchema,
  emptyBodySchema,
  idParamSchema,
  snoozeBodySchema,
} from './schemas.js';

type RouterType = ReturnType<typeof Router>;
const router: RouterType = Router();

/**
 * Every route below is mounted behind `authMiddleware` at the router level
 * rather than per-handler.
 *
 * Per-handler is the house style elsewhere, and it is the style that lets a
 * seventh route be added later without it — an unauthenticated FleetGraph
 * endpoint leaks who is accountable for what across a workspace. Applying it
 * once here means a new route cannot forget.
 */
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The repo's error envelope: `{ error: string }`, plus a code where useful. */
function badRequest(res: Response, err: unknown): void {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    res.status(400).json({
      error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request',
      code: 'VALIDATION_ERROR',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  res.status(400).json({ error: 'Invalid request', code: 'VALIDATION_ERROR' });
}

/**
 * Resolve a notification the caller is actually entitled to act on.
 *
 * Three conditions, all of them necessary:
 *   - the notification is in the caller's workspace
 *   - the caller is its recipient — Q6 gives every finding exactly ONE
 *     accountable person, and letting anyone else resolve it destroys the
 *     property that makes the notification closable
 *   - the caller can read the target document (see `visibleTargetClause`)
 *
 * Returns null for all three, and the routes answer 404 rather than 403 in
 * every case. A 403 would confirm the row exists, which tells an unauthorised
 * caller that a finding was raised about a document they cannot see — the same
 * leak FG-148 closes on the list endpoint, arriving through the back door.
 */
async function loadActionableNotification(
  notificationId: string,
  userId: string,
  workspaceId: string,
  isAdmin: boolean
): Promise<{
  id: string;
  observationId: string;
  pendingThreadId: string | null;
  state: string;
  targetId: string | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT n.id, n.observation_id, n.pending_thread_id, n.state, n.target_id
       FROM fleetgraph_notifications n
       LEFT JOIN documents d ON d.id = n.target_id
      WHERE n.id = $1
        AND n.workspace_id = $2
        AND n.recipient_user_id = $3
        AND (n.target_id IS NULL OR ${VISIBILITY_FILTER_SQL('d', '$3', '$4')})`,
    [notificationId, workspaceId, userId, isAdmin]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    observationId: row.observation_id,
    pendingThreadId: row.pending_thread_id,
    state: row.state,
    targetId: row.target_id,
  };
}

/**
 * Close a finding and the notification that delivered it, in one transaction.
 *
 * One transaction because the two writes are one decision. A resolved
 * observation with a still-pending notification re-presents a finding the human
 * has already answered; an acknowledged notification with an open observation
 * means the detector surfaces it again on the next run. Either half alone is a
 * bug that only shows up minutes later, in the cron, far from this code.
 *
 * Mirrors `resolveObservation` in `agent/src/data/boundary.ts`, including the
 * `resolved_at` rule: a snooze is NOT resolved, it is deferred, so `resolved_at`
 * stays null and `snooze_until` carries the horizon.
 */
async function persistDecision(
  notificationId: string,
  observationId: string,
  resolution: 'accepted' | 'dismissed' | 'snoozed',
  snoozeUntil: Date | null
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE fleetgraph_observations
          SET resolution = $2,
              resolved_at = CASE WHEN $2 = 'snoozed' THEN NULL ELSE NOW() END,
              snooze_until = $3,
              updated_at = NOW()
        WHERE id = $1`,
      [observationId, resolution, snoozeUntil]
    );
    await client.query(
      `UPDATE fleetgraph_notifications
          SET state = 'acknowledged', acknowledged_at = NOW()
        WHERE id = $1 AND state = 'pending'`,
      [notificationId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Snooze wake time, in business days from today (Q23).
 *
 * `addBusinessDays` is the same helper the detectors measure with — thresholds
 * that disagree between the detector and the product are worse than no
 * detector, which is why `api/src/utils/business-days.ts` is a shim over
 * `@ship/shared` rather than a second copy.
 *
 * Wakes at 00:00 UTC on the Nth business day, so a finding snoozed at any hour
 * returns at the start of a working day rather than mid-afternoon N*24h later.
 */
export function snoozeUntilDate(days: number, now: Date = new Date()): Date {
  const today = now.toISOString().slice(0, 10);
  return new Date(`${addBusinessDays(today, days)}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// FG-138 · GET /api/fleetgraph/notifications
// ---------------------------------------------------------------------------

/**
 * The caller's open findings, newest first.
 *
 * ── FG-148, the visibility filter ───────────────────────────────────────────
 * A notification names a document and quotes its state. Ship documents can be
 * `private`, readable only by their creator and workspace admins
 * (`middleware/visibility.ts`). So a finding about a private document must not
 * reach a recipient who cannot open it — otherwise the title and body leak the
 * contents of a document the reader has no right to, and the agent becomes a
 * disclosure channel that bypasses the permission model it reads through.
 *
 * The filter is applied in SQL, not after the fetch, so an unreadable row never
 * enters the process. `target_id IS NULL` passes: a workspace-level finding
 * with no document target has nothing to leak.
 *
 * Matches `listOpenNotifications` in `agent/src/data/boundary.ts` — same join,
 * same ordering, plus this filter. The agent-side query has no filter because
 * it runs as the system while resolving a recipient; this one runs as a human.
 */
router.get('/notifications', async (req: Request, res: Response) => {
  try {
    const { userId, workspaceId } = requireAuth(req);
    const { isAdmin } = await getVisibilityContext(userId, workspaceId);

    const { rows } = await pool.query(
      `SELECT n.id,
              n.observation_id,
              n.title,
              n.body,
              n.target_id,
              n.pending_thread_id,
              n.created_at,
              d.title         AS target_title,
              d.document_type AS target_type,
              o.signal_type,
              o.fingerprint
         FROM fleetgraph_notifications n
         JOIN fleetgraph_observations o ON o.id = n.observation_id
         LEFT JOIN documents d ON d.id = n.target_id
        WHERE n.recipient_user_id = $1
          AND n.workspace_id = $2
          AND n.state = 'pending'
          AND (n.target_id IS NULL OR ${VISIBILITY_FILTER_SQL('d', '$1', '$3')})
        ORDER BY n.created_at DESC`,
      [userId, workspaceId, isAdmin]
    );

    res.json({
      notifications: rows.map((r) => ({
        id: r.id,
        observationId: r.observation_id,
        title: r.title,
        body: r.body,
        targetId: r.target_id,
        targetTitle: r.target_title,
        targetType: r.target_type,
        signalType: r.signal_type,
        fingerprint: r.fingerprint,
        // Non-null means this finding is gated on a human answer (Q21): the UI
        // renders Accept / Dismiss / Snooze rather than a bare acknowledge.
        pendingThreadId: r.pending_thread_id,
        requiresApproval: r.pending_thread_id !== null,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('FleetGraph list notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// ---------------------------------------------------------------------------
// FG-139 · POST /api/fleetgraph/notifications/:id/acknowledge
// ---------------------------------------------------------------------------

/**
 * "I have seen this." Not a judgment — the observation is left open.
 *
 * Idempotent, by the `state = 'pending'` guard in the UPDATE and by answering
 * 200 either way. A double-click, a retried request and a second tab must all
 * be indistinguishable from one click; anything else pushes retry logic into
 * the UI for an operation that has no meaningful failure.
 */
router.post('/notifications/:id/acknowledge', async (req: Request, res: Response) => {
  let notificationId: string;
  try {
    notificationId = idParamSchema.parse(req.params).id;
    emptyBodySchema.parse(req.body ?? {});
  } catch (err) {
    badRequest(res, err);
    return;
  }

  try {
    const { userId, workspaceId } = requireAuth(req);
    const { isAdmin } = await getVisibilityContext(userId, workspaceId);
    const notification = await loadActionableNotification(
      notificationId,
      userId,
      workspaceId,
      isAdmin
    );
    if (!notification) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }

    await pool.query(
      `UPDATE fleetgraph_notifications
          SET state = 'acknowledged', acknowledged_at = NOW()
        WHERE id = $1 AND state = 'pending'`,
      [notificationId]
    );

    res.json({ id: notificationId, state: 'acknowledged' });
  } catch (err) {
    console.error('FleetGraph acknowledge error:', err);
    res.status(500).json({ error: 'Failed to acknowledge notification' });
  }
});

// ---------------------------------------------------------------------------
// FG-140/141/142 · the approve path
// ---------------------------------------------------------------------------

/**
 * The three decisions share a shape: resolve the notification, persist the
 * decision, report what the resume path will find. Only the resolution and the
 * snooze horizon differ, so they share one handler factory — three copies of
 * this would be three places for the transaction boundary to be got wrong.
 *
 * `resumed` reports whether the suspended graph run was actually continued.
 * The decision is persisted FIRST and the resume attempted after, so a
 * checkpointer that is unreachable costs a proposed comment, never the human's
 * decision. Losing the decision would resurface a finding someone dismissed,
 * which is the fastest route to the agent being muted (Q23).
 *
 * `resumed: false` is also the normal answer for most findings: only gated
 * mutations suspend at all, and an additive finding has no thread to resume.
 */
function approvalHandler(
  resolution: 'accepted' | 'dismissed' | 'snoozed',
  computeSnoozeUntil?: (req: Request) => Date
) {
  /** The resolution as the graph's `interrupt()` expects to receive it. */
  const decisionFor = (req: Request): ApprovalDecision => {
    if (resolution === 'accepted') return { decision: 'accept' };
    if (resolution === 'dismissed') return { decision: 'dismiss' };
    const days = snoozeBodySchema.parse(req.body ?? {}).days;
    return { decision: 'snooze', businessDays: days as 1 | 3 | 5 };
  };

  return async (req: Request, res: Response): Promise<void> => {
    let notificationId: string;
    let snoozeUntil: Date | null = null;
    try {
      notificationId = idParamSchema.parse(req.params).id;
      snoozeUntil = computeSnoozeUntil ? computeSnoozeUntil(req) : null;
      if (!computeSnoozeUntil) emptyBodySchema.parse(req.body ?? {});
    } catch (err) {
      badRequest(res, err);
      return;
    }

    try {
      const { userId, workspaceId } = requireAuth(req);
      const { isAdmin } = await getVisibilityContext(userId, workspaceId);
      const notification = await loadActionableNotification(
        notificationId,
        userId,
        workspaceId,
        isAdmin
      );
      if (!notification) {
        res.status(404).json({ error: 'Notification not found' });
        return;
      }

      // Persist FIRST. See the header: a failed resume must not cost the
      // decision.
      await persistDecision(
        notification.id,
        notification.observationId,
        resolution,
        snoozeUntil
      );

      const { resumeApproval, makeJudge, makeAnswer, makeShipAct } = await import('@ship/agent');
      const resume = await resumeApproval({
        threadId: notification.pendingThreadId,
        decision: decisionFor(req),
        db: pool,
        judge: makeJudge(),
        answer: makeAnswer(),
        act: makeShipAct(),
      });

      res.json({
        id: notification.id,
        observationId: notification.observationId,
        resolution,
        snoozeUntil: snoozeUntil ? snoozeUntil.toISOString() : null,
        threadId: notification.pendingThreadId,
        resumed: resume.resumed,
      });
    } catch (err) {
      console.error(`FleetGraph ${resolution} error:`, err);
      res.status(500).json({ error: `Failed to record ${resolution} decision` });
    }
  };
}

/**
 * FG-140 · Accept. The human agrees; the proposal should execute.
 *
 * Marks the observation `accepted` so the detector stops re-surfacing it while
 * the resumed graph carries out the proposal via Ship's own HTTP API (Q23). It
 * does NOT execute the proposal here — that would put a mutation outside the
 * graph's trace, and Q21's whole argument for `interrupt()` is that the
 * reasoning and the action stay in one run.
 */
router.post('/approvals/:id/accept', approvalHandler('accepted'));

/**
 * FG-141 · Dismiss. The agent was wrong, or the human knows something it does not.
 *
 * `resolution = 'dismissed'` is PERMANENT for this fingerprint. The suppression
 * query in `agent/src/data/boundary.ts#loadSuppressionSet` keeps dismissed rows
 * in the set forever — unlike snoozed rows, which fall out at their horizon —
 * so the same fingerprint never fires again for that target (Q23). Dismissal is
 * information: re-asking is worse than useless, and a dismissed finding that
 * returns next week is the fastest route to the agent being switched off.
 *
 * The fingerprint includes a threshold bucket (migration 038), so this silences
 * "idle 5 days" for this issue without silencing "idle 20 days" — a genuinely
 * worse condition is still allowed to surface once.
 */
router.post('/approvals/:id/dismiss', approvalHandler('dismissed'));

/**
 * FG-142 · Snooze. Not now — ask again in N business days.
 *
 * Sets `snooze_until`; the observation stays unresolved. At wake the detector
 * is RE-RUN rather than the stored finding replayed (Q23), so a condition that
 * fixed itself in the meantime simply never comes back. That is only affordable
 * because detection is pure SQL and costs no tokens (Q1/Q2).
 */
router.post(
  '/approvals/:id/snooze',
  approvalHandler('snoozed', (req) => {
    const { days } = snoozeBodySchema.parse(req.body ?? {});
    return snoozeUntilDate(days);
  })
);

// ---------------------------------------------------------------------------
// FG-143/144/149 · POST /api/fleetgraph/chat
// ---------------------------------------------------------------------------

/**
 * On-demand invocation. Use case 6 (Q9): read-only, grounded in one document.
 *
 * ── The privacy boundary (FG-144, Q7) ───────────────────────────────────────
 * The body carries ROUTE PARAMETERS — document id, document type, active tab —
 * and NEVER rendered content. The schema is `.strict()`, so a client that adds
 * `content` or an editor snapshot gets a 400 naming the field rather than
 * having it quietly forwarded to Bedrock. The reasoning is in
 * `agentBridge.ts`; the short version is that an id can be re-read under this
 * user's visibility rules and a blob of HTML cannot be checked at all.
 *
 * The visibility check below is the other half of that: the caller must be able
 * to read the document before the agent is asked to reason about it. Without
 * it, chat becomes a read primitive for private documents — ask about an id you
 * cannot open and let the agent read it for you.
 *
 * ── The rate limit (FG-149, Q32) ────────────────────────────────────────────
 * On-demand cost scales with engagement rather than with drift, so it is
 * unbounded by anything in the architecture. `checkRateLimit` from
 * `ai-analysis.ts` is reused deliberately — Q32 names that pattern, and a
 * second limiter would be a second thing to tune. Consequence worth knowing:
 * the bucket is keyed by user id and SHARED with `/api/ai/analyze-*`, so heavy
 * chat use eats into plan-analysis budget. That is a real coupling, accepted
 * because 120/hr is far above either path's realistic use.
 *
 * ── The outbound call ───────────────────────────────────────────────────────
 * The model call itself is behind the graph, which runs the Bedrock breaker in
 * `services/circuitBreaker.ts` (Implementation Rule 7). This route's job is to
 * turn an unavailable agent into `ai_unavailable` — the same answer the UI
 * already knows how to render from `PlanQualityBanner` — rather than a stack
 * trace or a hang. Named failure mode: agent unreachable or not deployed →
 * 503 `ai_unavailable`, chat renders as unavailable, nothing else degrades.
 */
router.post('/chat', async (req: Request, res: Response) => {
  let body;
  try {
    body = chatBodySchema.parse(req.body ?? {});
  } catch (err) {
    badRequest(res, err);
    return;
  }

  try {
    const { userId, workspaceId } = requireAuth(req);

    if (!checkRateLimit(userId)) {
      res.status(429).json({
        error: 'Rate limit exceeded. Max 120 agent requests per hour.',
        code: 'RATE_LIMITED',
      });
      return;
    }

    // FG-148 on the chat path. Same filter as the list endpoint, and 404 rather
    // than 403 for the same reason: the response must not distinguish "no such
    // document" from "a document you may not read".
    const { isAdmin } = await getVisibilityContext(userId, workspaceId);
    const { rows } = await pool.query(
      `SELECT d.id, d.document_type
         FROM documents d
        WHERE d.id = $1
          AND d.workspace_id = $2
          AND d.deleted_at IS NULL
          AND ${VISIBILITY_FILTER_SQL('d', '$3', '$4')}`,
      [body.document_id, workspaceId, userId, isAdmin]
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const result = await invokeAgentChat({
      documentId: body.document_id,
      // The stored type wins over the client's. The client's value is a routing
      // hint from the URL and can be stale after a document conversion
      // (`converted_to_id` exists precisely because types change); the graph
      // must pick its context node from what the document actually is.
      documentType: rows[0].document_type,
      tab: body.tab ?? null,
      userId,
      workspaceId,
      message: body.message,
    });

    res.json({
      answer: result.answer,
      threadId: result.threadId,
      documentId: body.document_id,
    });
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      // Expected while the graph is unwired, and expected again whenever it is
      // down. Logged at warn, not error: this is a degraded state, not a defect.
      console.warn(`FleetGraph chat unavailable (${err.reason})`);
      res.status(503).json({ error: 'ai_unavailable', reason: err.reason });
      return;
    }
    console.error('FleetGraph chat error:', err);
    res.status(500).json({ error: 'Chat request failed' });
  }
});

export default router;
