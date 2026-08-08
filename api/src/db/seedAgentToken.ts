import crypto from 'crypto';
// `QueryRunner`, not `pg.Pool`: this function only ever calls `.query`, and the
// exported `pool` is the `Database` wrapper that adds connect-retry rather than a
// raw Pool. Typing the parameter to the narrowest interface it actually uses is
// what the wrapper's own header asks for — widen here and every call site has to
// hand over a real Pool it doesn't have.
import type { QueryRunner } from './client.js';

/**
 * Seed the FleetGraph agent's Ship API token.
 *
 * The agent authenticates to Ship's own HTTP API with SHIP_API_TOKEN, which
 * `auth.ts:98` validates against a row in `api_tokens`. Nothing created that
 * row. It was made by hand, once, against a database that no longer exists.
 *
 * The destroy-and-redeploy cycle is what exposed it. Terraform rebuilt every
 * resource, the app booted, migrate and seed ran, `/health` and `/ready` both
 * came back green — and the cron still exited 1 on every run, because the
 * agent's first write returned 401 `Invalid or expired API token`. The graph
 * was healthy throughout: it scanned, measured five signals and judged them
 * against a real provider before failing at delivery. What was missing was a
 * database row that lived outside both Terraform and the code.
 *
 * That is the difference between "the infrastructure is reproducible" and "the
 * environment is reproducible", and the brief (p.3) asks for the second one.
 *
 * Lives in its own module rather than inside seed.ts because seed.ts calls
 * `seed()` at import time — a test that imported it would run the entire seed
 * as a side effect.
 */

/** Name is the conflict key together with (user_id, workspace_id). */
export const AGENT_TOKEN_NAME = 'FleetGraph agent';

export function hashApiToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export type SeedAgentTokenResult =
  | { seeded: true }
  | { seeded: false; reason: 'no_token' | 'no_user' };

export async function seedAgentApiToken(
  pool: QueryRunner,
  workspaceId: string,
  token: string | undefined,
  userEmail = 'dev@ship.local'
): Promise<SeedAgentTokenResult> {
  // No SHIP_API_TOKEN, no row. Local dev and the test suite stay untouched.
  if (!token) return { seeded: false, reason: 'no_token' };

  const user = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [
    userEmail,
  ]);
  if (!user.rows[0]) return { seeded: false, reason: 'no_user' };

  // ON CONFLICT against UNIQUE(user_id, workspace_id, name) from
  // 014_api_tokens.sql. Reseeding is a no-op; rotating the secret rewrites the
  // hash rather than leaving a second live token under the same name.
  //
  // `revoked_at` is cleared deliberately: without it, a rotation would write a
  // fresh hash onto a revoked row and auth.ts would keep refusing the token
  // while the seed log claimed success.
  //
  // `scopes` is left NULL. Migration 038 added the column so an agent token CAN
  // be read-only (Q3, Q29), and NULL means unscoped — exactly what the
  // hand-made token had. Restoring parity is the point, and a read-only token
  // would break the agent, which posts comments. Narrowing scope is a separate
  // decision from making the environment rebuildable.
  await pool.query(
    `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, workspace_id, name)
     DO UPDATE SET token_hash   = EXCLUDED.token_hash,
                   token_prefix = EXCLUDED.token_prefix,
                   revoked_at   = NULL`,
    [user.rows[0].id, workspaceId, AGENT_TOKEN_NAME, hashApiToken(token), token.slice(0, 8)]
  );

  return { seeded: true };
}
