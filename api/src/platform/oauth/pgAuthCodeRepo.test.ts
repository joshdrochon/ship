/**
 * PF-086 (the migration) and PF-104 (`PgAuthCodeRepo` as a Liskov pair with the
 * in-memory double), against a real database.
 *
 * The pair matters here for the same reason it does in `pgTokenRepo.test.ts`:
 * `InMemoryAuthCodeRepo` is what the authorize handler's unit tests build
 * against, and if it disagrees with Postgres about the CONDITIONAL CONSUME —
 * the one operation the entire single-use guarantee rests on — every unit test
 * passes and code replay works in production. The contract block runs the same
 * assertions against both.
 *
 * Also asserts the schema facts no unit test can see: `ON DELETE RESTRICT` on
 * `app_id`, the `S256` CHECK, `UNIQUE(code_hash)`, the sweeper's index, and the
 * byte-level claim that the raw code is in no column.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import { PgOAuthAppRepo } from '../apps/pg-repo.js';
import { secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { PgAuthCodeRepo } from './pgAuthCodeRepo.js';
import {
  InMemoryAuthCodeRepo,
  generateAuthorizationCode,
  hashAuthorizationCode,
  authorizationCodePrefix,
  type IAuthCodeRepo,
  type InsertAuthorizationCodeInput,
} from './authCodes.js';

const GRANTED: Scope[] = ['documents:read', 'issues:read'];
const REDIRECT_URI = 'https://app.example.test/callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

let workspaceId: string;
let ownerId: string;
let app: OAuthApp;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L04 test workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l04-owner@ship.local', 'L04 Test') RETURNING id`,
  );
  ownerId = user.rows[0]!.id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_authorization_codes');
  await pool.query('DELETE FROM oauth_tokens');
  await pool.query('DELETE FROM oauth_apps');
  app = await new PgOAuthAppRepo(pool).create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L04 auth-code app',
    ownerUserId: ownerId,
    workspaceId,
    redirectUris: [REDIRECT_URI],
    requestedScopes: GRANTED,
  });
});

function input(overrides: Partial<InsertAuthorizationCodeInput> = {}): InsertAuthorizationCodeInput {
  const code = generateAuthorizationCode();
  return {
    codeHash: hashAuthorizationCode(code),
    codePrefix: authorizationCodePrefix(code),
    appId: app.id,
    userId: ownerId,
    workspaceId,
    redirectUri: REDIRECT_URI,
    scopes: GRANTED,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...overrides,
  };
}

describe('PF-086 — the migration', () => {
  it('applied, and the table exists with the columns the ticket names', async () => {
    const result = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'oauth_authorization_codes'`,
    );
    const columns = new Map(result.rows.map((r) => [r.column_name, r.is_nullable]));
    for (const name of [
      'id', 'code_hash', 'code_prefix', 'app_id', 'user_id', 'workspace_id',
      'redirect_uri', 'scopes', 'code_challenge', 'code_challenge_method',
      'expires_at', 'consumed_at', 'created_at',
    ]) {
      expect(columns.has(name), `missing column ${name}`).toBe(true);
    }
    // PF-090's structural half: the challenge is NOT NULL precisely so no
    // `if (challenge)` branch that skips PKCE can ever be justified (PF-103).
    expect(columns.get('code_challenge')).toBe('NO');
    expect(columns.get('code_challenge_method')).toBe('NO');
    expect(columns.get('redirect_uri')).toBe('NO');
    expect(columns.get('scopes')).toBe('NO');
    expect(columns.get('expires_at')).toBe('NO');
    // Only consumed_at is nullable — NULL means unredeemed.
    expect(columns.get('consumed_at')).toBe('YES');
  });

  it('app_id is ON DELETE RESTRICT, matching PF-031 on a deleted owner', async () => {
    const result = await pool.query<{ delete_rule: string; column_name: string }>(
      `SELECT rc.delete_rule, kcu.column_name
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'oauth_authorization_codes'`,
    );
    const appIdRule = result.rows.find((r) => r.column_name === 'app_id');
    expect(appIdRule?.delete_rule).toBe('RESTRICT');

    // And it BITES: an app with a live code cannot be deleted out from under it.
    await new PgAuthCodeRepo(pool).insert(input());
    await expect(pool.query('DELETE FROM oauth_apps WHERE id = $1', [app.id])).rejects.toThrow();
  });

  it('UNIQUE(code_hash) is enforced by the database', async () => {
    const repo = new PgAuthCodeRepo(pool);
    const shared = input();
    await repo.insert(shared);
    await expect(repo.insert(shared)).rejects.toThrow();
  });

  it('the S256 CHECK stops any writer behind the endpoint from inserting plain', async () => {
    const repo = new PgAuthCodeRepo(pool);
    await expect(repo.insert(input({ codeChallengeMethod: 'plain' }))).rejects.toThrow();
  });

  it('the sweeper has its index on (expires_at)', async () => {
    const result = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'oauth_authorization_codes'`,
    );
    expect(result.rows.some((r) => /\(expires_at\)/.test(r.indexdef))).toBe(true);
  });

  it('the raw code is in no column of the row', async () => {
    const code = generateAuthorizationCode();
    await new PgAuthCodeRepo(pool).insert(
      input({ codeHash: hashAuthorizationCode(code), codePrefix: authorizationCodePrefix(code) }),
    );
    // Cast the entire row to text and search it. Catches a column added by a
    // later migration that someone populated with the code.
    const result = await pool.query<{ whole: string }>(
      `SELECT oauth_authorization_codes::text AS whole FROM oauth_authorization_codes`,
    );
    expect(result.rows[0]!.whole).not.toContain(code);
    expect(result.rows[0]!.whole).toContain(code.slice(0, 8));
  });
});

/**
 * The same assertions against both backends. A divergence here is a bug in one
 * of them, and the in-memory double is the one every unit test in this lane
 * builds on.
 */
describe.each<[string, () => IAuthCodeRepo]>([
  ['PgAuthCodeRepo', () => new PgAuthCodeRepo(pool)],
  ['InMemoryAuthCodeRepo', () => new InMemoryAuthCodeRepo()],
])('IAuthCodeRepo contract — %s', (_name, make) => {
  let repo: IAuthCodeRepo;
  beforeEach(() => {
    repo = make();
  });

  it('insert then findByHash round-trips every field', async () => {
    const written = input();
    const row = await repo.insert(written);
    const found = await repo.findByHash(written.codeHash);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(row.id);
    expect(found!.redirectUri).toBe(REDIRECT_URI);
    expect(found!.scopes).toEqual(GRANTED);
    expect(found!.codeChallenge).toBe(CHALLENGE);
    expect(found!.codeChallengeMethod).toBe('S256');
    expect(found!.consumedAt).toBeNull();
  });

  it('findByHash returns null for an unknown hash', async () => {
    expect(await repo.findByHash('0'.repeat(64))).toBeNull();
  });

  it('consume succeeds exactly once — the single-use guarantee', async () => {
    const row = await repo.insert(input());
    expect(await repo.consume(row.id, new Date())).toBe(true);
    expect(await repo.consume(row.id, new Date())).toBe(false);
  });

  it('a consumed row is still findable, so a replay is detectable', async () => {
    const written = input();
    const row = await repo.insert(written);
    await repo.consume(row.id, new Date());
    const found = await repo.findByHash(written.codeHash);
    expect(found?.consumedAt).not.toBeNull();
  });

  it('deleteSwept removes expired-unconsumed and aged-consumed, and nothing else', async () => {
    const now = Date.now();
    const expired = input({ expiresAt: new Date(now - 10_000) });
    const live = input({ expiresAt: new Date(now + 600_000) });
    const aged = input({ expiresAt: new Date(now - 10_000) });
    const fresh = input({ expiresAt: new Date(now - 10_000) });

    await repo.insert(expired);
    await repo.insert(live);
    const agedRow = await repo.insert(aged);
    const freshRow = await repo.insert(fresh);
    await repo.consume(agedRow.id, new Date(now - 7_200_000));
    await repo.consume(freshRow.id, new Date(now - 1_000));

    const removed = await repo.deleteSwept(new Date(now), new Date(now - 3_600_000));
    expect(removed).toBe(2);
    expect(await repo.findByHash(expired.codeHash)).toBeNull();
    expect(await repo.findByHash(aged.codeHash)).toBeNull();
    expect(await repo.findByHash(live.codeHash)).not.toBeNull();
    expect(await repo.findByHash(fresh.codeHash)).not.toBeNull();
  });

  it('transaction hands the callback a repo bound to the same unit of work', async () => {
    const written = input();
    const id = await repo.transaction(async (tx) => {
      const row = await tx.insert(written);
      expect(await tx.consume(row.id, new Date())).toBe(true);
      return row.id;
    });
    const found = await repo.findByHash(written.codeHash);
    expect(found?.id).toBe(id);
    expect(found?.consumedAt).not.toBeNull();
  });
});

describe('PF-104 — concurrent redemption, against the engine whose guarantee it is', () => {
  it('two simultaneous consumes of one code produce exactly one success', async () => {
    // In-memory cannot prove this: single-threaded JavaScript serialises the
    // callbacks for free, which would demonstrate nothing about Postgres. This
    // runs against the real row lock.
    const repo = new PgAuthCodeRepo(pool);
    const row = await repo.insert(input());

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repo.transaction((tx) => tx.consume(row.id, new Date())),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(7);
  });
});
