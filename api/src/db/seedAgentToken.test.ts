import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from './client.js';
import { seedAgentApiToken, hashApiToken, AGENT_TOKEN_NAME } from './seedAgentToken.js';

/**
 * The bug these cover.
 *
 * `SHIP_API_TOKEN` is validated against a row in `api_tokens` (auth.ts:98), and
 * for the life of this project that row was made by hand. The
 * destroy-and-redeploy cycle destroyed the database it lived in, and the
 * rebuilt environment came back with /health and /ready green while the cron
 * exited 1 on every run — 401 on the agent's first write.
 *
 * Nothing caught it, because nothing had ever rebuilt the database from scratch
 * before. These tests are what would have.
 */
describe('seedAgentApiToken', () => {
  let workspaceId: string;
  let userId: string;

  // Created once, not per test: `users.email` is globally unique, and the shared
  // setup truncates per FILE rather than per test (api/src/test/setup.ts), so a
  // per-test insert of dev@ship.local collides with itself on the second case.
  beforeAll(async () => {
    const ws = await pool.query(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      ['token-seed-test']
    );
    workspaceId = ws.rows[0].id;

    const user = await pool.query(
      `INSERT INTO users (email, password_hash, name, last_workspace_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['dev@ship.local', 'x', 'Dev', workspaceId]
    );
    userId = user.rows[0].id;
  });

  // The rows under test, cleared between cases so each starts from no token.
  beforeEach(async () => {
    await pool.query('DELETE FROM api_tokens WHERE user_id = $1', [userId]);
  });

  const rows = () =>
    pool.query(
      `SELECT token_hash, token_prefix, revoked_at, scopes FROM api_tokens
       WHERE user_id = $1 AND workspace_id = $2 AND name = $3`,
      [userId, workspaceId, AGENT_TOKEN_NAME]
    );

  it('creates a token the API would accept', async () => {
    const result = await seedAgentApiToken(pool, workspaceId, 'ship_abcdef0123456789');
    expect(result).toEqual({ seeded: true });

    const { rows: got } = await rows();
    expect(got).toHaveLength(1);
    // The hash is what auth.ts looks up. If this drifts, the agent 401s and the
    // seed log still says success — the exact failure mode in production.
    expect(got[0].token_hash).toBe(hashApiToken('ship_abcdef0123456789'));
    expect(got[0].token_prefix).toBe('ship_abc');
  });

  it('is idempotent — reseeding leaves exactly one row', async () => {
    await seedAgentApiToken(pool, workspaceId, 'ship_abcdef0123456789');
    await seedAgentApiToken(pool, workspaceId, 'ship_abcdef0123456789');

    const { rows: got } = await rows();
    expect(got).toHaveLength(1);
  });

  it('rotates the hash rather than adding a second live token', async () => {
    await seedAgentApiToken(pool, workspaceId, 'ship_old00000000000');
    await seedAgentApiToken(pool, workspaceId, 'ship_new00000000000');

    const { rows: got } = await rows();
    expect(got).toHaveLength(1);
    expect(got[0].token_hash).toBe(hashApiToken('ship_new00000000000'));
    expect(got[0].token_hash).not.toBe(hashApiToken('ship_old00000000000'));
  });

  it('revives a revoked row on rotation', async () => {
    await seedAgentApiToken(pool, workspaceId, 'ship_abcdef0123456789');
    await pool.query(
      `UPDATE api_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND workspace_id = $2 AND name = $3`,
      [userId, workspaceId, AGENT_TOKEN_NAME]
    );

    await seedAgentApiToken(pool, workspaceId, 'ship_abcdef0123456789');

    const { rows: got } = await rows();
    // Without the explicit `revoked_at = NULL`, this row keeps a revocation
    // timestamp, auth.ts refuses the token, and the seed reports success.
    expect(got[0].revoked_at).toBeNull();
  });

  it('leaves scopes NULL so the agent keeps write access', async () => {
    await seedAgentApiToken(pool, workspaceId, 'ship_abcdef0123456789');

    const { rows: got } = await rows();
    // Migration 038 allows a read-only agent token. NULL is unscoped, which is
    // what the hand-made token had — and the agent posts comments, so a
    // read-only token here would reintroduce the 401 under a different cause.
    expect(got[0].scopes).toBeNull();
  });

  it('does nothing when SHIP_API_TOKEN is unset', async () => {
    const result = await seedAgentApiToken(pool, workspaceId, undefined);
    expect(result).toEqual({ seeded: false, reason: 'no_token' });

    const { rows: got } = await rows();
    expect(got).toHaveLength(0);
  });

  it('reports rather than throws when the seed user is absent', async () => {
    const result = await seedAgentApiToken(
      pool,
      workspaceId,
      'ship_abcdef0123456789',
      'nobody@ship.local'
    );
    expect(result).toEqual({ seeded: false, reason: 'no_user' });
  });
});
