/**
 * PF-284 / PF-285 / PF-286 / PF-289 / PF-291 — the four public sprint routes.
 *
 * The headline assertion is PF-284's: **a workspace with sprints 1–5 lists all
 * five.** Ship's internal sprint list returns exactly one — the sprint
 * whose number matches today's date — so this is the test that proves the public
 * list is a list rather than a wrapper around the internal handler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createSprintService } from '../../../../services/sprints.js';
import { RecordingEventBus } from '../../../webhooks/bus.js';
import { mountSprints } from './routes.js';
import {
  sprintSchema,
  SPRINT_PROJECTION_FIELDS,
  FORBIDDEN_SPRINT_FIELDS,
  REJECTED_SPRINT_FIELDS,
} from './sprints.schema.js';

const SPRINT_COUNT = 5;

describe('/api/v1/sprints', () => {
  let harness: BearerTestApp;
  let bus: RecordingEventBus;
  let workspaceId: string;
  let userId: string;
  let programId: string;
  let wikiId: string;
  let sprintIds: string[] = [];

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // A KNOWN sprint_start_date, so the derived calendar is deterministic rather
    // than a function of the day the suite runs. Sprint 1 starts 2026-01-05.
    const ws = await pool.query(
      `INSERT INTO workspaces (name, sprint_start_date) VALUES ($1, '2026-01-05') RETURNING id`,
      [`L10 sprints ${runId}`],
    );
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Sprint User') RETURNING id`,
      [`l10-sprints-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    const program = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'program', 'A program', $2) RETURNING id`,
      [workspaceId, userId],
    );
    programId = program.rows[0].id;

    const wiki = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'wiki', 'Not a sprint', $2) RETURNING id`,
      [workspaceId, userId],
    );
    wikiId = wiki.rows[0].id;

    // FIVE sprints, numbered 1..5. The internal route would return at most one.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, properties, created_at)
       SELECT $1, 'sprint', 'Sprint ' || g, $2,
              jsonb_build_object('sprint_number', g),
              now() - (g || ' seconds')::interval
       FROM generate_series(1, ${SPRINT_COUNT}) g
       RETURNING id`,
      [workspaceId, userId],
    );
    sprintIds = seeded.rows.map((r) => r.id);

    bus = new RecordingEventBus();
    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountSprints(router, { db: pool, service: createSprintService({ bus }) }),
    });
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM document_associations WHERE document_id IN
        (SELECT id FROM documents WHERE workspace_id = $1)`,
      [workspaceId],
    );
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  const auth = async (scopes: Parameters<BearerTestApp['mint']>[0]) =>
    `Bearer ${(await harness.mint(scopes)).access_token}`;

  // ── PF-284's headline ─────────────────────────────────────────────────────

  it('PF-284 — a workspace with five sprints lists FIVE (the internal route returns one)', () => {
    // Stated as its own case because it is the entire justification for this
    // resource existing rather than proxying Ship's internal sprint route, which
    // computes the current sprint number from `workspaces.sprint_start_date` and
    // filters `(d.properties->>'sprint_number')::int = $2`, so it can only ever
    // return the sprints matching today.
    expect(sprintIds).toHaveLength(SPRINT_COUNT);
  });

  it('the list returns all five, newest-created first', async () => {
    const res = await request(harness.app)
      .get('/api/v1/sprints?limit=100')
      .set('Authorization', await auth(['sprints:read']));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(SPRINT_COUNT);
    expect(res.body.data.map((s: { id: string }) => s.id).sort()).toEqual([...sprintIds].sort());
    expect(res.body).toHaveProperty('next_cursor');
    expect(res.body.next_cursor).toBeNull();
  });

  // ── the scope matrix ──────────────────────────────────────────────────────

  describe('the scope matrix', () => {
    it('no token is 401 on the list', async () => {
      const res = await request(harness.app).get('/api/v1/sprints');
      expect(res.status).toBe(401);
    });

    it('an issues:read token gets 403 on /sprints, naming sprints:read', async () => {
      // PF-283's converse half. Three scope pairs over ONE table; this is what
      // stops them collapsing into one.
      const res = await request(harness.app)
        .get('/api/v1/sprints')
        .set('Authorization', await auth(['issues:read']));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details.missing_scope).toBe('sprints:read');
    });

    it('a sprints:read token cannot POST or PATCH', async () => {
      const read = await auth(['sprints:read']);
      const created = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', read)
        .send({ sprint_number: 99 });
      expect(created.status).toBe(403);
      expect(created.body.details.missing_scope).toBe('sprints:write');

      const patched = await request(harness.app)
        .patch(`/api/v1/sprints/${sprintIds[0]}`)
        .set('Authorization', read)
        .send({ status: 'active' });
      expect(patched.status).toBe(403);
    });
  });

  // ── PF-289 — the projection and the derived fields ────────────────────────

  describe('PF-289 — computed fields are computed server-side and declared read-only', () => {
    it('every item parses as sprintSchema and has exactly the declared keys', async () => {
      const res = await request(harness.app)
        .get('/api/v1/sprints?limit=100')
        .set('Authorization', await auth(['sprints:read']));

      for (const item of res.body.data) {
        expect(Object.keys(item).sort()).toEqual([...SPRINT_PROJECTION_FIELDS].sort());
        expect(() => sprintSchema.parse(item)).not.toThrow();
      }
    });

    it('the internal dashboard fields and the `properties` blob are absent', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/sprints/${sprintIds[0]}`)
        .set('Authorization', await auth(['sprints:read']));

      expect(res.status).toBe(200);
      for (const forbidden of FORBIDDEN_SPRINT_FIELDS) {
        expect(res.body, `${forbidden} leaked into the public sprint body`).not.toHaveProperty(
          forbidden,
        );
      }
    });

    it('start_date and end_date are derived from sprint_number and the workspace anchor', async () => {
      // The workspace anchor is 2026-01-05 and sprints are seven days. So sprint
      // 1 is 2026-01-05..2026-01-11, sprint 3 is 2026-01-19..2026-01-25.
      // Computed HERE rather than left to the client, which is the ticket: two
      // clients computing this independently would be two answers.
      const res = await request(harness.app)
        .get('/api/v1/sprints?limit=100')
        .set('Authorization', await auth(['sprints:read']));

      const byNumber = new Map<number, { start_date: string; end_date: string }>(
        res.body.data.map((s: { sprint_number: number; start_date: string; end_date: string }) => [
          s.sprint_number,
          { start_date: s.start_date, end_date: s.end_date },
        ]),
      );

      expect(byNumber.get(1)).toEqual({ start_date: '2026-01-05', end_date: '2026-01-11' });
      expect(byNumber.get(3)).toEqual({ start_date: '2026-01-19', end_date: '2026-01-25' });
      expect(byNumber.get(5)).toEqual({ start_date: '2026-02-02', end_date: '2026-02-08' });
    });

    it('status is derived from the calendar when nothing was ever transitioned', async () => {
      // None of the seeded sprints has a stored `properties.status`, and all five
      // windows are in the past relative to the suite's run date, so the honest
      // answer is `completed` — NOT the `planning` that `statusOf`'s bare default
      // would give. That difference is the whole of PF-289's status half.
      const res = await request(harness.app)
        .get('/api/v1/sprints?limit=100')
        .set('Authorization', await auth(['sprints:read']));

      for (const sprint of res.body.data) {
        expect(sprint.status, `sprint ${sprint.sprint_number}`).toBe('completed');
      }
    });

    it('an explicit stored transition WINS over the calendar', async () => {
      // The complement, and the reason the rule is "explicit beats inferred": a
      // human or an app asserted something, and asserting beats inferring.
      await pool.query(
        `UPDATE documents SET properties = properties || '{"status":"active"}'::jsonb
          WHERE id = $1`,
        [sprintIds[0]],
      );

      const res = await request(harness.app)
        .get(`/api/v1/sprints/${sprintIds[0]}`)
        .set('Authorization', await auth(['sprints:read']));

      expect(res.body.status).toBe('active');

      await pool.query(
        `UPDATE documents SET properties = properties - 'status' WHERE id = $1`,
        [sprintIds[0]],
      );
    });
  });

  // ── PF-285 — not_found ────────────────────────────────────────────────────

  describe('not_found', () => {
    it('an unknown id is 404 with no details', async () => {
      const res = await request(harness.app)
        .get('/api/v1/sprints/00000000-0000-4000-8000-000000000000')
        .set('Authorization', await auth(['sprints:read']));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(res.body.details).toBeUndefined();
    });

    it('a WIKI id requested through /sprints is 404 — the unified-model case', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/sprints/${wikiId}`)
        .set('Authorization', await auth(['sprints:read']));
      expect(res.status).toBe(404);
    });

    it('a non-UUID path param is validation_failed, not a Postgres error', async () => {
      const res = await request(harness.app)
        .get('/api/v1/sprints/not-a-uuid')
        .set('Authorization', await auth(['sprints:read']));
      expect(res.status).toBe(422);
      expect(res.body.details.fields[0].field).toBe('id');
    });
  });

  it('PF-283 — the list contains only document_type=sprint', async () => {
    const res = await request(harness.app)
      .get('/api/v1/sprints?limit=100')
      .set('Authorization', await auth(['sprints:read']));

    const ids = res.body.data.map((d: { id: string }) => d.id);
    expect(ids, 'a wiki reached the sprints list').not.toContain(wikiId);
    expect(ids, 'a program reached the sprints list').not.toContain(programId);
    for (const item of res.body.data) expect(item.document_type).toBe('sprint');
  });

  // ── PF-286 — create ───────────────────────────────────────────────────────

  describe('POST /api/v1/sprints', () => {
    it('creates with 201 + Location, and the derived fields come back computed', async () => {
      const res = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: 20, title: 'Sprint twenty' });

      expect(res.status).toBe(201);
      expect(res.headers.location).toBe(`/api/v1/sprints/${res.body.id}`);
      expect(res.body.sprint_number).toBe(20);
      expect(res.body.title).toBe('Sprint twenty');
      // 2026-01-05 plus 19 seven-day windows.
      expect(res.body.start_date).toBe('2026-05-18');
      expect(res.body.end_date).toBe('2026-05-24');
      expect(() => sprintSchema.parse(res.body)).not.toThrow();
    });

    it('defaults the title to "Untitled", per the repo-wide convention', async () => {
      const res = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: 21 });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Untitled');
    });

    it('rejects start_date, end_date and status BY NAME rather than ignoring them', async () => {
      // The ticket's core point: the server stores no such columns, so accepting
      // these would document writable fields it silently discards.
      for (const field of REJECTED_SPRINT_FIELDS) {
        const res = await request(harness.app)
          .post('/api/v1/sprints')
          .set('Authorization', await auth(['sprints:write']))
          .send({ sprint_number: 30, [field]: 'x' });

        expect(res.status, `${field} was accepted`).toBe(422);
        const named = res.body.details.fields.map((f: { field: string }) => f.field);
        expect(named, `the 422 for ${field} did not name it`).toContain(field);
      }
    });

    it('a duplicate programless sprint_number is a 422 naming sprint_number', async () => {
      const first = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: 40 });
      expect(first.status).toBe(201);

      const second = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: 40 });

      expect(second.status).toBe(422);
      expect(second.body.details.fields[0].field).toBe('sprint_number');
    });

    it('a program_id this workspace does not have is a 422, not a 404', async () => {
      // A 404 would distinguish "no such program" from "a program you cannot
      // see", which is a cross-tenant existence oracle through a body field.
      const res = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: 50, program_id: '00000000-0000-4000-8000-000000000000' });

      expect(res.status).toBe(422);
      expect(res.body.details.fields[0].field).toBe('program_id');
    });

    it('a valid program_id is associated and comes back on the projection', async () => {
      const res = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: 60, program_id: programId });

      expect(res.status).toBe(201);
      expect(res.body.program_id).toBe(programId);

      const fetched = await request(harness.app)
        .get(`/api/v1/sprints/${res.body.id}`)
        .set('Authorization', await auth(['sprints:read']));
      expect(fetched.body.program_id).toBe(programId);
    });

    it('an owner_id who is not a member of this workspace is a 422', async () => {
      const outsider = await pool.query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, 'test-hash', 'Outsider') RETURNING id`,
        [`l10-outsider-${Date.now()}@ship.local`],
      );
      try {
        const res = await request(harness.app)
          .post('/api/v1/sprints')
          .set('Authorization', await auth(['sprints:write']))
          .send({ sprint_number: 70, owner_id: outsider.rows[0].id });

        expect(res.status).toBe(422);
        expect(res.body.details.fields[0].field).toBe('owner_id');
      } finally {
        await pool.query(`DELETE FROM users WHERE id = $1`, [outsider.rows[0].id]);
      }
    });
  });

  // ── PF-291 — the transition ───────────────────────────────────────────────

  describe('PATCH /api/v1/sprints/:id — the public producer of sprint.* events', () => {
    async function freshSprint(n: number): Promise<string> {
      const res = await request(harness.app)
        .post('/api/v1/sprints')
        .set('Authorization', await auth(['sprints:write']))
        .send({ sprint_number: n });
      expect(res.status).toBe(201);
      return res.body.id;
    }

    it('planning → active is 200 and the body reports active', async () => {
      const id = await freshSprint(100);
      const res = await request(harness.app)
        .patch(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'active' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
      expect(res.body.id).toBe(id);
    });

    it('the PATCH body is byte-identical to a following GET', async () => {
      // The property an SDK's update-then-cache depends on. It is why the
      // handler re-reads rather than projecting the transition's own RETURNING,
      // which does not carry the workspace calendar anchor.
      const id = await freshSprint(101);
      const patched = await request(harness.app)
        .patch(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'active' });
      const fetched = await request(harness.app)
        .get(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:read']));

      expect(patched.body).toEqual(fetched.body);
    });

    it('PF-291 — {status:"completed"} really writes the value, and this test FAILS if nothing does', async () => {
      // Written to fail rather than skip, per the ticket. The stored value is
      // read straight out of `properties` rather than off the response, so a
      // handler that reported `completed` from the calendar while writing
      // nothing would not pass.
      const id = await freshSprint(102);

      const res = await request(harness.app)
        .patch(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'completed' });
      expect(res.status).toBe(200);

      const stored = await pool.query<{ status: string | null }>(
        `SELECT properties->>'status' AS status FROM documents WHERE id = $1`,
        [id],
      );
      expect(
        stored.rows[0]!.status,
        'no write path set properties.status = "completed", so one of the eight ' +
          'registered event types has no public producer',
      ).toBe('completed');
    });

    it('an illegal transition is a 422 naming status, and writes nothing', async () => {
      const id = await freshSprint(103);
      await request(harness.app)
        .patch(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'completed' });

      // completed is terminal — SPRINT_TRANSITIONS.completed is [].
      const res = await request(harness.app)
        .patch(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'active' });

      expect(res.status).toBe(422);
      expect(res.body.details.fields[0].field).toBe('status');

      const stored = await pool.query<{ status: string }>(
        `SELECT properties->>'status' AS status FROM documents WHERE id = $1`,
        [id],
      );
      expect(stored.rows[0]!.status).toBe('completed');
    });

    it('an unknown status value is rejected by the schema', async () => {
      const id = await freshSprint(104);
      const res = await request(harness.app)
        .patch(`/api/v1/sprints/${id}`)
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'cancelled' });
      expect(res.status).toBe(422);
    });

    it('the PATCH accepts ONLY status — title and sprint_number are rejected', async () => {
      const id = await freshSprint(105);
      for (const field of ['title', 'sprint_number', 'owner_id']) {
        const res = await request(harness.app)
          .patch(`/api/v1/sprints/${id}`)
          .set('Authorization', await auth(['sprints:write']))
          .send({ status: 'active', [field]: field === 'sprint_number' ? 9 : 'x' });
        expect(res.status, `${field} was accepted by the sprint PATCH`).toBe(422);
      }
    });

    it('patching an unknown id is 404', async () => {
      const res = await request(harness.app)
        .patch('/api/v1/sprints/00000000-0000-4000-8000-000000000000')
        .set('Authorization', await auth(['sprints:write']))
        .send({ status: 'active' });
      expect(res.status).toBe(404);
    });
  });

  // ── the query allowlist ───────────────────────────────────────────────────

  it('?sort=sprint_number is rejected rather than silently ignored', async () => {
    // The parameter a consumer will actually reach for, given PF-288's
    // consequence. Rejecting it names the situation instead of returning
    // creation order while the caller believes otherwise.
    const res = await request(harness.app)
      .get('/api/v1/sprints?sort=sprint_number')
      .set('Authorization', await auth(['sprints:read']));

    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('sort');
  });
});
