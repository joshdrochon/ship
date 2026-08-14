/**
 * PF-427 — the Postgres subscription repository, on migration 047.
 *
 * Constructed in `productionDeps()` and nowhere else;
 * `subscriptionRepoFitness.test.ts` fails on a second construction site, the
 * same rule PF-037 applies to `PgOAuthAppRepo` and PF-154 to `PgTokenRepo`.
 *
 * ## The `app_id` parameter on every single-row method
 *
 * `getById`, `deactivate`, `setActive` and `rotateSecret` all take the app id
 * and put it in the WHERE clause. That is PF-432 made structural: another app's
 * subscription id matches no row, so the handler's only possible answer is
 * `not_found`. If the scoping were applied by the caller after the fetch, the
 * day someone forgot would be a cross-tenant read, and forgetting is the normal
 * case — there are four verbs.
 */
import type { Database } from '../../db/client.js';
import type { SecretCipher } from './secretCipher.js';
import { generateSigningSecret, signingSecretPrefix } from './signingSecret.js';
import {
  DuplicateSubscriptionError,
  type CreateSubscriptionInput,
  type IWebhookSubscriptionRepo,
  type SubscriptionMatch,
  type SubscriptionPageQuery,
  type WebhookSubscription,
  type WebhookSubscriptionWithSecret,
} from './subscriptions.js';
import type { EventType } from './events.js';

/**
 * The public projection, as SQL.
 *
 * `secret_ciphertext` is ABSENT from this list and that is the enforcement, not
 * a convention: a `SELECT *` here would put the ciphertext on every row object
 * the route layer handles, and PF-424's byte-scan would start failing for a
 * reason nobody could see in the handler. `created_at` and `updated_at` are
 * rendered by Postgres rather than by `node-postgres`'s `Date` parsing, so the
 * microsecond precision the cursor depends on survives (the same trap L09
 * documents as `CURSOR_TIMESTAMP_EXPR`).
 */
const PUBLIC_COLUMNS = `
  id, app_id, workspace_id, user_id,
  event_type AS event, target_url,
  secret_prefix, secret_version, active,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
  to_char(deactivated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deactivated_at
`;

interface Row {
  id: string;
  app_id: string;
  workspace_id: string;
  user_id: string | null;
  event: string;
  target_url: string;
  secret_prefix: string;
  secret_version: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
}

function toSubscription(row: Row): WebhookSubscription {
  return { ...row, event: row.event as EventType };
}

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

export class PgWebhookSubscriptionRepo implements IWebhookSubscriptionRepo {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  async create(input: CreateSubscriptionInput): Promise<WebhookSubscriptionWithSecret> {
    const secret = generateSigningSecret();
    // Encrypted BEFORE the INSERT, so a cipher failure (no key, wrong key)
    // aborts with no row written rather than leaving a subscription whose
    // secret cannot be read back.
    const ciphertext = this.cipher.encrypt(secret);

    try {
      const result = await this.db.query<Row>(
        `INSERT INTO webhook_subscriptions
           (app_id, workspace_id, user_id, event_type, target_url,
            secret_ciphertext, secret_prefix)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${PUBLIC_COLUMNS}`,
        [
          input.app_id,
          input.workspace_id,
          input.user_id,
          input.event,
          input.target_url,
          ciphertext,
          signingSecretPrefix(secret),
        ],
      );
      return { subscription: toSubscription(result.rows[0]!), signing_secret: secret };
    } catch (err) {
      // The unique constraint is the authority on duplicates, not a prior
      // SELECT — two concurrent creates of the same triple would both pass a
      // check-then-insert and one would still violate.
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateSubscriptionError(input.event, input.target_url);
      }
      throw err;
    }
  }

  async getById(appId: string, id: string): Promise<WebhookSubscription | null> {
    const result = await this.db.query<Row>(
      `SELECT ${PUBLIC_COLUMNS} FROM webhook_subscriptions WHERE id = $1 AND app_id = $2`,
      [id, appId],
    );
    const row = result.rows[0];
    return row ? toSubscription(row) : null;
  }

  async listByApp(query: SubscriptionPageQuery): Promise<WebhookSubscription[]> {
    // The keyset predicate is a row comparison, which is what makes the page
    // query O(page) on `idx_webhook_subscriptions_app_keyset` rather than
    // O(table). `$3::timestamptz IS NULL` lets one statement serve the first
    // page and every subsequent one — two statements would be two places for
    // the ORDER BY to drift.
    const result = await this.db.query<Row>(
      `SELECT ${PUBLIC_COLUMNS}
         FROM webhook_subscriptions
        WHERE app_id = $1
          AND ($2::timestamptz IS NULL
               OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [query.app_id, query.cursor?.timestamp ?? null, query.cursor?.id ?? null, query.limit],
    );
    return result.rows.map(toSubscription);
  }

  async findActiveByEventType(workspaceId: string, event: string): Promise<SubscriptionMatch[]> {
    const result = await this.db.query<Row & { secret_ciphertext: string }>(
      `SELECT ${PUBLIC_COLUMNS}, secret_ciphertext
         FROM webhook_subscriptions
        WHERE workspace_id = $1 AND event_type = $2 AND active = true
        ORDER BY created_at ASC, id ASC`,
      [workspaceId, event],
    );
    return result.rows.map((row) => ({
      subscription: toSubscription(row),
      // Throws on a missing or wrong key. Deliberately NOT caught here: the
      // matcher must abort rather than deliver an unsigned body (PF-422).
      signing_secret: this.cipher.decrypt(row.secret_ciphertext),
    }));
  }

  async deactivate(appId: string, id: string): Promise<WebhookSubscription | null> {
    return this.setActive(appId, id, false);
  }

  async setActive(
    appId: string,
    id: string,
    active: boolean,
  ): Promise<WebhookSubscription | null> {
    // `WHERE active IS DISTINCT FROM $3` makes the second call a no-op UPDATE
    // that returns nothing, so the SELECT below answers instead — which is what
    // makes DELETE idempotent without a read-then-write race.
    const updated = await this.db.query<Row>(
      `UPDATE webhook_subscriptions
          SET active = $3,
              deactivated_at = CASE WHEN $3 THEN NULL ELSE now() END,
              updated_at = now()
        WHERE id = $1 AND app_id = $2 AND active IS DISTINCT FROM $3
        RETURNING ${PUBLIC_COLUMNS}`,
      [id, appId, active],
    );
    const row = updated.rows[0];
    if (row) return toSubscription(row);
    return this.getById(appId, id);
  }

  async rotateSecret(appId: string, id: string): Promise<WebhookSubscriptionWithSecret | null> {
    const secret = generateSigningSecret();
    const ciphertext = this.cipher.encrypt(secret);
    const result = await this.db.query<Row>(
      `UPDATE webhook_subscriptions
          SET secret_ciphertext = $3,
              secret_prefix = $4,
              secret_version = secret_version + 1,
              updated_at = now()
        WHERE id = $1 AND app_id = $2
        RETURNING ${PUBLIC_COLUMNS}`,
      [id, appId, ciphertext, signingSecretPrefix(secret)],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { subscription: toSubscription(row), signing_secret: secret };
  }
}
