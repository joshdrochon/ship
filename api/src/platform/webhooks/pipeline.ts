/**
 * The subscription matcher and the bus handler — event in, signed request out.
 *
 * Tickets: PF-440 (the matcher), PF-441 (sign and hand off, never await the
 * wire), PF-442 (signed at send time, per attempt), PF-443 (rotation
 * mid-flight), and decision **D7**'s private-document gate.
 *
 * This is the `subscription matcher` node the pipeline figure in
 * `docs/architecture.md` shows, and it is the last thing L15 owns: the HTTP
 * courier, the retry ladder, the delivery log, the DLQ and replay are L16's.
 *
 * ## The contract with the bus (dispute B2, settled in `bus.ts`)
 *
 * `InProcessEventBus.publish()` awaits every handler, and the publish sits on
 * the request path after commit. So this handler does in-process bookkeeping —
 * match, serialize, sign, enqueue — and returns. **It never awaits the wire.**
 * If it did, a subscriber's latency would be inside `POST /api/v1/documents`'s
 * P95 and MVP-9's +10% budget would be a third party's to blow rather than
 * ours. p.6's 2 s target is on *webhook delivery*, measured from the event —
 * not on API latency, and conflating them is how both numbers get missed.
 *
 * ## D7 — THE PRIVATE-DOCUMENT GATE. This is the piece only L15 can enforce.
 *
 * L14's D7 decided the payload is the resource's public API representation and
 * added `visibility` to it specifically so that this function can gate without a
 * database read. Quoting the decision: *"the bus is in-process and is NOT the
 * exposure boundary — L15's matcher is."*
 *
 * The rule: **a private document's event may only be delivered to a subscription
 * whose consenting user could have `GET`ed that document.** With `visibility`
 * and `created_by` both on the payload and `user_id` on the subscription, that
 * is a comparison of three values already in hand.
 *
 * Why it cannot be a database read: `document.deleted` fires for a HARD delete
 * (finding F10). By the time this handler runs there is no row to check an ACL
 * against — the envelope is the only surviving record of the document. A gate
 * that needed the row would work for two of the three `document.*` events and
 * silently fail open on the third, which is the one carrying a deleted private
 * document's title.
 *
 * ### What is NOT implemented, and why — read this before "fixing" it
 *
 * D7's sentence has a second clause: *"or that user is a workspace admin"*. It
 * is deliberately absent, and the gate fails CLOSED without it.
 *
 * Two reasons. First, it needs a `workspace_memberships` read per (event ×
 * subscription) on the request path — the exact cost this gate was designed to
 * avoid, and it would reintroduce a database dependency into a function whose
 * whole value is not having one. Second, and more important: "an admin
 * subscribed a webhook, therefore every private document in the workspace is
 * fanned out to that URL" is a surprising default that nobody asked for. Nothing
 * in the PRD requires it. The conservative reading loses an admin some events
 * they could have read by hand; the permissive one ships other people's private
 * titles to a third-party endpoint. Those are not symmetric mistakes.
 *
 * If the admin branch is ever wanted, it belongs behind an explicit
 * per-subscription opt-in recorded on the row, not behind a membership lookup —
 * so that "this subscription receives private documents" is a fact somebody
 * decided rather than a consequence of a role.
 */
import type { EventEnvelope } from './events.js';
import type { EventHandler } from './bus.js';
import type { DeliveryRequest, IWebhookDeliverer } from './deliverer.js';
import { envelopeToRawBody } from './deliverer.js';
import { SignatureSigner } from './signer.js';
import type {
  IWebhookSubscriptionRepo,
  SubscriptionMatch,
  WebhookSubscription,
} from './subscriptions.js';

/**
 * The authorization-relevant fields a payload may carry.
 *
 * Read defensively rather than parsed: the envelope was already validated
 * against the registry inside `publish()` (PF-393), and re-parsing here would
 * be a second schema this lane would own.
 */
interface GateInput {
  visibility?: unknown;
  created_by?: unknown;
}

export type GateOutcome = 'deliver' | 'private-not-owner' | 'unknown-visibility';

/**
 * D7's gate. Pure, synchronous, no I/O — deliberately, so it can be unit-tested
 * exhaustively and so `document.deleted` is not a special case.
 *
 * `unknown-visibility` is a distinct outcome from `private-not-owner` because
 * they mean different things operationally: the first says a producer emitted a
 * payload this gate does not understand (a bug on our side, and a loud one), the
 * second says the gate did its job. Collapsing them would hide a producer
 * regression as ordinary filtering.
 */
export function gateSubscription(
  data: unknown,
  subscription: Pick<WebhookSubscription, 'user_id'>,
): GateOutcome {
  const payload = (data ?? {}) as GateInput;

  if (payload.visibility === 'workspace') return 'deliver';

  // Anything that is not the literal `'private'` is also not deliverable. Fail
  // CLOSED on an absent or unrecognised value: L14's `visibilityOf` already
  // narrows to the two literals before publishing, so a third value here means
  // a producer is emitting a shape nobody registered.
  if (payload.visibility !== 'private') return 'unknown-visibility';

  const author = payload.created_by;
  // A null author or a null subscriber is not a match. `null === null` would be
  // true in JavaScript and would deliver EVERY authorless private document to
  // EVERY machine-to-machine subscription, which is the one case that must not
  // pass by accident.
  if (typeof author !== 'string' || typeof subscription.user_id !== 'string') {
    return 'private-not-owner';
  }
  return author === subscription.user_id ? 'deliver' : 'private-not-owner';
}

// ─────────────────────────────────────────────────────────────────────────────
// The L15 → L16 seam
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One event, bound for one subscription. **This is what L16 consumes.**
 *
 * `request` is attempt 1, already signed at hand-off (PF-441). `resign()` builds
 * the request for any LATER attempt: a fresh `t` from the clock and the
 * subscription's CURRENT secret, re-read from the repository (PF-442, PF-443).
 *
 * The split is the whole design. Signing once at enqueue and reusing that header
 * would make every retry carry the original `t` — so a delivery still retrying
 * after the 300 s window would be rejected by its own subscriber as a replay,
 * and the retry ladder's 30-minute tail (p.4) would be entirely wasted. Signing
 * per attempt is also what gives "a secret rotated mid-flight" a defined
 * outcome instead of an accident.
 */
export interface DeliveryJob {
  subscriptionId: string;
  eventId: string;
  eventType: string;
  targetUrl: string;
  /** Stable across every attempt and every replay. See `idempotencyKeyFor`. */
  idempotencyKey: string;
  /** Attempt 1, fully signed before this job was handed over. */
  request: DeliveryRequest;
  /**
   * Attempt 2..N. Returns `null` when the subscription has been deactivated or
   * removed since — a subscriber who unsubscribed mid-ladder should stop
   * receiving retries, and `null` is how L16 learns to abandon rather than
   * dead-letter.
   */
  resign(): Promise<DeliveryRequest | null>;
}

/**
 * Where a signed job goes. L15 hands over; L16 owns what happens next.
 *
 * `enqueue` returns `void` and MUST NOT be awaited by the bus handler — that is
 * the shape of PF-441's rule, expressed in a type.
 */
export interface IDeliveryQueue {
  enqueue(job: DeliveryJob): void;
}

/**
 * The delivery's identity: this event, to this subscription.
 *
 * Derived from `event_id` (PF-394's invariant) AND the subscription, because one
 * event legitimately produces N deliveries. Keying on the event alone would give
 * two apps that happen to share a target URL the same key, and a subscriber
 * doing its job would dedupe one of them away — silently dropping a delivery for
 * an integration that never heard of the other one.
 *
 * Deterministic and readable rather than hashed: a developer reading a delivery
 * log should be able to see which event and which subscription a row is about
 * without a lookup. It is not a secret and nothing authenticates with it.
 */
export function idempotencyKeyFor(eventId: string, subscriptionId: string): string {
  return `${eventId}:${subscriptionId}`;
}

export interface PipelineDeps {
  repo: IWebhookSubscriptionRepo;
  signer: SignatureSigner;
  queue: IDeliveryQueue;
  /** Where a gate rejection or a signing failure is reported. */
  logger?: Pick<Console, 'error' | 'warn'>;
}

export interface PipelineResult {
  matched: number;
  gated: number;
  enqueued: number;
}

/**
 * PF-440/PF-441 — the bus handler.
 *
 * Subscribe it with `bus.subscribe('*', handler)`: it filters by looking the
 * event type up in the subscription table, which is where the closed set of
 * types already lives. A per-type subscription would mean eight registrations
 * that have to be kept in step with `EVENT_TYPES` — the copy PF-395 exists to
 * prevent.
 */
export function createWebhookPipeline(deps: PipelineDeps): EventHandler {
  const logger = deps.logger ?? console;

  return async function webhookPipelineHandler(event: EventEnvelope): Promise<void> {
    let matches: SubscriptionMatch[];
    try {
      matches = await deps.repo.findActiveByEventType(event.workspace_id, event.type);
    } catch (err) {
      // A decryption failure lands here (PF-422 fails closed). Logged and
      // swallowed: the bus already isolates handlers so a throw would not fail
      // the domain write, but reporting it HERE names the workspace and the
      // event, which the bus's generic message cannot.
      logger.error(
        `[webhooks] could not resolve subscriptions for ${event.type} in workspace ` +
          `${event.workspace_id}; NOTHING was delivered. If this is a decryption ` +
          `failure, WEBHOOK_SECRET_KEY is missing or wrong — deliveries fail closed ` +
          `rather than going out unsigned.`,
        err,
      );
      return;
    }

    // PF-440 — zero matches is the NORMAL case, not a fault. Almost every
    // workspace is unsubscribed. No throw, and no log line at error level:
    // an "error" per document create in an unsubscribed workspace would bury
    // the real ones.
    if (matches.length === 0) return;

    // PF-436 — serialized ONCE, here. Every subscription's signature is computed
    // over this same buffer, and this same buffer is what each of them receives.
    const rawBody = envelopeToRawBody(event);

    for (const match of matches) {
      const outcome = gateSubscription(event.data, match.subscription);

      if (outcome === 'unknown-visibility') {
        // A producer emitted a payload without a recognisable `visibility`.
        // That is our bug, it is loud, and it fails closed.
        logger.warn(
          `[webhooks] ${event.type} (event ${event.id}) carries no recognisable ` +
            `\`visibility\`, so decision D7's gate cannot be evaluated and the event was ` +
            `NOT delivered to subscription ${match.subscription.id}. Every payload built ` +
            `by platform/webhooks/payloads.ts carries one; a payload here without it means ` +
            `a producer bypassed those builders.`,
        );
        continue;
      }
      if (outcome === 'private-not-owner') continue;

      const request = signedRequest(deps.signer, event, match, rawBody);

      deps.queue.enqueue({
        subscriptionId: match.subscription.id,
        eventId: event.id,
        eventType: event.type,
        targetUrl: match.subscription.target_url,
        idempotencyKey: request.idempotencyKey,
        request,
        // PF-442/PF-443 — the CURRENT secret, re-read per attempt, and a fresh
        // `t` from the clock. Closes over the ids only, never over the secret.
        resign: async () => {
          const current = await deps.repo.findActiveByEventType(
            event.workspace_id,
            event.type,
          );
          const still = current.find((m) => m.subscription.id === match.subscription.id);
          if (!still) return null;
          return signedRequest(deps.signer, event, still, rawBody);
        },
      });
    }
  };
}

/** Builds one attempt's signed request. The signature is minted HERE and now. */
function signedRequest(
  signer: SignatureSigner,
  event: EventEnvelope,
  match: SubscriptionMatch,
  rawBody: Buffer,
): DeliveryRequest {
  const signed = signer.sign(match.signing_secret, rawBody);
  return {
    targetUrl: match.subscription.target_url,
    // The same buffer object, not a copy and not a re-serialization.
    rawBody,
    signatureHeader: signed.header,
    signedAtSeconds: signed.timestamp,
    idempotencyKey: idempotencyKeyFor(event.id, match.subscription.id),
    eventId: event.id,
    subscriptionId: match.subscription.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Queues
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records jobs and delivers nothing. The double every L15 test uses.
 *
 * It exists so an assertion can be made about what was HANDED OVER rather than
 * about what was logged — PF-426's "an inactive subscription receives zero
 * deliveries" is checked against this array, not against a log line.
 */
export class RecordingDeliveryQueue implements IDeliveryQueue {
  readonly jobs: DeliveryJob[] = [];

  enqueue(job: DeliveryJob): void {
    this.jobs.push(job);
  }

  reset(): void {
    this.jobs.length = 0;
  }
}

/**
 * First attempt only, fire-and-forget. **L16 replaces this.**
 *
 * It is here because a signer with nothing to hand a signed request to cannot be
 * tested end-to-end, and because TS-6's server half needs one real delivery to
 * assert against. It has no retry ladder, no delivery log, no DLQ and no
 * circuit breaker — all of which are L16's (PF-451–490).
 *
 * `void this.dispatch(job)` and not `await`: that is PF-441. `settled()` exists
 * so a test can wait for the in-flight promises WITHOUT a timer — it awaits the
 * promises themselves, which is deterministic, where a `setTimeout(0)` would be
 * a guess that usually works.
 */
export class ImmediateDeliveryQueue implements IDeliveryQueue {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly deliverer: IWebhookDeliverer,
    private readonly logger: Pick<Console, 'error'> = console,
  ) {}

  enqueue(job: DeliveryJob): void {
    const promise = this.deliverer
      .deliver(job.request)
      .then(() => undefined)
      .catch((err: unknown) => {
        // Swallowed on purpose. An unhandled rejection from a fire-and-forget
        // delivery would crash the process under Node's default policy, which
        // would mean a broken subscriber can take Ship down.
        this.logger.error(
          `[webhooks] delivery of event ${job.eventId} to subscription ` +
            `${job.subscriptionId} threw. There is no retry here — the ladder, the ` +
            `delivery log and the DLQ are L16's.`,
          err,
        );
      })
      .finally(() => {
        this.inFlight.delete(promise);
      });
    this.inFlight.add(promise);
  }

  /** Await every in-flight delivery. Tests only; no production caller. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /** How many deliveries have not settled. Lets a test assert "still pending". */
  pendingCount(): number {
    return this.inFlight.size;
  }
}
