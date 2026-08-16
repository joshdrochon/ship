/**
 * PRD p.8 option 6, executed. PF-728 – PF-732.
 *
 * Every assertion in this file is made from the SUBSCRIBER's side, on purpose.
 * The delivery log is the platform's own account of what it believes it sent;
 * this drill exists to check that account against what actually arrived on the
 * wire. Testing Scenario 8 (p.5) asserts the replayed key from the developer
 * portal — this asserts it at the far end, which is where the guarantee has to
 * hold for it to mean anything.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ShipClient } from '@ship/sdk';
import { authenticatedClient, keysOf, subscribe, type Subscribed } from './support/world.js';

let client: ShipClient;
let world: Subscribed | null = null;

/**
 * Poll the public delivery log until a dead-lettered delivery for `subscriptionId`
 * exists.
 *
 * ── Why a poll here, when p.11 forbids sleeping for an outcome ──────────────
 * `listener.waitFor` is event-driven and resolves once the response has been
 * written back — so it proves the subscriber ANSWERED 410. It cannot prove the
 * platform has yet read that 410, classified it as permanent, and committed
 * `dead_lettered`. Those happen in the server process, after the response leaves
 * the listener, with no event the drill can subscribe to.
 *
 * That gap is a real read-after-write race across two processes, and it is what
 * made this test flaky: the assertion below read the log 106 ms after the reply
 * and saw zero rows (CI job 68852). Everything the drill can observe had already
 * happened; the thing it was asserting on had not.
 *
 * The shape follows `testkit/listener.ts`: the deadline can only ever REJECT,
 * and a satisfied predicate returns on the current iteration. The interval never
 * delays a success by more than one poll period, and the failure names what it
 * was waiting for instead of surfacing as a bare `expected 0 to be >= 1`.
 */
async function waitForDeadLettered(
  shipClient: ShipClient,
  subscriptionId: string,
  { timeoutMs = 15_000, intervalMs = 100 } = {},
): Promise<Awaited<ReturnType<typeof shipClient.webhooks.deliveries.list>>['data']> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = await shipClient.webhooks.deliveries.list({
      status: 'dead_lettered',
      subscription_id: subscriptionId,
    });
    if (page.data.length >= 1) return page.data;
    if (Date.now() >= deadline) {
      throw new Error(
        `the delivery should have dead-lettered on a permanent 4xx, but after ${timeoutMs} ms ` +
          `the public delivery log still reports ${page.data.length} dead-lettered deliveries for ` +
          `subscription ${subscriptionId}. The subscriber answered 410 and the listener saw ` +
          `the response, so either the outcome classifier no longer treats a permanent 4xx as ` +
          `terminal, or the delivery never reached the classifier at all.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(async () => {
  client = await authenticatedClient();
}, 180_000);

afterEach(async () => {
  await world?.dispose();
  world = null;
});

describe('PF-728 — the drill subscribes and receives the way a stranger would', () => {
  it('a document created through /api/v1 arrives as a SIGNED delivery at the listener', async () => {
    world = await subscribe(client, 'document.created');

    const doc = await client.documents.create({ title: 'PF-728 — first delivery' });

    await world.listener.waitFor((r) => r.length >= 1, { what: 'the first delivery' });
    const first = world.received[0];

    // Verified — and `verified` here is `verifyWebhook` over the RAW bytes,
    // called by the subscriber before it looked at any header.
    expect(world.subscriber.decisions[0]?.verified).toBe(true);
    expect(world.subscriber.decisions[0]?.status).toBe(200);

    // It is the document we created, not a delivery left over from anything.
    const envelope = first?.json<{ type: string; data: { id: string } }>();
    expect(envelope?.type).toBe('document.created');
    expect(envelope?.data.id).toBe(doc.id);

    // And it carried a key at all — everything below depends on this.
    expect(first?.idempotencyKey).toEqual(expect.any(String));
    expect(first?.idempotencyKey).not.toBe('');
  });
});

describe('PF-729 — the subscriber dedupes: one key, one side effect, two 200s', () => {
  it('two POSTs carrying one key produce one side effect and two 200s', async () => {
    world = await subscribe(client, 'document.created');
    await client.documents.create({ title: 'PF-729 — dedupe' });
    await world.listener.waitFor((r) => r.length >= 1, { what: 'the original delivery' });

    const original = world.received[0];
    if (original === undefined) throw new Error('no delivery arrived');

    // The same bytes, the same signature, the same key — a sender retrying
    // something it is not sure landed. Replayed by hand rather than by waiting
    // for Ship to retry, because this ticket is about the SUBSCRIBER's rule and
    // the sender's schedule is PF-731's business.
    const replayed = await fetch(world.listener.url, {
      method: 'POST',
      headers: original.headers,
      body: original.rawBody,
    });

    await world.listener.waitFor((r) => r.length >= 2, { what: 'the duplicate' });

    expect(replayed.status).toBe(200);
    expect(world.subscriber.decisions.at(-1)?.deduped).toBe(true);
    expect(world.subscriber.keysSeen).toHaveLength(2);
    expect(new Set(world.subscriber.keysSeen).size).toBe(1);
    // The whole point.
    expect(world.subscriber.sideEffects).toHaveLength(1);
  });
});

describe('PF-730 — a replay carries the ORIGINAL key, proven at the subscriber', () => {
  it('dead-letters, replays through /api/v1, and the key is string-equal', async () => {
    // A permanent 4xx dead-letters immediately (L16's `classifyDeliveryOutcome`,
    // decision D9). That is what makes this tractable: driving a delivery to the
    // DLQ by exhausting the ladder would take 1+4+16+60+300 = 381 s, and the
    // ticket is about the replayed KEY, not about the schedule.
    //
    // The subscriber answers 410 until the replay, then 200. Both halves matter:
    // the 410 gets the delivery into the DLQ with NO side effect committed, and
    // the 200 means the replay would commit one if the key had been forgotten —
    // which is the failure this test is here to detect.
    let permanent = true;
    world = await subscribe(client, 'document.created', () => (permanent ? 410 : 200));
    await client.documents.create({ title: 'PF-730 — replay' });
    await world.listener.waitFor((r) => r.length >= 1, { what: 'the original delivery' });

    const originalKey = world.received[0]?.idempotencyKey;
    expect(originalKey).toEqual(expect.any(String));

    // Found through the PUBLIC delivery log, the same way the portal finds it.
    // Polled rather than read once: the 410 has been answered, but the platform
    // commits `dead_lettered` in its own process afterwards. See the note on
    // `waitForDeadLettered`.
    const dlqData = await waitForDeadLettered(client, world.subscription.id);
    expect(dlqData.length, 'the delivery should have dead-lettered on a permanent 4xx').toBeGreaterThanOrEqual(1);
    const dead = dlqData[0];
    if (dead === undefined) throw new Error('no dead-lettered delivery');
    expect(dead.idempotency_key).toBe(originalKey);

    permanent = false;
    const replayRow = await client.webhooks.deliveries.replay(dead.id);
    await world.listener.waitFor((r) => r.length >= 2, { what: 'the replayed delivery' });

    const replayedKey = world.received[1]?.idempotencyKey;

    // At the wire, which is where it has to hold.
    expect(replayedKey).toBe(originalKey);
    // And the platform's own account agrees with the wire.
    expect(replayRow.idempotency_key).toBe(originalKey);
    expect(replayRow.replay_of_delivery_id).toBe(dead.id);

    // The original attempt was a 410, so no side effect ever committed — the
    // subscriber has never processed this key, and the replay is its first
    // successful sight of it. One side effect, not zero and not two.
    expect(world.subscriber.sideEffects).toHaveLength(1);
    expect(world.subscriber.sideEffects[0]?.idempotencyKey).toBe(originalKey);
  });
});

describe('PF-731 — four attempts of one delivery share one key', () => {
  it('500, 500, 500, 200 → four identical keys and exactly one side effect', async () => {
    // The REAL ladder: 1 s, 4 s, 16 s before attempts 2, 3 and 4 (p.4, and L16's
    // RETRY_SCHEDULE_SECONDS). The drill never sleeps — it waits on the arrival
    // of the fourth request, which is an event, and the only clock in play is
    // the server's own schedule.
    world = await subscribe(client, 'document.created', (attempt) => (attempt <= 3 ? 500 : 200));
    await client.documents.create({ title: 'PF-731 — retries share a key' });

    await world.listener.waitFor((r) => r.length >= 4, {
      what: 'four attempts (1 s + 4 s + 16 s of ladder)',
      timeoutMs: 90_000,
    });

    const keys = keysOf(world.received).slice(0, 4);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size, `four attempts carried ${new Set(keys).size} distinct keys: ${keys.join(', ')}`).toBe(1);

    // Without this, a platform minting a fresh key per attempt passes PF-729 and
    // PF-730 and every subscriber that 5xx's once double-processes forever.
    expect(world.subscriber.sideEffects).toHaveLength(1);
  }, 120_000);
});

describe('PF-732 — distinct events never share a key', () => {
  it('two documents → two different keys and two side effects', async () => {
    world = await subscribe(client, 'document.created');

    const a = await client.documents.create({ title: 'PF-732 — first' });
    const b = await client.documents.create({ title: 'PF-732 — second' });

    await world.listener.waitFor((r) => r.length >= 2, { what: 'both deliveries' });

    const keys = keysOf(world.received).slice(0, 2);
    // A platform emitting a constant key passes PF-729, PF-730 and PF-731 and
    // fails only here.
    expect(new Set(keys).size).toBe(2);
    expect(world.subscriber.sideEffects).toHaveLength(2);

    // The key's provenance is one hop, not a coincidence: L14 makes `event.id`
    // the sole idempotency basis, so two events carry two ids and the two side
    // effects name them.
    const ids = world.subscriber.sideEffects.map((s) => s.eventId);
    expect(new Set(ids).size).toBe(2);
    const seen = world.received.slice(0, 2).map((r) => r.json<{ data: { id: string } }>().data.id);
    expect(new Set(seen)).toEqual(new Set([a.id, b.id]));
  });
});
