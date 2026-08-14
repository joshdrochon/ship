/**
 * L07 PF-194 — the public envelope did NOT leak into the internal `/api` surface.
 *
 * Finding F5: the internal surface has no error middleware at all. Roughly 400
 * `res.status(…).json({ error: '…' })` call sites across `api/src/routes/*.ts`
 * do it inline, and they do not even agree with each other — `documents.ts`
 * answers `{error: 'Internal server error'}` while `setup.ts` answers
 * `{success: false, error: {code, message}}`. That inconsistency is Part 1's and
 * is deliberately left alone: the UI is written against it, and "improving" it
 * is a breaking change to a working contract, not a refactor.
 *
 * So the assertion is negative and it is the important half of the one-way door
 * (PRD p.11): mounting `apiErrorMiddleware` app-wide would silently restyle
 * every one of those 400 responses into the public envelope. This test is what
 * makes that mistake fail loudly.
 *
 * These run against the real app and a real database, hence the DB setup.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';

describe('PF-194 — internal /api keeps its own error shapes, byte for byte', () => {
  const app = createApp();
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let workspaceId: string;
  let userId: string;
  let sessionCookie: string;

  beforeAll(async () => {
    const workspace = await pool.query(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
      `L07 Internal Shape ${runId}`,
    ]);
    workspaceId = workspace.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', 'L07 Test User') RETURNING id`,
      [`l07-internal-${runId}@ship.local`],
    );
    userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId],
    );
    sessionCookie = `session_id=${sessionId}`;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM workspace_memberships WHERE workspace_id = $1', [workspaceId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  });

  it('a real internal 500 is still exactly { error: "Internal server error" }', async () => {
    // A non-UUID id makes Postgres reject the comparison, the route's catch
    // block runs, and we get the legacy body. A genuine 500 from a real route —
    // not a synthetic throw.
    const res = await request(app)
      .get('/api/documents/not-a-uuid')
      .set('Cookie', sessionCookie)
      .expect(500);

    expect(res.body).toEqual({ error: 'Internal server error' });
    // The public envelope's keys must be nowhere in sight.
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('request_id');
    expect(res.headers['x-request-id']).toBeUndefined();
  });

  it('an internal 401 keeps the internal shape too', async () => {
    const res = await request(app).get('/api/documents').expect(401);

    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('request_id');
    expect(res.headers['x-request-id']).toBeUndefined();
  });

  it('the internal app mounts no error-handling middleware at all (F5)', () => {
    // The structural half: if someone adds an app-level error handler, the two
    // request-level assertions above might still pass while every other internal
    // route quietly changes shape. Express marks error middleware by arity 4.
    const stack = (app as unknown as { _router?: { stack: { handle: { length: number } }[] } })
      ._router?.stack;
    expect(stack, 'could not read the Express router stack').toBeDefined();

    const errorHandlers = (stack ?? []).filter((layer) => layer.handle?.length === 4);
    expect(
      errorHandlers.length,
      'an error handler appeared on the internal app — that restyles ~400 inline responses',
    ).toBe(0);
  });
});
