/**
 * Resource client: webhook subscriptions — PF-524, PF-525.
 *
 * p.3: *"Per-app per-event-type subscriptions. Target URL, hashed signing
 * secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage
 * scope)."*
 *
 * Every one of the six methods needs `webhooks:manage`, INCLUDING the two reads.
 * A token without it gets `{ kind: 'auth', code: 'forbidden' }` and
 * `error.requiredScope === 'webhooks:manage'` — the SDK surfaces the scope
 * failure rather than flattening it, which is what lets a consumer re-consent
 * for the right scope instead of guessing.
 *
 * ── PF-525: the secret is TWO TYPES, not one optional field ─────────────────
 * p.8's Subscribe stage: *"Subscription persisted; signing secret returned
 * once"*. p.7's drill reads `sub.signing_secret` straight off the create
 * response and hands it to `verifyWebhook`.
 *
 * So `create()` and `rotate()` return `WebhookSubscriptionWithSecret` and
 * `list()` / `get()` / `update()` / `delete()` return `WebhookSubscription`,
 * which has no `signing_secret` at all. One type with `signing_secret?: string`
 * would compile this:
 *
 *     const [sub] = (await client.webhooks.list()).data;
 *     verifyWebhook(headers, body, sub.signing_secret!);   // always undefined
 *
 * and that fails at 3am against a live subscriber. Two types make it a
 * `pnpm type-check` failure at the keyboard. `typeProofs/secretOnce.ts` pins
 * both directions.
 */
import type { Transport } from '../transport.js';
import { ResourceClient } from './base.js';

/**
 * The eight event types a subscription may name.
 *
 * Restated rather than imported for the same reason `errors.ts` restates the
 * server's code list: `sdk/**` may import nothing from this repository (ESLint
 * fence 4 / L99 F24). A test in `api/` asserts this array is string-equal to the
 * server's `EVENT_TYPES`, so a ninth type fails by name rather than by a
 * consumer's 422.
 */
export const SHIP_EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const;

export type ShipEventType = (typeof SHIP_EVENT_TYPES)[number];

/** The READ projection. There is no secret in it, by construction. */
export const WEBHOOK_SUBSCRIPTION_FIELDS = [
  'id',
  'event',
  'target_url',
  'active',
  'secret_prefix',
  'secret_version',
  'created_at',
  'updated_at',
  'deactivated_at',
] as const;

export interface WebhookSubscription {
  id: string;
  event: ShipEventType;
  target_url: string;
  active: boolean;
  /** The first 8 characters — says WHICH secret without holding one. */
  secret_prefix: string;
  secret_version: number;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
}

/** The read projection plus the one field only `create` and `rotate` return. */
export const WEBHOOK_SUBSCRIPTION_WITH_SECRET_FIELDS = [
  ...WEBHOOK_SUBSCRIPTION_FIELDS,
  'signing_secret',
] as const;

/**
 * The create/rotate response — the ONLY shape in this SDK carrying a raw secret.
 *
 * Capture it here. There is no endpoint that returns it again; a lost secret is
 * rotated, not retrieved (p.2).
 */
export interface WebhookSubscriptionWithSecret extends WebhookSubscription {
  signing_secret: string;
}

/** `POST /webhooks`. Both fields required — a subscription is one event type. */
export const CREATE_WEBHOOK_FIELDS = ['event', 'target_url'] as const;

export interface CreateWebhookInput {
  event: ShipEventType;
  /** Absolute `https`, and not into private address space. */
  target_url: string;
}

/**
 * `PATCH /webhooks/{id}`. `active` is the only mutable field, and it is
 * required.
 *
 * `event` and `target_url` are immutable server-side: mutating a target in place
 * would silently redirect an existing signing secret to a new host. Changing a
 * target is `delete()` then `create()`, which mints a new secret.
 */
export const UPDATE_WEBHOOK_FIELDS = ['active'] as const;

export interface UpdateWebhookInput {
  active: boolean;
}

export class WebhooksClient extends ResourceClient<WebhookSubscription> {
  constructor(transport: Transport) {
    super(transport, '/webhooks');
  }

  /** Returns the signing secret EXACTLY ONCE. Capture it. */
  create(input: CreateWebhookInput): Promise<WebhookSubscriptionWithSecret> {
    return this.transport.request<WebhookSubscriptionWithSecret>('POST', this.collectionPath, {
      body: input,
    });
  }

  /** Activate or deactivate. */
  update(id: string, input: UpdateWebhookInput): Promise<WebhookSubscription> {
    return this.transport.request<WebhookSubscription>('PATCH', this.itemPath(id), { body: input });
  }

  /**
   * Deactivate. Idempotent, and the row is retained so the delivery log keeps a
   * resolvable `subscription_id` after a subscriber walks away.
   */
  delete(id: string): Promise<WebhookSubscription> {
    return this.transport.request<WebhookSubscription>('DELETE', this.itemPath(id));
  }

  /**
   * Mint a new signing secret. The previous one stops verifying immediately —
   * there is no grace period, and the delivery retry ladder is what covers the
   * window while a subscriber updates its environment.
   */
  rotate(id: string): Promise<WebhookSubscriptionWithSecret> {
    return this.transport.request<WebhookSubscriptionWithSecret>(
      'POST',
      `${this.itemPath(id)}/rotate`,
    );
  }
}
