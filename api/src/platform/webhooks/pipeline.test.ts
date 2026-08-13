/**
 * PF-440 – PF-443, and decision D7's private-document gate.
 *
 * Everything here runs through the REAL `InProcessEventBus`, because the
 * property under test is what happens when a domain write publishes — not what
 * happens when someone calls the handler directly. No `setTimeout` anywhere; the
 * only clock is a `FakeClock`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InProcessEventBus } from './bus.js';
import { FakeClock } from '../clock.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from './secretCipher.js';
import { InMemoryWebhookSubscriptionRepo } from './inMemorySubscriptionRepo.js';
import { InMemoryDeliverer, type DeliveryRequest } from './deliverer.js';
import { SignatureSigner, verifySignature } from './signer.js';
import { eventEnvelopeSchema } from './events.js';
import {
  createWebhookPipeline,
  gateSubscription,
  idempotencyKeyFor,
  ImmediateDeliveryQueue,
  RecordingDeliveryQueue,
} from './pipeline.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x4d));
const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';
const AUTHOR = '44444444-4444-4444-8444-444444444444';
const SOMEONE_ELSE = '55555555-5555-4555-8555-555555555555';
const DOC = '66666666-6666-4666-8666-666666666666';

const T0_MS = 1_715_985_600_000;

interface Rig {
  bus: InProcessEventBus;
  repo: InMemoryWebhookSubscriptionRepo;
  queue: RecordingDeliveryQueue;
  clock: FakeClock;
}

function rig(): Rig {
  const clock = new FakeClock(T0_MS);
  // A separate, always-advancing clock for the repository so two subscriptions
  // created in the same tick still get distinct `created_at` values. The
  // SIGNER's clock is the fixed one — that is the clock under test.
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
  const bus = new InProcessEventBus({ clock, newId: () => 'e0000000-0000-4000-8000-000000000001' });
  bus.subscribe(
    '*',
    createWebhookPipeline({ repo, signer: new SignatureSigner(clock), queue }),
  );
  return { bus, repo, queue, clock };
}

function documentData(over: Record<string, unknown> = {}) {
  return {
    id: DOC,
    document_type: 'wiki',
    title: 'hello',
    parent_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: AUTHOR,
    visibility: 'workspace',
    ...over,
  };
}

let r: Rig;
beforeEach(() => {
  r = rig();
});

async function subscribe(over: Partial<{ target_url: string; event: string; user_id: string | null; workspace_id: string; app_id: string }> = {}) {
  return r.repo.create({
    app_id: over.app_id ?? APP,
    workspace_id: over.workspace_id ?? WS,
    user_id: over.user_id === undefined ? AUTHOR : over.user_id,
    event: (over.event ?? 'document.created') as 'document.created',
    target_url: over.target_url ?? 'https://example.test/hooks/a',
  });
}

async function publishDocumentCreated(over: Record<string, unknown> = {}, workspace = WS) {
  await r.bus.publish({
    type: 'document.created',
    workspace_id: workspace,
    data: documentData(over),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('PF-440 — the matcher', () => {
  it('three active subscriptions produce three requests, distinctly signed', async () => {
    const created = [
      await subscribe({ target_url: 'https://example.test/hooks/1' }),
      await subscribe({ target_url: 'https://example.test/hooks/2' }),
      await subscribe({ target_url: 'https://example.test/hooks/3' }),
    ];
    await publishDocumentCreated();

    expect(r.queue.jobs).toHaveLength(3);
    expect(new Set(r.queue.jobs.map((j) => j.subscriptionId)).size).toBe(3);

    // Three DISTINCT signatures over IDENTICAL bytes — because three distinct
    // secrets. If any two matched, one subscription's secret would verify
    // another's delivery.
    const signatures = r.queue.jobs.map((j) => j.request.signatureHeader);
    expect(new Set(signatures).size).toBe(3);
    for (const job of r.queue.jobs) {
      expect(Buffer.compare(job.request.rawBody, r.queue.jobs[0]!.request.rawBody)).toBe(0);
    }

    // …and each verifies under its OWN secret and no other.
    for (const sub of created) {
      const job = r.queue.jobs.find((j) => j.subscriptionId === sub.subscription.id)!;
      expect(
        verifySignature(sub.signing_secret, job.request.signatureHeader, job.request.rawBody, T0_MS / 1000),
      ).toBe(true);
      for (const other of created.filter((c) => c.subscription.id !== sub.subscription.id)) {
        expect(
          verifySignature(other.signing_secret, job.request.signatureHeader, job.request.rawBody, T0_MS / 1000),
        ).toBe(false);
      }
    }
  });

  it('zero matches is zero requests, no throw and no error log', async () => {
    const errors: unknown[] = [];
    const clock = new FakeClock(T0_MS);
    const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    const queue = new RecordingDeliveryQueue();
    const bus = new InProcessEventBus({ clock });
    bus.subscribe(
      '*',
      createWebhookPipeline({
        repo,
        signer: new SignatureSigner(clock),
        queue,
        logger: { error: (...a) => errors.push(a), warn: () => undefined },
      }),
    );

    // An unsubscribed workspace is what almost every workspace is. Logging an
    // error per document create would bury the real ones.
    await expect(
      bus.publish({ type: 'document.created', workspace_id: WS, data: documentData() }),
    ).resolves.toBeUndefined();
    expect(queue.jobs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('other event types and other workspaces are absent from the set', async () => {
    const wanted = await subscribe({ target_url: 'https://example.test/hooks/wanted' });
    await subscribe({ event: 'document.deleted', target_url: 'https://example.test/hooks/del' });
    await subscribe({ workspace_id: OTHER_WS, target_url: 'https://example.test/hooks/ws2' });

    await publishDocumentCreated();

    expect(r.queue.jobs.map((j) => j.subscriptionId)).toEqual([wanted.subscription.id]);
  });

  it('PF-426 — an inactive subscription receives ZERO requests, and no backfill on reactivation', async () => {
    const sub = await subscribe();
    await r.repo.deactivate(APP, sub.subscription.id);

    await publishDocumentCreated();
    // Asserted on the recorded hand-offs, not on a log line.
    expect(r.queue.jobs).toEqual([]);

    await r.repo.setActive(APP, sub.subscription.id, true);
    // Reactivation resumes matching; it does not replay what was missed. There
    // is no queue of skipped events and no API by which one could be recovered.
    expect(r.queue.jobs).toEqual([]);
    await publishDocumentCreated();
    expect(r.queue.jobs).toHaveLength(1);
  });

  it('the body is the registry-valid envelope, serialized once', async () => {
    await subscribe();
    await publishDocumentCreated();

    const body = JSON.parse(r.queue.jobs[0]!.request.rawBody.toString('utf8'));
    expect(eventEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(body.type).toBe('document.created');
    expect(body.data.id).toBe(DOC);
  });

  it('the idempotency key is (event, subscription) and is stable', async () => {
    const a = await subscribe({ target_url: 'https://example.test/hooks/a' });
    const b = await subscribe({ target_url: 'https://example.test/hooks/b' });
    await publishDocumentCreated();

    const keys = r.queue.jobs.map((j) => j.idempotencyKey);
    // Two subscriptions, one event: DIFFERENT keys. Keying on the event alone
    // would give two apps sharing a target URL the same key, and a subscriber
    // doing its job would dedupe one delivery away.
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain(idempotencyKeyFor('e0000000-0000-4000-8000-000000000001', a.subscription.id));
    expect(keys).toContain(idempotencyKeyFor('e0000000-0000-4000-8000-000000000001', b.subscription.id));
  });
});

describe('D7 — the private-document gate. The one piece only L15 can enforce.', () => {
  it('a workspace-visible document goes to every matching subscription', async () => {
    await subscribe({ user_id: SOMEONE_ELSE });
    await publishDocumentCreated({ visibility: 'workspace' });
    expect(r.queue.jobs).toHaveLength(1);
  });

  it("a private document reaches ONLY the subscription whose user authored it", async () => {
    const mine = await subscribe({
      user_id: AUTHOR,
      target_url: 'https://example.test/hooks/author',
    });
    await subscribe({ user_id: SOMEONE_ELSE, target_url: 'https://example.test/hooks/other' });
    await subscribe({ user_id: null, target_url: 'https://example.test/hooks/m2m' });

    await publishDocumentCreated({ visibility: 'private', created_by: AUTHOR });

    expect(r.queue.jobs.map((j) => j.subscriptionId)).toEqual([mine.subscription.id]);
  });

  it('works for document.deleted, where there is NO ROW LEFT to read', async () => {
    // This is why the gate takes the payload and not an id. `DELETE
    // /api/documents/:id` is a HARD delete (finding F10): by the time this runs
    // the row is gone, so a gate that queried the database would fail open on
    // the one event carrying a deleted private document's title.
    await subscribe({ event: 'document.deleted', user_id: SOMEONE_ELSE });
    await r.bus.publish({
      type: 'document.deleted',
      workspace_id: WS,
      data: { ...documentData({ visibility: 'private' }), deleted_at: '2026-01-02T00:00:00.000Z' },
    });
    expect(r.queue.jobs).toEqual([]);
  });

  it('is a pure function — the unit table', () => {
    const t = (visibility: unknown, createdBy: unknown, userId: string | null) =>
      gateSubscription({ visibility, created_by: createdBy }, { user_id: userId });

    expect(t('workspace', AUTHOR, SOMEONE_ELSE)).toBe('deliver');
    expect(t('workspace', null, null)).toBe('deliver');
    expect(t('private', AUTHOR, AUTHOR)).toBe('deliver');
    expect(t('private', AUTHOR, SOMEONE_ELSE)).toBe('private-not-owner');
    expect(t('private', AUTHOR, null)).toBe('private-not-owner');

    // The case that must not pass by accident: `null === null` is TRUE in
    // JavaScript, so a naive equality would deliver every authorless private
    // document to every machine-to-machine subscription.
    expect(t('private', null, null)).toBe('private-not-owner');

    // Fail closed on anything unrecognised, and say so distinctly — a producer
    // emitting an unknown visibility is our bug, not ordinary filtering.
    expect(t(undefined, AUTHOR, AUTHOR)).toBe('unknown-visibility');
    expect(t('secret', AUTHOR, AUTHOR)).toBe('unknown-visibility');
    expect(t(null, AUTHOR, AUTHOR)).toBe('unknown-visibility');
  });

  it('an unrecognisable visibility is WARNED about and delivered to nobody', async () => {
    const warnings: string[] = [];
    const clock = new FakeClock(T0_MS);
    const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    const queue = new RecordingDeliveryQueue();
    await repo.create({
      app_id: APP,
      workspace_id: WS,
      user_id: AUTHOR,
      event: 'document.created',
      target_url: 'https://example.test/hooks/warn',
    });
    const handler = createWebhookPipeline({
      repo,
      signer: new SignatureSigner(clock),
      queue,
      logger: { error: () => undefined, warn: (m: string) => warnings.push(m) },
    });

    // Called directly rather than through the bus: the registry would REJECT a
    // payload with no `visibility` at publish time (PF-393), which is the
    // correct outer defence. This asserts the inner one — what the gate does if
    // a payload ever reaches it anyway.
    await handler({
      id: 'e1',
      type: 'document.created',
      created_at: '2026-01-01T00:00:00.000Z',
      workspace_id: WS,
      data: { id: DOC, created_by: AUTHOR },
    });

    expect(queue.jobs).toEqual([]);
    expect(warnings.join('\n')).toMatch(/visibility/);
  });

  it('the workspace-admin branch is NOT implemented, and that is recorded', () => {
    // D7's sentence has a second clause — "or that user is a workspace admin" —
    // and it is deliberately absent. It needs a membership read per (event ×
    // subscription) on the request path, which is the cost the gate exists to
    // avoid; and "an admin subscribed a webhook, therefore every private
    // document in the workspace is fanned out to that URL" is a surprising
    // default nobody asked for. This assertion exists so that adding it later
    // is a deliberate act with a failing test, not a quiet widening.
    expect(gateSubscription({ visibility: 'private', created_by: AUTHOR }, { user_id: SOMEONE_ELSE }))
      .toBe('private-not-owner');
  });
});

describe('PF-441 — the API response never waits on a subscriber', () => {
  it('publish() resolves even when the deliverer NEVER resolves', async () => {
    const clock = new FakeClock(T0_MS);
    const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    await repo.create({
      app_id: APP,
      workspace_id: WS,
      user_id: AUTHOR,
      event: 'document.created',
      target_url: 'https://example.test/hooks/hang',
    });

    let everSettled = false;
    const hanging = {
      deliver: () =>
        new Promise<never>(() => {
          /* deliberately never settles */
        }).finally(() => {
          everSettled = true;
        }),
    };
    const queue = new ImmediateDeliveryQueue(hanging as never);
    const bus = new InProcessEventBus({ clock });
    bus.subscribe('*', createWebhookPipeline({ repo, signer: new SignatureSigner(clock), queue }));

    const startedMs = Date.now();
    await bus.publish({ type: 'document.created', workspace_id: WS, data: documentData() });
    const elapsedMs = Date.now() - startedMs;

    // The ticket's bound. In-process matching and one HMAC should be
    // sub-millisecond, so 200 ms is a ~200x margin rather than a tight timing
    // assertion — but the STRUCTURAL assertions below are the real proof, and
    // they cannot flake at all.
    expect(elapsedMs).toBeLessThan(200);

    // The delivery is still in flight, which is the actual property: the wire
    // was never inside `publish()`. If it had been, the line above would not
    // have been reached at all.
    expect(queue.pendingCount()).toBe(1);
    expect(everSettled).toBe(false);
  });

  it('the request is FULLY SIGNED at hand-off, not later', async () => {
    const sub = await subscribe();
    await publishDocumentCreated();

    const job = r.queue.jobs[0]!;
    // Everything a courier needs is present the moment the job is handed over.
    // A job carrying an unsigned body and a promise to sign it later would let
    // an L16 bug send something unsigned.
    expect(job.request.signatureHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(job.request.rawBody.length).toBeGreaterThan(0);
    expect(job.request.targetUrl).toBe('https://example.test/hooks/a');
    expect(job.request.eventId).toBe('e0000000-0000-4000-8000-000000000001');
    expect(
      verifySignature(sub.signing_secret, job.request.signatureHeader, job.request.rawBody, T0_MS / 1000),
    ).toBe(true);
  });

  it('a throwing deliverer does not reject publish() or crash the process', async () => {
    const clock = new FakeClock(T0_MS);
    const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    await repo.create({
      app_id: APP,
      workspace_id: WS,
      user_id: AUTHOR,
      event: 'document.created',
      target_url: 'https://example.test/hooks/boom',
    });
    const errors: unknown[] = [];
    const queue = new ImmediateDeliveryQueue(
      { deliver: () => Promise.reject(new Error('connection refused')) } as never,
      { error: (...a) => errors.push(a) },
    );
    const bus = new InProcessEventBus({ clock });
    bus.subscribe('*', createWebhookPipeline({ repo, signer: new SignatureSigner(clock), queue }));

    await expect(
      bus.publish({ type: 'document.created', workspace_id: WS, data: documentData() }),
    ).resolves.toBeUndefined();
    // Awaited through the queue's own tracking, not a timer.
    await queue.settled();
    // An unhandled rejection from a fire-and-forget delivery would crash the
    // process under Node's default policy — a broken subscriber taking Ship
    // down.
    expect(errors).toHaveLength(1);
  });

  it('a decryption failure delivers NOTHING and says why', async () => {
    const clock = new FakeClock(T0_MS);
    const good = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    await good.create({
      app_id: APP,
      workspace_id: WS,
      user_id: AUTHOR,
      event: 'document.created',
      target_url: 'https://example.test/hooks/x',
    });
    // Same store, wrong key — a rotated `WEBHOOK_SECRET_KEY` or a restored
    // backup. Simulated by a cipher that always throws on decrypt.
    const broken = {
      ...good,
      findActiveByEventType: () => Promise.reject(new Error('failed to decrypt')),
    } as never;

    const errors: string[] = [];
    const queue = new RecordingDeliveryQueue();
    const bus = new InProcessEventBus({ clock });
    bus.subscribe(
      '*',
      createWebhookPipeline({
        repo: broken,
        signer: new SignatureSigner(clock),
        queue,
        logger: { error: (m: string) => errors.push(m), warn: () => undefined },
      }),
    );

    await bus.publish({ type: 'document.created', workspace_id: WS, data: documentData() });
    expect(queue.jobs).toEqual([]);
    expect(errors.join('\n')).toMatch(/WEBHOOK_SECRET_KEY/);
    expect(errors.join('\n')).toMatch(/unsigned/);
  });
});

describe('PF-442 — signed at send time, per attempt', () => {
  it('attempt 2 differs in t and v1 and agrees on body, event id and key', async () => {
    const sub = await subscribe();
    await publishDocumentCreated();
    const first = r.queue.jobs[0]!;

    // The retry ladder's first rung. Advancing the clock is what makes the
    // second attempt's `t` different — no sleeping, per p.11.
    r.clock.advance(4000);
    const second = (await first.resign()) as DeliveryRequest;

    expect(second).not.toBeNull();
    // Different — because the signature is minted now, not reused.
    expect(second.signedAtSeconds).toBe(first.request.signedAtSeconds + 4);
    expect(second.signatureHeader).not.toBe(first.request.signatureHeader);
    // Identical — because rotation changes the signature, never the message.
    expect(Buffer.compare(second.rawBody, first.request.rawBody)).toBe(0);
    expect(second.eventId).toBe(first.request.eventId);
    expect(second.idempotencyKey).toBe(first.request.idempotencyKey);

    // And attempt 2 verifies at its own time, which attempt 1's header would
    // not once the window passed — the reason signing per attempt is not
    // cosmetic.
    expect(
      verifySignature(sub.signing_secret, second.signatureHeader, second.rawBody, T0_MS / 1000 + 4),
    ).toBe(true);
  });

  it('attempt 1\'s header EXPIRES while attempt 2\'s does not — why this matters', async () => {
    const sub = await subscribe();
    await publishDocumentCreated();
    const first = r.queue.jobs[0]!;

    // The retry tail runs to 30 minutes (p.4), well past the 300 s window.
    r.clock.advance(31 * 60 * 1000);
    const late = (await first.resign()) as DeliveryRequest;
    const nowSeconds = T0_MS / 1000 + 31 * 60;

    expect(verifySignature(sub.signing_secret, first.request.signatureHeader, first.request.rawBody, nowSeconds)).toBe(false);
    expect(verifySignature(sub.signing_secret, late.signatureHeader, late.rawBody, nowSeconds)).toBe(true);
  });

  it('resign() returns null once the subscription is deactivated', async () => {
    const sub = await subscribe();
    await publishDocumentCreated();
    const job = r.queue.jobs[0]!;

    await r.repo.deactivate(APP, sub.subscription.id);
    // A subscriber who unsubscribed mid-ladder should stop receiving retries.
    // `null` is how L16 learns to abandon rather than dead-letter.
    expect(await job.resign()).toBeNull();
  });
});

describe('PF-443 — a secret rotated mid-flight', () => {
  it('attempt 2 verifies under the NEW secret and fails under the old', async () => {
    const sub = await subscribe();
    await publishDocumentCreated();
    const job = r.queue.jobs[0]!;
    const secretA = sub.signing_secret;

    // Attempt 1 was signed with A.
    expect(verifySignature(secretA, job.request.signatureHeader, job.request.rawBody, T0_MS / 1000)).toBe(true);

    const rotated = await r.repo.rotateSecret(APP, sub.subscription.id);
    const secretB = rotated!.signing_secret;
    expect(secretB).not.toBe(secretA);

    r.clock.advance(4000);
    const second = (await job.resign()) as DeliveryRequest;
    const nowSeconds = T0_MS / 1000 + 4;

    expect(verifySignature(secretB, second.signatureHeader, second.rawBody, nowSeconds)).toBe(true);
    expect(verifySignature(secretA, second.signatureHeader, second.rawBody, nowSeconds)).toBe(false);
  });

  it('rotation changes the signature and NOTHING else about the message', async () => {
    const sub = await subscribe();
    await publishDocumentCreated();
    const job = r.queue.jobs[0]!;

    await r.repo.rotateSecret(APP, sub.subscription.id);
    r.clock.advance(1000);
    const second = (await job.resign()) as DeliveryRequest;

    expect(Buffer.compare(second.rawBody, job.request.rawBody)).toBe(0);
    expect(second.eventId).toBe(job.request.eventId);
    expect(second.idempotencyKey).toBe(job.request.idempotencyKey);
    expect(second.subscriptionId).toBe(job.request.subscriptionId);
    expect(second.targetUrl).toBe(job.request.targetUrl);
  });
});

describe('ImmediateDeliveryQueue — the hand-off L16 replaces', () => {
  it('delivers the signed request and settles without a timer', async () => {
    const clock = new FakeClock(T0_MS);
    const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock });
    const sub = await repo.create({
      app_id: APP,
      workspace_id: WS,
      user_id: AUTHOR,
      event: 'document.created',
      target_url: 'https://example.test/hooks/real',
    });
    const deliverer = new InMemoryDeliverer();
    const queue = new ImmediateDeliveryQueue(deliverer);
    const bus = new InProcessEventBus({ clock });
    bus.subscribe('*', createWebhookPipeline({ repo, signer: new SignatureSigner(clock), queue }));

    await bus.publish({ type: 'document.created', workspace_id: WS, data: documentData() });
    await queue.settled();

    expect(deliverer.delivered).toHaveLength(1);
    const sent = deliverer.delivered[0]!;
    expect(sent.targetUrl).toBe('https://example.test/hooks/real');
    expect(
      verifySignature(sub.signing_secret, sent.signatureHeader, sent.rawBody, T0_MS / 1000),
    ).toBe(true);
    expect(queue.pendingCount()).toBe(0);
  });
});
