/**
 * PF-260 / PF-261 / PF-283 — a sprints token sees one workspace, one user's
 * view, and one `document_type`.
 *
 * Mirrored from `issues.tenancy.test.ts` rather than assumed to carry: L09 wrote
 * the documents version AFTER a real cross-tenant defect was found elsewhere
 * (F43), and the lesson is that tenancy is a property of each QUERY, not of the
 * architecture. The sprints queries are new code with their own predicates —
 * and one of them, `create`, takes a `program_id` and an `owner_id` from the
 * request body, which are two more places a cross-tenant reference could enter.
 *
 * This file also completes PF-283's 3×3 claim: with `documents`, `issues` and
 * `sprints` all mounted, every off-diagonal pair is asserted to be a 403 naming
 * the scope the caller LACKS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createSprintService } from '../../../../services/sprints.js';
import { createIssueService } from '../../../../services/issues.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountSprints } from './routes.js';
import { mountIssues } from '../issues/routes.js';
import { mountDocuments } from '../documents/routes.js';

describe('/api/v1/sprints — tenancy, visibility and the 3×3 scope matrix', () => {
  let appA: BearerTestApp;
  let appB: BearerTestApp;
  let appOtherUser: BearerTestApp;

  let wsA: string;
  let wsB: string;
  let userA: string;
  let userB: string;

  let sprintInA: string;
  let privateSprintOfA: string;
  let sprintInB: string;
  let programInB: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const a = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, '2026-01-05') RETURNING id`,
      [`L10 sprint tenancy A ${runId}`],
    );
    wsA = a.rows[0].id;
    const b = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, '2026-01-05') RETURNING id`,
      [`L10 sprint tenancy B ${runId}`],
    );
    wsB = b.rows[0].id;

    const ua = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'User A') RETURNING id`,
      [`l10-sprint-a-${runId}@ship.local`],
    );
    userA = ua.rows[0].id;
    const ub = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'User B') RETURNING id`,
      [`l10-sprint-b-${runId}@ship.local`],
    );
    userB = ub.rows[0].id;

    // Members, not admins — the admin branch of the visibility predicate would
    // let user B see A's private sprint legitimately and this file would prove
    // nothing.
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
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties)
       VALUES
         ($1, 'sprint',  'Sprint in A',         $2, 'workspace', '{"sprint_number": 1}'),
         ($1, 'sprint',  'PRIVATE sprint of A', $2, 'private',   '{"sprint_number": 2}'),
         ($3, 'sprint',  'Sprint in B',         $2, 'workspace', '{"sprint_number": 1}'),
         ($3, 'program', 'Program in B',        $2, 'workspace', '{}')
       RETURNING id`,
      [wsA, userA, wsB],
    );
    sprintInA = rows.rows[0]!.id;
    privateSprintOfA = rows.rows[1]!.id;
    sprintInB = rows.rows[2]!.id;
    programInB = rows.rows[3]!.id;

    const mount = (router: Parameters<typeof mountSprints>[0]) => {
      mountSprints(router, { db: pool, service: createSprintService() });
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
      await pool.query(
        `DELETE FROM document_associations WHERE document_id IN
          (SELECT id FROM documents WHERE workspace_id = $1)`,
        [ws],
      );
      await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [ws]);
      await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [ws]);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [ws]);
    }
  });

  const read = async (h: BearerTestApp) =>
    `Bearer ${(await h.mint(['sprints:read'])).access_token}`;
  const write = async (h: BearerTestApp) =>
    `Bearer ${(await h.mint(['sprints:write'])).access_token}`;

  // ── PF-260 — tenancy ──────────────────────────────────────────────────────

  it('a workspace-A token lists only A’s sprints', async () => {
    const res = await request(appA.app)
      .get('/api/v1/sprints?limit=100')
      .set('Authorization', await read(appA));

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(sprintInA);
    expect(ids, 'workspace B’s sprint reached an A token').not.toContain(sprintInB);
  });

  it('fetching B’s sprint on an A token is 404, never 403', async () => {
    const res = await request(appA.app)
      .get(`/api/v1/sprints/${sprintInB}`)
      .set('Authorization', await read(appA));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('an A token cannot transition B’s sprint', async () => {
    const res = await request(appA.app)
      .patch(`/api/v1/sprints/${sprintInB}`)
      .set('Authorization', await write(appA))
      .send({ status: 'active' });

    expect(res.status).toBe(404);

    // And nothing moved. A 404 returned after a successful write is the worst
    // possible outcome here, because the event would already have fired.
    const after = await pool.query<{ status: string | null }>(
      `SELECT properties->>'status' AS status FROM documents WHERE id = $1`,
      [sprintInB],
    );
    expect(after.rows[0]!.status).toBeNull();
  });

  it('PF-286’s program_id cannot reference another workspace’s program', async () => {
    // The body field is the interesting attack surface on this resource: an
    // unchecked `program_id` would let a sprint in A be associated with a
    // program in B, which is a cross-tenant WRITE through a field nobody thinks
    // of as one.
    const res = await request(appA.app)
      .post('/api/v1/sprints')
      .set('Authorization', await write(appA))
      .send({ sprint_number: 900, program_id: programInB });

    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('program_id');

    const leaked = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM document_associations WHERE related_id = $1`,
      [programInB],
    );
    expect(leaked.rows[0]!.n, 'an association crossed a tenant boundary').toBe(0);
  });

  it('PF-286’s owner_id cannot reference a non-member', async () => {
    // `userB` is a member of A but NOT of B, so this is the same check from the
    // other side and it uses a real user rather than a random UUID.
    const res = await request(appB.app)
      .post('/api/v1/sprints')
      .set('Authorization', await write(appB))
      .send({ sprint_number: 901, owner_id: userB });

    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('owner_id');
  });

  it('the SAME user on a workspace-B token sees B and not A', async () => {
    const res = await request(appB.app)
      .get('/api/v1/sprints?limit=100')
      .set('Authorization', await read(appB));

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(sprintInB);
    expect(ids).not.toContain(sprintInA);
    expect(ids).not.toContain(privateSprintOfA);
  });

  // ── PF-261 — visibility ───────────────────────────────────────────────────

  it('user B, a member of A, does not see A’s PRIVATE sprint', async () => {
    const listed = await request(appOtherUser.app)
      .get('/api/v1/sprints?limit=100')
      .set('Authorization', await read(appOtherUser));

    const ids = listed.body.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(sprintInA);
    expect(ids, 'a private sprint leaked to another member').not.toContain(privateSprintOfA);

    const fetched = await request(appOtherUser.app)
      .get(`/api/v1/sprints/${privateSprintOfA}`)
      .set('Authorization', await read(appOtherUser));
    expect(fetched.status).toBe(404);
  });

  it('user A does see their own private sprint', async () => {
    const res = await request(appA.app)
      .get(`/api/v1/sprints/${privateSprintOfA}`)
      .set('Authorization', await read(appA));
    expect(res.status).toBe(200);
  });

  // ── PF-283 / PF-296(a) — the 3×3 scope matrix ────────────────────────────

  describe('PF-296(a) — three read scopes against three list routes', () => {
    const routes = [
      { path: '/api/v1/documents', scope: 'documents:read' },
      { path: '/api/v1/issues', scope: 'issues:read' },
      { path: '/api/v1/sprints', scope: 'sprints:read' },
    ] as const;

    for (const held of routes) {
      for (const target of routes) {
        const diagonal = held.scope === target.scope;
        it(`${held.scope} → ${target.path} is ${diagonal ? '200' : '403'}`, async () => {
          const res = await request(appA.app)
            .get(target.path)
            .set(
              'Authorization',
              `Bearer ${(await appA.mint([held.scope as never])).access_token}`,
            );

          if (diagonal) {
            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);
          } else {
            expect(res.status).toBe(403);
            // The 403 names the scope the caller LACKS, not the one it holds.
            // That is MVP gate item 6's actual requirement (p.2: "the missing
            // scope named explicitly in the error body") and the difference is
            // the whole value of the message.
            expect(res.body.details.missing_scope).toBe(target.scope);
          }
        });
      }
    }
  });

  it('each list serves ONLY its own document_type — three scopes over one table', async () => {
    const bearer = async (scope: string) =>
      `Bearer ${(await appA.mint([scope as never])).access_token}`;

    const sprints = await request(appA.app)
      .get('/api/v1/sprints?limit=100')
      .set('Authorization', await bearer('sprints:read'));
    for (const s of sprints.body.data) expect(s.document_type).toBe('sprint');

    const docs = await request(appA.app)
      .get('/api/v1/documents?limit=100')
      .set('Authorization', await bearer('documents:read'));
    const docIds = docs.body.data.map((d: { id: string }) => d.id);
    expect(docIds, 'a sprint reached the documents list').not.toContain(sprintInA);
    for (const d of docs.body.data) expect(d.document_type).not.toBe('sprint');
  });
});
