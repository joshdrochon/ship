/**
 * PF-427 — `IWebhookSubscriptionRepo`, its row type, and the in-memory double.
 *
 * This is the `subsRepo(db)` argument the composition-root sketch p.12 requires
 * the architecture document to show, alongside the OAuth, rate-limiter,
 * event-bus and webhook-deliverer wiring — and its in-memory sibling.
 *
 * ## No Express and no `pg` in any signature
 *
 * Deliberate, and asserted by `subscriptions.test.ts` importing this module in a
 * bare Node context with no HTTP stack loaded. A repository that took a
 * `Request` would make the matcher — which runs from a bus handler with no
 * request in sight — unable to use it, and a repository that returned `pg`'s
 * `QueryResult` would put node-postgres in the type of every consumer.
 *
 * ## The secret never appears on `WebhookSubscription`
 *
 * PF-424. The row type below has `secret_prefix` and no secret and no
 * ciphertext, so returning a subscription from any handler cannot leak one — not
 * because the handler is careful but because the value is not in the object.
 * The raw secret exists in exactly two places in this codebase: the return value
 * of `create()`/`rotateSecret()`, which carries it in a SEPARATE field the
 * caller has to destructure on purpose, and the argument to the signer.
 */
import type { EventType } from './events.js';

/**
 * A subscription as every reader sees it. No secret, no ciphertext.
 *
 * `event` rather than `event_type` on the wire — p.7's drill loop is
 * `client.webhooks.create({ event, target_url })`, singular — while the column
 * is `event_type`. The mapping happens in the repository so exactly one layer
 * knows both spellings.
 */
export interface WebhookSubscription {
  id: string;
  app_id: string;
  workspace_id: string;
  /** The consenting user of the token that created it, or null for m2m. */
  user_id: string | null;
  event: EventType;
  target_url: string;
  secret_prefix: string;
  secret_version: number;
  active: boolean;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
}

/**
 * What `create()` and `rotateSecret()` return: the subscription, plus the raw
 * secret, ONCE.
 *
 * A separate type rather than an optional field on `WebhookSubscription`,
 * because an optional `signing_secret?: string` is a field every read path would
 * have to remember to strip. Here the strip is structural: a `WebhookSubscription`
 * simply has nowhere to put one.
 */
export interface WebhookSubscriptionWithSecret {
  subscription: WebhookSubscription;
  /** Shown exactly once. Never persisted in this form (PF-422/PF-423). */
  signing_secret: string;
}

export interface CreateSubscriptionInput {
  app_id: string;
  workspace_id: string;
  user_id: string | null;
  event: EventType;
  target_url: string;
}

/**
 * A match, as the matcher needs it: the subscription plus the secret to sign
 * with, decrypted at read time.
 *
 * The secret is on THIS type and not on `WebhookSubscription` for the reason
 * above — the only caller that gets one is the one that is about to compute an
 * HMAC with it.
 */
export interface SubscriptionMatch {
  subscription: WebhookSubscription;
  signing_secret: string;
}

/** Keyset page over subscriptions, in the shape L08's `sliceToPage` consumes. */
export interface SubscriptionPageQuery {
  app_id: string;
  limit: number;
  cursor: { timestamp: string; id: string } | null;
}

export interface IWebhookSubscriptionRepo {
  /** Mints the secret, encrypts it, inserts the row. Returns the raw secret once. */
  create(input: CreateSubscriptionInput): Promise<WebhookSubscriptionWithSecret>;

  /**
   * One subscription, scoped to the owning app.
   *
   * `app_id` is a PARAMETER and not a filter the caller applies afterwards.
   * PF-432 requires another app's id to be `not_found` rather than `forbidden`,
   * and the only way to make that structural is for the repository to be unable
   * to return a row it was not asked for.
   */
  getById(appId: string, id: string): Promise<WebhookSubscription | null>;

  /** Cursor-paginated, newest first, scoped to one app. Returns `limit` rows at most. */
  listByApp(query: SubscriptionPageQuery): Promise<WebhookSubscription[]>;

  /**
   * PF-440's query: every ACTIVE subscription for one workspace and one event
   * type, with its secret decrypted.
   *
   * Zero matches is `[]` and is the normal case, not an error — an unsubscribed
   * workspace is what almost every workspace is.
   */
  findActiveByEventType(workspaceId: string, event: string): Promise<SubscriptionMatch[]>;

  /**
   * PF-426 — `active = false` plus `deactivated_at`, never a `DELETE`.
   *
   * Idempotent: deactivating an already-deactivated subscription returns it
   * unchanged rather than throwing, so `DELETE` can answer the same status
   * twice (PF-431).
   */
  deactivate(appId: string, id: string): Promise<WebhookSubscription | null>;

  /** Reactivate. Explicitly does NOT backfill events published while inactive. */
  setActive(appId: string, id: string, active: boolean): Promise<WebhookSubscription | null>;

  /** New secret, `secret_version + 1`, old secret dead immediately (PF-433). */
  rotateSecret(appId: string, id: string): Promise<WebhookSubscriptionWithSecret | null>;
}

/** Thrown when the unique (app, event, target) triple already exists. */
export class DuplicateSubscriptionError extends Error {
  constructor(
    readonly event: string,
    readonly targetUrl: string,
  ) {
    // ⚑ The second sentence used to read "…under the same idempotency key,
    // which the subscriber cannot tell from a retry." That was true only under
    // PF-469's original derivation (`idempotency_key = event.id`, verbatim) and
    // is FALSE against the derivation that shipped: `idempotencyKeyFor` keys on
    // (event, subscription), so two subscriptions get two DIFFERENT keys.
    //
    // The correction strengthens the guard rather than weakening it. Under the
    // old wording the subscriber's own deduplication would have absorbed the
    // duplicate; under the shipped derivation nothing absorbs it, so the second
    // POST is a genuine duplicate delivery the subscriber has no mechanical way
    // to recognise. This message reaches a public API consumer verbatim —
    // `webhooks/routes.ts` puts it on the 422 — so it has to be true.
    // Recorded as F212.
    super(
      `This app already has a subscription for "${event}" pointed at ${targetUrl}. ` +
        `A second one would deliver the same event twice to the same URL, and the two ` +
        `deliveries carry different Idempotency-Key values, so the subscriber has no way ` +
        `to recognise the duplicate.`,
    );
    this.name = 'DuplicateSubscriptionError';
  }
}
