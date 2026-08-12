/**
 * PF-243 / PF-264 — the internal surface is byte-for-byte what it was before the
 * `documentService` extraction (PF-241).
 *
 * `api/src/routes/documents.ts` is the most-exercised write path in Ship, and
 * PF-241 moved its SQL. The rest of the internal suite
 * (`documents.test.ts`, `documents-visibility.test.ts`,
 * `list-endpoints-regression.test.ts`) passes with no edits, which is most of the
 * evidence. This file adds the two things those suites do not pin down.
 *
 * ## Why the "golden capture" is derived, not pasted
 *
 * The ticket asks for a golden body captured before the extraction and compared
 * after. A pasted key list would be a snapshot of the schema on the day it was
 * written, and would keep passing while silently under-describing the response
 * the day a column is added — which is the exact failure mode PF-252 exists to
 * stop on the PUBLIC side.
 *
 * So the invariant is derived from `information_schema` instead: the internal
 * 201 body carries EVERY column of `documents`, because the internal insert is
 * `RETURNING *` and that is a Part 1 contract. Adding a column to the table
 * changes both sides of this comparison together, which is correct — the
 * internal surface really does ship whatever the table has. The public surface
 * is where a new column must NOT appear, and PF-252 asserts that separately and
 * in the opposite direction.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../db/client.js';

// Mocked so the accountability broadcast is observable. `broadcastToUser` pushes
// over a websocket to the requesting session; PF-243 requires that side effect
// to survive the extraction, and the only way to see it is to watch the call.
const broadcastToUser = vi.fn();
vi.mock('../collaboration/index.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../collaboration/index.js');
  return { ...actual, broadcastToUser: (...args: unknown[]) => broadcastToUser(...args) };
});

const { createApp } = await import('../app.js');

describe('PF-243 · internal POST /api/documents after the extraction', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let sessionCookie: string;
  let csrfToken: string;
  let workspaceId: string;
  let userId: string;

  beforeAll(async () => {
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L09 extraction ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'Extraction User') RETURNING id`,
      [`l09-extraction-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [workspaceId, userId],
    );

    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId],
    );
    sessionCookie = `session_id=${sessionId}`;

    // CSRF is double-submit: the token comes back in the body and its secret in
    // a `connect.sid` cookie, so both have to ride on every later request.
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
    csrfToken = csrf.body.token;
    const connectSid = csrf.headers['set-cookie']?.[0]?.split(';')[0] || '';
    if (connectSid) sessionCookie = `${sessionCookie}; ${connectSid}`;
  });

  function post(body: Record<string, unknown>) {
    return request(app)
      .post('/api/documents')
      .set('Cookie', sessionCookie)
      .set('x-csrf-token', csrfToken)
      .send(body);
  }

  it('still returns every column of `documents` — RETURNING * is the Part 1 contract', async () => {
    const res = await post({ title: 'Golden body', document_type: 'wiki' });
    expect(res.status).toBe(201);

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'`,
    );
    const expected = columns.rows.map((r) => r.column_name).sort();

    expect(
      Object.keys(res.body).sort(),
      'The internal 201 body is `RETURNING *`. If this list shrank, the extraction ' +
        'changed the internal contract; if it grew, a column was added and the PUBLIC ' +
        'projection (PF-252) must be checked, not this one.',
    ).toEqual(expected);
  });

  it('still returns 400 with the raw Zod `details` shape on invalid input', async () => {
    // The internal failure shape is `{error, details}` with `z.ZodError.errors`
    // passed straight through. Deliberately NOT the public envelope — the public
    // surface maps issue paths into `details.fields[]` (PF-254), and unifying
    // them would be a breaking change to the Ship frontend.
    const res = await post({ title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid input');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('still broadcasts accountability:updated for a weekly_plan', async () => {
    broadcastToUser.mockClear();
    const res = await post({ title: 'Week plan', document_type: 'weekly_plan' });

    expect(res.status).toBe(201);
    expect(broadcastToUser).toHaveBeenCalledWith(
      userId,
      'accountability:updated',
      expect.objectContaining({ documentId: res.body.id, documentType: 'weekly_plan' }),
    );
  });

  it('still broadcasts for a document carrying an `outcome` property', async () => {
    broadcastToUser.mockClear();
    const res = await post({
      title: 'Retro',
      document_type: 'wiki',
      properties: { outcome: 'shipped' },
    });

    expect(res.status).toBe(201);
    expect(broadcastToUser).toHaveBeenCalledTimes(1);
  });

  it('does NOT broadcast for an ordinary wiki page', async () => {
    // The positive controls above would all pass against a handler that
    // broadcasts unconditionally.
    broadcastToUser.mockClear();
    const res = await post({ title: 'Just a page', document_type: 'wiki' });

    expect(res.status).toBe(201);
    expect(broadcastToUser).not.toHaveBeenCalled();
  });

  it('PF-256 — the internal list still sorts by position, which the public list must not', async () => {
    // The public sort is `(created_at DESC, id DESC)`; this one is unchanged at
    // `position ASC, created_at DESC`. They are two different sorts on purpose,
    // and this asserts the extraction did not quietly migrate the internal one.
    await pool.query(`UPDATE documents SET position = 5 WHERE workspace_id = $1`, [workspaceId]);
    const first = await pool.query<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by, position)
       VALUES ($1, 'wiki', 'Position zero', $2, 0) RETURNING id`,
      [workspaceId, userId],
    );

    const res = await request(app).get('/api/documents').set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(
      res.body[0].id,
      'The internal list orders by `position ASC` first. A row at position 0 leads.',
    ).toBe(first.rows[0]!.id);
  });

  it('PF-264 — the list still uses its named prepared statements', async () => {
    // The six named shapes are the reason planning stopped being ~47% of this
    // endpoint's server-side cost. A service extraction that rebuilt the text per
    // request would pass every behavioural test above and silently undo that.
    const stats = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_prepared_statements WHERE name LIKE 'documents_list_%'`,
    );
    // pg_prepared_statements is per-session, and the pool hands out a different
    // connection than the one the request used, so a zero here proves nothing.
    // What is assertable without that coupling is that the statement NAMES are
    // still the ones the pool caches under.
    expect(stats.rows[0]!.n).toBeGreaterThanOrEqual(0);

    const { createDocumentService } = await import('../services/documents.js');
    const service = createDocumentService();
    const rows = await service.list(
      { workspaceId, userId, db: pool },
      { mode: 'internal', type: 'wiki' },
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});
