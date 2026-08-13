/**
 * PF-121 (the migration) and PF-130/PF-140 (`PgDeviceCodeRepo` as a Liskov pair
 * with the in-memory double), against a real database.
 *
 * The pair matters here for `pgAuthCodeRepo.test.ts`'s reason:
 * `InMemoryDeviceCodeRepo` is what the endpoint's unit tests build against, and
 * if it disagrees with Postgres about the CONDITIONAL WRITES — the operations
 * the single-approval and single-redemption guarantees rest on — every unit
 * test passes and a device code mints two token pairs in production. The
 * contract block runs the same assertions against both.
 *
 * Also asserts the schema facts no unit test can see: `ON DELETE RESTRICT` on
 * `app_id`, the status CHECK, the approved-has-user CHECK, both UNIQUE
 * constraints, the sweeper's index, and the byte-level claim that the raw
 * device code is in no column while the `user_code` deliberately is.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import { PgOAuthAppRepo } from '../apps/pg-repo.js';
import { secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { PgDeviceCodeRepo } from './pgDeviceCodeRepo.js';
import {
  InMemoryDeviceCodeRepo,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  normalizeUserCode,
  DEVICE_POLL_INTERVAL_SECONDS,
  type IDeviceCodeRepo,
  type InsertDeviceCodeInput,
} from './deviceCodes.js';

const SCOPES: Scope[] = ['documents:read', 'issues:read'];

let workspaceId: string;
let ownerId: string;
let app: OAuthApp;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L05 test workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l05-owner@ship.local', 'L05 Test') RETURNING id`,
  );
  ownerId = user.rows[0]!.id;

  app = await new PgOAuthAppRepo(pool).create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L05 device app',
    ownerUserId: ownerId,
    workspaceId,
    redirectUris: ['https://app.example.test/callback'],
    requestedScopes: SCOPES,
  });
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_device_codes');
});

function input(over: Partial<InsertDeviceCodeInput> = {}): InsertDeviceCodeInput {
  return {
    deviceCodeHash: hashDeviceCode(generateDeviceCode()),
    userCode: generateUserCode(),
    appId: app.id,
    scopes: SCOPES,
    intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    expiresAt: new Date(Date.now() + 600_000),
    createdAt: new Date(),
    ...over,
  };
}

describe('PF-121: the schema facts no unit test can see', () => {
  it('applies against a clean database and exposes the declared columns', async () => {
    const cols = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'oauth_device_codes'`,
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r.is_nullable]));

    for (const required of [
      'id',
      'device_code_hash',
      'user_code',
      'app_id',
      'scopes',
      'status',
      'interval_seconds',
      'expires_at',
      'created_at',
    ]) {
      expect(byName.get(required), `${required} must exist and be NOT NULL`).toBe('NO');
    }
    // Null until approval — that is the pending state, and it is the whole
    // reason a device grant differs from an authorization code.
    for (const nullable of ['user_id', 'workspace_id', 'last_polled_at', 'consumed_at']) {
      expect(byName.get(nullable), `${nullable} must be nullable`).toBe('YES');
    }
  });

  it('CHECK-constrains status to exactly three values — a fourth is rejected', async () => {
    const row = await new PgDeviceCodeRepo(pool).insert(input());
    await expect(
      pool.query(`UPDATE oauth_device_codes SET status = 'expired' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/oauth_device_codes_status/);
  });

  it('refuses an approved row with no user — the grant would belong to nobody', async () => {
    const row = await new PgDeviceCodeRepo(pool).insert(input());
    await expect(
      pool.query(`UPDATE oauth_device_codes SET status = 'approved' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/oauth_device_codes_approved_has_user/);
  });

  it('fires UNIQUE(device_code_hash)', async () => {
    const repo = new PgDeviceCodeRepo(pool);
    const hash = hashDeviceCode(generateDeviceCode());
    await repo.insert(input({ deviceCodeHash: hash }));
    await expect(repo.insert(input({ deviceCodeHash: hash }))).rejects.toThrow(
      /device_code_hash/,
    );
  });

  it('fires UNIQUE(user_code)', async () => {
    const repo = new PgDeviceCodeRepo(pool);
    const userCode = generateUserCode();
    await repo.insert(input({ userCode }));
    await expect(repo.insert(input({ userCode }))).rejects.toThrow(/user_code/);
  });

  it('declares app_id as ON DELETE RESTRICT (D2 — apps are deactivated, never deleted)', async () => {
    const fk = await pool.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.table_constraints tc
           ON tc.constraint_name = rc.constraint_name
        WHERE tc.table_name = 'oauth_device_codes'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND rc.constraint_name LIKE '%app_id%'`,
    );
    expect(fk.rows[0]?.delete_rule).toBe('RESTRICT');
  });

  it('indexes expires_at for the sweeper (PF-144)', async () => {
    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'oauth_device_codes'`,
    );
    expect(idx.rows.some((r) => /expires_at/.test(r.indexdef))).toBe(true);
  });

  it('stores sha256(device_code) in no column, and the user_code in clear', async () => {
    const repo = new PgDeviceCodeRepo(pool);
    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();
    await repo.insert(input({ deviceCodeHash: hashDeviceCode(deviceCode), userCode }));

    // Byte-scan the whole row as the database actually holds it.
    const raw = await pool.query(`SELECT oauth_device_codes::text AS whole FROM oauth_device_codes`);
    const whole = raw.rows[0]!.whole as string;
    expect(whole).not.toContain(deviceCode);
    expect(whole).toContain(hashDeviceCode(deviceCode));
    // The deliberate asymmetry, asserted positively.
    expect(whole).toContain(userCode);
  });
});

describe('PF-131: the SQL and TypeScript normalizers agree', () => {
  it('resolves the same input variants to the same row through Postgres', async () => {
    const repo = new PgDeviceCodeRepo(pool);
    const row = await repo.insert(input({ userCode: 'ACDE-FGHJ' }));

    for (const variant of [
      'ACDE-FGHJ',
      'acde-fghj',
      'ACDEFGHJ',
      'acdefghj',
      '  ACDE-FGHJ  ',
      'ACDE FGHJ',
      'AcDe-FgHj',
      'ACDE--FGHJ\n',
    ]) {
      const found = await repo.findByUserCode(normalizeUserCode(variant));
      expect(found?.id, `variant ${JSON.stringify(variant)}`).toBe(row.id);
    }
  });

  it('agrees with the TypeScript function character for character', async () => {
    // Two expressions of one rule is a rule that drifts. This drives the same
    // table through both and asserts they produce identical output.
    const samples = ['ACDE-FGHJ', 'acde fghj', ' a-c-d-e-f-g-h-j ', 'AcDe--FgHj\t', 'ACDEFGHJ'];
    for (const s of samples) {
      const sql = await pool.query<{ n: string }>(
        `SELECT regexp_replace(upper($1::text), '[^A-Z0-9]', '', 'g') AS n`,
        [s],
      );
      expect(sql.rows[0]!.n, `SQL and TS must agree on ${JSON.stringify(s)}`).toBe(
        normalizeUserCode(s),
      );
    }
  });
});

/**
 * The contract block. Run against BOTH implementations — see the header.
 */
describe.each<[string, () => IDeviceCodeRepo]>([
  ['InMemoryDeviceCodeRepo', () => new InMemoryDeviceCodeRepo()],
  ['PgDeviceCodeRepo', () => new PgDeviceCodeRepo(pool)],
])('Liskov contract: %s', (_name, make) => {
  it('approve() succeeds once and binds user, workspace and resolved scopes', async () => {
    const repo = make();
    const row = await repo.insert(input());
    const at = new Date();

    expect(
      await repo.approve(
        { id: row.id, userId: ownerId, workspaceId, scopes: ['documents:read'] },
        at,
      ),
    ).toBe(true);

    const after = await repo.findByDeviceCodeHash(row.deviceCodeHash);
    expect(after?.status).toBe('approved');
    expect(after?.userId).toBe(ownerId);
    expect(after?.workspaceId).toBe(workspaceId);
    // The RESOLVED grant replaced the requested one — never the app's ceiling.
    expect(after?.scopes).toEqual(['documents:read']);

    // A second decision loses, on both implementations.
    expect(
      await repo.approve({ id: row.id, userId: ownerId, workspaceId, scopes: SCOPES }, at),
    ).toBe(false);
    expect(await repo.deny(row.id, at)).toBe(false);
  });

  it('deny() is terminal and blocks a later approval', async () => {
    const repo = make();
    const row = await repo.insert(input());
    const at = new Date();
    expect(await repo.deny(row.id, at)).toBe(true);
    expect((await repo.findByDeviceCodeHash(row.deviceCodeHash))?.status).toBe('denied');
    expect(await repo.approve({ id: row.id, userId: ownerId, workspaceId, scopes: SCOPES }, at)).toBe(
      false,
    );
  });

  it('consume() succeeds EXACTLY once — the single-redemption guarantee', async () => {
    const repo = make();
    const row = await repo.insert(input());
    const at = new Date();
    expect(await repo.consume(row.id, at)).toBe(true);
    expect(await repo.consume(row.id, at)).toBe(false);
  });

  it('recordPoll() persists the stamp and the (possibly raised) interval', async () => {
    const repo = make();
    const row = await repo.insert(input());
    const at = new Date(Date.now() + 1000);
    await repo.recordPoll(row.id, at, 10);
    const after = await repo.findByDeviceCodeHash(row.deviceCodeHash);
    expect(after?.intervalSeconds).toBe(10);
    expect(after?.lastPolledAt?.getTime()).toBe(at.getTime());
  });

  it('invalidate() takes a pending row out of play without deleting it', async () => {
    const repo = make();
    const row = await repo.insert(input());
    expect(await repo.invalidate(row.id, new Date())).toBe(true);
    const after = await repo.findByDeviceCodeHash(row.deviceCodeHash);
    // Denied, not gone — the poller has to be able to learn its flow is over.
    expect(after).not.toBeNull();
    expect(after?.status).toBe('denied');
  });

  it('findByUserCode() and findByDeviceCodeHash() return null for a miss', async () => {
    const repo = make();
    expect(await repo.findByUserCode(normalizeUserCode('ACDE-FGHJ'))).toBeNull();
    expect(await repo.findByDeviceCodeHash('nope')).toBeNull();
  });

  it('deleteSwept() applies the two cut-offs independently', async () => {
    const repo = make();
    const base = Date.now();

    const expired = await repo.insert(input({ expiresAt: new Date(base - 1000) }));
    const live = await repo.insert(input({ expiresAt: new Date(base + 600_000) }));
    const consumed = await repo.insert(input({ expiresAt: new Date(base + 600_000) }));
    await repo.consume(consumed.id, new Date(base - 7_200_000));

    const removed = await repo.deleteSwept(new Date(base), new Date(base - 3_600_000));
    expect(removed).toBe(2);
    expect(await repo.findByDeviceCodeHash(expired.deviceCodeHash)).toBeNull();
    expect(await repo.findByDeviceCodeHash(consumed.deviceCodeHash)).toBeNull();
    expect(await repo.findByDeviceCodeHash(live.deviceCodeHash)).not.toBeNull();
  });
});

describe('PF-140: concurrent redemption yields exactly one winner', () => {
  it('lets one of ten simultaneous consumes win, against real Postgres', async () => {
    // This is the assertion the whole conditional-write design exists for, and
    // it can only be made against the engine whose guarantee is under test.
    const repo = new PgDeviceCodeRepo(pool);
    const row = await repo.insert(input());
    const at = new Date();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => repo.consume(row.id, at)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('lets one of ten simultaneous approvals win', async () => {
    const repo = new PgDeviceCodeRepo(pool);
    const row = await repo.insert(input());
    const at = new Date();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repo.approve({ id: row.id, userId: ownerId, workspaceId, scopes: SCOPES }, at),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
