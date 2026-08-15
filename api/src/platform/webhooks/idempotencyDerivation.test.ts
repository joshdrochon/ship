/**
 * PF-469 — the `Idempotency-Key` derivation, and the cost it accepts.
 *
 * ## Why this file exists rather than a line in `pipeline.test.ts`
 *
 * PF-469's row on `tickets/plugforge/lane-16-webhooks-delivery.md` states a
 * decision that is NOT what shipped: *"`idempotency_key = event.id`, verbatim"*,
 * with the fan-in collision it accepts documented as expected behaviour. L15 had
 * already shipped `idempotencyKeyFor(eventId, subscriptionId)` →
 * `` `${eventId}:${subscriptionId}` `` before this lane started, on a better
 * argument: keying on the event alone gives **two unrelated apps that happen to
 * share a target URL** the same key, and a subscriber doing its job deduplicates
 * one of them away — silently dropping a delivery for an integration that never
 * heard of the other one. Neither developer can detect that.
 *
 * L16's audit notes record the adoption. What did NOT exist until this file is a
 * test for either half of the shipped decision:
 *
 *   - `pipeline.test.ts` "the idempotency key is (event, subscription) and is
 *     stable" asserts two subscriptions get DIFFERENT keys — but it gives them
 *     two different `target_url`s, so it is silent on the case PF-469 was
 *     actually reasoning about, and silent on the departure itself.
 *   - nothing anywhere asserts the key is not `event.id`, so the "fix" back to
 *     PF-469's literal text would pass the whole suite.
 *
 * So this file pins three things: the shape, the departure, and the cost.
 *
 * ## The cost the SHIPPED derivation accepts, stated
 *
 * PF-469's collision runs the other way once the subscription is in the key. One
 * app holding two subscriptions on the SAME target URL for the same event now
 * receives **two POSTs carrying two different keys**, and a subscriber
 * deduplicating on `Idempotency-Key` — exactly what `docs/architecture.md` tells
 * it to do — cannot collapse them. It sees one event twice.
 *
 * That is a real cost and it is the right one to pay: the fan-in case is one
 * app's own duplicate subscription, which its operator can see in the portal and
 * delete, whereas PF-469's collision is invisible to both of the two parties it
 * silently harms. The asymmetry is the whole argument, and it is asserted below
 * rather than left in a comment.
 *
 * No `setTimeout` and no wall-clock anywhere — `FakeClock` only, per p.11.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InProcessEventBus } from './bus.js';
import { FakeClock } from '../clock.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from './secretCipher.js';
import { InMemoryWebhookSubscriptionRepo } from './inMemorySubscriptionRepo.js';
import { SignatureSigner } from './signer.js';
import { DuplicateSubscriptionError } from './subscriptions.js';
import { createWebhookPipeline, idempotencyKeyFor, RecordingDeliveryQueue } from './pipeline.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x4d));
const WS = '11111111-1111-4111-8111-111111111111';
const APP = '33333333-3333-4333-8333-333333333333';
const OTHER_APP = '77777777-7777-4777-8777-777777777777';
const AUTHOR = '44444444-4444-4444-8444-444444444444';
const DOC = '66666666-6666-4666-8666-666666666666';
const EVENT_ID = 'e0000000-0000-4000-8000-000000000001';

/** One target URL, used by every subscription in the fan-in cases below. */
const SHARED_TARGET = 'https://subscriber.test/hooks/inbox';

const T0_MS = 1_715_985_600_000;

interface Rig {
  bus: InProcessEventBus;
  repo: InMemoryWebhookSubscriptionRepo;
  queue: RecordingDeliveryQueue;
}

function rig(): Rig {
  const clock = new FakeClock(T0_MS);
  // The repository clock advances so two subscriptions created in one tick get
  // distinct `created_at`s. Same device `pipeline.test.ts` uses, same reason.
  const repoClock = (() => {
    const fake = new FakeClock(T0_MS);
    return {
      nowMs: () => {
        fake.advance(1000);
        return fake.nowMs();
      },
    };
  })();
  const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock: repoClock });
  const queue = new RecordingDeliveryQueue();
  const bus = new InProcessEventBus({ clock, newId: () => EVENT_ID });
  bus.subscribe('*', createWebhookPipeline({ repo, signer: new SignatureSigner(clock), queue }));
  return { bus, repo, queue };
}

let r: Rig;
beforeEach(() => {
  r = rig();
});

function subscribe(over: { app_id?: string; target_url?: string } = {}) {
  return r.repo.create({
    app_id: over.app_id ?? APP,
    workspace_id: WS,
    user_id: AUTHOR,
    event: 'document.created',
    target_url: over.target_url ?? SHARED_TARGET,
  });
}

async function publish(): Promise<void> {
  await r.bus.publish({
    type: 'document.created',
    workspace_id: WS,
    data: {
      id: DOC,
      document_type: 'wiki',
      title: 'hello',
      parent_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_by: AUTHOR,
      visibility: 'workspace',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The derivation itself.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-469 — the derivation is (event, subscription), NOT event.id verbatim', () => {
  it('is exactly `${eventId}:${subscriptionId}` — readable, not hashed', () => {
    expect(idempotencyKeyFor('event-1', 'subscription-9')).toBe('event-1:subscription-9');
  });

  it('the key a first delivery carries is NOT the event id — PF-469 as written, refuted', async () => {
    const sub = await subscribe();
    await publish();

    const key = r.queue.jobs[0]!.idempotencyKey;
    // The assertion that makes reverting to PF-469's stated decision fail
    // loudly. Without it, `idempotencyKeyFor = (id) => id` passes every other
    // test in this package — `dlqAndReplay.test.ts` reads the key back off the
    // stored row, so it cannot see the derivation at all.
    expect(key).not.toBe(EVENT_ID);
    expect(key).toBe(`${EVENT_ID}:${sub.subscription.id}`);
    // Still derived from the event id, which is what the Webhook Pipeline
    // section of `docs/architecture.md` claims — from it AND the subscription.
    expect(key.startsWith(`${EVENT_ID}:`)).toBe(true);
  });

  it('is deterministic — the same pair re-derives the same key', () => {
    const a = idempotencyKeyFor(EVENT_ID, 'subscription-1');
    const b = idempotencyKeyFor(EVENT_ID, 'subscription-1');
    expect(a).toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The collision PF-469 would have accepted, and the one the shipped
// derivation accepts instead. Both asserted; the asymmetry is the argument.
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-469 — the collision AVOIDED: two apps, one shared target URL', () => {
  it('two different apps subscribed to the same URL get DIFFERENT keys', async () => {
    const mine = await subscribe({ app_id: APP, target_url: SHARED_TARGET });
    const theirs = await subscribe({ app_id: OTHER_APP, target_url: SHARED_TARGET });
    await publish();

    const byApp = new Map(
      r.queue.jobs.map((j) => [j.subscriptionId, j.idempotencyKey] as const),
    );
    expect(byApp.size).toBe(2);
    expect(byApp.get(mine.subscription.id)).not.toBe(byApp.get(theirs.subscription.id));

    // Under PF-469's stated derivation both of these would have been `EVENT_ID`,
    // and a subscriber deduplicating correctly would have dropped one — for an
    // app that never heard of the other. That is the case L15's derivation
    // exists to prevent, and this is where it is checked.
    expect([...byApp.values()].every((k) => k !== EVENT_ID)).toBe(true);
  });
});

describe('PF-469 — the fan-in case is UNREACHABLE, under either derivation', () => {
  /**
   * Measured, not assumed. PF-469's row reasons at length about *"one subscriber
   * holding two subscriptions matching the same event at the same target URL"*
   * and decides to accept the resulting collision as *"a subscriber
   * misconfiguration we would be papering over"*.
   *
   * It cannot be created. `IWebhookSubscriptionRepo.create` refuses the
   * `(app, event, target_url)` triple outright — PF-431's uniqueness rule, in
   * both implementations. So the case the ticket weighed does not exist on this
   * surface at all, and the derivation was never the thing standing between a
   * subscriber and a duplicated event: the subscription table is.
   *
   * That is why the departure from PF-469's stated decision costs nothing. It
   * removes a collision that WAS reachable (two apps, one URL, above) and gives
   * up an accommodation for a case the repository already forbids.
   */
  it('a second subscription on the same (app, event, target) is REFUSED', async () => {
    await subscribe({ target_url: SHARED_TARGET });
    await expect(subscribe({ target_url: SHARED_TARGET })).rejects.toThrow(
      DuplicateSubscriptionError,
    );
  });

  it('F212 — the refusal does not claim the two would share an idempotency key', async () => {
    await subscribe({ target_url: SHARED_TARGET });
    const error = await subscribe({ target_url: SHARED_TARGET }).catch((e: unknown) => e);

    // The message reaches a public API consumer verbatim: `webhooks/routes.ts`
    // puts it on the 422 as the `target_url` field message. It used to read
    // "…under the same idempotency key, which the subscriber cannot tell from a
    // retry", which is PF-469's superseded derivation stated as fact. Under the
    // shipped derivation the two keys DIFFER — which is a stronger reason to
    // refuse, because nothing absorbs the duplicate.
    expect(error).toBeInstanceOf(DuplicateSubscriptionError);
    const message = (error as Error).message;
    expect(message).not.toContain('same idempotency key');
    expect(message).toContain('different Idempotency-Key values');
  });

  it('and had it been reachable, the two deliveries would carry different keys', () => {
    // The counterfactual, asserted against the derivation directly rather than
    // through a repository that will not build the fixture. This is the cost the
    // shipped decision accepts, stated where a reader will find it: a subscriber
    // could not have deduplicated them.
    const a = idempotencyKeyFor(EVENT_ID, 'subscription-1');
    const b = idempotencyKeyFor(EVENT_ID, 'subscription-2');
    expect(a).not.toBe(b);
  });
});
