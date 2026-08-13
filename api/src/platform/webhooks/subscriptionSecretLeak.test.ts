/**
 * PF-424 — the secret is unreadable after creation, proven by a scan rather
 * than by a promise.
 *
 * Answers p.15's 1.4 leakage question for the webhook signing secret the same
 * way L02 answers it for `client_secret`. Four assertions were ticketed; three
 * of them are here and the fourth (the `.strict()` response schema) lands with
 * the routes in S2, because there is no response to be strict about yet.
 *
 * The point of this file is that none of these checks read the code. They read
 * what the database actually holds and what the process actually printed. A
 * code review can miss a `console.log`; a grep over captured output cannot.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { pool } from '../../db/client.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from './secretCipher.js';
import { PgWebhookSubscriptionRepo } from './pgSubscriptionRepo.js';
import { InMemoryWebhookSubscriptionRepo } from './inMemorySubscriptionRepo.js';
import { FakeClock } from '../clock.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x3c));

let workspaceId: string;
let userId: string;
let appId: string;

beforeAll(async () => {
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L15 leak workspace') RETURNING id`,
  );
  workspaceId = ws.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ('l15-leak@ship.local', 'L15') RETURNING id`,
  );
  userId = user.rows[0]!.id;
  const app = await pool.query<{ id: string }>(
    `INSERT INTO oauth_apps
       (client_id, client_secret_hash, secret_prefix, name, redirect_uris,
        owner_user_id, workspace_id, requested_scopes)
     VALUES ('ship_app_l15_leak', 'x', 'yyyyyyyy', 'leak', ARRAY['https://example.test/cb'],
             $1, $2, ARRAY['webhooks:manage'])
     RETURNING id`,
    [userId, workspaceId],
  );
  appId = app.rows[0]!.id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM webhook_subscriptions');
});

describe('PF-424 (b-as-data) — the raw secret is in NO column of the table', () => {
  it('a byte scan over SELECT * finds it nowhere', async () => {
    const repo = new PgWebhookSubscriptionRepo(pool, CIPHER);
    const created = await repo.create({
      app_id: appId,
      workspace_id: workspaceId,
      user_id: userId,
      event: 'document.created',
      target_url: 'https://example.test/hooks/scan',
    });
    const secret = created.signing_secret;
    // The random body, without the `whsec_` tag. Scanning for the tagged form
    // alone would be satisfied by a store that dropped six characters.
    const body = secret.slice('whsec_'.length);

    const rows = await pool.query(`SELECT * FROM webhook_subscriptions`);
    expect(rows.rowCount).toBe(1);

    // Every value of every column, coerced to bytes. Not `JSON.stringify` of
    // the row: a `bytea` column serialises as `{"type":"Buffer","data":[…]}`
    // and a substring search over that would miss the secret entirely.
    for (const row of rows.rows) {
      for (const [column, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const bytes = Buffer.isBuffer(value)
          ? value
          : Buffer.from(
              value instanceof Date ? value.toISOString() : String(value),
              'utf8',
            );
        expect(
          bytes.includes(Buffer.from(secret, 'utf8')),
          `column ${column} contains the raw signing secret`,
        ).toBe(false);
        expect(
          bytes.includes(Buffer.from(body, 'utf8')),
          `column ${column} contains the secret's random body`,
        ).toBe(false);
      }
    }

    // The prefix IS present, by design, and it is 8 characters — that is the
    // whole disclosure budget and this pins it so a future "make the prefix
    // longer for readability" is a failing test rather than a quiet widening.
    const stored = rows.rows[0] as Record<string, unknown>;
    expect(stored.secret_prefix).toBe(body.slice(0, 8));
    expect(String(stored.secret_prefix)).toHaveLength(8);
  });

  it('the ciphertext column is not the plaintext with extra steps', async () => {
    const repo = new PgWebhookSubscriptionRepo(pool, CIPHER);
    const created = await repo.create({
      app_id: appId,
      workspace_id: workspaceId,
      user_id: userId,
      event: 'document.updated',
      target_url: 'https://example.test/hooks/ct',
    });
    const r = await pool.query<{ secret_ciphertext: string }>(
      `SELECT secret_ciphertext FROM webhook_subscriptions`,
    );
    const ct = r.rows[0]!.secret_ciphertext;
    expect(ct).not.toContain(created.signing_secret);
    // Base64-decoding it must not reveal the secret either — the case a
    // "the column looks like gibberish" eyeball check would pass.
    expect(
      Buffer.from(ct, 'base64').includes(Buffer.from(created.signing_secret, 'utf8')),
    ).toBe(false);
  });
});

describe('PF-424 (b) — create → list → get → rotate prints the secret nowhere', () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        }),
      );
    }
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  it.each([
    ['Pg', () => new PgWebhookSubscriptionRepo(pool, CIPHER)],
    [
      'InMemory',
      () =>
        new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock: new FakeClock(1) }),
    ],
  ])('%s repository logs zero occurrences of either secret', async (_name, make) => {
    const repo = make();
    const created = await repo.create({
      app_id: appId,
      workspace_id: workspaceId,
      user_id: userId,
      event: 'document.created',
      target_url: 'https://example.test/hooks/log',
    });
    await repo.listByApp({ app_id: appId, limit: 25, cursor: null });
    await repo.getById(appId, created.subscription.id);
    await repo.findActiveByEventType(workspaceId, 'document.created');
    const rotated = await repo.rotateSecret(appId, created.subscription.id);

    const output = captured.join('\n');
    expect(output).not.toContain(created.signing_secret);
    expect(output).not.toContain(rotated!.signing_secret);
    // And the untagged bodies, so a log line that stripped the tag is caught.
    expect(output).not.toContain(created.signing_secret.slice(6));
    expect(output).not.toContain(rotated!.signing_secret.slice(6));
  });
});
