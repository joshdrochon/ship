/**
 * PF-260 / PF-261 — a token sees exactly one workspace, and exactly what its
 * user can see.
 *
 * PRD p.18's 3.4 asks how a grader gets a pre-registered app *"without exposing
 * your tenant's data"*. This file is that answer, asserted rather than assumed.
 *
 * The two questions are separate and both have to hold:
 *
 *   PF-260  TENANCY. The workspace comes from the token's `PlatformAuthContext`
 *           and from nowhere else. No body, query parameter or header can name
 *           one, and a cursor minted under another tenant cannot import rows.
 *   PF-261  VISIBILITY. A token acts FOR A USER, so it sees what that user
 *           sees — never the app's own view. A private document belonging to
 *           someone else is absent and 404s, and the page walk stays gapless
 *           with private rows interleaved, which is the case a
 *           LIMIT-then-filter implementation gets wrong.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountDocuments } from './routes.js';

describe('/api/v1/documents — tenancy and visibility', () => {
  let appA: BearerTestApp;
  let appB: BearerTestApp;
  let appOtherUser: BearerTestApp;

  let wsA: string;
  let wsB: string;
  let userA: string;
  let userB: string;

  let publicInA: string;
  let privateOfA: string;
  let inWorkspaceB: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const a = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 tenancy A ${runId}`,
    ]);
    wsA = a.rows[0].id;
    const b = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 tenancy B ${runId}`,
    ]);
    wsB = b.rows[0].id;

    const ua = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'User A') RETURNING id`,
      [`l09-tenancy-a-${runId}@ship.local`],
    );
    userA = ua.rows[0].id;
    const ub = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'User B') RETURNING id`,
      [`l09-tenancy-b-${runId}@ship.local`],
    );
    userB = ub.rows[0].id;

    // Both users are MEMBERS of workspace A. Members, not admins: the admin
    // branch of the visibility predicate would make user B able to see A's
    // private document legitimately, and then this file would prove nothing.
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [wsA, userA, userB],
    );

    // 30 rows in A, every third one PRIVATE to user A. Interleaved on purpose:
    // a handler that fetches `limit` rows and THEN filters by visibility returns
    // short pages and loses rows at every boundary, and that failure only shows
    // up when the private rows are spread through the ordering rather than
    // clustered at one end.
    const seeded = await pool.query<{ id: string; visibility: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, created_at)
       SELECT $1, 'wiki', 'A doc ' || g, $2,
              CASE WHEN g % 3 = 0 THEN 'private' ELSE 'workspace' END,
              now() - (g || ' seconds')::interval
       FROM generate_series(1, 30) g
       RETURNING id, visibility`,
      [wsA, userA],
    );
    publicInA = seeded.rows.find((r) => r.visibility === 'workspace')!.id;
    privateOfA = seeded.rows.find((r) => r.visibility === 'private')!.id;

    const inB = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title)
       VALUES ($1, 'wiki', 'Belongs to tenant B') RETURNING id`,
      [wsB],
    );
    inWorkspaceB = inB.rows[0].id;

    const mount = (router: Parameters<typeof mountDocuments>[0]) =>
      mountDocuments(router, { db: pool, service: createDocumentService() });

    appA = await createBearerTestApp({ workspaceId: wsA, userId: userA, mountResources: mount });
    appB = await createBearerTestApp({ workspaceId: wsB, userId: userB, mountResources: mount });
    appOtherUser = await createBearerTestApp({
      workspaceId: wsA,
      userId: userB,
      mountResources: mount,
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = ANY($1::uuid[])`, [[wsA, wsB]]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = ANY($1::uuid[])`, [
      [wsA, wsB],
    ]);
    await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [[wsA, wsB]]);
  });

  async function token(harness: BearerTestApp) {
    return `Bearer ${(await harness.mint(['documents:read', 'documents:write'])).access_token}`;
  }

  // ── PF-260 · tenancy ──────────────────────────────────────────────────────

  describe('PF-260 · one token, one workspace', () => {
    it("a token for A gets 404 — not 403 — on a document in B", async () => {
      const res = await request(appA.app)
        .get(`/api/v1/documents/${inWorkspaceB}`)
        .set('Authorization', await token(appA));

      expect(res.status).toBe(404);
      // 403 would confirm the id exists in some workspace, which is a
      // cross-tenant existence oracle (PF-255).
      expect(res.status).not.toBe(403);
    });

    it("a token for B sees none of A's 30 rows, even at ?limit=100", async () => {
      const res = await request(appB.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', await token(appB));

      expect(res.status).toBe(200);
      const ids: string[] = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(inWorkspaceB);
      expect(ids).toHaveLength(1);
    });

    it('a cursor minted under B imports nothing into a listing under A', async () => {
      // The cursor is opaque but it is not a capability. Its payload is
      // `{id, timestamp, resource}` — it says WHERE to resume, never WHOSE rows
      // to return. If the workspace filter came from anywhere the caller could
      // influence, this is where it would show.
      const first = await request(appB.app)
        .get('/api/v1/documents?limit=1')
        .set('Authorization', await token(appB));
      expect(first.status).toBe(200);

      // B has one row, so its cursor is null. Mint one from A's own listing and
      // replay it under B instead — same question, and a cursor actually exists.
      const fromA = await request(appA.app)
        .get('/api/v1/documents?limit=1')
        .set('Authorization', await token(appA));
      const cursorFromA: string = fromA.body.next_cursor;
      expect(cursorFromA).toBeTruthy();

      const replayed = await request(appB.app)
        .get(`/api/v1/documents?limit=100&cursor=${encodeURIComponent(cursorFromA)}`)
        .set('Authorization', await token(appB));

      expect(replayed.status).toBe(200);
      const ids: string[] = replayed.body.data.map((d: { id: string }) => d.id);
      expect(
        ids.filter((id) => id !== inWorkspaceB),
        "a cursor minted in workspace A returned workspace A's rows under a token for B",
      ).toEqual([]);
    });

    it('POST cannot name a workspace — the body is rejected, not honoured', async () => {
      const before = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1`, [
        wsB,
      ]);

      const res = await request(appA.app)
        .post('/api/v1/documents')
        .set('Authorization', await token(appA))
        .send({ title: 'Cross-tenant write', workspace_id: wsB });

      expect(res.status).toBe(422);

      const after = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1`, [
        wsB,
      ]);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('a created document lands in the TOKEN’s workspace', async () => {
      const res = await request(appA.app)
        .post('/api/v1/documents')
        .set('Authorization', await token(appA))
        .send({ title: 'Lands in A' });

      expect(res.status).toBe(201);
      const row = await pool.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM documents WHERE id = $1`,
        [res.body.id],
      );
      expect(row.rows[0]!.workspace_id).toBe(wsA);
    });
  });

  // ── PF-261 · visibility ───────────────────────────────────────────────────

  describe('PF-261 · a token sees what its user sees', () => {
    it("user A's own private document is visible to user A's token", async () => {
      // The positive control. Without it, a handler that hid every private row
      // from everyone would pass every test below.
      const res = await request(appA.app)
        .get(`/api/v1/documents/${privateOfA}`)
        .set('Authorization', await token(appA));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(privateOfA);
    });

    it("user A's private document 404s for a token acting as user B", async () => {
      // Same workspace, same app, same scopes — different consenting user. A
      // token acts for a user, never with the app's own view.
      const res = await request(appOtherUser.app)
        .get(`/api/v1/documents/${privateOfA}`)
        .set('Authorization', await token(appOtherUser));

      expect(res.status).toBe(404);
    });

    it("a workspace-visible document IS reachable by user B's token", async () => {
      const res = await request(appOtherUser.app)
        .get(`/api/v1/documents/${publicInA}`)
        .set('Authorization', await token(appOtherUser));

      expect(res.status).toBe(200);
    });

    it("user A's private rows are absent from user B's list", async () => {
      const res = await request(appOtherUser.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', await token(appOtherUser));

      const ids: string[] = res.body.data.map((d: { id: string }) => d.id);
      const privateIds = await pool.query<{ id: string }>(
        `SELECT id FROM documents WHERE workspace_id = $1 AND visibility = 'private'`,
        [wsA],
      );
      for (const row of privateIds.rows) {
        expect(ids, 'a private document leaked into another user’s list').not.toContain(row.id);
      }
    });

    it('the page walk stays gapless with private rows interleaved', async () => {
      // The case a LIMIT-then-filter implementation gets wrong. Filtering after
      // the limit yields short pages and drops rows at every boundary; the
      // predicate has to be IN the query, which is why it lives in the service
      // beside the keyset predicate rather than in the handler.
      const auth = await token(appOtherUser);
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < 40; page++) {
        const url: string = cursor
          ? `/api/v1/documents?limit=4&cursor=${encodeURIComponent(cursor)}`
          : '/api/v1/documents?limit=4';
        const res = await request(appOtherUser.app).get(url).set('Authorization', auth);
        expect(res.status).toBe(200);
        seen.push(...res.body.data.map((d: { id: string }) => d.id));
        cursor = res.body.next_cursor;
        if (cursor === null) break;
      }

      const expected = await pool.query<{ id: string }>(
        `SELECT id FROM documents
          WHERE workspace_id = $1 AND deleted_at IS NULL AND archived_at IS NULL
            AND visibility = 'workspace'
            AND document_type = 'wiki'`,
        [wsA],
      );

      expect(new Set(seen).size, 'a duplicate appeared in the walk').toBe(seen.length);
      expect([...seen].sort()).toEqual(expected.rows.map((r) => r.id).sort());
    });
  });
});
