/**
 * PF-151 (the migration) and PF-154 (`PgTokenRepo` as a Liskov pair with the
 * in-memory double), against a real database.
 *
 * The pair matters more here than it usually does. `InMemoryTokenRepo` is what
 * L04, L05 and this lane's own unit tests build against; if it disagrees with
 * Postgres about the CONDITIONAL SPEND — the one operation the entire theft
 * signal rests on — every one of those tests passes and rotation is broken in
 * production. The contract block below runs the same assertions against both.
 *
 * Also asserts the schema facts PF-151 specifies that no unit test can see: the
 * CHECK on `token_type`, the self-referencing FK, `ON DELETE RESTRICT` on
 * `app_id`, and the byte-level claim that the raw token is in no column.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { scanTree } from '../../test/sourceScan.js';
import { pool } from '../../db/client.js';
import { FakeClock } from '../clock.js';
import { PgOAuthAppRepo } from '../apps/pg-repo.js';
import { secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { PgTokenRepo } from './pgTokenRepo.js';
import { InMemoryTokenRepo, type ITokenRepo } from './tokenRepo.js';
import { issueTokenPair } from './issue.js';
import { resolveToken } from './resolve.js';
import { DEFAULT_TOKEN_TTL, generateAccessToken, hashToken, tokenPrefix, newFamilyId } from './tokens.js';

const GRANTED: Scope[] = ['documents:read', 'issues:read'];

let workspaceId: string;
let ownerId: string;
let app: OAuthApp;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L06 test workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l06-owner@ship.local', 'L06 Test') RETURNING id`,
  );
  ownerId = user.rows[0]!.id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_tokens');
  await pool.query('DELETE FROM oauth_apps');
  app = await new PgOAuthAppRepo(pool).create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L06 Pg test app',
    ownerUserId: ownerId,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'documents:write', 'issues:read'],
  });
});

function baseInput(familyId = newFamilyId()) {
  const access = generateAccessToken();
  const refresh = generateAccessToken();
  const now = new Date('2026-08-12T00:00:00.000Z');
  return {
    raw: { access, refresh },
    input: {
      familyId,
      appId: app.id,
      userId: ownerId,
      workspaceId,
      scopes: GRANTED,
      accessTokenHash: hashToken(access),
      accessTokenPrefix: tokenPrefix(access),
      accessExpiresAt: new Date(now.getTime() + 3600_000),
      refreshTokenHash: hashToken(refresh),
      refreshTokenPrefix: tokenPrefix(refresh),
      refreshExpiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
    },
  };
}

describe('PF-151: the schema facts no unit test can see', () => {
  it('rejects a third token_type at the CHECK constraint', async () => {
    const { input } = baseInput();
    await expect(
      pool.query(
        `INSERT INTO oauth_tokens (token_hash, token_prefix, token_type, family_id, app_id,
           workspace_id, scopes, expires_at)
         VALUES ($1, $2, 'id_token', $3, $4, $5, $6::text[], $7)`,
        [
          input.accessTokenHash,
          input.accessTokenPrefix,
          input.familyId,
          app.id,
          workspaceId,
          GRANTED,
          input.accessExpiresAt,
        ],
      ),
    ).rejects.toThrow(/oauth_tokens_token_type_check|violates check constraint/);
  });

  it('holds the self-referencing FK on replaces_token_id', async () => {
    const { input } = baseInput();
    await expect(
      pool.query(
        `INSERT INTO oauth_tokens (token_hash, token_prefix, token_type, family_id, app_id,
           workspace_id, scopes, expires_at, replaces_token_id)
         VALUES ($1, $2, 'access', $3, $4, $5, $6::text[], $7, '00000000-0000-4000-8000-000000000000')`,
        [
          input.accessTokenHash,
          input.accessTokenPrefix,
          input.familyId,
          app.id,
          workspaceId,
          GRANTED,
          input.accessExpiresAt,
        ],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('refuses to delete an app that still has tokens (ON DELETE RESTRICT)', async () => {
    await new PgTokenRepo(pool).insertPair(baseInput().input);
    await expect(pool.query('DELETE FROM oauth_apps WHERE id = $1', [app.id])).rejects.toThrow(
      /violates foreign key constraint/i,
    );
  });

  it('rejects a duplicate token_hash', async () => {
    const { input } = baseInput();
    await new PgTokenRepo(pool).insertPair(input);
    await expect(new PgTokenRepo(pool).insertPair(input)).rejects.toThrow(/duplicate key/i);
  });

  it('rejects a revoked_at with no reason (the coherence CHECK)', async () => {
    const { access } = await new PgTokenRepo(pool).insertPair(baseInput().input);
    await expect(
      pool.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1`, [access.id]),
    ).rejects.toThrow(/oauth_tokens_revocation_coherent|violates check constraint/);
  });
});

describe('PF-152: the raw token is in NO column', () => {
  it('survives a byte scan of every text column of the written rows', async () => {
    const clock = new FakeClock(Date.parse('2026-08-12T00:00:00.000Z'));
    const repo = new PgTokenRepo(pool);
    const { response } = await issueTokenPair(
      { tokenRepo: repo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app, userId: ownerId, scopes: GRANTED },
    );

    // Every column, cast to text, concatenated. If the raw value is anywhere in
    // the row — in a column this test does not know the name of, added by a
    // later migration — it shows up here.
    const dumped = await pool.query<{ everything: string }>(
      `SELECT oauth_tokens::text AS everything FROM oauth_tokens`,
    );
    expect(dumped.rows.length).toBe(2);
    for (const row of dumped.rows) {
      expect(row.everything).not.toContain(response.access_token);
      expect(row.everything).not.toContain(response.refresh_token);
      // The tagless body too, in case a column stored it stripped.
      expect(row.everything).not.toContain(response.access_token.slice(8));
      expect(row.everything).not.toContain(response.refresh_token.slice(8));
    }
  });
});

describe('PF-154: PgTokenRepo and InMemoryTokenRepo are a Liskov pair', () => {
  const backends: [string, () => ITokenRepo][] = [
    ['PgTokenRepo', () => new PgTokenRepo(pool)],
    ['InMemoryTokenRepo', () => new InMemoryTokenRepo()],
  ];

  for (const [name, make] of backends) {
    describe(name, () => {
      it('returns null for an unknown hash', async () => {
        expect(await make().findByHash(hashToken('nothing'))).toBeNull();
      });

      it('marks a token spent exactly once — the second call is false', async () => {
        const repo = make();
        const { refresh } = await repo.insertPair(baseInput().input);
        const at = new Date('2026-08-12T01:00:00.000Z');
        expect(await repo.markSpent(refresh.id, at)).toBe(true);
        expect(await repo.markSpent(refresh.id, at)).toBe(false);
      });

      it('returns false rather than throwing for an unknown token id', async () => {
        const repo = make();
        // A UUID that is well-formed but absent. The in-memory double uses
        // string ids, so this is "absent" for both backends.
        expect(await repo.markSpent('00000000-0000-4000-8000-000000000000', new Date())).toBe(false);
      });

      it('revokes every token in a family regardless of type or spent state', async () => {
        const repo = make();
        const familyId = newFamilyId();
        const { input } = baseInput(familyId);
        const { refresh } = await repo.insertPair(input);
        await repo.markSpent(refresh.id, new Date('2026-08-12T01:00:00.000Z'));

        const count = await repo.revokeFamily(
          familyId,
          'refresh_token_reuse',
          new Date('2026-08-12T02:00:00.000Z'),
        );
        expect(count).toBe(2);

        const family = await repo.listFamily(familyId);
        expect(family).toHaveLength(2);
        for (const row of family) {
          expect(row.revokedAt).not.toBeNull();
          expect(row.revocationReason).toBe('refresh_token_reuse');
        }
      });

      it('lists a family oldest first', async () => {
        const repo = make();
        const familyId = newFamilyId();
        await repo.insertPair(baseInput(familyId).input);
        const family = await repo.listFamily(familyId);
        expect(family.map((r) => r.tokenType).sort()).toEqual(['access', 'refresh']);
      });

      it('deletes only rows already past expiry', async () => {
        const repo = make();
        await repo.insertPair(baseInput().input);
        // Access expires at +1h, refresh at +24h.
        const deleted = await repo.deleteExpired(new Date('2026-08-12T02:00:00.000Z'));
        expect(deleted).toBe(1);
      });

      it('runs a callback inside transaction() and returns its value', async () => {
        const repo = make();
        const result = await repo.transaction(async (tx) => {
          await tx.insertPair(baseInput().input);
          return 'done';
        });
        expect(result).toBe('done');
      });
    });
  }
});

describe('PF-170: the transaction really rolls back (Postgres only)', () => {
  it('leaves no rows behind when the callback throws', async () => {
    const repo = new PgTokenRepo(pool);
    await expect(
      repo.transaction(async (tx) => {
        await tx.insertPair(baseInput().input);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const remaining = await pool.query<{ count: string }>('SELECT count(*) FROM oauth_tokens');
    expect(Number(remaining.rows[0]!.count)).toBe(0);
  });
});

describe('PF-156: D2 end to end, against Postgres', () => {
  it('401-worthy: a token minted before deactivation stops resolving after it', async () => {
    const clock = new FakeClock(Date.parse('2026-08-12T00:00:00.000Z'));
    const tokenRepo = new PgTokenRepo(pool);
    const appsRepo = new PgOAuthAppRepo(pool);
    const { response } = await issueTokenPair(
      { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
      { app, userId: ownerId, scopes: GRANTED },
    );

    expect((await resolveToken({ tokenRepo, appsRepo, clock }, response.access_token)).ok).toBe(true);

    const deactivated = await appsRepo.deactivateByOwner(ownerId, new Date(clock.nowMs()));
    expect(deactivated).toBeGreaterThanOrEqual(1);

    expect(await resolveToken({ tokenRepo, appsRepo, clock }, response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('PF-154: the composition root is the only construction site', () => {
  it('constructs PgTokenRepo nowhere but productionDeps()', () => {
    const offenders = scanTree(join(process.cwd(), 'src'))
      // `deps.ts` IS the composition root — the one allowed site.
      .filter((f) => !f.path.endsWith(join('src', 'deps.ts')))
      // Comments are stripped, so the prose in `tokenRepo.ts` explaining this
      // very rule does not count as a violation of it.
      .filter((f) => f.code.includes('new PgTokenRepo('))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });
});
