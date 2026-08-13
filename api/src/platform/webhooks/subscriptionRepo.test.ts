/**
 * PF-427 / PF-426 — the subscription repository contract, run against BOTH
 * implementations.
 *
 * `InMemoryWebhookSubscriptionRepo` and `PgWebhookSubscriptionRepo` are a
 * Liskov pair, and a pair is only a pair if something checks. The in-memory
 * double is what the matcher tests and L16's suites build against; if it
 * disagrees with Postgres about ordering, about null-on-missing, or about
 * whether deactivation is idempotent, those lanes pass and production does not.
 *
 * The suite below is written ONCE and parameterised over a factory. Anything
 * that can only be asserted against a real database — the unique constraint's
 * SQLSTATE, the FK, the CHECK — is in its own block at the bottom.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { pool } from '../../db/client.js';
import { FakeClock } from '../clock.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from './secretCipher.js';
import { InMemoryWebhookSubscriptionRepo } from './inMemorySubscriptionRepo.js';
import { PgWebhookSubscriptionRepo } from './pgSubscriptionRepo.js';
import {
  DuplicateSubscriptionError,
  type IWebhookSubscriptionRepo,
} from './subscriptions.js';
import { SIGNING_SECRET_TAG } from './signingSecret.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x7f));

let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;
let appA: string;
let appB: string;

beforeAll(async () => {
  const ws = async (name: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [name],
    );
    return r.rows[0]!.id;
  };
  workspaceId = await ws('L15 subs workspace');
  otherWorkspaceId = await ws('L15 subs other workspace');

  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l15-subs@ship.local', 'L15') RETURNING id`,
  );
  userId = user.rows[0]!.id;

  const app = async (clientId: string, ws_: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO oauth_apps
         (client_id, client_secret_hash, secret_prefix, name, redirect_uris,
          owner_user_id, workspace_id, requested_scopes)
       VALUES ($1, 'x', 'yyyyyyyy', $1, ARRAY['https://example.test/cb'], $2, $3,
               ARRAY['webhooks:manage'])
       RETURNING id`,
      [clientId, userId, ws_],
    );
    return r.rows[0]!.id;
  };
  appA = await app('ship_app_l15_a', workspaceId);
  appB = await app('ship_app_l15_b', workspaceId);
});

beforeEach(async () => {
  await pool.query('DELETE FROM webhook_subscriptions');
});

interface Fixture {
  name: string;
  make(): IWebhookSubscriptionRepo;
}

const FIXTURES: Fixture[] = [
  {
    name: 'InMemoryWebhookSubscriptionRepo',
    make: () =>
      // A clock that advances on every read, so `created_at` is strictly
      // increasing between inserts. A fixed clock would make the sort order
      // depend on id tie-breaking alone and would not exercise the timestamp
      // half of the keyset at all.
      new InMemoryWebhookSubscriptionRepo({
        cipher: CIPHER,
        clock: (() => {
          const fake = new FakeClock(1_700_000_000_000);
          return {
            nowMs: () => {
              fake.advance(1000);
              return fake.nowMs();
            },
          };
        })(),
      }),
  },
  {
    name: 'PgWebhookSubscriptionRepo',
    make: () => new PgWebhookSubscriptionRepo(pool, CIPHER),
  },
];

function create(repo: IWebhookSubscriptionRepo, over: Partial<{ app_id: string; workspace_id: string; user_id: string | null; event: string; target_url: string }> = {}) {
  return repo.create({
    app_id: over.app_id ?? appA,
    workspace_id: over.workspace_id ?? workspaceId,
    user_id: over.user_id === undefined ? userId : over.user_id,
    event: (over.event ?? 'document.created') as 'document.created',
    target_url: over.target_url ?? 'https://example.test/hooks/a',
  });
}

describe.each(FIXTURES)('$name — the shared contract', ({ make }) => {
  it('create returns the raw secret once, and never on any read', async () => {
    const repo = make();
    const created = await create(repo);

    expect(created.signing_secret.startsWith(SIGNING_SECRET_TAG)).toBe(true);
    // PF-424(a): the row type has nowhere to put a secret. This is a structural
    // assertion, not a "did the handler remember to delete the field" one.
    expect(created.subscription).not.toHaveProperty('signing_secret');
    expect(created.subscription).not.toHaveProperty('secret_ciphertext');
    expect(created.subscription.secret_prefix).toBe(
      created.signing_secret.slice(SIGNING_SECRET_TAG.length, SIGNING_SECRET_TAG.length + 8),
    );
    expect(created.subscription.secret_version).toBe(1);
    expect(created.subscription.active).toBe(true);
    expect(created.subscription.deactivated_at).toBeNull();

    const read = await repo.getById(appA, created.subscription.id);
    expect(read).not.toHaveProperty('signing_secret');
    expect(read).not.toHaveProperty('secret_ciphertext');
    expect(JSON.stringify(read)).not.toContain(created.signing_secret);
  });

  it('the stored secret round-trips through findActiveByEventType', async () => {
    const repo = make();
    const created = await create(repo);
    const matches = await repo.findActiveByEventType(workspaceId, 'document.created');
    expect(matches).toHaveLength(1);
    // The whole reason PF-422 encrypts rather than hashes: this value has to
    // come back out to key an HMAC.
    expect(matches[0]!.signing_secret).toBe(created.signing_secret);
  });

  it('rejects a duplicate (app, event, target) triple', async () => {
    const repo = make();
    await create(repo);
    await expect(create(repo)).rejects.toThrow(DuplicateSubscriptionError);
  });

  it('allows the SAME event type to a DIFFERENT target, and a different app to the same one', async () => {
    const repo = make();
    await create(repo);
    // One app legitimately fans one event out to a staging and a production
    // listener — "per-app per-event-type" (p.3) names the granularity of a
    // subscription, not a uniqueness constraint over it.
    await expect(
      create(repo, { target_url: 'https://example.test/hooks/b' }),
    ).resolves.toBeDefined();
    await expect(create(repo, { app_id: appB })).resolves.toBeDefined();
  });

  it('getById is scoped to the owning app — another app sees null, not the row', async () => {
    const repo = make();
    const { subscription } = await create(repo);
    expect(await repo.getById(appA, subscription.id)).not.toBeNull();
    // PF-432's structural half. `null` here is what makes 404 the only
    // possible answer at the route; a 403 would confirm the id exists.
    expect(await repo.getById(appB, subscription.id)).toBeNull();
  });

  it('getById returns null for an id that matches nothing', async () => {
    const repo = make();
    expect(await repo.getById(appA, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('listByApp is newest-first, app-scoped, and walks by cursor without repeats', async () => {
    const repo = make();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { subscription } = await create(repo, { target_url: `https://example.test/h/${i}` });
      ids.push(subscription.id);
    }
    // App B's rows must never appear in App A's walk.
    for (let i = 0; i < 3; i += 1) {
      await create(repo, { app_id: appB, target_url: `https://example.test/b/${i}` });
    }

    const seen: string[] = [];
    let cursor: { timestamp: string; id: string } | null = null;
    for (let page = 0; page < 10; page += 1) {
      const rows: Awaited<ReturnType<IWebhookSubscriptionRepo['listByApp']>> =
        await repo.listByApp({ app_id: appA, limit: 2, cursor });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      cursor = { timestamp: last.created_at, id: last.id };
      if (rows.length < 2) break;
    }

    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(seen.length);
    for (const row of await repo.listByApp({ app_id: appA, limit: 100, cursor: null })) {
      expect(row.app_id).toBe(appA);
    }
  });

  it('findActiveByEventType matches on workspace AND event type, and nothing else', async () => {
    const repo = make();
    const wanted = await create(repo);
    await create(repo, { event: 'document.deleted', target_url: 'https://example.test/h/del' });
    await create(repo, {
      app_id: appB,
      workspace_id: otherWorkspaceId,
      target_url: 'https://example.test/h/other-ws',
    });

    const matches = await repo.findActiveByEventType(workspaceId, 'document.created');
    expect(matches.map((m) => m.subscription.id)).toEqual([wanted.subscription.id]);
  });

  it('zero matches is an empty array, never a throw', async () => {
    const repo = make();
    // The normal case: almost every workspace is unsubscribed.
    await expect(repo.findActiveByEventType(workspaceId, 'sprint.started')).resolves.toEqual([]);
  });

  it('PF-426 — an inactive subscription is not a match, and reactivating does not backfill', async () => {
    const repo = make();
    const { subscription } = await create(repo);

    const deactivated = await repo.deactivate(appA, subscription.id);
    expect(deactivated!.active).toBe(false);
    expect(deactivated!.deactivated_at).not.toBeNull();
    expect(await repo.findActiveByEventType(workspaceId, 'document.created')).toEqual([]);

    // The row is still there — L16's delivery log keeps a resolvable
    // `subscription_id` after a subscriber walks away.
    expect(await repo.getById(appA, subscription.id)).not.toBeNull();

    const reactivated = await repo.setActive(appA, subscription.id, true);
    expect(reactivated!.active).toBe(true);
    expect(reactivated!.deactivated_at).toBeNull();
    // Reactivation resumes matching. There is no queue of missed events and no
    // API by which one could be replayed — asserted here so "no backfill" is a
    // property rather than an omission nobody wrote down.
    expect(await repo.findActiveByEventType(workspaceId, 'document.created')).toHaveLength(1);
  });

  it('deactivate is idempotent — the second call is not an error', async () => {
    const repo = make();
    const { subscription } = await create(repo);
    const first = await repo.deactivate(appA, subscription.id);
    const second = await repo.deactivate(appA, subscription.id);
    expect(second).not.toBeNull();
    expect(second!.active).toBe(false);
    expect(second!.deactivated_at).toBe(first!.deactivated_at);
  });

  it('deactivate on a foreign app returns null rather than deactivating', async () => {
    const repo = make();
    const { subscription } = await create(repo);
    expect(await repo.deactivate(appB, subscription.id)).toBeNull();
    expect((await repo.getById(appA, subscription.id))!.active).toBe(true);
  });

  it('PF-433 — rotate mints a new secret, bumps the version, kills the old one', async () => {
    const repo = make();
    const created = await create(repo);
    const rotated = await repo.rotateSecret(appA, created.subscription.id);

    expect(rotated!.signing_secret).not.toBe(created.signing_secret);
    expect(rotated!.subscription.secret_version).toBe(2);
    expect(rotated!.subscription.secret_prefix).toBe(
      rotated!.signing_secret.slice(SIGNING_SECRET_TAG.length, SIGNING_SECRET_TAG.length + 8),
    );

    // No grace period, matching D3 for `client_secret`. The old secret is not
    // retrievable from anywhere after this point.
    const matches = await repo.findActiveByEventType(workspaceId, 'document.created');
    expect(matches[0]!.signing_secret).toBe(rotated!.signing_secret);
    expect(matches[0]!.signing_secret).not.toBe(created.signing_secret);
  });

  it('rotate on a foreign app returns null and leaves the secret alone', async () => {
    const repo = make();
    const created = await create(repo);
    expect(await repo.rotateSecret(appB, created.subscription.id)).toBeNull();
    const matches = await repo.findActiveByEventType(workspaceId, 'document.created');
    expect(matches[0]!.signing_secret).toBe(created.signing_secret);
  });

  it('fails CLOSED when the secret cannot be decrypted', async () => {
    // The wrong key, standing in for a rotated `WEBHOOK_SECRET_KEY` or a
    // restored backup. The matcher must not be able to proceed: a body
    // delivered unsigned, or signed with garbage, is worse than no delivery.
    const repo = make();
    await create(repo);
    const wrongKeyRepo =
      repo instanceof PgWebhookSubscriptionRepo
        ? new PgWebhookSubscriptionRepo(
            pool,
            new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x01)),
          )
        : null;
    if (!wrongKeyRepo) return; // in-memory rows live in the instance; covered by the Pg leg
    await expect(
      wrongKeyRepo.findActiveByEventType(workspaceId, 'document.created'),
    ).rejects.toThrow(/failed to decrypt/i);
  });
});

describe('PF-421 — schema facts only Postgres can answer', () => {
  it('there is NO CHECK constraint on event_type', async () => {
    // The closed set is L14's EVENT_TYPES. Restating it in SQL would make a
    // ninth event type a migration, which is exactly the Open/Closed property
    // PF-395 proves.
    const r = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'webhook_subscriptions'::regclass AND contype = 'c'`,
    );
    for (const row of r.rows) expect(row.def).not.toContain('event_type');
  });

  it('an unregistered event_type is accepted by the DATABASE — the route rejects it', async () => {
    const repo = new PgWebhookSubscriptionRepo(pool, CIPHER);
    await expect(
      repo.create({
        app_id: appA,
        workspace_id: workspaceId,
        user_id: userId,
        // Cast: the point of this test is what happens when the type system is
        // bypassed, which is what an HTTP request does.
        event: 'plugin.installed' as never,
        target_url: 'https://example.test/hooks/unregistered',
      }),
    ).resolves.toBeDefined();
  });

  it('the deactivation coherence CHECK forbids active=false with a null timestamp', async () => {
    const repo = new PgWebhookSubscriptionRepo(pool, CIPHER);
    const { subscription } = await repo.create({
      app_id: appA,
      workspace_id: workspaceId,
      user_id: userId,
      event: 'document.created',
      target_url: 'https://example.test/hooks/coherence',
    });
    await expect(
      pool.query(
        `UPDATE webhook_subscriptions SET active = false, deactivated_at = NULL WHERE id = $1`,
        [subscription.id],
      ),
    ).rejects.toThrow(/webhook_subscriptions_deactivation_coherent/);
  });

  it('app_id CASCADEs — a deleted app takes its subscriptions with it', async () => {
    const r = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'webhook_subscriptions'::regclass
          AND conname = 'webhook_subscriptions_app_id_fkey'`,
    );
    expect(r.rows[0]!.confdeltype).toBe('c');
  });

  it('user_id is SET NULL — a deleted user does not take live subscriptions with them', async () => {
    // And a NULL `user_id` fails D7's private gate closed. See the matcher.
    const r = await pool.query<{ confdeltype: string }>(
      `SELECT confdeltype FROM pg_constraint
        WHERE conrelid = 'webhook_subscriptions'::regclass
          AND conname = 'webhook_subscriptions_user_id_fkey'`,
    );
    expect(r.rows[0]!.confdeltype).toBe('n');
  });
});
