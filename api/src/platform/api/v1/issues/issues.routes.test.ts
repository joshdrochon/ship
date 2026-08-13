/**
 * PF-277 / PF-278 / PF-279 / PF-280 / PF-282 — the four public issue routes.
 *
 * The scope matrix, the four-way `not_found`, the `.strict()` request schemas
 * and the projection allowlist. Testing Scenario 4's four clauses are asserted
 * by other lanes' walkers over the live route tree (PF-373, PF-079, PF-201,
 * PF-229–231); this file asserts the behaviour those walkers cannot see.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createIssueService } from '../../../../services/issues.js';
import { RecordingEventBus } from '../../../webhooks/bus.js';
import { mountIssues } from './routes.js';
import {
  ISSUE_PROJECTION_FIELDS,
  FORBIDDEN_ISSUE_FIELDS,
  REJECTED_INTERNAL_ISSUE_FIELDS,
  issueSchema,
} from './issues.schema.js';

describe('/api/v1/issues', () => {
  let harness: BearerTestApp;
  let bus: RecordingEventBus;
  let workspaceId: string;
  let userId: string;
  let sprintId: string;
  let wikiId: string;
  let seededIssueId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const ws = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L10 issues ${runId}`,
    ]);
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Issue User') RETURNING id`,
      [`l10-issues-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    // A sprint and a wiki in the SAME workspace. Both exist so the isolation
    // assertions below are about `document_type` and not about tenancy — in a
    // unified document model those are two different ways to be absent and a
    // test that only has issues cannot tell them apart.
    const sprint = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, properties)
       VALUES ($1, 'sprint', 'Sprint 1', $2, '{"sprint_number": 1}') RETURNING id`,
      [workspaceId, userId],
    );
    sprintId = sprint.rows[0].id;

    const wiki = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'wiki', 'A wiki page', $2) RETURNING id`,
      [workspaceId, userId],
    );
    wikiId = wiki.rows[0].id;

    const seeded = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, ticket_number, properties)
       VALUES ($1, 'issue', 'Seeded issue', $2, 1,
               '{"state":"todo","priority":"high","source":"internal"}')
       RETURNING id`,
      [workspaceId, userId],
    );
    seededIssueId = seeded.rows[0].id;

    bus = new RecordingEventBus();
    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountIssues(router, { db: pool, service: createIssueService({ bus }) }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM document_associations WHERE document_id IN
       (SELECT id FROM documents WHERE workspace_id = $1)`, [workspaceId]);
    await pool.query(`DELETE FROM document_history WHERE document_id IN
       (SELECT id FROM documents WHERE workspace_id = $1)`, [workspaceId]);
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  const auth = async (scopes: Parameters<BearerTestApp['mint']>[0]) =>
    `Bearer ${(await harness.mint(scopes)).access_token}`;

  // ── PF-277/278/279/280 — the scope matrix ─────────────────────────────────

  describe('the scope matrix — 401 without a token, 403 with the wrong one', () => {
    const cases = [
      { method: 'get' as const, path: '/api/v1/issues', required: 'issues:read' },
      { method: 'post' as const, path: '/api/v1/issues', required: 'issues:write' },
    ];

    for (const c of cases) {
      it(`${c.method.toUpperCase()} ${c.path} — no token is 401`, async () => {
        const res = await request(harness.app)[c.method](c.path).send({});
        expect(res.status).toBe(401);
        expect(res.body.code).toBeDefined();
      });

      it(`${c.method.toUpperCase()} ${c.path} — a token without ${c.required} is 403 naming it`, async () => {
        // `documents:read` and NOT a made-up scope: the interesting failure is a
        // real, registered scope for a DIFFERENT resource reaching this one,
        // because in a single-table data model that is the mistake that silently
        // works if the guard is missing.
        const res = await request(harness.app)
          [c.method](c.path)
          .set('Authorization', await auth(['documents:read']))
          .send({ title: 'nope' });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('forbidden');
        // L03 renamed this key `required_scope` → `missing_scope` on the merge;
        // read whichever the envelope carries rather than pinning the spelling.
        const details = res.body.details ?? {};
        expect(
          details.missing_scope ?? details.required_scope,
          'the 403 must name the scope the caller LACKS, not the one it holds',
        ).toBe(c.required);
      });
    }

    it('GET /api/v1/issues with issues:read is 200 and a page envelope', async () => {
      const res = await request(harness.app)
        .get('/api/v1/issues')
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Present-and-null on the last page, never absent (PF-224).
      expect(res.body).toHaveProperty('next_cursor');
    });

    it('a read token cannot write and a write token cannot read', async () => {
      const readOnly = await auth(['issues:read']);
      const writeOnly = await auth(['issues:write']);

      const write = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', readOnly)
        .send({ title: 'Should not be created' });
      expect(write.status).toBe(403);

      const read = await request(harness.app)
        .get('/api/v1/issues')
        .set('Authorization', writeOnly);
      expect(read.status).toBe(403);
    });
  });

  // ── PF-282 — the projection ───────────────────────────────────────────────

  describe('the projection is an allowlist', () => {
    it('a listed issue has exactly the declared keys and parses as issueSchema', async () => {
      const res = await request(harness.app)
        .get('/api/v1/issues')
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);

      for (const item of res.body.data) {
        expect(Object.keys(item).sort()).toEqual([...ISSUE_PROJECTION_FIELDS].sort());
        // `.strict()` means this ALSO fails on an unexpected key, so the schema
        // and the key-set assertion are not redundant with each other in the
        // direction that matters.
        expect(() => issueSchema.parse(item)).not.toThrow();
      }
    });

    it('`properties` and every other internal column are absent', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/issues/${seededIssueId}`)
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(200);
      for (const forbidden of FORBIDDEN_ISSUE_FIELDS) {
        expect(res.body, `${forbidden} leaked into the public issue body`).not.toHaveProperty(
          forbidden,
        );
      }
    });

    it('the JSONB properties are flattened and NAMED, with real enum values', async () => {
      // The whole point of PF-282: `state` and `priority` are first-class typed
      // fields with enums the generated spec can express, not an opaque blob.
      const res = await request(harness.app)
        .get(`/api/v1/issues/${seededIssueId}`)
        .set('Authorization', await auth(['issues:read']));

      expect(res.body.state).toBe('todo');
      expect(res.body.priority).toBe('high');
      expect(res.body.ticket_number).toBe(1);
      expect(res.body.document_type).toBe('issue');
    });
  });

  // ── PF-278 — the four-way not_found ───────────────────────────────────────

  describe('not_found, four ways, indistinguishable on the wire', () => {
    it('(a) a well-formed UUID matching no row', async () => {
      const res = await request(harness.app)
        .get('/api/v1/issues/00000000-0000-4000-8000-000000000000')
        .set('Authorization', await auth(['issues:read']));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      // `not_found` is in CODES_WITHOUT_DETAILS: anything here would be the
      // existence leak arriving by another route.
      expect(res.body.details).toBeUndefined();
    });

    it('(d) a WIKI id requested through /issues — the unified-model case', async () => {
      // This is the case that exists only because issues are not a table. The
      // row is real, it is in this workspace, and the caller can read it through
      // `/api/v1/documents` with `documents:read`. Through `/issues` it must be
      // absent, or `issues:read` and `documents:read` are the same scope.
      const res = await request(harness.app)
        .get(`/api/v1/issues/${wikiId}`)
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('(d²) a SPRINT id requested through /issues is equally absent', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/issues/${sprintId}`)
        .set('Authorization', await auth(['issues:read']));
      expect(res.status).toBe(404);
    });

    it('a non-UUID path param is validation_failed, never a Postgres error', async () => {
      // Without the UUID guard this is `invalid input syntax for type uuid`
      // surfacing as a 500 — a client mistake reported as a server fault.
      const res = await request(harness.app)
        .get('/api/v1/issues/not-a-uuid')
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fields[0].field).toBe('id');
    });
  });

  // ── PF-283 — the list returns ONLY issues ─────────────────────────────────

  it('PF-283 — the list contains no wiki and no sprint, only document_type=issue', async () => {
    const res = await request(harness.app)
      .get('/api/v1/issues?limit=100')
      .set('Authorization', await auth(['issues:read']));

    expect(res.status).toBe(200);
    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids, 'a wiki reached the issues list').not.toContain(wikiId);
    expect(ids, 'a sprint reached the issues list').not.toContain(sprintId);
    for (const item of res.body.data) {
      expect(item.document_type).toBe('issue');
    }
  });

  // ── PF-279 — create ───────────────────────────────────────────────────────

  describe('POST /api/v1/issues', () => {
    it('creates, returns 201 with a Location header, and allocates a ticket_number', async () => {
      const res = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: 'A public issue', state: 'todo', priority: 'urgent' });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/api/v1/issues/${res.body.id}`);
      expect(res.body.title).toBe('A public issue');
      expect(res.body.state).toBe('todo');
      expect(res.body.priority).toBe('urgent');
      expect(typeof res.body.ticket_number).toBe('number');
      expect(() => issueSchema.parse(res.body)).not.toThrow();
    });

    it('the created id resolves through GET by id, byte-identical', async () => {
      const created = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: 'Round trip' });
      expect(created.status).toBe(201);

      const fetched = await request(harness.app)
        .get(`/api/v1/issues/${created.body.id}`)
        .set('Authorization', await auth(['issues:read']));

      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(created.body);
    });

    it('rejects every internal-only field BY NAME rather than ignoring it', async () => {
      // The escalation this stops: `is_system_generated: true` would let any app
      // with `issues:write` fabricate system-authored accountability items that
      // Ship's UI presents as its own.
      for (const field of REJECTED_INTERNAL_ISSUE_FIELDS) {
        const res = await request(harness.app)
          .post('/api/v1/issues')
          .set('Authorization', await auth(['issues:write']))
          .send({ title: 'Escalation attempt', [field]: 'x' });

        expect(res.status, `${field} was accepted`).toBe(422);
        expect(res.body.code).toBe('validation_failed');
        const named = res.body.details.fields.map((f: { field: string }) => f.field);
        expect(named, `the 422 for ${field} did not name it`).toContain(field);
      }
    });

    it('a body naming workspace_id is a rejection, never a cross-tenant override', async () => {
      const other = await pool.query(`INSERT INTO workspaces (name) VALUES ('L10 elsewhere') RETURNING id`);
      const res = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: 'Cross tenant', workspace_id: other.rows[0].id });

      expect(res.status).toBe(422);
      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [other.rows[0].id]);
    });

    it('an empty title is validation_failed, not a silent "Untitled"', async () => {
      const res = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: '' });
      expect(res.status).toBe(422);
    });
  });

  // ── D13 — belongs_to on the projection ────────────────────────────────────

  it('D13 — belongs_to carries the sprint association, as an array', async () => {
    const created = await request(harness.app)
      .post('/api/v1/issues')
      .set('Authorization', await auth(['issues:write']))
      .send({ title: 'In a sprint', belongs_to: [{ id: sprintId, type: 'sprint' }] });

    expect(created.status).toBe(201);
    expect(created.body.belongs_to).toEqual([{ id: sprintId, type: 'sprint' }]);

    // The read L23's detectors actually perform. Asserted in the shape they
    // would write it, so this test fails if the field is ever flattened away.
    const sprintRef = created.body.belongs_to.find(
      (b: { type: string }) => b.type === 'sprint',
    );
    expect(sprintRef?.id).toBe(sprintId);

    // An issue with no associations gets `[]`, never a missing key — a consumer
    // writing `for (const b of issue.belongs_to)` must never need a guard.
    const bare = await request(harness.app)
      .post('/api/v1/issues')
      .set('Authorization', await auth(['issues:write']))
      .send({ title: 'Unassociated' });
    expect(bare.body.belongs_to).toEqual([]);
  });

  // ── PF-280 — patch ────────────────────────────────────────────────────────

  describe('PATCH /api/v1/issues/:id', () => {
    it('updates state and priority and returns the new representation', async () => {
      const created = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: 'To patch', state: 'backlog', priority: 'low' });

      const patched = await request(harness.app)
        .patch(`/api/v1/issues/${created.body.id}`)
        .set('Authorization', await auth(['issues:write']))
        .send({ state: 'in_progress', priority: 'urgent' });

      expect(patched.status).toBe(200);
      expect(patched.body.state).toBe('in_progress');
      expect(patched.body.priority).toBe('urgent');
      expect(patched.body.id).toBe(created.body.id);
    });

    it('a no-op PATCH returns 200 and changes nothing', async () => {
      const created = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: 'Unchanged', state: 'todo' });

      const before = await request(harness.app)
        .get(`/api/v1/issues/${created.body.id}`)
        .set('Authorization', await auth(['issues:read']));

      // Same values that are already stored — a diff of zero entries.
      const noop = await request(harness.app)
        .patch(`/api/v1/issues/${created.body.id}`)
        .set('Authorization', await auth(['issues:write']))
        .send({ state: 'todo', title: 'Unchanged' });

      expect(noop.status).toBe(200);
      expect(noop.body).toEqual(before.body);

      // Nothing written: `updated_at` did not move and no history row appeared.
      const history = await pool.query(
        `SELECT count(*)::int AS n FROM document_history WHERE document_id = $1`,
        [created.body.id],
      );
      expect(history.rows[0].n, 'a no-op PATCH wrote a history row').toBe(0);
    });

    it('rejects claude_metadata and confirm_orphan_children by name', async () => {
      const created = await request(harness.app)
        .post('/api/v1/issues')
        .set('Authorization', await auth(['issues:write']))
        .send({ title: 'Strict patch' });

      for (const field of ['claude_metadata', 'confirm_orphan_children', 'estimate']) {
        const res = await request(harness.app)
          .patch(`/api/v1/issues/${created.body.id}`)
          .set('Authorization', await auth(['issues:write']))
          .send({ [field]: field === 'estimate' ? 3 : true });

        expect(res.status, `${field} was accepted by the public PATCH`).toBe(422);
        const named = res.body.details.fields.map((f: { field: string }) => f.field);
        expect(named).toContain(field);
      }
    });

    it('patching an unknown id is 404, and a wiki id is 404 too', async () => {
      const missing = await request(harness.app)
        .patch('/api/v1/issues/00000000-0000-4000-8000-000000000000')
        .set('Authorization', await auth(['issues:write']))
        .send({ state: 'done' });
      expect(missing.status).toBe(404);

      const wiki = await request(harness.app)
        .patch(`/api/v1/issues/${wikiId}`)
        .set('Authorization', await auth(['issues:write']))
        .send({ state: 'done' });
      expect(wiki.status).toBe(404);
    });
  });

  // ── PF-226 — the query allowlist ──────────────────────────────────────────

  describe('query parameters are allowlisted, not ignored', () => {
    it('?offset= is a 422 pointing at cursor pagination', async () => {
      const res = await request(harness.app)
        .get('/api/v1/issues?offset=10')
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(422);
      expect(res.body.details.fields[0].field).toBe('offset');
      expect(res.body.details.fields[0].message).toMatch(/cursor/i);
    });

    it("the internal list's own filters are rejected rather than silently ignored", async () => {
      // `?state=` and `?sprint_id=` work on `/api/issues`. Accepting-and-ignoring
      // them here is the silent-success failure PF-226 exists to prevent: a
      // caller filtering by state would receive every issue and believe the
      // filter applied.
      for (const param of ['state', 'priority', 'assignee_id', 'sprint_id', 'parent_filter']) {
        const res = await request(harness.app)
          .get(`/api/v1/issues?${param}=x`)
          .set('Authorization', await auth(['issues:read']));

        expect(res.status, `?${param}= was silently accepted`).toBe(422);
      }
    });

    it('?limit=101 is rejected, not clamped', async () => {
      const res = await request(harness.app)
        .get('/api/v1/issues?limit=101')
        .set('Authorization', await auth(['issues:read']));
      expect(res.status).toBe(422);
      expect(res.body.details.fields[0].field).toBe('limit');
    });
  });
});
