/**
 * Route tests for the six FleetGraph endpoints.
 *
 * What these are actually defending, in rough order of how expensive the bug
 * would be:
 *
 *   1. Dismissal is permanent for a fingerprint (Q23). The suppression query is
 *      the largest cost cliff in the design (Q32) — one leaked finding becomes
 *      480 model calls a day and the only symptom is a cost graph.
 *   2. The chat body carries route params and NOTHING else (Q7, FG-144). This
 *      is a privacy boundary; the tests send `content`/`html`/a DOM snapshot and
 *      demand a 400.
 *   3. Visibility (FG-148). A notification quotes the document it is about, so a
 *      finding about a private document must not reach someone who cannot open
 *      that document.
 *   4. Snooze horizons are business days (Q23), not calendar days.
 *
 * The agent seam is exercised AS a seam. `agentBridge` is mocked so its one
 * unimplemented function can be swapped per test, and the default delegates to
 * the real module — so "the graph is not wired" is asserted against the actual
 * code path rather than against a fake that agrees with it. When the graph lands
 * at `agent/src/graph/`, these tests still describe the contract it must meet.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';

import { createApp } from '../../app.js';
import { testDeps } from '../../deps.js';
import { pool } from '../../db/client.js';
import { snoozeUntilDate } from './index.js';
import * as agentBridge from './agentBridge.js';
import type { AgentChatRequest, AgentChatResponse } from './agentBridge.js';

/**
 * Per-test override for the agent seam. Null means "use the real one", which is
 * what makes the `agent_not_wired` test meaningful.
 *
 * A module mock rather than `vi.spyOn`: ESM exports are immutable bindings, so
 * spying on a namespace import cannot work here.
 */
let chatImpl: ((req: AgentChatRequest) => Promise<AgentChatResponse>) | null = null;

vi.mock('./agentBridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentBridge.js')>();
  return {
    ...actual,
    invokeAgentChat: vi.fn((req: AgentChatRequest) =>
      chatImpl ? chatImpl(req) : actual.invokeAgentChat(req)
    ),
  };
});

const invokeAgentChat = vi.mocked(agentBridge.invokeAgentChat);

/** What the route handed the agent on its first call. Fails loudly if it never called. */
function firstAgentCall(): AgentChatRequest {
  const call = invokeAgentChat.mock.calls[0];
  expect(call, 'expected the route to invoke the agent').toBeDefined();
  return call![0];
}

const app = createApp(testDeps({ corsOrigin: 'http://localhost:5173' }));
const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

interface Auth {
  cookie: string;
  csrf: string;
}

/** A session cookie plus a matching CSRF token — the POST routes need both. */
async function makeAuth(userId: string | null, workspaceId: string): Promise<Auth> {
  let cookie = '';
  if (userId) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId]
    );
    cookie = `session_id=${sessionId}`;
  }
  const csrfRes = await request(app).get('/api/csrf-token').set('Cookie', cookie);
  const connectSid = csrfRes.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
  return {
    cookie: [cookie, connectSid].filter(Boolean).join('; '),
    csrf: csrfRes.body.token,
  };
}

describe('FleetGraph API', () => {
  let workspaceId: string;
  let recipientId: string;
  let otherUserId: string;
  let adminId: string;
  const extraUserIds: string[] = [];

  let recipientAuth: Auth;
  let adminAuth: Auth;
  /** Valid CSRF, no session — isolates the 401 from the CSRF gate in front of it. */
  let anonAuth: Auth;

  let publicDocId: string;
  let privateDocId: string;

  beforeAll(async () => {
    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `FleetGraph Test ${runId}`,
    ]);
    workspaceId = ws.rows[0].id;

    const mkUser = async (label: string) => {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', $2) RETURNING id`,
        [`fg-${label}-${runId}@ship.local`, `FG ${label}`]
      );
      const row = r.rows[0];
      if (!row) throw new Error(`fixture: INSERT of user ${label} returned no row`);
      return row.id;
    };

    recipientId = await mkUser('recipient');
    otherUserId = await mkUser('other');
    adminId = await mkUser('admin');
    extraUserIds.push(recipientId, otherUserId, adminId);

    for (const [uid, role] of [
      [recipientId, 'member'],
      [otherUserId, 'member'],
      [adminId, 'admin'],
    ] as const) {
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`,
        [workspaceId, uid, role]
      );
    }

    recipientAuth = await makeAuth(recipientId, workspaceId);
    adminAuth = await makeAuth(adminId, workspaceId);
    anonAuth = await makeAuth(null, workspaceId);

    // A workspace-visible issue, and a private one created by somebody else.
    const pub = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
       VALUES ($1, 'issue', 'Public stalled issue', $2, 'workspace') RETURNING id`,
      [workspaceId, otherUserId]
    );
    publicDocId = pub.rows[0].id;

    const priv = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility)
       VALUES ($1, 'issue', 'Secret issue', $2, 'private') RETURNING id`,
      [workspaceId, otherUserId]
    );
    privateDocId = priv.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [extraUserIds]);
  });

  beforeEach(async () => {
    // Cascades to fleetgraph_notifications, so no test leans on another's rows.
    await pool.query(`DELETE FROM fleetgraph_observations WHERE workspace_id = $1`, [workspaceId]);

    // LangGraph's checkpoint tables too. The approval routes now resume a real
    // graph, so a thread id left behind by an earlier test is a suspended run
    // the next one will find and continue — which is exactly what happened:
    // `resumed` came back true for a thread whose only checkpoints were
    // written by a previous run of this same file. The tables are created by
    // the library on first use, so the delete is guarded.
    await pool
      .query(`TRUNCATE checkpoints, checkpoint_blobs, checkpoint_writes`)
      .catch(() => undefined);
    chatImpl = null;
    invokeAgentChat.mockClear();
  });

  /** One observation plus the notification that delivered it. */
  async function seedFinding(opts: {
    targetId: string | null;
    recipient: string;
    signalType?: string;
    pendingThreadId?: string | null;
  }): Promise<{ observationId: string; notificationId: string; fingerprint: string }> {
    const fingerprint = `fp-${crypto.randomUUID()}`;
    const obs = await pool.query(
      `INSERT INTO fleetgraph_observations
         (workspace_id, fingerprint, signal_type, target_id, target_type, last_surfaced_at)
       VALUES ($1, $2, $3, $4, 'issue', NOW()) RETURNING id`,
      [workspaceId, fingerprint, opts.signalType ?? 'stalled_work', opts.targetId ?? publicDocId]
    );
    const notif = await pool.query(
      `INSERT INTO fleetgraph_notifications
         (workspace_id, observation_id, recipient_user_id, title, body, target_id, pending_thread_id)
       VALUES ($1, $2, $3, 'Stalled for 7 business days', 'No history since Monday', $4, $5)
       RETURNING id`,
      [
        workspaceId,
        obs.rows[0].id,
        opts.recipient,
        opts.targetId,
        opts.pendingThreadId ?? 'thread-1',
      ]
    );
    return { observationId: obs.rows[0].id, notificationId: notif.rows[0].id, fingerprint };
  }

  // -------------------------------------------------------------------------
  // FG-147 · every endpoint behind authMiddleware
  // -------------------------------------------------------------------------

  describe('authentication (FG-147)', () => {
    // A valid CSRF token is sent on the POSTs deliberately. Without one the CSRF
    // gate answers 403 before authMiddleware ever runs, and the test would pass
    // whether or not the route was authenticated — proving nothing.
    it('GET /notifications rejects an unauthenticated caller', async () => {
      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', anonAuth.cookie);
      expect(res.status).toBe(401);
    });

    it.each([
      `/api/fleetgraph/notifications/${crypto.randomUUID()}/acknowledge`,
      `/api/fleetgraph/approvals/${crypto.randomUUID()}/accept`,
      `/api/fleetgraph/approvals/${crypto.randomUUID()}/dismiss`,
      `/api/fleetgraph/approvals/${crypto.randomUUID()}/snooze`,
      '/api/fleetgraph/chat',
    ])('POST %s rejects an unauthenticated caller', async (path) => {
      const res = await request(app)
        .post(path)
        .set('Cookie', anonAuth.cookie)
        .set('x-csrf-token', anonAuth.csrf)
        .send({});
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // FG-138 · GET /notifications, and FG-148 visibility
  // -------------------------------------------------------------------------

  describe('GET /notifications (FG-138)', () => {
    it("returns the caller's pending notifications", async () => {
      const { notificationId, observationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', recipientAuth.cookie);

      expect(res.status).toBe(200);
      const found = res.body.notifications.find((n: { id: string }) => n.id === notificationId);
      expect(found).toBeDefined();
      expect(found.observationId).toBe(observationId);
      expect(found.targetId).toBe(publicDocId);
      expect(found.targetTitle).toBe('Public stalled issue');
      expect(found.targetType).toBe('issue');
      expect(found.signalType).toBe('stalled_work');
      // pending_thread_id is set, so this finding is gated on a human answer.
      expect(found.requiresApproval).toBe(true);
    });

    // Q6: exactly one accountable person per finding. If another user's
    // notifications leak into this list, "the one person who can close it" stops
    // being true and the inbox becomes everybody's problem.
    it("never returns another user's notifications", async () => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: otherUserId,
      });

      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', recipientAuth.cookie);

      expect(res.status).toBe(200);
      expect(res.body.notifications.map((n: { id: string }) => n.id)).not.toContain(notificationId);
    });

    it('omits acknowledged notifications', async () => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });
      await pool.query(`UPDATE fleetgraph_notifications SET state = 'acknowledged' WHERE id = $1`, [
        notificationId,
      ]);

      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', recipientAuth.cookie);

      expect(res.body.notifications.map((n: { id: string }) => n.id)).not.toContain(notificationId);
    });

    // FG-148. The title and body quote the document, so delivering the finding
    // to someone who cannot open that document turns the agent into a disclosure
    // channel around Ship's own permission model.
    it('hides a finding about a private document from a non-reader', async () => {
      const { notificationId } = await seedFinding({
        targetId: privateDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', recipientAuth.cookie);

      expect(res.status).toBe(200);
      expect(res.body.notifications.map((n: { id: string }) => n.id)).not.toContain(notificationId);
    });

    it('shows the same finding to a workspace admin, who can read the document', async () => {
      const { notificationId } = await seedFinding({
        targetId: privateDocId,
        recipient: adminId,
      });

      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', adminAuth.cookie);

      expect(res.body.notifications.map((n: { id: string }) => n.id)).toContain(notificationId);
    });

    // Q22's deliberate exception: a load-imbalance finding targets a set, not one
    // document. It has no target and nothing to leak.
    it('returns a notification with no target document', async () => {
      const obs = await pool.query(
        `INSERT INTO fleetgraph_observations
           (workspace_id, fingerprint, signal_type, target_id, target_type)
         VALUES ($1, $2, 'load_imbalance', $3, 'sprint') RETURNING id`,
        [workspaceId, `fp-${crypto.randomUUID()}`, publicDocId]
      );
      const notif = await pool.query(
        `INSERT INTO fleetgraph_notifications
           (workspace_id, observation_id, recipient_user_id, title, target_id)
         VALUES ($1, $2, $3, 'Load imbalance', NULL) RETURNING id`,
        [workspaceId, obs.rows[0].id, recipientId]
      );

      const res = await request(app)
        .get('/api/fleetgraph/notifications')
        .set('Cookie', recipientAuth.cookie);

      const found = res.body.notifications.find((n: { id: string }) => n.id === notif.rows[0].id);
      expect(found).toBeDefined();
      expect(found.targetId).toBeNull();
      expect(found.requiresApproval).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // FG-139 · acknowledge
  // -------------------------------------------------------------------------

  describe('POST /notifications/:id/acknowledge (FG-139)', () => {
    it('marks the notification acknowledged and leaves the observation open', async () => {
      const { notificationId, observationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/notifications/${notificationId}/acknowledge`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: notificationId, state: 'acknowledged' });

      const notif = await pool.query(
        `SELECT state, acknowledged_at FROM fleetgraph_notifications WHERE id = $1`,
        [notificationId]
      );
      expect(notif.rows[0].state).toBe('acknowledged');
      expect(notif.rows[0].acknowledged_at).not.toBeNull();

      // Acknowledge is "seen", not "judged" — the finding stays open.
      const obs = await pool.query(`SELECT resolution FROM fleetgraph_observations WHERE id = $1`, [
        observationId,
      ]);
      expect(obs.rows[0].resolution).toBeNull();
    });

    // A double-click and a retried request must be indistinguishable from one
    // click, or the UI grows retry logic for an operation that cannot fail.
    it('is idempotent', async () => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });
      const call = () =>
        request(app)
          .post(`/api/fleetgraph/notifications/${notificationId}/acknowledge`)
          .set('Cookie', recipientAuth.cookie)
          .set('x-csrf-token', recipientAuth.csrf)
          .send({});

      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
    });

    // 404 rather than 403, deliberately: a 403 confirms the row exists, which
    // tells an unauthorised caller that a finding was raised about something
    // they cannot see. That is the FG-148 leak arriving through the back door.
    it("returns 404 for another user's notification, not 403", async () => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: otherUserId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/notifications/${notificationId}/acknowledge`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(404);
    });

    it('rejects a non-uuid id', async () => {
      const res = await request(app)
        .post('/api/fleetgraph/notifications/not-a-uuid/acknowledge')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // FG-140 · accept
  // -------------------------------------------------------------------------

  describe('POST /approvals/:id/accept (FG-140)', () => {
    it('persists the decision so the suspended run can pick it up', async () => {
      const { notificationId, observationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
        pendingThreadId: 'thread-accept',
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/accept`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.resolution).toBe('accepted');
      expect(res.body.observationId).toBe(observationId);
      expect(res.body.threadId).toBe('thread-accept');
      expect(res.body.snoozeUntil).toBeNull();
      // Honest, not optimistic: the graph has not run yet.
      expect(res.body.resumed).toBe(false);

      const obs = await pool.query(
        `SELECT resolution, resolved_at FROM fleetgraph_observations WHERE id = $1`,
        [observationId]
      );
      expect(obs.rows[0].resolution).toBe('accepted');
      expect(obs.rows[0].resolved_at).not.toBeNull();

      // Same transaction: an accepted observation with a still-pending
      // notification would re-present a finding the human already answered.
      const notif = await pool.query(`SELECT state FROM fleetgraph_notifications WHERE id = $1`, [
        notificationId,
      ]);
      expect(notif.rows[0].state).toBe('acknowledged');
      // 30s, not the 5s default. This test does a seed, an authenticated round
      // trip and two follow-up queries, and on a loaded CI runner that lands
      // just past the line: it timed out at 5042 ms in job 69056 and 5015 ms in
      // job 69115, then passed on retry with nothing changed. Forty milliseconds
      // either side of a deadline is not a signal about the code.
      //
      // The number is deliberately far from the observed cost rather than a
      // little above it -- a limit set at 6s would buy one more bad afternoon.
      // Nothing here waits on a timer, so a longer ceiling cannot hide a hang;
      // it only stops the suite failing on scheduler noise.
    }, 30_000);

    it("returns 404 for another user's finding", async () => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: otherUserId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/accept`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // FG-141 · dismiss — the one that must never come back
  // -------------------------------------------------------------------------

  describe('POST /approvals/:id/dismiss (FG-141)', () => {
    it('resolves the observation as dismissed', async () => {
      const { notificationId, observationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/dismiss`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.resolution).toBe('dismissed');

      const obs = await pool.query(
        `SELECT resolution, resolved_at, snooze_until FROM fleetgraph_observations WHERE id = $1`,
        [observationId]
      );
      expect(obs.rows[0].resolution).toBe('dismissed');
      expect(obs.rows[0].resolved_at).not.toBeNull();
      expect(obs.rows[0].snooze_until).toBeNull();
    });

    // THE regression test for PRESEARCH.md Q23 + Q32, and the reason this file
    // exists. `loadSuppressionSet` keeps dismissed rows FOREVER — unlike snoozed
    // rows, which fall out at their horizon. This asserts the row a dismiss
    // writes still satisfies that query with the clock pushed a year forward. If
    // it ever stops, one dismissed finding becomes 480 model calls a day and the
    // only symptom is a cost graph.
    it('stays suppressed forever — the same fingerprint never fires again', async () => {
      const { notificationId, fingerprint } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/dismiss`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      // The WHERE clause from agent/src/data/boundary.ts#loadSuppressionSet,
      // with NOW() pushed past any plausible snooze horizon.
      const suppressed = await pool.query(
        `SELECT o.fingerprint
           FROM fleetgraph_observations o
          WHERE o.workspace_id = $1
            AND (
              o.resolution IS NULL
              OR o.resolution = 'dismissed'
              OR (o.resolution = 'snoozed' AND o.snooze_until > NOW() + interval '1 year')
            )`,
        [workspaceId]
      );

      expect(suppressed.rows.map((r) => r.fingerprint)).toContain(fingerprint);
    });

    // The counterpart, and the reason the test above is not vacuous: a SNOOZED
    // finding does fall out of the suppression set once its horizon passes.
    it('unlike a snooze, which stops suppressing once its horizon passes', async () => {
      const { notificationId, fingerprint } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/snooze`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ days: 5 });

      const suppressed = await pool.query(
        `SELECT o.fingerprint
           FROM fleetgraph_observations o
          WHERE o.workspace_id = $1
            AND (
              o.resolution IS NULL
              OR o.resolution = 'dismissed'
              OR (o.resolution = 'snoozed' AND o.snooze_until > NOW() + interval '1 year')
            )`,
        [workspaceId]
      );

      expect(suppressed.rows.map((r) => r.fingerprint)).not.toContain(fingerprint);
    });
  });

  // -------------------------------------------------------------------------
  // FG-142 · snooze, in business days
  // -------------------------------------------------------------------------

  describe('POST /approvals/:id/snooze (FG-142)', () => {
    it('defaults to 3 business days when the body is empty', async () => {
      const { notificationId, observationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/snooze`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.resolution).toBe('snoozed');
      expect(res.body.snoozeUntil).toBe(snoozeUntilDate(3).toISOString());

      const obs = await pool.query(
        `SELECT resolution, resolved_at, snooze_until FROM fleetgraph_observations WHERE id = $1`,
        [observationId]
      );
      expect(obs.rows[0].resolution).toBe('snoozed');
      // A snooze is deferred, not resolved. boundary.ts encodes the same rule.
      expect(obs.rows[0].resolved_at).toBeNull();
      expect(obs.rows[0].snooze_until).not.toBeNull();
    });

    it.each([1, 3, 5])('accepts the %i business-day horizon', async (days) => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/snooze`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ days });

      expect(res.status).toBe(200);
      expect(res.body.snoozeUntil).toBe(snoozeUntilDate(days).toISOString());
    });

    // Q23 offers three fixed horizons, in business days. An arbitrary or
    // hours-scale snooze would wake before the underlying state could plausibly
    // change and re-present a byte-identical finding.
    it.each([0, 2, 7, -1])('rejects a %i-day horizon', async (days) => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/snooze`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ days });

      expect(res.status).toBe(400);
    });

    it('rejects an hours-based snooze rather than silently ignoring it', async () => {
      const { notificationId } = await seedFinding({
        targetId: publicDocId,
        recipient: recipientId,
      });

      const res = await request(app)
        .post(`/api/fleetgraph/approvals/${notificationId}/snooze`)
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ hours: 4 });

      expect(res.status).toBe(400);
    });

    // The whole point of business days: a Friday snooze must not wake on a
    // Saturday. Asserted on the computed date rather than through HTTP so it does
    // not depend on which day the suite happens to run.
    it('never wakes on a weekend', () => {
      const friday = new Date('2026-08-07T15:00:00.000Z');
      for (const days of [1, 3, 5]) {
        const wake = snoozeUntilDate(days, friday);
        expect(wake.getUTCDay()).not.toBe(0);
        expect(wake.getUTCDay()).not.toBe(6);
        expect(wake.getTime()).toBeGreaterThan(friday.getTime());
      }
      // One business day from Friday is Monday, not Saturday.
      expect(snoozeUntilDate(1, friday).toISOString().slice(0, 10)).toBe('2026-08-10');
    });
  });

  // -------------------------------------------------------------------------
  // FG-143/144 · chat
  // -------------------------------------------------------------------------

  describe('POST /chat (FG-143)', () => {
    it('surfaces an unreachable graph as ai_unavailable rather than a 500', async () => {
      // This used to assert `reason: 'agent_not_wired'` — the stub. The graph
      // is wired now (FG-279), so the only way this path degrades is the model
      // being unreachable, which is `agent_unreachable`.
      //
      // What must NOT change is the shape: a degraded agent is a 503 the UI
      // renders as a quiet unavailable state, never a 500 and never a 200 with
      // an empty answer that reads like a reply.
      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_id: publicDocId, document_type: 'issue', tab: 'plan' });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe('ai_unavailable');
      expect(res.body.reason).toBe('agent_unreachable');
    });

    it('passes route params to the agent and returns its answer', async () => {
      chatImpl = async () => ({ answer: 'Three issues are stalled.', threadId: 'thread-xyz' });

      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({
          document_id: publicDocId,
          document_type: 'issue',
          tab: 'plan',
          message: 'What is blocked?',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        answer: 'Three issues are stalled.',
        threadId: 'thread-xyz',
        documentId: publicDocId,
      });

      expect(invokeAgentChat).toHaveBeenCalledWith({
        documentId: publicDocId,
        documentType: 'issue',
        tab: 'plan',
        userId: recipientId,
        workspaceId,
        message: 'What is blocked?',
      });

      // Q7 is a privacy boundary, so assert the negative too: nothing resembling
      // rendered content reaches the agent.
      const sent: Readonly<Record<string, unknown>> = { ...firstAgentCall() };
      for (const forbidden of ['content', 'html', 'text', 'selection', 'dom']) {
        expect(sent).not.toHaveProperty(forbidden);
      }
    });

    it('omits message when the user asked nothing, rather than inventing one', async () => {
      chatImpl = async () => ({ answer: 'ok', threadId: null });

      await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_id: publicDocId, document_type: 'issue' });

      expect(firstAgentCall().message).toBeUndefined();
      expect(firstAgentCall().tab).toBeNull();
    });

    // A document can be converted (`converted_to_id` exists because types
    // change), which leaves stale types in bookmarked URLs. The graph must pick
    // its context node from what the document actually is.
    it("uses the document's stored type, not the client's claim", async () => {
      chatImpl = async () => ({ answer: 'ok', threadId: null });

      await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_id: publicDocId, document_type: 'project' });

      expect(firstAgentCall().documentType).toBe('issue');
    });

    // FG-144. The boundary is enforced by a 400, not by a comment: a client that
    // starts sending editor content is told so immediately, instead of having it
    // silently dropped today and quietly forwarded to Bedrock tomorrow.
    it.each(['content', 'html', 'text', 'selection', 'rendered'])(
      'rejects a body carrying rendered %s (FG-144, Q7)',
      async (field) => {
        const res = await request(app)
          .post('/api/fleetgraph/chat')
          .set('Cookie', recipientAuth.cookie)
          .set('x-csrf-token', recipientAuth.csrf)
          .send({
            document_id: publicDocId,
            document_type: 'issue',
            [field]: '<p>secret contents of the document</p>',
          });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(invokeAgentChat).not.toHaveBeenCalled();
      }
    );

    it('rejects a missing document_id', async () => {
      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_type: 'issue' });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown document_type', async () => {
      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_id: publicDocId, document_type: 'spreadsheet' });

      expect(res.status).toBe(400);
    });

    // FG-148 on the chat path. Without this, chat is a read primitive for private
    // documents: name an id you cannot open and let the agent read it for you.
    it('refuses to reason about a document the caller cannot read', async () => {
      chatImpl = async () => ({ answer: 'should never be reached', threadId: null });

      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_id: privateDocId, document_type: 'issue' });

      expect(res.status).toBe(404);
      expect(invokeAgentChat).not.toHaveBeenCalled();
    });

    it('lets an admin ask about the same private document', async () => {
      chatImpl = async () => ({ answer: 'ok', threadId: null });

      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', adminAuth.cookie)
        .set('x-csrf-token', adminAuth.csrf)
        .send({ document_id: privateDocId, document_type: 'issue' });

      expect(res.status).toBe(200);
      expect(invokeAgentChat).toHaveBeenCalled();
    });

    it('returns 404 for a document id that does not exist', async () => {
      const res = await request(app)
        .post('/api/fleetgraph/chat')
        .set('Cookie', recipientAuth.cookie)
        .set('x-csrf-token', recipientAuth.csrf)
        .send({ document_id: crypto.randomUUID(), document_type: 'issue' });

      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // FG-149 · rate limit
  // -------------------------------------------------------------------------

  describe('chat rate limit (FG-149, Q32)', () => {
    // On-demand cost scales with engagement rather than with drift, so nothing in
    // the architecture bounds it. This drives the REAL limiter from
    // ai-analysis.ts rather than a mock — the bug worth catching is the route
    // forgetting to call it, and a mock cannot see that.
    //
    // Its own user, because the limiter is keyed by user id and shared with
    // /api/ai/analyze-*; spending the main test user's budget here would make
    // unrelated tests in this file fail depending on order.
    it('returns 429 once the hourly budget is spent', async () => {
      const user = await pool.query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, 'test-hash', 'FG ratelimit') RETURNING id`,
        [`fg-ratelimit-${runId}@ship.local`]
      );
      const uid = user.rows[0].id;
      extraUserIds.push(uid);
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
        [workspaceId, uid]
      );
      const auth = await makeAuth(uid, workspaceId);

      chatImpl = async () => ({ answer: 'ok', threadId: null });

      const call = () =>
        request(app)
          .post('/api/fleetgraph/chat')
          .set('Cookie', auth.cookie)
          .set('x-csrf-token', auth.csrf)
          .send({ document_id: publicDocId, document_type: 'issue' });

      // RATE_LIMIT is 120/hour/user in ai-analysis.ts.
      const statuses: number[] = [];
      for (let i = 0; i < 121; i++) {
        statuses.push((await call()).status);
      }

      expect(statuses.slice(0, 120)).toEqual(Array(120).fill(200));
      expect(statuses[120]).toBe(429);

      const last = await call();
      expect(last.status).toBe(429);
      expect(last.body.code).toBe('RATE_LIMITED');
    }, 120_000);
  });
});
