/**
 * PF-482 · PF-483 — the two cost questions this lane owns, and the fitness test
 * that keeps the answer to the first one honest.
 *
 * Pre-Search 1.1 (p.15): the delivery log's growth rate and retention window.
 * Pre-Search 1.2 (p.15): the runaway-cost ceiling and the mechanism enforcing it.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../clock.js';
import { RetryScheduler, MAX_ATTEMPTS } from './retry.js';
import { InMemoryDeliverer } from './deliverer.js';
import { InMemoryDeliveryLog } from './deliveryLog.js';
import { makeDeliveryJob, singleAppResolver, TEST_APP_ID } from './deliveryTestSupport.js';
import {
  SubscriptionCircuits,
  ATTEMPTS_PER_HOUR_CEILING,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
} from './subscriptionCircuit.js';
import {
  BYTES_PER_ROW,
  RETENTION_DAYS,
  RETENTION_ESTIMATE,
  ATTEMPT_MULTIPLIER_CEILING,
  DELIVERIES_PER_DAY,
  retentionBytes,
  pruneDeliveryLog,
} from './retention.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM = join(HERE, '..');

describe('PF-482 — the runaway ceiling is a per-subscription circuit breaker', () => {
  it('opens after the threshold and sends further deliveries STRAIGHT to the DLQ', async () => {
    const clock = new FakeClock(1_000);
    const deliverer = new InMemoryDeliverer();
    const log = new InMemoryDeliveryLog(singleAppResolver);
    const breaker = new SubscriptionCircuits({ clock, failureThreshold: 2, cooldownMs: 60_000 });

    let group = 0;
    const scheduler = new RetryScheduler({
      clock,
      deliverer,
      log,
      breaker,
      jitter: () => 0.5,
      newGroupId: () => `g${(group += 1)}`,
      logger: { error: () => {}, warn: () => {} },
    });

    // Two permanent failures trip the circuit (threshold 2).
    for (let n = 0; n < 2; n += 1) {
      deliverer.queueResponse({ status: 404 });
      scheduler.enqueue(makeDeliveryJob({ eventId: `44444444-4444-4444-8444-00000000000${n}` }).job);
      await scheduler.settled();
    }
    expect(breaker.stateOf('11111111-1111-4111-8111-111111111111')).toBe('open');

    // The next delivery is dead-lettered WITHOUT a request. Not dropped: a
    // delivery that vanished is one the portal cannot show and nobody can replay.
    const before = deliverer.delivered.length;
    scheduler.enqueue(makeDeliveryJob({ eventId: '44444444-4444-4444-8444-000000000099' }).job);
    await scheduler.settled();

    expect(deliverer.delivered.length, 'no request was made').toBe(before);
    const rows = await log.listByGroup('g3');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('dead_lettered');
    expect(rows[0]!.dlq_reason).toBe('circuit_open');
    // The row still carries everything a replay needs.
    expect(rows[0]!.idempotency_key).toBeTruthy();
  });

  it('a half-open probe is allowed after the cooldown — advanced, never waited', async () => {
    const clock = new FakeClock(1_000);
    const breaker = new SubscriptionCircuits({ clock, failureThreshold: 1, cooldownMs: 60_000 });

    await breaker.record('sub-1', false);
    expect(breaker.allows('sub-1')).toBe(false);

    clock.advance(59_999);
    expect(breaker.allows('sub-1'), 'still open just before the cooldown').toBe(false);

    clock.advance(1);
    expect(breaker.allows('sub-1'), 'half-open at the cooldown').toBe(true);

    // A success closes it again.
    await breaker.record('sub-1', true);
    expect(breaker.stateOf('sub-1')).toBe('closed');
  });

  it('circuits are PER SUBSCRIPTION — one broken subscriber does not gate another', async () => {
    const clock = new FakeClock(1_000);
    const breaker = new SubscriptionCircuits({ clock, failureThreshold: 1 });
    await breaker.record('broken', false);

    expect(breaker.allows('broken')).toBe(false);
    expect(breaker.allows('healthy')).toBe(true);
    expect(breaker.openCount()).toBe(1);
  });

  it('the ceiling is a NUMBER, and it is what Pre-Search 1.2 asks for', () => {
    // 60 attempts/hour/subscription at steady state, independent of event
    // volume — which is the property that matters, because the unbounded term in
    // the runaway is events, not attempts per event.
    expect(ATTEMPTS_PER_HOUR_CEILING).toBe(60);
    expect(DEFAULT_COOLDOWN_MS).toBe(60_000);
    // The threshold is one full ladder's worth of failures, not a round number.
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(MAX_ATTEMPTS - 1);
  });

  it('the DLQ alone does NOT answer the question (dispute B4)', () => {
    // The DLQ caps attempts per DELIVERY; it does not cap deliveries per
    // SUBSCRIPTION. Stated as an assertion because "DLQ after 6 attempts" is the
    // wrong answer that reads as the right one.
    const perDeliveryCap = MAX_ATTEMPTS;
    const eventsPerHourAtLargeTier = DELIVERIES_PER_DAY.large / 24;
    const withoutBreaker = perDeliveryCap * eventsPerHourAtLargeTier;
    expect(withoutBreaker).toBeGreaterThan(1_000_000);
    expect(ATTEMPTS_PER_HOUR_CEILING).toBeLessThan(withoutBreaker / 10_000);
  });

  it('the map is bounded — closed circuits are swept, open ones survive', async () => {
    const clock = new FakeClock(1_000);
    const breaker = new SubscriptionCircuits({ clock, failureThreshold: 1, maxCircuits: 5 });
    await breaker.record('sticky', false);
    expect(breaker.stateOf('sticky')).toBe('open');

    for (let n = 0; n < 20; n += 1) breaker.allows(`transient-${n}`);

    // The open circuit is actively suppressing traffic and must not be dropped;
    // a closed one is indistinguishable from a subscription that never failed.
    expect(breaker.stateOf('sticky')).toBe('open');
    expect(breaker.size()).toBeLessThanOrEqual(20);
  });
});

describe('PF-482 — there is NO second circuit breaker under platform/', () => {
  it('no class under platform/ implements its own breaker', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(PLATFORM);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // A `class ... CircuitBreaker`/`...Breaker` declaration anywhere under
      // platform/ is a second breaker. `api/src/services/circuitBreaker.ts`
      // records the standing rule: engineering requirement 4 says REUSE it.
      if (/\bclass\s+\w*(CircuitBreaker|Breaker)\b/.test(text)) {
        offenders.push(relative(PLATFORM, file));
      }
    }

    expect(
      offenders,
      `A second circuit breaker was declared under platform/. The shared one in ` +
        `@ship/shared (shared/src/circuitBreaker.ts) is the only implementation; ` +
        `SubscriptionCircuits ADAPTS it (a Clock lambda and a keyed map) rather than ` +
        `reimplementing its state machine.`,
    ).toEqual([]);
  });

  it('SubscriptionCircuits imports the shared breaker rather than defining one', () => {
    const source = readFileSync(join(PLATFORM, 'webhooks', 'subscriptionCircuit.ts'), 'utf8');
    expect(source).toContain("import { CircuitBreaker } from '@ship/shared'");
    // Anti-vacuity: the grep above only means something if this file would have
    // been caught had it declared one.
    expect(/\bclass\s+\w*(CircuitBreaker|Breaker)\b/.test('class MyCircuitBreaker {}')).toBe(true);
  });
});

describe('PF-483 — the growth rate, the retention window, and the prune', () => {
  it('states BOTH windows, with the reason each is set there', () => {
    // p.10's Include Assumptions asks for both, and the second is the one that
    // is easy to forget: dead-lettered rows outlive the window.
    expect(RETENTION_DAYS).toBe(30);
    const source = readFileSync(join(PLATFORM, 'webhooks', 'retention.ts'), 'utf8');
    expect(source).toContain('indefinitely');
    expect(source, 'the 30d window is matched to L12 D10, not chosen alone').toContain('D10');
  });

  it('bytes per row is DERIVED from the schema, and bounded by the excerpt cap', () => {
    // The excerpt cap is what makes this a ceiling rather than a guess: without
    // it, one subscriber's HTML error page is a megabyte per attempt.
    expect(BYTES_PER_ROW).toBeGreaterThan(1_000);
    expect(BYTES_PER_ROW).toBeLessThan(1_200);
  });

  it('rows × retention days × bytes per row — the arithmetic p.10 asks for', () => {
    expect(retentionBytes(DELIVERIES_PER_DAY.small)).toBe(
      DELIVERIES_PER_DAY.small * ATTEMPT_MULTIPLIER_CEILING * RETENTION_DAYS * BYTES_PER_ROW,
    );

    const smallGB = RETENTION_ESTIMATE.smallBytes / 1e9;
    const largeTB = RETENTION_ESTIMATE.largeBytes / 1e12;
    // ~1.0 GB at the 100-user tier; ~1.0 TB at 100 000 users under the 6×
    // ceiling. Asserted rather than written down because the first draft of the
    // doc comment said "~102 GB" and was wrong by an order of magnitude — which
    // is exactly the class of error a cost analysis must not ship with.
    expect(smallGB).toBeGreaterThan(0.5);
    expect(smallGB).toBeLessThan(2);
    expect(largeTB).toBeGreaterThan(0.5);
    expect(largeTB).toBeLessThan(2);

    // The healthy case is exactly 6× smaller, which is what makes the multiplier
    // a ceiling rather than an estimate.
    expect(RETENTION_ESTIMATE.largeBytes / RETENTION_ESTIMATE.largeHealthyBytes).toBe(
      ATTEMPT_MULTIPLIER_CEILING,
    );
  });

  it('the prune deletes past the window and NEVER an unreplayed DLQ row', async () => {
    const clock = new FakeClock(Date.UTC(2026, 7, 13));
    const log = new InMemoryDeliveryLog(singleAppResolver);

    let seq = 0;
    const seed = async (attemptedAt: string, dead: boolean) => {
      seq += 1;
      const row = await log.beginAttempt({
        delivery_group_id: `g-${attemptedAt}-${dead}`,
        subscription_id: '11111111-1111-4111-8111-111111111111',
        // A fresh event id per row: the partial unique index over ORIGINAL
        // attempts (PF-462) correctly refuses two attempt-1 rows for one event
        // to one subscription.
        event_id: `55555555-5555-4555-8555-${String(seq).padStart(12, '0')}`,
        event_type: 'document.created',
        attempt_number: 1,
        idempotency_key: `k-${attemptedAt}-${dead}`,
        signature_header: null,
        replay_of_delivery_id: null,
        raw_body: Buffer.from('{}'),
        attempted_at: attemptedAt,
      });
      await log.completeAttempt(row.id, {
        status: dead ? 'dead_lettered' : 'delivered',
        response_status: dead ? 500 : 200,
        response_excerpt: null,
        latency_ms: 1,
        dlq_reason: dead ? 'max_attempts_exhausted' : null,
      });
      return row.id;
    };

    const oldDelivered = await seed('2026-01-01T00:00:00.000000Z', false);
    const oldDead = await seed('2026-01-01T00:00:00.000000Z', true);
    const recent = await seed('2026-08-12T00:00:00.000000Z', false);

    const deleted = await pruneDeliveryLog(log, clock);
    expect(deleted).toBe(1);

    const left = (await log.listByApp({ app_id: TEST_APP_ID, limit: 25, cursor: null })).map(
      (r) => r.id,
    );
    expect(left).toContain(oldDead);
    expect(left).toContain(recent);
    expect(left).not.toContain(oldDelivered);
  });
});
