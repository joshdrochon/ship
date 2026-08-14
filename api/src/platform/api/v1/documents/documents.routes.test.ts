/**
 * MVP GATE ITEM 4 (PRD p.2), asserted against the routes a grader actually calls.
 *
 * *"At least one resource (documents) implements GET list, GET by id, and POST.
 * Each route declares its required scope via a require(scope) middleware
 * factory."*
 *
 * Tickets: PF-245 (list), PF-246 (by id), PF-247 (create), PF-249 (negative
 * matrix), PF-250 (`PUBLIC_DOCUMENT_TYPES`), PF-265 (documents only).
 *
 * These run against `createBearerTestApp` — the REAL bearer middleware over real
 * tokens, not the stub in `api/v1/testSupport.ts`. The stub is right for testing
 * the envelope and the middleware order; it cannot tell you whether an
 * unauthenticated request 401s, because it decides that itself. L03's PF-080
 * asserts the scope matrix against a fixture router; this asserts it against the
 * mounted routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountDocuments } from './routes.js';
import { PUBLIC_DOCUMENT_TYPES, NON_PUBLIC_DOCUMENT_TYPES } from './documents.schema.js';
import { pageSchema } from '../page.js';
import { documentSchema } from './documents.schema.js';

describe('/api/v1/documents — MVP gate item 4', () => {
  let harness: BearerTestApp;
  let workspaceId: string;
  let userId: string;
  let seededWikiId: string;
  let seededIssueId: string;
  let seededSprintId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 routes ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Routes User') RETURNING id`,
      [`l09-routes-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    // One row of each shape the leak test needs. Seeded through SQL rather than
    // the public POST precisely because PF-250 makes some of them uncreatable
    // there — a test that could only seed what the API allows could never prove
    // the API hides what it does not allow.
    const wiki = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'wiki', 'Seeded wiki', $2) RETURNING id`,
      [workspaceId, userId],
    );
    seededWikiId = wiki.rows[0].id;

    const issue = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'issue', 'Seeded issue', $2) RETURNING id`,
      [workspaceId, userId],
    );
    seededIssueId = issue.rows[0].id;

    const sprint = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, 'sprint', 'Seeded sprint', $2) RETURNING id`,
      [workspaceId, userId],
    );
    seededSprintId = sprint.rows[0].id;

    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountDocuments(router, { db: pool, service: createDocumentService() }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  async function bearer(scopes: Parameters<BearerTestApp['mint']>[0]) {
    const pair = await harness.mint(scopes);
    return `Bearer ${pair.access_token}`;
  }

  // ── PF-245 · GET list ──────────────────────────────────────────────────────

  describe('PF-245 · GET /api/v1/documents', () => {
    it('200 with a pageSchema-valid body for a documents:read token', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents')
        .set('Authorization', await bearer(['documents:read']));

      expect(res.status).toBe(200);
      const parsed = pageSchema(documentSchema).safeParse(res.body);
      expect(
        parsed.success ? [] : parsed.error.issues,
        'The list body must parse against pageSchema(documentSchema) exactly — ' +
          'it is `.strict()`, so an extra top-level key is a second, undocumented ' +
          'pagination protocol.',
      ).toEqual([]);
    });

    it('403 naming documents:read for a token with no scopes', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents')
        .set('Authorization', await bearer([]));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      expect(res.body.details.missing_scope).toBe('documents:read');
      expect(res.body.details.granted_scopes).toEqual([]);
      // MVP gate item 6: the missing scope named explicitly, no opaque 'forbidden'.
      expect(res.body.details.scope_description).toBeTruthy();
    });

    it('401 with no token at all', async () => {
      const res = await request(harness.app).get('/api/v1/documents');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    });
  });

  // ── PF-246 · GET by id ─────────────────────────────────────────────────────

  describe('PF-246 · GET /api/v1/documents/:id', () => {
    it('200 for a documents:read token', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/documents/${seededWikiId}`)
        .set('Authorization', await bearer(['documents:read']));

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(seededWikiId);
      expect(documentSchema.safeParse(res.body).success).toBe(true);
    });

    it('403 naming documents:read for a scopeless token', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/documents/${seededWikiId}`)
        .set('Authorization', await bearer([]));

      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('documents:read');
    });

    it('401 with no token', async () => {
      const res = await request(harness.app).get(`/api/v1/documents/${seededWikiId}`);
      expect(res.status).toBe(401);
    });

    it('a non-UUID id is validation_failed, never a Postgres error as server_error', async () => {
      // The internal equivalent has no such guard: `canAccessDocument` passes
      // `$1` straight through, so `invalid input syntax for type uuid` surfaces
      // as a 500. A 500 tells an SDK to retry, forever, on a request that can
      // never succeed.
      const res = await request(harness.app)
        .get('/api/v1/documents/not-a-uuid')
        .set('Authorization', await bearer(['documents:read']));

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fields[0].field).toBe('id');
    });
  });

  // ── PF-247 · POST create ───────────────────────────────────────────────────

  describe('PF-247 · POST /api/v1/documents', () => {
    it('201 with the projection and a Location header', async () => {
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await bearer(['documents:write']))
        .send({ title: 'Made through the public API', document_type: 'wiki' });

      expect(res.status).toBe(201);
      expect(documentSchema.safeParse(res.body).success).toBe(true);
      expect(res.headers.location).toBe(`/api/v1/documents/${res.body.id}`);
    });

    it('defaults the title to "Untitled" — the one repo-wide default', async () => {
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await bearer(['documents:write']))
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Untitled');
    });

    it('401 with no token', async () => {
      const res = await request(harness.app).post('/api/v1/documents').send({ title: 'x' });
      expect(res.status).toBe(401);
    });
  });

  // ── PF-249 · the negative matrix, over the LIVE routes ─────────────────────

  describe('PF-249 · scope negative matrix', () => {
    it('(a) a documents:read token on POST → 403 naming documents:write', async () => {
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await bearer(['documents:read']))
        .send({ title: 'Should not be created' });

      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('documents:write');
      expect(res.body.details.granted_scopes).toEqual(['documents:read']);
    });

    it('(b) an issues:write token on POST → 403 naming documents:write', async () => {
      // Proves the check is "has THIS scope", not "has any scope". A guard
      // testing `auth.scopes.length > 0` would pass every other case here.
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await bearer(['issues:write']))
        .send({ title: 'Should not be created' });

      expect(res.status).toBe(403);
      expect(res.body.details.missing_scope).toBe('documents:write');
    });

    it('(c) a token with an empty scope array → 403, not 500', async () => {
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await bearer([]))
        .send({ title: 'Should not be created' });

      expect(res.status).toBe(403);
      expect(res.status).not.toBe(500);
    });

    it("(d′) the positive control — the right scope reaches the handler", async () => {
      // Without this, a guard that 403'd unconditionally would pass (a), (b), (c).
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await bearer(['documents:write']))
        .send({ title: 'Positive control' });

      expect(res.status).toBe(201);
    });
  });

  // ── PF-250 · the scope leak, closed ────────────────────────────────────────

  describe('PF-250 · documents:read does not reach issues or sprints (F16)', () => {
    it('a seeded issue is absent from the list', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', await bearer(['documents:read']));

      expect(res.status).toBe(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(
        ids,
        'An unfiltered public list returns issues under `documents:read`, which makes ' +
          '`issues:read` decorative. That is finding F16.',
      ).not.toContain(seededIssueId);
    });

    it('a seeded sprint is absent from the list', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', await bearer(['documents:read']));

      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(seededSprintId);
    });

    it('the list returns only PUBLIC_DOCUMENT_TYPES', async () => {
      const res = await request(harness.app)
        .get('/api/v1/documents?limit=100')
        .set('Authorization', await bearer(['documents:read']));

      const types = new Set(res.body.data.map((d: { document_type: string }) => d.document_type));
      for (const type of types) {
        expect(PUBLIC_DOCUMENT_TYPES as readonly string[]).toContain(type);
      }
    });

    it('an issue is 404 by id — NOT 403, which would confirm it exists', async () => {
      // PF-255(d). A 403 here is a cross-tenant existence oracle: a caller
      // iterating UUIDs learns which ones are real.
      const res = await request(harness.app)
        .get(`/api/v1/documents/${seededIssueId}`)
        .set('Authorization', await bearer(['documents:read']));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(res.status).not.toBe(403);
    });

    it('a sprint is 404 by id', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/documents/${seededSprintId}`)
        .set('Authorization', await bearer(['documents:read']));

      expect(res.status).toBe(404);
    });

    it('POST rejects every non-public document_type by name', async () => {
      // `documents:write` must not be able to mint an issue. The internal create
      // schema accepts `document_type:'issue'` (`routes/documents.ts`), which is
      // the other half of F16.
      for (const type of NON_PUBLIC_DOCUMENT_TYPES) {
        const res = await request(harness.app)
          .post('/api/v1/documents')
          .set('Authorization', await bearer(['documents:write']))
          .send({ title: 'Nope', document_type: type });

        expect(res.status, `document_type=${type}`).toBe(422);
        expect(res.body.code).toBe('validation_failed');
        expect(res.body.details.fields[0].field).toBe('document_type');
      }
    });

    it('accepts every type that IS public', async () => {
      // The positive control. Without it, a schema rejecting everything would
      // pass the test above.
      for (const type of PUBLIC_DOCUMENT_TYPES) {
        const res = await request(harness.app)
          .post('/api/v1/documents')
          .set('Authorization', await bearer(['documents:write']))
          .send({ title: `A ${type}`, document_type: type });

        expect(res.status, `document_type=${type}`).toBe(201);
        expect(res.body.document_type).toBe(type);
      }
    });
  });
});
