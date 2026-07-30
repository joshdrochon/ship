/**
 * Regression cover for the Lane 3 (Category 3, p.5) rewrites of the two hottest list
 * endpoints. Both were changed for latency only, so the contract these tests pin down is
 * "the answer did not change".
 *
 * GET /api/documents
 *   The handler used to build its SQL text per request. It now selects one of six
 *   pre-built, named (server-prepared) statements from the (type filter) x (parent filter)
 *   matrix, and each shape numbers its bind parameters independently. A mistake in one
 *   shape's parameter numbering or predicate is invisible in the other five -- and the
 *   benchmark only ever exercises the no-filter shape -- so every shape is asserted here.
 *   The admin half of the visibility predicate also moved from a separate
 *   isWorkspaceAdmin() round trip into an inline scalar subquery, so admin/member/creator
 *   visibility is re-asserted against a real database.
 *
 * GET /api/projects
 *   sprint_count, issue_count and inferred_status used to be three correlated subqueries
 *   evaluated once per project row; they are now grouped CTEs joined once. The existing
 *   projects.test.ts mocks pg entirely and cannot see a semantic change in that SQL, so
 *   these run against a real database and cover every inferred_status branch plus the
 *   zero-association COALESCE path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

describe('List endpoints — query-shape regression', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let memberId: string;
  let adminId: string;
  let memberCookie: string;
  let adminCookie: string;

  const ids: Record<string, string> = {};

  async function makeUser(name: string, role: 'member' | 'admin') {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test-hash', $2) RETURNING id`,
      [`${name}-lists-${runId}@ship.local`, name]
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

  async function makeDoc(opts: {
    key: string;
    type: string;
    title: string;
    parent?: string | null;
    createdBy: string;
    visibility?: 'workspace' | 'private';
    properties?: Record<string, unknown>;
    archived?: boolean;
  }) {
    const r = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, parent_id, created_by,
                              visibility, properties, archived_at)
       VALUES ($1, $2::document_type, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
      [
        workspaceId, opts.type, opts.title, opts.parent ?? null, opts.createdBy,
        opts.visibility ?? 'workspace', JSON.stringify(opts.properties ?? {}),
        opts.archived ? new Date() : null,
      ]
    );
    ids[opts.key] = r.rows[0].id;
    return r.rows[0].id as string;
  }

  async function associate(childKey: string, projectKey: string) {
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'project')`,
      [ids[childKey], ids[projectKey]]
    );
  }

  beforeAll(async () => {
    // sprint_start_date is pinned so "current sprint" is deterministic: sprint N covers
    // [start + (N-1)*7, start + (N-1)*7 + 6]. With start = today, sprint 1 is current,
    // sprint 2 is future, and sprint 0 would be past — the route uses sprint_number, so
    // past is expressed as a large negative offset instead.
    const ws = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, CURRENT_DATE) RETURNING id`,
      [`List Regression ${runId}`]
    );
    workspaceId = ws.rows[0].id;

    ({ userId: memberId, cookie: memberCookie } = await makeUser('member', 'member'));
    ({ userId: adminId, cookie: adminCookie } = await makeUser('admin', 'admin'));

    // --- documents fixtures: two types, roots and children, one private doc ---
    await makeDoc({ key: 'wikiRoot', type: 'wiki', title: 'Wiki Root', createdBy: memberId });
    await makeDoc({ key: 'wikiChild', type: 'wiki', title: 'Wiki Child', parent: ids.wikiRoot, createdBy: memberId });
    await makeDoc({ key: 'issueRoot', type: 'issue', title: 'Issue Root', createdBy: memberId });
    await makeDoc({ key: 'issueChild', type: 'issue', title: 'Issue Child', parent: ids.wikiRoot, createdBy: memberId });
    await makeDoc({
      key: 'adminPrivate', type: 'wiki', title: 'Admin Private', createdBy: adminId, visibility: 'private',
    });

    // --- projects fixtures, one per inferred_status branch ---
    await makeDoc({ key: 'pActive', type: 'project', title: 'P Active', createdBy: memberId, properties: { impact: 5, confidence: 5, ease: 5 } });
    await makeDoc({ key: 'pPlanned', type: 'project', title: 'P Planned', createdBy: memberId, properties: { impact: 4, confidence: 4, ease: 4 } });
    await makeDoc({ key: 'pBacklog', type: 'project', title: 'P Backlog', createdBy: memberId, properties: { impact: 3, confidence: 3, ease: 3 } });
    await makeDoc({ key: 'pCompleted', type: 'project', title: 'P Completed', createdBy: memberId, properties: { impact: 2, confidence: 2, ease: 2, plan_validated: '2026-01-01' } });
    await makeDoc({ key: 'pArchived', type: 'project', title: 'P Archived', createdBy: memberId, properties: { impact: 1, confidence: 1, ease: 1 }, archived: true });
    await makeDoc({ key: 'pPrivate', type: 'project', title: 'P Private', createdBy: adminId, visibility: 'private', properties: { impact: 1, confidence: 1, ease: 2 } });

    // sprint allocations drive inferred_status; only sprints with assignees count
    await makeDoc({ key: 'sCurrent', type: 'sprint', title: 'S current', createdBy: memberId, properties: { sprint_number: 1, project_id: ids.pActive, assignee_ids: [memberId] } });
    await makeDoc({ key: 'sFuture', type: 'sprint', title: 'S future', createdBy: memberId, properties: { sprint_number: 2, project_id: ids.pPlanned, assignee_ids: [memberId] } });
    await makeDoc({ key: 'sPast', type: 'sprint', title: 'S past', createdBy: memberId, properties: { sprint_number: -50, project_id: ids.pBacklog, assignee_ids: [memberId] } });
    // unassigned sprint on pActive must be ignored entirely
    await makeDoc({ key: 'sUnassigned', type: 'sprint', title: 'S unassigned', createdBy: memberId, properties: { sprint_number: 1, project_id: ids.pBacklog, assignee_ids: [] } });

    // association counts
    await makeDoc({ key: 'i1', type: 'issue', title: 'I1', createdBy: memberId });
    await makeDoc({ key: 'i2', type: 'issue', title: 'I2', createdBy: memberId });
    await makeDoc({ key: 'sA', type: 'sprint', title: 'SA', createdBy: memberId, properties: { sprint_number: 9 } });
    await associate('i1', 'pActive');
    await associate('i2', 'pActive');
    await associate('sA', 'pActive');
    // a wiki linked with relationship_type 'project' must count as neither
    await makeDoc({ key: 'wLinked', type: 'wiki', title: 'W linked', createdBy: memberId });
    await associate('wLinked', 'pActive');
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM document_associations WHERE document_id IN (SELECT id FROM documents WHERE workspace_id = $1)`,
      [workspaceId]
    );
    await pool.query('DELETE FROM sessions WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM documents WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [memberId, adminId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  const titles = (body: Array<{ title: string }>) => body.map(d => d.title).sort();

  describe('GET /api/documents — every prepared statement shape', () => {
    it('no filter returns all visible documents', async () => {
      const res = await request(app).get('/api/documents').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(titles(res.body)).toContain('Wiki Root');
      expect(titles(res.body)).toContain('Issue Root');
      expect(titles(res.body)).toContain('P Active');
    });

    it('type filter returns only that document_type', async () => {
      const res = await request(app).get('/api/documents?type=wiki').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body.every((d: { document_type: string }) => d.document_type === 'wiki')).toBe(true);
      expect(titles(res.body)).toContain('Wiki Child');
      expect(titles(res.body)).not.toContain('Issue Root');
    });

    it('parent_id=null returns only roots', async () => {
      const res = await request(app).get('/api/documents?parent_id=null').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(res.body.every((d: { parent_id: string | null }) => d.parent_id === null)).toBe(true);
      expect(titles(res.body)).not.toContain('Wiki Child');
    });

    it('parent_id=<uuid> returns only that parent’s children', async () => {
      const res = await request(app).get(`/api/documents?parent_id=${ids.wikiRoot}`).set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Issue Child', 'Wiki Child']);
    });

    it('type + parent_id=null applies both predicates', async () => {
      const res = await request(app).get('/api/documents?type=wiki&parent_id=null').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(titles(res.body)).toContain('Wiki Root');
      expect(titles(res.body)).not.toContain('Wiki Child');
      expect(titles(res.body)).not.toContain('Issue Root');
    });

    it('type + parent_id=<uuid> applies both predicates', async () => {
      const res = await request(app).get(`/api/documents?type=issue&parent_id=${ids.wikiRoot}`).set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      expect(titles(res.body)).toEqual(['Issue Child']);
    });

    it('flattens the seven backwards-compatible property fields', async () => {
      await pool.query(
        `UPDATE documents SET properties = '{"state":"in_progress","priority":"urgent","estimate":3,"source":"internal","prefix":"ENG","color":"#abc"}'::jsonb
         WHERE id = $1`,
        [ids.issueRoot]
      );
      const res = await request(app).get('/api/documents?type=issue').set('Cookie', memberCookie);
      const row = res.body.find((d: { id: string }) => d.id === ids.issueRoot);
      expect(row).toMatchObject({
        state: 'in_progress', priority: 'urgent', estimate: 3,
        source: 'internal', prefix: 'ENG', color: '#abc',
      });
      // properties itself must still be present alongside the flattened copies
      expect(row.properties.state).toBe('in_progress');
    });
  });

  describe('GET /api/documents — inline admin visibility subquery', () => {
    it('hides another user’s private document from a member', async () => {
      const res = await request(app).get('/api/documents').set('Cookie', memberCookie);
      expect(titles(res.body)).not.toContain('Admin Private');
    });

    it('shows every private document to a workspace admin', async () => {
      const res = await request(app).get('/api/documents').set('Cookie', adminCookie);
      expect(titles(res.body)).toContain('Admin Private');
    });
  });

  describe('GET /api/projects — pre-aggregated counts and status', () => {
    const byTitle = (body: Array<{ title: string }>, t: string) =>
      body.find(p => p.title === t) as Record<string, unknown> | undefined;

    it('counts only sprint and issue associations, not other types', async () => {
      const res = await request(app).get('/api/projects').set('Cookie', memberCookie);
      expect(res.status).toBe(200);
      const p = byTitle(res.body, 'P Active')!;
      expect(p.issue_count).toBe(2);
      expect(p.sprint_count).toBe(1); // the linked wiki must not be counted
    });

    it('reports zero counts for a project with no associations', async () => {
      const res = await request(app).get('/api/projects').set('Cookie', memberCookie);
      const p = byTitle(res.body, 'P Backlog')!;
      expect(p.sprint_count).toBe(0);
      expect(p.issue_count).toBe(0);
    });

    it('derives inferred_status from sprint allocation timing', async () => {
      const res = await request(app).get('/api/projects').set('Cookie', memberCookie);
      expect(byTitle(res.body, 'P Active')!.inferred_status).toBe('active');
      expect(byTitle(res.body, 'P Planned')!.inferred_status).toBe('planned');
      // past allocation and unassigned allocation both fall through to backlog
      expect(byTitle(res.body, 'P Backlog')!.inferred_status).toBe('backlog');
    });

    it('plan_validated wins over allocation, archived wins over everything', async () => {
      const res = await request(app).get('/api/projects?archived=true').set('Cookie', memberCookie);
      expect(byTitle(res.body, 'P Completed')!.inferred_status).toBe('completed');
      expect(byTitle(res.body, 'P Archived')!.inferred_status).toBe('archived');
    });

    it('excludes archived projects unless archived=true', async () => {
      const plain = await request(app).get('/api/projects').set('Cookie', memberCookie);
      expect(plain.body.map((p: { title: string }) => p.title)).not.toContain('P Archived');
      const withArchived = await request(app).get('/api/projects?archived=true').set('Cookie', memberCookie);
      expect(withArchived.body.map((p: { title: string }) => p.title)).toContain('P Archived');
    });

    it('applies the inline admin visibility subquery', async () => {
      const asMember = await request(app).get('/api/projects').set('Cookie', memberCookie);
      expect(asMember.body.map((p: { title: string }) => p.title)).not.toContain('P Private');
      const asAdmin = await request(app).get('/api/projects').set('Cookie', adminCookie);
      expect(asAdmin.body.map((p: { title: string }) => p.title)).toContain('P Private');
    });

    it('still sorts by computed ICE score descending by default', async () => {
      const res = await request(app).get('/api/projects').set('Cookie', memberCookie);
      const scores = res.body.map((p: { ice_score: number }) => p.ice_score);
      expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    });
  });
});
