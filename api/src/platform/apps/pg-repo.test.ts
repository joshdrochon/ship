/**
 * PF-031 and PF-037 — `PgOAuthAppRepo` against a real database.
 *
 * `InMemoryOAuthAppRepo` and `PgOAuthAppRepo` are a Liskov pair, and a pair is
 * only a pair if something checks. The in-memory double is what L04/L05/L06
 * will build against; if it disagrees with Postgres about ordering, about
 * null-on-missing, or about whether a deactivated app is still returned, those
 * lanes will pass their tests and fail in production.
 *
 * Also asserts the schema facts PF-031 specifies that no unit test can see:
 * the ON DELETE RESTRICT on `owner_user_id`, and the absence of a salt column.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import { PgOAuthAppRepo } from './pg-repo.js';
import { InMemoryOAuthAppRepo, secretMaterial, verifyClientSecret } from './repo.js';
import { generateClientId, generateClientSecret } from './secrets.js';
import type { Scope } from '../scopes/scopes.js';

const SCOPES_FIXTURE: Scope[] = ['documents:read', 'issues:read'];

let workspaceId: string;
let ownerId: string;
let otherOwnerId: string;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L02 test workspace') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;

  const mkUser = async (email: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ($1, 'L02 Test') RETURNING id`,
      [email]
    );
    return r.rows[0]!.id;
  };
  ownerId = await mkUser('l02-owner@ship.local');
  otherOwnerId = await mkUser('l02-other@ship.local');
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_apps');
});

function repo() {
  return new PgOAuthAppRepo(pool);
}

async function seed(owner = ownerId) {
  const clientId = generateClientId();
  const rawSecret = generateClientSecret();
  const app = await repo().create({
    clientId,
    ...secretMaterial(rawSecret),
    name: 'Pg Test App',
    ownerUserId: owner,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: SCOPES_FIXTURE,
  });
  return { app, clientId, rawSecret };
}

describe('PF-031 — schema facts', () => {
  it('owner_user_id is ON DELETE RESTRICT, not CASCADE', async () => {
    // D2's safety net. A user-delete path that forgets deactivateByOwner()
    // must fail LOUDLY here rather than cascading the rows away and taking the
    // audit trail's client_id resolvability with them.
    const r = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'oauth_apps'::regclass
          AND conname = 'oauth_apps_owner_user_id_fkey'`
    );
    // 'r' = RESTRICT, 'c' = CASCADE, 'a' = NO ACTION
    expect(r.rows[0]!.confdeltype).toBe('r');
  });

  it('deleting an owner with a live app is REFUSED by the database', async () => {
    const { app } = await seed();
    await expect(pool.query('DELETE FROM users WHERE id = $1', [ownerId])).rejects.toThrow();
    // The app is untouched.
    expect(await repo().findById(app.id)).not.toBeNull();
  });

  it('has no salt column', async () => {
    const r = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'oauth_apps'`
    );
    const names = r.rows.map((x) => x.column_name);
    expect(names.some((n) => /salt/i.test(n))).toBe(false);
    // And the columns p.2 names are all present.
    for (const required of [
      'id',
      'client_id',
      'client_secret_hash',
      'redirect_uris',
      'owner_user_id',
      'requested_scopes',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('enforces client_id uniqueness', async () => {
    const { clientId } = await seed();
    await expect(
      repo().create({
        clientId,
        ...secretMaterial(generateClientSecret()),
        name: 'Duplicate',
        ownerUserId: ownerId,
        workspaceId,
        redirectUris: ['https://example.test/cb'],
        requestedScopes: SCOPES_FIXTURE,
      })
    ).rejects.toThrow();
  });

  it('refuses an incoherent deactivation state', async () => {
    const { app } = await seed();
    // active=false with no deactivated_at is a state no reader can interpret.
    await expect(
      pool.query('UPDATE oauth_apps SET active = false WHERE id = $1', [app.id])
    ).rejects.toThrow();
  });
});

describe('PF-031 — migration ordering (L99 dispute B3)', () => {
  it('039 is recorded, and precedes the block reserved for L15', async () => {
    const r = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version LIKE '039%'`
    );
    expect(r.rows[0]!.version).toBe('039_oauth_apps');

    // L15's PF-421 declares an FK into oauth_apps and draws from 047-050.
    // migrate.ts sorts filenames lexicographically, so 039 < 047 is the whole
    // guarantee that the FK's target exists when L15's file runs. This asserts
    // the invariant rather than the not-yet-written file.
    expect('039_oauth_apps' < '047_').toBe(true);
  });
});

describe('PF-037 — PgOAuthAppRepo matches the in-memory double', () => {
  it('create stores the hash and never the raw secret, in any text column', async () => {
    const { app, rawSecret } = await seed();
    // Byte scan across every text-ish column of the persisted row.
    const r = await pool.query(`SELECT oauth_apps::text AS whole FROM oauth_apps WHERE id = $1`, [
      app.id,
    ]);
    expect(String(r.rows[0]!.whole)).not.toContain(rawSecret);
  });

  it('findByClientId returns a deactivated app with active=false', async () => {
    const { app, clientId } = await seed();
    await repo().deactivate(app.id, 'admin_action', new Date());
    const found = await repo().findByClientId(clientId);
    expect(found).not.toBeNull();
    expect(found!.active).toBe(false);
  });

  it('listByOwner excludes another owner entirely', async () => {
    const mine = await seed(ownerId);
    await seed(otherOwnerId);
    const list = await repo().listByOwner(ownerId);
    expect(list.map((a) => a.id)).toEqual([mine.app.id]);
  });

  it('returns null for missing ids, exactly as the in-memory double does', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const pg = repo();
    const mem = new InMemoryOAuthAppRepo();
    expect(await pg.findById(missing)).toBe(await mem.findById('nope'));
    expect(await pg.findByClientId('ship_app_nope')).toBe(
      await mem.findByClientId('ship_app_nope')
    );
    expect(await pg.rotateSecret(missing, 'h', 'p')).toBeNull();
    expect(await pg.reactivate(missing, ownerId)).toBeNull();
  });

  it('rotation is instant: the old secret dies, secret_version increments (D3)', async () => {
    const { app, clientId, rawSecret } = await seed();
    const next = generateClientSecret();
    const material = secretMaterial(next);

    const rotated = await repo().rotateSecret(app.id, material.clientSecretHash, material.secretPrefix);
    expect(rotated!.secretVersion).toBe(2);
    expect(rotated!.secretPrefix).toBe(material.secretPrefix);

    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(false);
    expect((await verifyClientSecret(repo(), clientId, next)).ok).toBe(true);
  });

  it('deactivateByOwner deactivates all of one owner and nobody else (D2)', async () => {
    const a = await seed(ownerId);
    const b = await seed(ownerId);
    const other = await seed(otherOwnerId);

    const count = await repo().deactivateByOwner(ownerId, new Date());
    expect(count).toBe(2);

    for (const seeded of [a, b]) {
      const app = await repo().findById(seeded.app.id);
      expect(app!.active).toBe(false);
      expect(app!.deactivationReason).toBe('owner_deleted');
      expect(app!.clientId).toBe(seeded.clientId); // row survives, id unchanged
    }
    expect((await repo().findById(other.app.id))!.active).toBe(true);
  });

  it('deactivateByOwner is idempotent and does not refresh deactivated_at', async () => {
    const { app } = await seed(ownerId);
    await repo().deactivateByOwner(ownerId, new Date('2026-01-01T00:00:00Z'));
    const first = (await repo().findById(app.id))!.deactivatedAt;

    const second = await repo().deactivateByOwner(ownerId, new Date('2026-02-01T00:00:00Z'));
    expect(second).toBe(0);
    expect((await repo().findById(app.id))!.deactivatedAt).toEqual(first);
  });

  it('reactivate reassigns and preserves the credential (PF-053)', async () => {
    const { app, clientId, rawSecret } = await seed(ownerId);
    await repo().deactivateByOwner(ownerId, new Date());

    const back = await repo().reactivate(app.id, otherOwnerId);
    expect(back!.active).toBe(true);
    expect(back!.ownerUserId).toBe(otherOwnerId);
    expect(back!.deactivatedAt).toBeNull();
    expect(back!.clientId).toBe(clientId);
    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(true);
  });

  it('reactivate naming a nonexistent owner is refused by the FK', async () => {
    // PF-053: "rejects reactivation without a live owner". An active app with a
    // deleted owner is the orphan state D2 was chosen to avoid.
    const { app } = await seed(ownerId);
    await repo().deactivateByOwner(ownerId, new Date());
    await expect(
      repo().reactivate(app.id, '00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow();
  });
});
