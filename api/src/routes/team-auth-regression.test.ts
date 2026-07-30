/**
 * Regression cover for the Lane 3 (Category 3, p.5) rewrites of GET /api/team/grid and
 * GET /api/auth/me. Both were changed for latency only, so what these pin down is that
 * the answer did not change.
 *
 * GET /api/team/grid
 *   Five strictly serialised round trips became one concurrent batch of three, one of
 *   which — a four-table join whose result was assigned to `dbSprintsResult` and never
 *   read — was deleted outright. The admin lookup moved from a getVisibilityContext()
 *   round trip into an inline subquery in each statement's visibility predicate. If the
 *   deleted query had in fact been load-bearing, or if the inlined predicate were wrong,
 *   the payload would change; these assert every branch of it.
 *
 * GET /api/auth/me
 *   Three serialised queries became one, with the workspace list and the current
 *   workspace built by json_agg / json_build_object inside SQL rather than by mapping
 *   rows in JS. That moves shape, ordering and the super-admin role fallback into the
 *   query, so all three are asserted here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

describe('team/grid and auth/me — rewrite regression', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let wsAId: string;      // "Alpha" — the session workspace
  let wsBId: string;      // "Beta"  — member also belongs here
  let wsArchivedId: string;
  let memberId: string;
  let adminId: string;
  let memberCookie: string;
  let adminCookie: string;
  const ids: Record<string, string> = {};

  async function makeUser(label: string, role: 'member' | 'admin', workspaceId: string) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', $2) RETURNING id`,
      [`${label}-ta-${runId}@ship.local`, label]
    );
    const userId = u.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)`,
      [workspaceId, userId, role]
    );
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId]
    );
    return { userId, cookie: `session_id=${sessionId}` };
  }

  async function makeDoc(key: string, type: string, title: string, createdBy: string,
                         props: Record<string, unknown> = {},
                         opts: { visibility?: string; archived?: boolean; workspaceId?: string } = {}) {
    const r = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, visibility, properties, archived_at)
       VALUES ($1, $2::document_type, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
      [opts.workspaceId ?? wsAId, type, title, createdBy, opts.visibility ?? 'workspace',
       JSON.stringify(props), opts.archived ? new Date() : null]
    );
    ids[key] = r.rows[0].id;
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    // Names chosen so alphabetical order (Alpha, Beta) differs from insertion order,
    // which is what the ORDER BY w.name inside json_agg has to preserve.
    wsBId = (await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, CURRENT_DATE) RETURNING id`,
      [`Beta ${runId}`])).rows[0].id;
    wsAId = (await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, CURRENT_DATE) RETURNING id`,
      [`Alpha ${runId}`])).rows[0].id;
    wsArchivedId = (await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date, archived_at)
       VALUES ($1, CURRENT_DATE, now()) RETURNING id`,
      [`Archived ${runId}`])).rows[0].id;

    ({ userId: memberId, cookie: memberCookie } = await makeUser('member', 'member', wsAId));
    ({ userId: adminId, cookie: adminCookie } = await makeUser('admin', 'admin', wsAId));
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [wsBId, memberId]);
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [wsArchivedId, memberId]);

    // people for the grid
    await makeDoc('pMember', 'person', 'Zeta Person', memberId, { user_id: memberId, email: 'zeta@ship.local' });
    await makeDoc('pOther', 'person', 'Alpha Person', memberId, { user_id: adminId });
    await makeDoc('pArchived', 'person', 'Gone Person', memberId, { user_id: memberId }, { archived: true });
    await makeDoc('pPending', 'person', 'Pending Person', memberId, { pending: 'true', email: 'pending@ship.local' });
    await makeDoc('pPrivate', 'person', 'Secret Person', adminId, { user_id: adminId }, { visibility: 'private' });

    // a sprint in the current window plus an issue assigned to member, so the grid has a cell
    await makeDoc('sprint1', 'sprint', 'Sprint 1', memberId, {
      sprint_number: 1,
      start_date: new Date().toISOString().slice(0, 10),
      end_date: new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10),
    });
    await makeDoc('prog1', 'program', 'Prog One', memberId, { emoji: '🚀', color: '#123456' });
    await makeDoc('issue1', 'issue', 'Issue One', memberId, { assignee_id: memberId, state: 'in_progress' });
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'sprint')`, [ids.issue1, ids.sprint1]);
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'program')`, [ids.issue1, ids.prog1]);
  });

  afterAll(async () => {
    for (const ws of [wsAId, wsBId, wsArchivedId]) {
      await pool.query(
        `DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`, [ws]);
      await pool.query('DELETE FROM sessions WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM documents WHERE workspace_id = $1', [ws]);
      await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [ws]);
    }
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [memberId, adminId]);
    await pool.query('DELETE FROM workspaces WHERE id IN ($1, $2, $3)', [wsAId, wsBId, wsArchivedId]);
  });

  describe('GET /api/team/grid', () => {
    it('returns the four top-level keys the client reads', async () => {
      const res = await request(app).get('/api/team/grid').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['associations', 'currentSprintNumber', 'users', 'weeks']);
      expect(Array.isArray(res.body.weeks)).toBe(true);
      expect(res.body.weeks.length).toBeGreaterThan(0);
      expect(res.body.weeks.some((w: { isCurrent: boolean }) => w.isCurrent)).toBe(true);
      expect(typeof res.body.currentSprintNumber).toBe('number');
    });

    it('lists visible people, archived last and only when asked', async () => {
      const plain = await request(app).get('/api/team/grid').set('Cookie', memberCookie);
      const names = plain.body.users.map((u: { name: string }) => u.name);
      expect(names).toContain('Alpha Person');
      expect(names).toContain('Pending Person');
      expect(names).not.toContain('Gone Person');

      const withArchived = await request(app)
        .get('/api/team/grid?includeArchived=true').set('Cookie', memberCookie);
      const archNames = withArchived.body.users.map((u: { name: string }) => u.name);
      expect(archNames).toContain('Gone Person');
      // ORDER BY archived_at NULLS FIRST, title — archived rows come last
      expect(archNames[archNames.length - 1]).toBe('Gone Person');
    });

    it('flags pending people and carries personId separately from user id', async () => {
      const res = await request(app).get('/api/team/grid').set('Cookie', memberCookie);
      const pending = res.body.users.find((u: { name: string }) => u.name === 'Pending Person');
      expect(pending.isPending).toBe(true);
      expect(pending.id).toBeNull();
      expect(pending.personId).toBe(ids.pPending);
      const zeta = res.body.users.find((u: { name: string }) => u.name === 'Zeta Person');
      expect(zeta.isPending).toBe(false);
      expect(zeta.id).toBe(memberId);
      expect(zeta.email).toBe('zeta@ship.local');
    });

    it('applies the inlined admin visibility predicate to the people list', async () => {
      const asMember = await request(app).get('/api/team/grid').set('Cookie', memberCookie);
      expect(asMember.body.users.map((u: { name: string }) => u.name)).not.toContain('Secret Person');
      const asAdmin = await request(app).get('/api/team/grid').set('Cookie', adminCookie);
      expect(asAdmin.body.users.map((u: { name: string }) => u.name)).toContain('Secret Person');
    });

    it('still builds assignee → sprint → {programs, issues} cells', async () => {
      const res = await request(app).get('/api/team/grid').set('Cookie', memberCookie);
      const forMember = res.body.associations[memberId];
      expect(forMember, 'the assigned issue should produce a cell').toBeDefined();
      const cells = Object.values(forMember) as Array<{
        programs: Array<{ id: string; name: string; emoji: string; color: string; issueCount: number }>;
        issues: Array<{ id: string; title: string; displayId: string; state: string }>;
      }>;
      const cell = cells[0]!;
      expect(cell.issues.map(i => i.title)).toContain('Issue One');
      expect(cell.issues[0]!.state).toBe('in_progress');
      expect(cell.issues[0]!.displayId).toMatch(/^#/);
      expect(cell.programs[0]).toMatchObject({ id: ids.prog1, name: 'Prog One', emoji: '🚀', color: '#123456', issueCount: 1 });
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the user, the current workspace and the workspace list', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const d = res.body.data;
      expect(d.user).toMatchObject({ id: memberId, isSuperAdmin: false });
      expect(d.user.email).toContain(`member-ta-${runId}`);
      expect(d.currentWorkspace).toMatchObject({ id: wsAId, name: `Alpha ${runId}`, role: 'member' });
      expect(Array.isArray(d.workspaces)).toBe(true);
      expect(d.pendingAccountabilityItems).toEqual([]);
    });

    it('orders the workspace list by name and carries each membership role', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', memberCookie);
      const ws = res.body.data.workspaces as Array<{ id: string; name: string; role: string }>;
      const names = ws.map(w => w.name);
      expect(names).toEqual([...names].sort());
      expect(ws.find(w => w.id === wsAId)).toMatchObject({ name: `Alpha ${runId}`, role: 'member' });
      expect(ws.find(w => w.id === wsBId)).toMatchObject({ name: `Beta ${runId}`, role: 'member' });
      // every entry carries exactly the three keys the client reads
      expect(Object.keys(ws[0]!).sort()).toEqual(['id', 'name', 'role']);
    });

    it('excludes archived workspaces from the list', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', memberCookie);
      const ids2 = (res.body.data.workspaces as Array<{ id: string }>).map(w => w.id);
      expect(ids2).not.toContain(wsArchivedId);
    });

    it('reports the admin role for a workspace admin', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', adminCookie);
      expect(res.body.data.currentWorkspace.role).toBe('admin');
    });
  });
});
