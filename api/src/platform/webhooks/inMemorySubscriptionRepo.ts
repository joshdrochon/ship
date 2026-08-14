/**
 * PF-427/PF-016 — the in-memory subscription repository.
 *
 * Constructed in `testDeps()` and nowhere else; `subscriptionRepoFitness.test.ts`
 * greps for a second construction site.
 *
 * It ENCRYPTS through the same `SecretCipher` the Postgres repository uses
 * rather than holding plaintext in a field. That is not ceremony: the shared
 * contract suite runs against both implementations, and a double that skipped
 * the cipher would pass PF-422's round-trip assertion for the wrong reason and
 * would not exercise the fail-closed path at all.
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
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

/** The stored shape: the public row plus the ciphertext nobody else may see. */
interface StoredRow extends WebhookSubscription {
  secret_ciphertext: string;
}

export interface InMemorySubscriptionRepoOptions {
  cipher: SecretCipher;
  /** The only source of `created_at`/`updated_at`. Injected, per PF-017. */
  clock: Pick<Clock, 'nowMs'>;
  /** Injected only so a test can pin ids; defaults to `randomUUID`. */
  newId?: () => string;
}

export class InMemoryWebhookSubscriptionRepo implements IWebhookSubscriptionRepo {
  private readonly rows = new Map<string, StoredRow>();
  private readonly cipher: SecretCipher;
  private readonly clock: Pick<Clock, 'nowMs'>;
  private readonly newId: () => string;

  constructor(options: InMemorySubscriptionRepoOptions) {
    this.cipher = options.cipher;
    this.clock = options.clock;
    this.newId = options.newId ?? randomUUID;
  }

  private now(): string {
    return new Date(this.clock.nowMs()).toISOString();
  }

  /** The public projection. Strips the ciphertext structurally, not by care. */
  private publish(row: StoredRow): WebhookSubscription {
    const { secret_ciphertext: _omitted, ...publicRow } = row;
    return { ...publicRow };
  }

  async create(input: CreateSubscriptionInput): Promise<WebhookSubscriptionWithSecret> {
    for (const row of this.rows.values()) {
      if (
        row.app_id === input.app_id &&
        row.event === input.event &&
        row.target_url === input.target_url
      ) {
        throw new DuplicateSubscriptionError(input.event, input.target_url);
      }
    }

    const secret = generateSigningSecret();
    const at = this.now();
    const row: StoredRow = {
      id: this.newId(),
      app_id: input.app_id,
      workspace_id: input.workspace_id,
      user_id: input.user_id,
      event: input.event,
      target_url: input.target_url,
      // Encrypted before it is stored, on the same code path as production.
      secret_ciphertext: this.cipher.encrypt(secret),
      secret_prefix: signingSecretPrefix(secret),
      secret_version: 1,
      active: true,
      created_at: at,
      updated_at: at,
      deactivated_at: null,
    };
    this.rows.set(row.id, row);
    return { subscription: this.publish(row), signing_secret: secret };
  }

  async getById(appId: string, id: string): Promise<WebhookSubscription | null> {
    const row = this.rows.get(id);
    if (!row || row.app_id !== appId) return null;
    return this.publish(row);
  }

  async listByApp(query: SubscriptionPageQuery): Promise<WebhookSubscription[]> {
    const ordered = [...this.rows.values()]
      .filter((row) => row.app_id === query.app_id)
      // Newest first, `(created_at, id)` descending — the same total order the
      // SQL `ORDER BY` produces, so the two implementations paginate alike.
      .sort((a, b) =>
        a.created_at === b.created_at
          ? b.id.localeCompare(a.id)
          : b.created_at.localeCompare(a.created_at),
      );

    const after = query.cursor;
    const page = after
      ? ordered.filter((row) =>
          row.created_at === after.timestamp
            ? row.id.localeCompare(after.id) < 0
            : row.created_at.localeCompare(after.timestamp) < 0,
        )
      : ordered;

    return page.slice(0, query.limit).map((row) => this.publish(row));
  }

  async findActiveByEventType(workspaceId: string, event: string): Promise<SubscriptionMatch[]> {
    return [...this.rows.values()]
      .filter((row) => row.active && row.workspace_id === workspaceId && row.event === event)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .map((row) => ({
        subscription: this.publish(row),
        // Decrypted here. A wrong or missing key throws, and the matcher lets it
        // propagate — see PF-422's fail-closed rule.
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
    const row = this.rows.get(id);
    if (!row || row.app_id !== appId) return null;
    // Idempotent: no-op when already in the requested state, and specifically
    // does NOT move `updated_at`, so a second DELETE is indistinguishable.
    if (row.active === active) return this.publish(row);
    row.active = active;
    row.deactivated_at = active ? null : this.now();
    row.updated_at = this.now();
    return this.publish(row);
  }

  async rotateSecret(appId: string, id: string): Promise<WebhookSubscriptionWithSecret | null> {
    const row = this.rows.get(id);
    if (!row || row.app_id !== appId) return null;
    const secret = generateSigningSecret();
    row.secret_ciphertext = this.cipher.encrypt(secret);
    row.secret_prefix = signingSecretPrefix(secret);
    row.secret_version += 1;
    row.updated_at = this.now();
    return { subscription: this.publish(row), signing_secret: secret };
  }

  /** Test affordance: drop everything. Not on the interface — no production caller. */
  reset(): void {
    this.rows.clear();
  }
}
