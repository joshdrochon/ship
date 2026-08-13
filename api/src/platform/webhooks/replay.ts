/**
 * PF-475 – PF-479, PF-484 — replay, and the boot-time re-drive.
 *
 * PRD p.4, Replay: *"/api/v1/webhooks/deliveries/:id/replay re-emits a logged
 * event. Idempotency-Key header passed through so subscribers can dedupe."*
 * PRD p.4, Dead-Letter Queue: *"Operators can replay manually; replays carry
 * the original idempotency key."*
 *
 * The service, not the route. The route (`deliveries.routes.ts`) does HTTP; this
 * does the domain work, so the lane-wide rule that `platform/api/v1/**` contains
 * no SQL and no signing holds without the handler having to be careful.
 *
 * ─── Why the replayed bytes come from the LOG and not from the document ──────
 *
 * `raw_body` (migration 051) stores the exact signed envelope. Replay POSTs
 * those bytes. The alternative — re-deriving the envelope from `event_id` at
 * replay time — reads CURRENT document state, so a replay of `document.created`
 * for a since-renamed document would deliver a DIFFERENT body under the ORIGINAL
 * idempotency key. A subscriber that correctly deduped the first delivery never
 * sees the change; one that did not sees two different payloads claiming to be
 * one event. And `document.deleted` cannot be derived at all — finding F10
 * established the delete is a hard delete.
 *
 * The SIGNATURE is recomputed at send time with a fresh `t` and the
 * subscription's CURRENT secret (L15 PF-442/PF-443), which is what makes a
 * replay verifiable rather than expired. Bytes from the log, signature from now.
 */
import type { SignatureSigner } from './signer.js';
import type { IWebhookSubscriptionRepo } from './subscriptions.js';
import type { DeliveryJob } from './pipeline.js';
import { idempotencyKeyFor } from './pipeline.js';
import type { DeliveryRecord, IDeliveryLog } from './deliveryLog.js';
import type { DeliveryRequest } from './deliverer.js';
import type { ReplayContext, RetryScheduler } from './retry.js';
import type { Clock } from '../clock.js';

/** The delivery id does not exist, or belongs to another app. Never distinguished. */
export class DeliveryNotFoundError extends Error {
  constructor(readonly deliveryId: string) {
    super(`No webhook delivery ${deliveryId}.`);
    this.name = 'DeliveryNotFoundError';
  }
}

/** PF-476 — an in-flight delivery has not finished; replaying it would race. */
export class DeliveryNotTerminalError extends Error {
  constructor(readonly status: string) {
    super(
      `This delivery is ${status}. A replay of an attempt that has not finished would race ` +
        `the attempt already in progress and produce two live ladders under one idempotency ` +
        `key. Wait for it to reach a terminal status.`,
    );
    this.name = 'DeliveryNotTerminalError';
  }
}

/** The subscription was deleted outright, so there is nowhere to replay to. */
export class SubscriptionGoneError extends Error {
  constructor(readonly subscriptionId: string) {
    super(
      `Subscription ${subscriptionId} no longer exists, so this delivery cannot be ` +
        `replayed. Deactivating a subscription keeps the row (PF-426) precisely so the ` +
        `delivery log stays resolvable; this one was removed with its app.`,
    );
    this.name = 'SubscriptionGoneError';
  }
}

export interface ReplayDeps {
  log: IDeliveryLog;
  repo: IWebhookSubscriptionRepo;
  signer: SignatureSigner;
  scheduler: Pick<RetryScheduler, 'driveExisting'>;
  clock: Clock;
  newGroupId: () => string;
}

export class ReplayService {
  constructor(private readonly deps: ReplayDeps) {}

  /**
   * PF-476/PF-477 — replay one delivery, returning the NEW attempt-1 record.
   *
   * The new record is created synchronously, before the HTTP call, so the route
   * has something to return; the ladder then runs fire-and-forget. That is the
   * same PF-459 ordering every other attempt uses, for the same reason.
   *
   * **Replayable from ANY terminal status, not only `dead_lettered`.** p.4 says
   * *"re-emits a logged event"* without restricting it, and an operator
   * debugging a subscriber that returned 200-but-mishandled has no other tool.
   */
  async replay(appId: string, deliveryId: string): Promise<DeliveryRecord> {
    const original = await this.deps.log.getById(appId, deliveryId);
    // PF-478 — a foreign id and a nonexistent id are the SAME error. A 403 for
    // the first would confirm the id exists, which turns the replay endpoint
    // into an enumeration oracle over every other developer's delivery ids.
    if (!original) throw new DeliveryNotFoundError(deliveryId);
    if (original.status === 'in_flight') throw new DeliveryNotTerminalError(original.status);

    const rawBody = await this.deps.log.getRawBody(appId, deliveryId);
    if (!rawBody) throw new DeliveryNotFoundError(deliveryId);

    const subscription = await this.deps.repo.getById(appId, original.subscription_id);
    if (!subscription) throw new SubscriptionGoneError(original.subscription_id);

    // PF-477 — the key is COPIED VERBATIM from the original row, never
    // recomputed. That is the whole of Testing Scenario 8's last clause, and
    // PF-470's persist-then-read design is what makes it survive any future
    // change to the derivation.
    const replay: ReplayContext = {
      replayOfDeliveryId: original.id,
      idempotencyKey: original.idempotency_key,
    };

    const groupId = this.deps.newGroupId();
    const request = await this.sign(subscription.id, subscription.workspace_id, subscription.event, {
      targetUrl: subscription.target_url,
      rawBody,
      idempotencyKey: original.idempotency_key,
      eventId: original.event_id,
    });

    const row = await this.deps.log.beginAttempt({
      delivery_group_id: groupId,
      subscription_id: original.subscription_id,
      event_id: original.event_id,
      event_type: original.event_type,
      // A replay is a NEW ladder: it starts at attempt 1 and gets the full six.
      // A replay against a still-broken subscriber retries and re-dead-letters;
      // it is not a single shot.
      attempt_number: 1,
      idempotency_key: original.idempotency_key,
      signature_header: request.signatureHeader,
      replay_of_delivery_id: original.id,
      raw_body: rawBody,
      attempted_at: new Date(this.deps.clock.nowMs()).toISOString(),
    });

    const job: DeliveryJob = {
      subscriptionId: original.subscription_id,
      eventId: original.event_id,
      eventType: original.event_type,
      targetUrl: subscription.target_url,
      idempotencyKey: original.idempotency_key,
      request,
      // Re-signed per attempt against the CURRENT secret, exactly as L15's
      // pipeline does — and `null` when the subscription has been deactivated
      // since, which abandons the ladder rather than dead-lettering it.
      resign: async () => {
        const current = await this.deps.repo.getById(appId, original.subscription_id);
        if (!current || !current.active) return null;
        return this.sign(current.id, current.workspace_id, current.event, {
          targetUrl: current.target_url,
          rawBody,
          idempotencyKey: original.idempotency_key,
          eventId: original.event_id,
        });
      },
    };

    this.deps.scheduler.driveExisting(job, row, replay);

    // The ORIGINAL row is left untouched, so the DLQ keeps its history instead
    // of mutating a failure into a success. A replay is a new fact, not an edit.
    return row;
  }

  // PF-484's boot re-drive is NOT here, and the reason is a missing seam rather
  // than a missing intention. Resuming an interrupted ladder needs the
  // subscription's target URL and its decrypted secret, and every read on
  // `IWebhookSubscriptionRepo` is app-scoped by design (PF-432) — correctly, but
  // a boot handler has no app context and no request to derive one from. The
  // delivery row knows its `app_id` (migration 051) but that column is
  // deliberately not projected onto `DeliveryRecord`, because it is a
  // storage-and-index concern rather than something every reader should hold.
  //
  // Closing the gap means one of: projecting `app_id` onto the record, or adding
  // an unscoped `findByIdForSystem` to L15's port. Both are defensible and
  // neither should be chosen unilaterally mid-build — the second widens another
  // lane's port, and the first weakens a projection this lane argued for two
  // slices ago. Filed as F64 rather than stubbed: a `redriveInterrupted()` that
  // returned a count and drove nothing would make PF-459's whole
  // write-before-attempt design look proven when it is only half-used.

  /** One attempt's signed request. The signature is minted HERE and now. */
  private async sign(
    subscriptionId: string,
    workspaceId: string,
    eventType: string,
    parts: { targetUrl: string; rawBody: Buffer; idempotencyKey: string; eventId: string },
  ): Promise<DeliveryRequest> {
    // The CURRENT secret, re-read per attempt, exactly as L15's pipeline does
    // (PF-442/PF-443). `findActiveByEventType` is the only read on the port that
    // decrypts — deliberately, so the one caller that gets a secret is the one
    // about to compute an HMAC with it. An inactive subscription yields no match
    // and this throws, which is the correct outcome: signing for a subscription
    // the operator switched off would deliver to a target nobody is expecting.
    const matches = await this.deps.repo.findActiveByEventType(workspaceId, eventType);
    const match = matches.find((m) => m.subscription.id === subscriptionId);
    if (!match) throw new SubscriptionGoneError(subscriptionId);
    const signed = this.deps.signer.sign(match.signing_secret, parts.rawBody);
    return {
      targetUrl: parts.targetUrl,
      // The same buffer object, not a copy and not a re-serialization (PF-436).
      rawBody: parts.rawBody,
      signatureHeader: signed.header,
      signedAtSeconds: signed.timestamp,
      idempotencyKey: parts.idempotencyKey,
      eventId: parts.eventId,
      subscriptionId,
    };
  }
}

/** Derives the key the way the pipeline does. Exported so a test can compare. */
export { idempotencyKeyFor };
