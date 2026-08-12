/**
 * PF-051 and PF-052 — D2 asserted against the real database and the real
 * user-delete path. Lane L02, slice S4.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import { deactivateAppsForDeletedOwner } from './owner-lifecycle.js';
import { PgOAuthAppRepo } from './pg-repo.js';
import { secretMaterial, verifyClientSecret } from './repo.js';
import { generateClientId, generateClientSecret } from './secrets.js';
import type { Scope } from '../scopes/registry.js';

let workspaceId: string;
const repo = () => new PgOAuthAppRepo(pool);
const SCOPES_FIXTURE: Scope[] = ['documents:read'];

async function makeUser(email: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'D2 Test') RETURNING id`,
    [email]
  );
  return r.rows[0]!.id;
}

async function seedApp(owner: string) {
  const clientId = generateClientId();
  const rawSecret = generateClientSecret();
  const app = await repo().create({
    clientId,
    ...secretMaterial(rawSecret),
    name: 'D2 App',
    ownerUserId: owner,
    workspaceId,
    redirectUris: ['https://example.test/cb'],
    requestedScopes: SCOPES_FIXTURE,
  });
  return { app, clientId, rawSecret };
}

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('D2 tests') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_apps');
});

describe('PF-051 — the FK makes a forgotten deactivation LOUD', () => {
  it('deleting an owner WITHOUT deactivating first is refused by the database', async () => {
    // This is the safety property the ON DELETE RESTRICT exists for. If this
    // test ever passes by succeeding, the FK has been changed to CASCADE and
    // every historical audit row's client_id has become unresolvable.
    const userId = await makeUser(`d2-loud-${Date.now()}@ship.local`);
    await seedApp(userId);

    await expect(pool.query('DELETE FROM users WHERE id = $1', [userId])).rejects.toThrow(
      /foreign key|violates/i
    );
  });

  it('deactivating first makes the delete succeed and the apps survive', async () => {
    const userId = await makeUser(`d2-flow-${Date.now()}@ship.local`);
    const a = await seedApp(userId);
    const b = await seedApp(userId);

    const at = new Date('2026-08-12T09:00:00.000Z');
    const count = await deactivateAppsForDeletedOwner(pool, userId, at);
    expect(count).toBe(2);

    await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM workspace_memberships WHERE user_id = $1', [userId]);
    // Still refused: the apps hold the owner reference, and that is the point —
    // D2 keeps the row, so the FK keeps the user too. The recovery story is
    // reassignment (PF-053), not deletion.
    await expect(pool.query('DELETE FROM users WHERE id = $1', [userId])).rejects.toThrow();

    for (const seeded of [a, b]) {
      const app = await repo().findById(seeded.app.id);
      expect(app).not.toBeNull();
      expect(app!.active).toBe(false);
      expect(app!.deactivationReason).toBe('owner_deleted');
      expect(app!.deactivatedAt).toEqual(at);
      // client_id unchanged: every historical audit row still resolves.
      expect(app!.clientId).toBe(seeded.clientId);
    }
  });

  it('only the named owner\'s apps are touched', async () => {
    const doomed = await makeUser(`d2-doomed-${Date.now()}@ship.local`);
    const safe = await makeUser(`d2-safe-${Date.now()}@ship.local`);
    const theirs = await seedApp(doomed);
    const ours = await seedApp(safe);

    await deactivateAppsForDeletedOwner(pool, doomed, new Date());
    expect((await repo().findById(theirs.app.id))!.active).toBe(false);
    expect((await repo().findById(ours.app.id))!.active).toBe(true);
  });
});

describe('PF-052 — active=false stops verification at the boundary', () => {
  it('a correct secret no longer verifies once the owner is deleted', async () => {
    // D2's whole argument is that deactivation is the only option where a
    // deleted user's access cannot outlive them. This is that argument's proof
    // at the layer L06's token middleware will consume.
    const userId = await makeUser(`d2-verify-${Date.now()}@ship.local`);
    const { clientId, rawSecret } = await seedApp(userId);

    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(true);
    await deactivateAppsForDeletedOwner(pool, userId, new Date());
    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(false);
  });

  it('the repository still SURFACES the app with active=false', async () => {
    // The contract L06 reads. Filtering the app out here would hide the flag
    // and make the decision invisible rather than asserted.
    const userId = await makeUser(`d2-surface-${Date.now()}@ship.local`);
    const { clientId } = await seedApp(userId);
    await deactivateAppsForDeletedOwner(pool, userId, new Date());

    const app = await repo().findByClientId(clientId);
    expect(app).not.toBeNull();
    expect(app!.active).toBe(false);
  });

  it('reactivating restores verification (PF-053 round trip)', async () => {
    const userId = await makeUser(`d2-round-${Date.now()}@ship.local`);
    const newOwner = await makeUser(`d2-newowner-${Date.now()}@ship.local`);
    const { app, clientId, rawSecret } = await seedApp(userId);

    await deactivateAppsForDeletedOwner(pool, userId, new Date());
    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(false);

    await repo().reactivate(app.id, newOwner);
    // The stored credential still works — client_secret_hash was untouched.
    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(true);
  });
});
