/**
 * PF-252 / PF-253 / PF-254 / PF-255 — the projection, the strict request, and
 * the two error matrices, against the live routes.
 *
 * The theme of this file is that the public representation is an ALLOWLIST in
 * both directions. Responses carry only named fields; requests accept only named
 * fields. Both defaults are "absent", which is the reversible one — a field that
 * was never published can be published later, while a field that leaked cannot
 * be un-leaked from a consumer that started depending on it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createDocumentService } from '../../../../services/documents.js';
import { mountDocuments } from './routes.js';
import { apiErrorBodySchema } from '../errors.js';
import {
  DOCUMENT_PROJECTION_FIELDS,
  REJECTED_INTERNAL_FIELDS,
  documentSchema,
} from './documents.schema.js';

describe('/api/v1/documents — schemas and error matrices', () => {
  let harness: BearerTestApp;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let wikiId: string;
  let deletedId: string;
  let foreignId: string;

  beforeAll(async () => {
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 schema ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;

    const other = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 schema other ${runId}`,
    ]);
    otherWorkspaceId = other.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Schema User') RETURNING id`,
      [`l09-schema-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    // A row with content AND a yjs_state, so "yjs_state is in no response" is a
    // real absence rather than a null that happens not to serialise.
    const wiki = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, content, yjs_state, position, ticket_number)
       VALUES ($1, 'wiki', 'Full row', $2, '{"type":"doc"}'::jsonb, '\\x0102030405'::bytea, 42, 7)
       RETURNING id`,
      [workspaceId, userId],
    );
    wikiId = wiki.rows[0].id;

    const deleted = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, deleted_at)
       VALUES ($1, 'wiki', 'Soft deleted', $2, now()) RETURNING id`,
      [workspaceId, userId],
    );
    deletedId = deleted.rows[0].id;

    const foreign = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title)
       VALUES ($1, 'wiki', 'Another tenant''s document') RETURNING id`,
      [otherWorkspaceId],
    );
    foreignId = foreign.rows[0].id;

    harness = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountDocuments(router, { db: pool, service: createDocumentService() }),
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM documents WHERE workspace_id = ANY($1::uuid[])`, [
      [workspaceId, otherWorkspaceId],
    ]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [
      [workspaceId, otherWorkspaceId],
    ]);
  });

  async function read() {
    return `Bearer ${(await harness.mint(['documents:read'])).access_token}`;
  }
  async function write() {
    return `Bearer ${(await harness.mint(['documents:write'])).access_token}`;
  }

  // ── PF-252 · one projection, an allowlist ─────────────────────────────────

  describe('PF-252 · the response projection (F17)', () => {
    it('the by-id body has EXACTLY the projected fields', async () => {
      const res = await request(harness.app)
        .get(`/api/v1/documents/${wikiId}`)
        .set('Authorization', await read());

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([...DOCUMENT_PROJECTION_FIELDS].sort());
    });

    it('`yjs_state` appears in no response body, under any of the three routes', async () => {
      // The internal create returns `RETURNING *`, i.e. every column including
      // `yjs_state` BYTEA. Passing that through publishes Ship's internal schema
      // as the public contract. That is finding F17.
      const token = await read();
      const list = await request(harness.app).get('/api/v1/documents').set('Authorization', token);
      const byId = await request(harness.app)
        .get(`/api/v1/documents/${wikiId}`)
        .set('Authorization', token);
      const created = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await write())
        .send({ title: 'For the projection check' });

      for (const [name, body] of [
        ['list', list.body],
        ['by id', byId.body],
        ['create', created.body],
      ] as const) {
        expect(JSON.stringify(body), `${name} response`).not.toContain('yjs_state');
        expect(JSON.stringify(body), `${name} response`).not.toContain('deleted_at');
        expect(JSON.stringify(body), `${name} response`).not.toContain('conversion_count');
      }
    });

    it('no internal column reaches any of the three bodies', async () => {
      // Enumerated from `information_schema` rather than pasted, so a column
      // added by a future migration is covered the day it lands. This is the
      // "a new column appears in no v1 response" half of PF-252, and it is the
      // reason the projection is an allowlist rather than an exclusion list.
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'`,
      );
      const internalOnly = columns.rows
        .map((r) => r.column_name)
        .filter((c) => !(DOCUMENT_PROJECTION_FIELDS as string[]).includes(c));

      expect(internalOnly.length, 'the table must have columns the projection omits').toBeGreaterThan(0);

      const res = await request(harness.app)
        .get(`/api/v1/documents/${wikiId}`)
        .set('Authorization', await read());

      for (const column of internalOnly) {
        expect(Object.keys(res.body), `column ${column}`).not.toContain(column);
      }
    });

    it('the SAME schema validates all three bodies — one SDK type, not three', async () => {
      const token = await read();
      const list = await request(harness.app).get('/api/v1/documents').set('Authorization', token);
      const byId = await request(harness.app)
        .get(`/api/v1/documents/${wikiId}`)
        .set('Authorization', token);
      const created = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await write())
        .send({ title: 'Same shape' });

      expect(documentSchema.safeParse(list.body.data[0]).success).toBe(true);
      expect(documentSchema.safeParse(byId.body).success).toBe(true);
      expect(documentSchema.safeParse(created.body).success).toBe(true);
    });
  });

  // ── PF-253 · strict requests ──────────────────────────────────────────────

  describe('PF-253 · internal-only fields are rejected BY NAME, not ignored', () => {
    for (const field of REJECTED_INTERNAL_FIELDS) {
      it(`rejects \`${field}\` and names it`, async () => {
        // Named rather than ignored, because ignoring is how a caller comes to
        // believe they set a field they did not: the request succeeds, the
        // response omits the field (it is not in the projection), and they
        // conclude the API is eventually consistent rather than that they were
        // wrong.
        const res = await request(harness.app)
          .post('/api/v1/documents')
          .set('Authorization', await write())
          .send({ title: 'Nope', [field]: field === 'position' ? 1 : 'x' });

        expect(res.status).toBe(422);
        expect(res.body.code).toBe('validation_failed');
        expect(res.body.details.fields.map((f: { field: string }) => f.field)).toContain(field);
      });
    }

    it('rejecting `workspace_id` is what makes tenancy a token property', async () => {
      // PF-260's write half. If the body could name a workspace, it would be an
      // override — and a cross-tenant write.
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await write())
        .send({ title: 'Cross tenant', workspace_id: otherWorkspaceId });

      expect(res.status).toBe(422);
      const rows = await pool.query(`SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1`, [
        otherWorkspaceId,
      ]);
      expect(rows.rows[0].n, 'nothing may have been written to the other workspace').toBe(1);
    });

    it('still ACCEPTS parent_id and belongs_to — the association surface', async () => {
      // The positive control. A schema that rejected everything would pass every
      // test above.
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await write())
        .send({ title: 'Child', parent_id: wikiId, belongs_to: [{ id: wikiId, type: 'parent' }] });

      expect(res.status).toBe(201);
      expect(res.body.parent_id).toBe(wikiId);
    });
  });

  // ── PF-254 · validation_failed ────────────────────────────────────────────

  describe('PF-254 · the live producer of validation_failed', () => {
    it('an empty title yields details.fields[0].field === "title"', async () => {
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await write())
        .send({ title: '' });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fields[0].field).toBe('title');
      expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
    });

    it('the body is the envelope, not raw z.ZodError.errors', async () => {
      // The internal route passes `parsed.error.errors` straight through. Those
      // objects carry `code`, `expected`, `received` and a `path` ARRAY — Zod's
      // internal vocabulary, which publishing would make part of the public
      // contract and unchangeable without a breaking change.
      const res = await request(harness.app)
        .post('/api/v1/documents')
        .set('Authorization', await write())
        .send({ title: '' });

      const field = res.body.details.fields[0];
      expect(Object.keys(field).sort()).toEqual(['field', 'message']);
      expect(Array.isArray(field.field), '`field` is a dotted string, not a path array').toBe(false);
      expect(field).not.toHaveProperty('code');
      expect(field).not.toHaveProperty('received');
    });
  });

  // ── PF-255 · the four-way not_found matrix ────────────────────────────────

  describe('PF-255 · four ways to miss, one envelope', () => {
    const cases: [string, () => string][] = [
      ['(a) a well-formed UUID matching no row', () => '11111111-1111-4111-8111-111111111111'],
      ['(b) a UUID belonging to another workspace', () => foreignId],
      ['(c) a soft-deleted row', () => deletedId],
    ];

    for (const [name, id] of cases) {
      it(`${name} → 404, identical shape, no details`, async () => {
        const res = await request(harness.app)
          .get(`/api/v1/documents/${id()}`)
          .set('Authorization', await read());

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('not_found');
        expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
        // `not_found` is in CODES_WITHOUT_DETAILS. Anything here would be the
        // existence leak arriving by another route.
        expect(res.body.details).toBeUndefined();
      });
    }

    it('(b) and (d) are 404 and NOT 403 — no cross-tenant existence oracle', async () => {
      // A 403 confirms the id EXISTS. A caller iterating UUIDs would learn which
      // ones are real in workspaces they cannot read, which is a disclosure even
      // though no content is returned. Case (d) — a type outside
      // PUBLIC_DOCUMENT_TYPES — is asserted in documents.routes.test.ts.
      const res = await request(harness.app)
        .get(`/api/v1/documents/${foreignId}`)
        .set('Authorization', await read());

      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
    });

    it('all four bodies are byte-identical to each other', async () => {
      const token = await read();
      const bodies = await Promise.all(
        [
          '11111111-1111-4111-8111-111111111111',
          foreignId,
          deletedId,
        ].map(async (id) => {
          const res = await request(harness.app)
            .get(`/api/v1/documents/${id}`)
            .set('Authorization', token);
          // `request_id` differs per request by design; everything else must not.
          const { request_id: _ignored, ...rest } = res.body;
          return JSON.stringify(rest);
        }),
      );

      expect(new Set(bodies).size, `distinct bodies: ${[...new Set(bodies)].join(' | ')}`).toBe(1);
    });
  });
});
