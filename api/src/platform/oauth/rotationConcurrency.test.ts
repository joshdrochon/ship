/**
 * PF-170 — rotation is one transaction, and the conditional spend is
 * authoritative under real concurrency.
 *
 * THIS TEST MUST RUN AGAINST POSTGRES AND CANNOT BE MOVED IN-MEMORY. Node is
 * single-threaded, so `InMemoryTokenRepo` serializes the ten callbacks for free
 * and would report a confident green while proving nothing. The guarantee under
 * test is the DATABASE's: that ten transactions issuing
 * `UPDATE … WHERE spent_at IS NULL` against one row yield exactly one winner.
 *
 * L17's PF-509 promises the SDK issues exactly one refresh under ten concurrent
 * expired calls. That promise is only worth what the server does when a client
 * does NOT keep it — single-flight is an optimization on the client side and a
 * correctness requirement on this one.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import { FakeClock } from '../clock.js';
import { PgOAuthAppRepo } from '../apps/pg-repo.js';
import { secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/registry.js';
import { PgTokenRepo } from './pgTokenRepo.js';
import { issueTokenPair } from './issue.js';
import { resolveToken } from './resolve.js';
import { DEFAULT_TOKEN_TTL, hashToken } from './tokens.js';
import { rotateRefreshToken, clearReplayCache } from './rotation.js';

const GRANTED: Scope[] = ['documents:read', 'issues:read'];

let workspaceId: string;
let ownerId: string;
let app: OAuthApp;
let clock: FakeClock;
let tokenRepo: PgTokenRepo;
let appsRepo: PgOAuthAppRepo;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L06 concurrency workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l06-concurrency@ship.local', 'L06') RETURNING id`,
  );
  ownerId = user.rows[0]!.id;
});

beforeEach(async () => {
  clearReplayCache();
  await pool.query('DELETE FROM oauth_tokens');
  await pool.query('DELETE FROM oauth_apps');
  clock = new FakeClock(Date.parse('2026-08-12T00:00:00.000Z'));
  tokenRepo = new PgTokenRepo(pool);
  appsRepo = new PgOAuthAppRepo(pool);
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L06 concurrency app',
    ownerUserId: ownerId,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'documents:write', 'issues:read'],
  });
});

describe('PF-170: ten simultaneous exchanges of one R1', () => {
  it('yields exactly one new pair and exactly one family revocation', async () => {
    const g1 = await issueTokenPair(
      { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app, userId: ownerId, scopes: GRANTED },
    );

    // Fired concurrently, not sequentially. Sequential calls would pass even a
    // read-then-write implementation, which is exactly the bug this guards.
    const attempts = Array.from({ length: 10 }, () =>
      rotateRefreshToken(
        { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL, replayWindowMs: 0 },
        { app, presentedToken: g1.response.refresh_token },
      ),
    );
    const results = await Promise.all(attempts);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    expect(winners, 'exactly one exchange may succeed').toHaveLength(1);
    expect(losers).toHaveLength(9);

    // Exactly one family revocation is RECORDED — the losers all attempt it,
    // but `WHERE revoked_at IS NULL` means only the first one changes any rows.
    const revoked = await pool.query<{ count: string }>(
      `SELECT count(DISTINCT revocation_reason) AS count
         FROM oauth_tokens
        WHERE family_id = $1 AND revocation_reason = 'refresh_token_reuse'`,
      [g1.familyId],
    );
    expect(Number(revoked.rows[0]!.count)).toBe(1);

    // Every token in the family carries a revocation — including the pair the
    // winner just issued. The row lock is what makes this ordering hold: the
    // losers block inside the spend and resume only after the winner commits,
    // so the new pair is already in the family when they sweep it.
    const family = await tokenRepo.listFamily(g1.familyId);
    expect(family.length).toBe(4); // R1, A1, R2, A2
    for (const row of family) {
      expect(row.revokedAt, `${row.tokenType} ${row.tokenPrefix} should be revoked`).not.toBeNull();
    }

    // And the winner's access token really is dead on the wire.
    const winner = winners[0]!;
    if (!winner.ok) return;
    expect(await resolveToken({ tokenRepo, appsRepo, clock }, winner.response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('never leaves a live access token with no refresh partner', async () => {
    const g1 = await issueTokenPair(
      { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app, userId: ownerId, scopes: GRANTED },
    );

    await Promise.all(
      Array.from({ length: 10 }, () =>
        rotateRefreshToken(
          { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL, replayWindowMs: 0 },
          { app, presentedToken: g1.response.refresh_token },
        ),
      ),
    );

    // Pairs are written by one multi-row INSERT inside one transaction, so the
    // counts must match exactly. An odd number here would mean a half-applied
    // pair survived a rollback.
    const counts = await pool.query<{ token_type: string; count: string }>(
      `SELECT token_type, count(*) AS count FROM oauth_tokens
        WHERE family_id = $1 GROUP BY token_type`,
      [g1.familyId],
    );
    const byType = Object.fromEntries(counts.rows.map((r) => [r.token_type, Number(r.count)]));
    expect(byType.access).toBe(byType.refresh);
  });

  it('a rollback mid-rotation leaves the presented token UNSPENT', async () => {
    // The transaction boundary is real, not decorative: if the insert fails the
    // spend must not stick, or a user loses their session to a transient error.
    const g1 = await issueTokenPair(
      { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app, userId: ownerId, scopes: GRANTED },
    );
    const r1Hash = hashToken(g1.response.refresh_token);

    await expect(
      tokenRepo.transaction(async (tx) => {
        const row = await tx.findByHash(r1Hash);
        expect(await tx.markSpent(row!.id, new Date(clock.nowMs()))).toBe(true);
        throw new Error('simulated failure after the spend');
      }),
    ).rejects.toThrow('simulated failure');

    const after = await tokenRepo.findByHash(r1Hash);
    expect(after!.spentAt, 'the spend must roll back with everything else').toBeNull();

    // And it still rotates normally afterwards.
    const result = await rotateRefreshToken(
      { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app, presentedToken: g1.response.refresh_token },
    );
    expect(result.ok).toBe(true);
  });
});
