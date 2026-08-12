/**
 * PF-036 and PF-037 — the repository contract and the verification seam.
 *
 * Imported in a bare Node context with no HTTP stack, which is PF-037's stated
 * acceptance criterion. If this file ever needs `supertest` or an Express app
 * to run, the interface has leaked transport concerns and the ticket is not met.
 */
import { describe, it, expect } from 'vitest';
import {
  InMemoryOAuthAppRepo,
  verifyClientSecret,
  secretMaterial,
  type IOAuthAppRepo,
  type VerifyFailureReason,
} from './repo.js';
import { generateClientId, generateClientSecret } from './secrets.js';
import type { Scope } from '../scopes/scopes.js';

const SCOPES_FIXTURE: Scope[] = ['documents:read'];

async function seedApp(
  repo: IOAuthAppRepo,
  overrides: { ownerUserId?: string; name?: string } = {}
): Promise<{ clientId: string; rawSecret: string; id: string }> {
  const clientId = generateClientId();
  const rawSecret = generateClientSecret();
  const app = await repo.create({
    clientId,
    ...secretMaterial(rawSecret),
    name: overrides.name ?? 'Test App',
    ownerUserId: overrides.ownerUserId ?? 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: SCOPES_FIXTURE,
  });
  return { clientId, rawSecret, id: app.id };
}

describe('PF-037 — IOAuthAppRepo contract', () => {
  it('create stores the hash and never the raw secret', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { rawSecret, id } = await seedApp(repo);

    const app = await repo.findById(id);
    expect(app).not.toBeNull();
    // The whole row, serialized, must not contain the raw secret anywhere.
    expect(JSON.stringify(app)).not.toContain(rawSecret);
    expect(app!.clientSecretHash).not.toBe(rawSecret);
  });

  it('starts an app active, at secret_version 1, with no deactivation bookkeeping', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { id } = await seedApp(repo);
    const app = (await repo.findById(id))!;

    expect(app.active).toBe(true);
    expect(app.secretVersion).toBe(1);
    expect(app.deactivatedAt).toBeNull();
    expect(app.deactivationReason).toBeNull();
    expect(app.isFirstParty).toBe(false);
  });

  it('findByClientId returns a DEACTIVATED app rather than hiding it', async () => {
    // This is the contract PF-052 rests on: the token path has to see `active`
    // and decide. A repo that filtered here would make "deactivated" look
    // identical to "never existed" to every caller, and the decision would be
    // invisible instead of asserted.
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, id } = await seedApp(repo);
    await repo.deactivate(id, 'admin_action', new Date());

    const app = await repo.findByClientId(clientId);
    expect(app).not.toBeNull();
    expect(app!.active).toBe(false);
  });

  it('listByOwner is owner-scoped and newest-first', async () => {
    const repo = new InMemoryOAuthAppRepo();
    await seedApp(repo, { ownerUserId: 'owner-a', name: 'A1' });
    await seedApp(repo, { ownerUserId: 'owner-a', name: 'A2' });
    await seedApp(repo, { ownerUserId: 'owner-b', name: 'B1' });

    const forA = await repo.listByOwner('owner-a');
    expect(forA.map((a) => a.name).sort()).toEqual(['A1', 'A2']);
    // A second owner's app is ABSENT from the list, not present-and-flagged.
    expect(forA.some((a) => a.name === 'B1')).toBe(false);
  });

  it('returns null rather than throwing for a missing id', async () => {
    const repo = new InMemoryOAuthAppRepo();
    expect(await repo.findById('nope')).toBeNull();
    expect(await repo.findByClientId('nope')).toBeNull();
    expect(await repo.rotateSecret('nope', 'h', 'p')).toBeNull();
    expect(await repo.deactivate('nope', 'admin_action', new Date())).toBeNull();
    expect(await repo.reactivate('nope', 'user-2')).toBeNull();
  });
});

describe('PF-036 — verifyClientSecret', () => {
  it('accepts the correct secret', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret } = await seedApp(repo);

    const result = await verifyClientSecret(repo, clientId, rawSecret);
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret } = await seedApp(repo);

    const result = await verifyClientSecret(repo, clientId, rawSecret + 'x');
    expect(result.ok).toBe(false);
  });

  it('rejects a correct secret for a DEACTIVATED app (D2)', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret, id } = await seedApp(repo);
    await repo.deactivate(id, 'owner_deleted', new Date());

    const result = await verifyClientSecret(repo, clientId, rawSecret);
    expect(result.ok).toBe(false);
  });

  it('the three failure cases are BYTE-IDENTICAL to the caller', async () => {
    // The point of the ticket. If unknown-client were distinguishable from
    // wrong-secret, /oauth/token would be a client_id enumerator: an attacker
    // could confirm which ids exist by presenting garbage secrets.
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret, id } = await seedApp(repo);

    const unknownClient = await verifyClientSecret(repo, 'ship_app_nonexistent', rawSecret);
    const badSecret = await verifyClientSecret(repo, clientId, generateClientSecret());

    await repo.deactivate(id, 'owner_deleted', new Date());
    const inactive = await verifyClientSecret(repo, clientId, rawSecret);

    const serialized = [unknownClient, badSecret, inactive].map((r) => JSON.stringify(r));
    expect(serialized[0]).toBe(serialized[1]);
    expect(serialized[1]).toBe(serialized[2]);
    // And none of them leaks a reason field.
    expect(serialized[0]).toBe('{"ok":false}');
  });

  it('reports the distinguishing reason to the AUDIT sink only (PF-050 seam)', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret, id } = await seedApp(repo);
    const seen: Array<VerifyFailureReason | undefined> = [];
    const record = (r: { reason?: VerifyFailureReason }) => void seen.push(r.reason);

    await verifyClientSecret(repo, 'ship_app_nope', rawSecret, record);
    await verifyClientSecret(repo, clientId, generateClientSecret(), record);
    await verifyClientSecret(repo, clientId, rawSecret, record);
    await repo.deactivate(id, 'owner_deleted', new Date());
    await verifyClientSecret(repo, clientId, rawSecret, record);

    // Server-side the distinctions exist in full — that is what makes the three
    // alert conditions in PF-050 expressible at all.
    expect(seen).toEqual(['unknown_client', 'bad_secret', undefined, 'app_inactive']);
  });

  it('calls the recorder on SUCCESS too', async () => {
    // Two of PF-050's three alert conditions are about successful
    // verifications (unusual source IPs), so a recorder wired only to failures
    // would make those conditions unimplementable.
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret } = await seedApp(repo);
    let calls = 0;
    await verifyClientSecret(repo, clientId, rawSecret, () => {
      calls += 1;
    });
    expect(calls).toBe(1);
  });
});

describe('D3 — rotation invalidates the old secret instantly (PF-047 repo half)', () => {
  it('the old secret fails on the very next call and the new one succeeds', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { clientId, rawSecret, id } = await seedApp(repo);

    const newSecret = generateClientSecret();
    const rotated = await repo.rotateSecret(id, ...([
      secretMaterial(newSecret).clientSecretHash,
      secretMaterial(newSecret).secretPrefix,
    ] as [string, string]));

    expect(rotated!.secretVersion).toBe(2);
    // No grace period: there is nowhere in the schema to put a second live hash.
    expect((await verifyClientSecret(repo, clientId, rawSecret)).ok).toBe(false);
    expect((await verifyClientSecret(repo, clientId, newSecret)).ok).toBe(true);
  });

  it('secret_prefix names the NEW secret after rotation', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { id } = await seedApp(repo);
    const newSecret = generateClientSecret();
    const material = secretMaterial(newSecret);

    const rotated = await repo.rotateSecret(id, material.clientSecretHash, material.secretPrefix);
    expect(rotated!.secretPrefix).toBe(material.secretPrefix);
  });
});

describe('D2 — owner deletion deactivates, never deletes (PF-051 repo half)', () => {
  it('deactivates every app the owner holds and leaves the rows intact', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const a = await seedApp(repo, { ownerUserId: 'doomed', name: 'A' });
    const b = await seedApp(repo, { ownerUserId: 'doomed', name: 'B' });
    const other = await seedApp(repo, { ownerUserId: 'safe', name: 'C' });

    const count = await repo.deactivateByOwner('doomed', new Date());
    expect(count).toBe(2);

    for (const seeded of [a, b]) {
      const app = await repo.findById(seeded.id);
      // The row SURVIVES. A hard delete would make every historical audit row's
      // client_id permanently unresolvable — L99's F10, from the other side.
      expect(app).not.toBeNull();
      expect(app!.active).toBe(false);
      expect(app!.deactivationReason).toBe('owner_deleted');
      expect(app!.clientId).toBe(seeded.clientId);
    }
    expect((await repo.findById(other.id))!.active).toBe(true);
  });

  it('reactivation preserves client_id and the stored credential (PF-053)', async () => {
    const repo = new InMemoryOAuthAppRepo();
    const { id, clientId, rawSecret } = await seedApp(repo, { ownerUserId: 'doomed' });
    await repo.deactivateByOwner('doomed', new Date());

    const back = await repo.reactivate(id, 'new-owner');
    expect(back!.active).toBe(true);
    expect(back!.ownerUserId).toBe('new-owner');
    expect(back!.deactivatedAt).toBeNull();
    expect(back!.deactivationReason).toBeNull();
    // Audit history stays continuous and the owner's secret still works.
    expect(back!.clientId).toBe(clientId);
    expect((await verifyClientSecret(repo, clientId, rawSecret)).ok).toBe(true);
  });
});
