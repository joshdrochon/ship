/**
 * PF-260 / PF-261 / PF-283 — an issues token sees exactly one workspace, exactly
 * what its user can see, and exactly one `document_type`.
 *
 * ## Why this file exists rather than trusting L09's
 *
 * L09 wrote the equivalent for `documents` AFTER a real cross-tenant defect was
 * found in a different lane (F43: `issueTokenPair` stamped the token with the
 * app's workspace, so a user in workspace A consenting to an app registered in B
 * minted a B-scoped token on an A session). The lesson recorded there is that
 * tenancy does not carry for free between resources — it is a property of each
 * query, and the issues queries are new code with their own predicates.
 *
 * The third axis is new here and exists only because of the unified document
 * model: `documents`, `issues` and `sprints` are three scoped resources over ONE
 * table. Cross-TYPE isolation is the only thing keeping three scope pairs from
 * collapsing into one, and it is invisible to every other test in the suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createIssueService } from '../../../../services/issues.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountIssues } from './routes.js';
import { mountDocuments } from '../documents/routes.js';

describe('/api/v1/issues — tenancy, visibility and cross-type isolation', () => {
  let appA: BearerTestApp;
  let appB: BearerTestApp;
  let appOtherUser: BearerTestApp;

  let wsA: string;
  let wsB: string;
  let userA: string;
  let userB: string;

  let issueInA: string;
  let privateIssueOfA: string;
  let issueInB: string;
  let wikiInA: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const a = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L10 tenancy A ${runId}`,
    ]);
    wsA = a.rows[0].id;
    const b = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L10 tenancy B ${runId}`,
    ]);
    wsB = b.rows[0].id;

    const ua = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'User A') RETURNING id`,
      [`l10-tenancy-a-${runId}@ship.local`],
    );
    userA = ua.rows[0].id;
    const ub = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'User B') RETURNING id`,
      [`l10-tenancy-b-${runId}@ship.local`],
    );
    userB = ub.rows[0].id;

    // Both users are MEMBERS of workspace A. Members and not admins: the admin
    // branch of the visibility predicate would let user B see A's private issue
    // legitimately, and then this file would prove nothing.
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [wsA, userA, userB],
    );
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [wsB, userA],
    );

    const rows = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility,
                              ticket_number, properties)
       VALUES
         ($1, 'issue', 'Workspace-visible issue in A', $2, 'workspace', 1,
          '{"state":"todo","priority":"medium"}'),
         ($1, 'issue', 'PRIVATE issue of A',           $2, 'private',   2,
          '{"state":"todo","priority":"medium"}'),
         ($3, 'issue', 'Issue in B',                   $2, 'workspace', 1,
          '{"state":"todo","priority":"medium"}'),
         ($1, 'wiki',  'Wiki in A',                    $2, 'workspace', NULL, '{}')
       RETURNING id`,
      [wsA, userA, wsB],
    );
    issueInA = rows.rows[0]!.id;
    privateIssueOfA = rows.rows[1]!.id;
    issueInB = rows.rows[2]!.id;
    wikiInA = rows.rows[3]!.id;

    const mount = (router: Parameters<typeof mountIssues>[0]) => {
      mountIssues(router, { db: pool, service: createIssueService() });
      mountDocuments(router, { db: pool, service: createDocumentService() });
    };

    appA = await createBearerTestApp({ workspaceId: wsA, userId: userA, mountResources: mount });
    appB = await createBearerTestApp({ workspaceId: wsB, userId: userA, mountResources: mount });
    appOtherUser = await createBearerTestApp({
      workspaceId: wsA,
      userId: userB,
      mountResources: mount,
    });
  });

  afterAll(async () => {
    for (const ws of [wsA, wsB]) {
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [ws]);
      await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [ws]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
    }
  });

  const read = async (h: BearerTestApp) =>
    `Bearer ${(await h.mint(['issues:read'])).access_token}`;
  const write = async (h: BearerTestApp) =>
    `Bearer ${(await h.mint(['issues:write'])).access_token}`;

  // ── PF-260 — tenancy ──────────────────────────────────────────────────────

  it('a workspace-A token lists only A’s issues', async () => {
    const res = await request(appA.app)
      .get('/api/v1/issues?limit=100')
      .set('Authorization', await read(appA));

    expect(res.status).toBe(200);
    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(issueInA);
    expect(ids, 'workspace B’s issue reached an A token').not.toContain(issueInB);
  });

  it('a workspace-A token fetching B’s issue by id gets 404, never 403', async () => {
    // A 403 would confirm the id EXISTS, which turns the endpoint into a
    // cross-tenant existence oracle: a caller iterating UUIDs learns which ones
    // are real in workspaces it cannot read.
    const res = await request(appA.app)
      .get(`/api/v1/issues/${issueInB}`)
      .set('Authorization', await read(appA));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('a workspace-A token cannot PATCH B’s issue', async () => {
    const res = await request(appA.app)
      .patch(`/api/v1/issues/${issueInB}`)
      .set('Authorization', await write(appA))
      .send({ state: 'done' });

    expect(res.status).toBe(404);

    // And the row really did not move — a 404 returned after a successful write
    // would be the worst possible outcome.
    const after = await pool.query<{ state: string }>(
      `SELECT properties->>'state' AS state FROM documents WHERE id = $1`,
      [issueInB],
    );
    expect(after.rows[0]!.state).toBe('todo');
  });

  it('the SAME user on a workspace-B token sees B and not A', async () => {
    // The token, not the user, decides the tenant. `userA` is a member of both
    // workspaces, so this is the case that distinguishes "scoped by token" from
    // "scoped by whoever is asking".
    const res = await request(appB.app)
      .get('/api/v1/issues?limit=100')
      .set('Authorization', await read(appB));

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(issueInB);
    expect(ids).not.toContain(issueInA);
    expect(ids).not.toContain(privateIssueOfA);
  });

  it('a cursor minted in workspace A imports nothing when replayed in B', async () => {
    const first = await request(appA.app)
      .get('/api/v1/issues?limit=1')
      .set('Authorization', await read(appA));
    expect(first.status).toBe(200);

    const cursor = first.body.next_cursor;
    if (cursor) {
      const replayed = await request(appB.app)
        .get(`/api/v1/issues?limit=100&cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', await read(appB));

      expect(replayed.status).toBe(200);
      const ids = replayed.body.data.map((d: { id: string }) => d.id);
      expect(ids, 'a cursor carried rows across a tenant boundary').not.toContain(issueInA);
      expect(ids).not.toContain(privateIssueOfA);
    }
  });

  // ── PF-261 — visibility ───────────────────────────────────────────────────

  it('user B, a member of A, does not see A’s PRIVATE issue', async () => {
    const listed = await request(appOtherUser.app)
      .get('/api/v1/issues?limit=100')
      .set('Authorization', await read(appOtherUser));

    const ids = listed.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(issueInA);
    expect(ids, 'a private issue leaked to another member').not.toContain(privateIssueOfA);

    const fetched = await request(appOtherUser.app)
      .get(`/api/v1/issues/${privateIssueOfA}`)
      .set('Authorization', await read(appOtherUser));
    expect(fetched.status).toBe(404);
  });

  it('user A does see their own private issue', async () => {
    // The complement, so the assertion above is proved to be about visibility
    // rather than about the row simply being unreachable.
    const res = await request(appA.app)
      .get(`/api/v1/issues/${privateIssueOfA}`)
      .set('Authorization', await read(appA));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(privateIssueOfA);
  });

  // ── PF-283 — cross-TYPE isolation, both directions ───────────────────────

  describe('PF-283 — three scopes over one table stay three scopes', () => {
    it('an issues:read token cannot reach /api/v1/documents', async () => {
      const res = await request(appA.app)
        .get('/api/v1/documents')
        .set('Authorization', await read(appA));

      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('documents:read');
    });

    it('a documents:read token cannot reach /api/v1/issues', async () => {
      // The converse of L09's PF-250. Together these two are what stop the two
      // scope pairs collapsing into one in a single-table model.
      const res = await request(appA.app)
        .get('/api/v1/issues')
        .set('Authorization', `Bearer ${(await appA.mint(['documents:read'])).access_token}`);

      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('issues:read');
    });

    it('/api/v1/documents serves no issues, and /api/v1/issues serves no wikis', async () => {
      const docs = await request(appA.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', `Bearer ${(await appA.mint(['documents:read'])).access_token}`);
      const docIds = docs.body.data.map((d: { id: string }) => d.id);
      expect(docIds, 'an issue reached the documents list').not.toContain(issueInA);
      expect(docIds).toContain(wikiInA);

      const issues = await request(appA.app)
        .get('/api/v1/issues?limit=100')
        .set('Authorization', await read(appA));
      const issueIds = issues.body.data.map((d: { id: string }) => d.id);
      expect(issueIds, 'a wiki reached the issues list').not.toContain(wikiInA);
      expect(issueIds).toContain(issueInA);
    });

    it('a documents:write token cannot mint an issue through /api/v1/issues', async () => {
      const res = await request(appA.app)
        .post('/api/v1/issues')
        .set('Authorization', `Bearer ${(await appA.mint(['documents:write'])).access_token}`)
        .send({ title: 'Minted with the wrong scope' });

      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('issues:write');
    });
  });
});
