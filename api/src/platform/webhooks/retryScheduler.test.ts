/**
 * PF-455 · PF-456 · PF-457 · PF-459 — the scheduler, over `FakeClock`.
 *
 * Zero `setTimeout`, zero `await new Promise(r => setTimeout(...))`, zero real
 * waiting. PRD p.11: *"tested with deterministic clock injection — never with
 * `setTimeout` waits in tests. Timing-based webhook tests are flaky tests."*
 * `retryClockFitness.test.ts` asserts that mechanically over this file.
 *
 * The pattern every test below uses:
 *
 *     scheduler.enqueue(job);
 *     await scheduler.settled();      // attempt 1 completes
 *     clock.advance(1_100);           // fires the due timer synchronously
 *     await scheduler.settled();      // attempt 2 completes
 *
 * `advance()` fires the callback in the same tick; `settled()` drains the async
 * continuation it started. Neither step waits for wall-clock time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeClock } from '../clock.js';
import { RetryScheduler, MAX_ATTEMPTS } from './retry.js';
import { InMemoryDeliverer } from './deliverer.js';
import { InMemoryDeliveryLog } from './deliveryLog.js';
import { makeDeliveryJob, singleAppResolver } from './deliveryTestSupport.js';

/** Jitter pinned to the midpoint, so every delay is exactly its rung. */
const noJitter = () => 0.5;

function harness() {
  const clock = new FakeClock(1_700_000_000_000);
  const deliverer = new InMemoryDeliverer();
  const log = new InMemoryDeliveryLog(singleAppResolver);
  let group = 0;
  const scheduler = new RetryScheduler({
    clock,
    deliverer,
    log,
    jitter: noJitter,
    newGroupId: () => {
      group += 1;
      return `group-${group}`;
    },
    logger: { error: () => {}, warn: () => {} },
  });
  return { clock, deliverer, log, scheduler };
}

describe('PF-459 — the row is written BEFORE the attempt, not after', () => {
  it('an outstanding delivery reads in_flight while the call has not resolved', async () => {
    const { clock, log } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A deliverer that never resolves until the test says so. This is the whole
    // point of PF-459: a log written only on completion records exactly the
    // attempts that did NOT need reconstructing.
    const hangingDeliverer = {
      deliver: async () => {
        await gate;
        return { ok: true, status: 200, responseExcerpt: null, latencyMs: 5, permanentFailure: false };
      },
    };
    const scheduler = new RetryScheduler({
      clock,
      deliverer: hangingDeliverer,
      log,
      jitter: noJitter,
      newGroupId: () => 'group-1',
    });

    const { job } = makeDeliveryJob();
    scheduler.enqueue(job);

    // Drain the microtask queue up to the point the deliverer blocks, without a
    // timer: `beginAttempt` and `deliver()`'s first await are both microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const rows = await log.listByGroup('group-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('in_flight');
    expect(rows[0]!.attempt_number).toBe(1);
    expect(rows[0]!.response_status).toBeNull();
    expect(rows[0]!.latency_ms).toBeNull();

    release();
    await scheduler.settled();
    expect((await log.listByGroup('group-1'))[0]!.status).toBe('delivered');
  });

  it('the attempt row carries the idempotency key and the signature actually sent', async () => {
    const { log, deliverer, scheduler } = harness();
    deliverer.queueResponse({ ok: true, status: 200, latencyMs: 12 });
    const { job } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();

    const [row] = await log.listByGroup('group-1');
    expect(row!.idempotency_key).toBe(job.idempotencyKey);
    // Finding B9 — L19's `--poll` cannot claim "signature verified ✓" without it.
    expect(row!.signature_header).toBe('t=1000,v1=attempt-1-signature');
    expect(row!.latency_ms).toBe(12);
  });
});

describe('PF-455 — a permanent classification skips the ladder entirely', () => {
  it('a 404 is dead-lettered after ONE attempt, and no timer is ever scheduled', async () => {
    const { clock, log, deliverer, scheduler } = harness();
    deliverer.queueResponse({ ok: false, status: 404, responseExcerpt: 'no such hook' });
    const { job } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();

    const rows = await log.listByGroup('group-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('dead_lettered');
    expect(rows[0]!.dlq_reason).toBe('permanent_status');
    expect(rows[0]!.response_status).toBe(404);
    // `Clock.setTimeout` was never called — the ladder was not entered at all.
    expect(clock.pendingCount()).toBe(0);
    expect(scheduler.scheduledCount()).toBe(0);

    // Advancing past every rung must not produce a second attempt.
    clock.advance(400_000);
    await scheduler.settled();
    expect(await log.listByGroup('group-1')).toHaveLength(1);
  });

  it('the symmetric negative: a 429 IS retried, so a rate-limited subscriber survives', async () => {
    const { clock, log, deliverer, scheduler } = harness();
    // D9's departure from p.4's flat "4xx permanent", exercised end to end.
    deliverer.queueResponse({ ok: false, status: 429, responseExcerpt: 'slow down' });
    deliverer.queueResponse({ ok: true, status: 200 });
    const { job } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();
    expect((await log.listByGroup('group-1'))[0]!.status).toBe('failed');

    clock.advance(1_000);
    await scheduler.settled();

    const rows = await log.listByGroup('group-1');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.attempt_number).toBe(2);
    expect(rows[1]!.status).toBe('delivered');
  });
});

describe('PF-456 — the ladder is driven only through the injected Clock', () => {
  let ctx: ReturnType<typeof harness>;
  beforeEach(() => {
    ctx = harness();
  });

  it('attempt 2 does not fire before the 1 s rung is due', async () => {
    const { clock, deliverer, scheduler, log } = ctx;
    deliverer.queueResponse({ ok: false, status: 500 });
    deliverer.queueResponse({ ok: true, status: 200 });
    const { job } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();
    expect(deliverer.delivered).toHaveLength(1);

    // 999 ms is short of the rung. Nothing happens — which is the assertion a
    // `setTimeout`-based test cannot make without being slow AND flaky.
    clock.advance(999);
    await scheduler.settled();
    expect(deliverer.delivered).toHaveLength(1);

    clock.advance(1);
    await scheduler.settled();
    expect(deliverer.delivered).toHaveLength(2);
    expect(await log.listByGroup('group-1')).toHaveLength(2);
  });

  it('a retry is re-signed: the wire carries a fresh signature, the same bytes', async () => {
    const { clock, deliverer, scheduler } = ctx;
    deliverer.queueResponse({ ok: false, status: 503 });
    deliverer.queueResponse({ ok: true, status: 200 });
    const { job, rawBody } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();
    clock.advance(1_000);
    await scheduler.settled();

    const [first, second] = deliverer.delivered;
    expect(first!.signatureHeader).not.toBe(second!.signatureHeader);
    // PF-436 — the same buffer object, not a re-serialization. `JSON.stringify(
    // JSON.parse(...))` anywhere on this path breaks the signature for a value
    // nobody tampered with.
    expect(second!.rawBody).toBe(rawBody);
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it('six consecutive 500s produce six rows and never a seventh', async () => {
    const { clock, deliverer, scheduler, log } = ctx;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) deliverer.queueResponse({ ok: false, status: 500 });
    const { job } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();
    for (const rung of [1_000, 4_000, 16_000, 60_000, 300_000]) {
      clock.advance(rung);
      await scheduler.settled();
    }

    const rows = await log.listByGroup('group-1');
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[5]!.status).toBe('dead_lettered');
    expect(rows[5]!.dlq_reason).toBe('max_attempts_exhausted');

    // The 30 m rung was never scheduled. Advancing an hour changes nothing.
    expect(clock.pendingCount()).toBe(0);
    clock.advance(3_600_000);
    await scheduler.settled();
    expect(await log.listByGroup('group-1')).toHaveLength(6);
    expect(deliverer.delivered).toHaveLength(6);
  });
});

describe('PF-457 — a scheduled retry is cancellable', () => {
  it('deactivating a subscription mid-ladder cancels the attempt as `cancelled`', async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const deliverer = new InMemoryDeliverer();
    const log = new InMemoryDeliveryLog(singleAppResolver);
    const scheduler = new RetryScheduler({
      clock,
      deliverer,
      log,
      jitter: noJitter,
      newGroupId: () => 'group-1',
    });

    // Two 500s, then the subscription goes away: `resign()` answers null, which
    // is L15's documented signal that the subscription was deactivated.
    let deactivated = false;
    deliverer.queueResponse({ ok: false, status: 500 });
    deliverer.queueResponse({ ok: false, status: 500 });
    const { job } = makeDeliveryJob({
      resign: async () =>
        deactivated
          ? null
          : {
              targetUrl: 'https://subscriber.test/hook',
              rawBody: Buffer.from('{}'),
              signatureHeader: 't=1001,v1=resigned',
              signedAtSeconds: 1001,
              idempotencyKey: job.idempotencyKey,
              eventId: job.eventId,
              subscriptionId: job.subscriptionId,
            },
    });

    scheduler.enqueue(job);
    await scheduler.settled();
    clock.advance(1_000);
    await scheduler.settled();
    expect(deliverer.delivered).toHaveLength(2);

    // Attempt 3 is scheduled. Flip the flag, then advance past its due time.
    expect(scheduler.scheduledCount()).toBe(1);
    deactivated = true;
    clock.advance(4_000);
    await scheduler.settled();

    // The deliverer was NOT called a third time…
    expect(deliverer.delivered).toHaveLength(2);
    const rows = await log.listByGroup('group-1');
    // …and attempt 3 is recorded as cancelled, not dead-lettered. An operator who
    // switched a subscription off did not get a delivery failure.
    expect(rows).toHaveLength(3);
    expect(rows[2]!.status).toBe('cancelled');
    expect(rows[2]!.dlq_reason).toBeNull();
    expect(rows[2]!.response_status).toBeNull();
    // The ladder stops there — nothing further is scheduled.
    expect(scheduler.scheduledCount()).toBe(0);
    clock.advance(3_600_000);
    await scheduler.settled();
    expect(await log.listByGroup('group-1')).toHaveLength(3);
  });

  it('stop() cancels every pending retry — a draining process stops POSTing', async () => {
    const { clock, deliverer, scheduler, log } = harness();
    deliverer.queueResponse({ ok: false, status: 500 });
    const { job } = makeDeliveryJob();

    scheduler.enqueue(job);
    await scheduler.settled();
    expect(scheduler.scheduledCount()).toBe(1);

    // Without the RETAINED cancel handle this is impossible, and a process that
    // stopped serving traffic keeps hitting subscribers for up to six minutes.
    scheduler.stop();
    expect(scheduler.scheduledCount()).toBe(0);

    clock.advance(3_600_000);
    await scheduler.settled();
    expect(deliverer.delivered).toHaveLength(1);
    expect(await log.listByGroup('group-1')).toHaveLength(1);
  });
});
