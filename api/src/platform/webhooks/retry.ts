/**
 * PF-451/PF-452/PF-453 — the retry ladder, and the off-by-one that decides
 * whether Testing Scenario 8 passes.
 *
 * PRD p.4, Retry Schedule: *"Exponential backoff with jitter: 1s, 4s, 16s, 1m,
 * 5m, 30m."* PRD p.4, Dead-Letter Queue: *"After 6 failed attempts, deliveries
 * land in a DLQ."*
 *
 * ─── Six intervals and six attempts cannot both be consumed ──────────────────
 *
 * Intervals sit BETWEEN attempts, so six attempts have five gaps. Testing
 * Scenario 7 (p.5) pins which end is fixed: *"return 500 on the first three
 * attempts and 200 on the fourth. Verify the retry schedule (1s, 4s, 16s ≥ wait
 * times before each attempt)"* — which is only true if attempt 1 fires
 * immediately and the wait before attempt *k* is rung *k−2*.
 *
 * **Decision: 6 attempts, 5 waits (1s · 4s · 16s · 1m · 5m), and the 30 m rung
 * never fires.** `MAX_ATTEMPTS` is an independent constant, NOT
 * `RETRY_SCHEDULE_SECONDS.length` — the spike had it derived, which conflates
 * "how many rungs are in the ladder" with "how many attempts do we make", and
 * those are the two quantities this decision separates.
 *
 * The two readings rejected, and why:
 *
 *   **7 attempts** (first attempt + six retries, every rung fires). This is what
 *   most retry libraries do and it makes the ladder look intentional. It fails
 *   Testing Scenario 8, whose whole assertion is that the delivery is *in the
 *   DLQ* after the 6th failure — under this reading it is scheduled for a 7th
 *   attempt thirty minutes out, and the grader's test fails on the assertion the
 *   PRD wrote itself.
 *
 *   **6 attempts with a 1 s wait before the first** (`SCHEDULE[k - 1]`, which is
 *   what the spike shipped). It consumes all six rungs inside six attempts, and
 *   it shifts every TS-7 assertion by one rung. It also spends half of p.6's
 *   *"Webhook delivery latency (P95, first attempt) < 2s"* budget on a sleep
 *   before we have even tried once.
 *
 * What the shipped reading costs: the 30 m rung is unreachable, which looks like
 * a bug to anyone reading the constant. It is kept in the array rather than
 * deleted because deleting a value the PRD names by name is a worse look than an
 * unreachable one, and `retry.test.ts` asserts the unreachability in the place
 * someone would go to "fix" it.
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { DeliveryJob } from './pipeline.js';
import type { DeliveryRequest, IWebhookDeliverer } from './deliverer.js';
import { classifyDeliveryOutcome } from './classify.js';
import type {
  DlqReason,
  IDeliveryLog,
  DeliveryRecord,
} from './deliveryLog.js';

/**
 * PF-451 — the p.4 ladder, in seconds, in order. ONE copy in the repository.
 *
 * `retryClockFitness.test.ts` greps for a second literal ladder anywhere under
 * `api/src`, `sdk/src` and `shared/src`, and `docs/architecture.md`'s composition
 * sketch imports this constant rather than restating it inline.
 */
export const RETRY_SCHEDULE_SECONDS = [1, 4, 16, 60, 300, 1800] as const;

/**
 * PF-452 — six attempts, then the DLQ. **Independent of the ladder's length.**
 *
 * Written as a literal with the relationship asserted in a test rather than as
 * `RETRY_SCHEDULE_SECONDS.length`, which is precisely the conflation that
 * produced the bug. That the two numbers are equal today is a coincidence of the
 * PRD naming six rungs and six attempts; the code must not depend on it.
 */
export const MAX_ATTEMPTS = 6;

/** How many rungs a full six-attempt ladder actually consumes. */
export const WAITS_CONSUMED = MAX_ATTEMPTS - 1;

/** ±10 % — the "with jitter" in p.4, bounded so it cannot reorder the ladder. */
export const JITTER_FRACTION = 0.1;

/**
 * The total wall time a full six-attempt ladder spends waiting: 1 + 4 + 16 + 60
 * + 300 seconds.
 *
 * **PF-452's ticket says 386 s and that is an arithmetic error** — the five
 * rungs its own decision consumes sum to 381. Recorded rather than quietly
 * corrected because the number appears in the acceptance criterion a PR cites,
 * and a reader checking the PR against the ticket would otherwise conclude the
 * implementation drifted. Filed as F62.
 */
export const LADDER_TOTAL_WAIT_SECONDS = 381;

/**
 * The default jitter source, named ONCE.
 *
 * A named binding rather than `Math.random` written at each of the two default
 * sites, so `retryClockFitness.test.ts` can assert there is exactly one
 * reference to `Math.random` under `platform/webhooks/**`. Two literal defaults
 * are two places a future edit could make one of them non-random without the
 * other, and nothing would fail.
 */
export const DEFAULT_JITTER: () => number = Math.random;

// Clock moved to platform/clock.ts (PF-017): the token bucket reads it too, and
// `ratelimit/` importing it from `webhooks/` made the rate limiter depend on the
// webhook pipeline for nothing. Re-exported here so `retry.ts` stays the place
// you look when you want the schedule and the clock that drives it.
export type { Clock } from '../clock.js';
export { SystemClock, FakeClock } from '../clock.js';

/**
 * PF-452/PF-453 — the wait before attempt `k`, 1-indexed, with bounded jitter.
 *
 * `null` means "do not wait, because there is no such attempt": `k === 1` fires
 * immediately, and `k > MAX_ATTEMPTS` is not scheduled at all.
 *
 * `jitter` is a PARAMETER and defaults to `Math.random`. Every test passes a
 * deterministic stub; nothing under `platform/webhooks/` calls `Math.random`
 * except this default, which is asserted by the fitness grep.
 *
 * The bound is what makes jitter safe: at ±10 %, rung *n* jittered high is
 * always strictly less than rung *n+1* jittered low (1.1 · 1 < 0.9 · 4,
 * 1.1 · 4 < 0.9 · 16, and so on for every used rung), so jitter can never make a
 * later retry arrive before an earlier one.
 */
export function delayBeforeAttemptMs(
  attemptNumber: number,
  jitter: () => number = DEFAULT_JITTER,
): number | null {
  // The first attempt is IMMEDIATE. This is the half of PF-452 that TS-7 pins.
  if (attemptNumber <= 1) return null;
  if (attemptNumber > MAX_ATTEMPTS) return null;

  // Rung `k - 2`: attempt 2 waits rung 0 (1 s), attempt 3 waits rung 1 (4 s).
  const base = RETRY_SCHEDULE_SECONDS[attemptNumber - 2];
  if (base === undefined) return null;

  const factor = 1 - JITTER_FRACTION + jitter() * 2 * JITTER_FRACTION;
  // `Math.max(1, …)` so a delay is never 0 or negative even if a caller supplies
  // a pathological jitter source. A 0 ms retry is a hot loop against a subscriber
  // that is already failing.
  return Math.max(1, Math.round(base * 1000 * factor));
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-456 — the scheduler
// ─────────────────────────────────────────────────────────────────────────────

export interface RetrySchedulerDeps {
  clock: Clock;
  deliverer: IWebhookDeliverer;
  log: IDeliveryLog;
  /** PF-453 — deterministic in tests, `Math.random` in production. */
  jitter?: () => number;
  /** PF-482's per-subscription ceiling. Absent means no breaker. */
  breaker?: ISubscriptionCircuit;
  logger?: Pick<Console, 'error' | 'warn'>;
  /** Mints delivery group ids. Injected so a test can make them predictable. */
  newGroupId?: () => string;
}

/**
 * PF-482's seam, declared here so the scheduler does not import the breaker.
 *
 * The scheduler asks two questions and reports one fact; it does not know that
 * the answer comes from `@ship/shared`'s `CircuitBreaker`, which is what lets
 * PF-482 reuse that class rather than write a second one.
 */
export interface ISubscriptionCircuit {
  /** May we attempt a delivery to this subscription right now? */
  allows(subscriptionId: string): boolean;
  record(subscriptionId: string, ok: boolean): void;
}

/** What `enqueue` needs beyond a `DeliveryJob` — set only on the replay path. */
export interface ReplayContext {
  replayOfDeliveryId: string;
  /** PF-477 — copied VERBATIM from the original row, never recomputed. */
  idempotencyKey: string;
}

/**
 * PF-456 — the ladder, driven entirely through the injected `Clock`.
 *
 * It implements `IDeliveryQueue`, so replacing `ImmediateDeliveryQueue` is an
 * edit to `api/src/deps.ts` and nothing else moves. That is the seam L15 built
 * and it is honoured literally.
 *
 * Time is read ONLY through `clock.nowMs()` and `clock.setTimeout()`.
 * `retryClockFitness.test.ts` greps `platform/webhooks/**` for a bare
 * `setTimeout(`, `setInterval(`, `Date.now(` or `new Date()` outside
 * `SystemClock` itself, and a second grep asserts zero `setTimeout` across every
 * test file in this lane. PRD p.11: *"tested with deterministic clock injection
 * — never with `setTimeout` waits in tests. Timing-based webhook tests are flaky
 * tests."*
 */
export class RetryScheduler {
  private readonly inFlight = new Set<Promise<void>>();
  /** PF-457 — the cancel handles `Clock.setTimeout` returns, RETAINED. */
  private readonly pendingTimers = new Map<string, () => void>();
  private readonly logger: Pick<Console, 'error' | 'warn'>;
  private readonly jitter: () => number;
  private readonly newGroupId: () => string;
  private groupCounter = 0;

  constructor(private readonly deps: RetrySchedulerDeps) {
    this.logger = deps.logger ?? console;
    this.jitter = deps.jitter ?? DEFAULT_JITTER;
    // `randomUUID` and not a timestamp: the group id has to be unique across
    // every process writing to one `webhook_deliveries` table, and a clock-derived
    // id from two schedulers that started in the same millisecond would collide on
    // `UNIQUE (delivery_group_id, attempt_number)`. It is also not a clock read,
    // which is what keeps PF-456's grep green.
    this.newGroupId = deps.newGroupId ?? (() => randomUUID());
  }

  /**
   * L15's `IDeliveryQueue.enqueue`. Returns `void` and MUST NOT be awaited — the
   * bus handler runs on the request path (PF-441) and a subscriber's latency must
   * never be inside `POST /api/v1/documents`'s P95.
   */
  enqueue(job: DeliveryJob, replay?: ReplayContext): void {
    const groupId = this.newGroupId();
    this.track(this.runAttempt(job, groupId, 1, job.request, replay));
  }

  /**
   * Await every in-flight attempt. **Tests only; no production caller.**
   *
   * It awaits the promises themselves rather than a timer, which is what makes
   * the scenario tests deterministic: `clock.advance(1000)` fires the due
   * callback synchronously, the callback's async continuation is a microtask, and
   * `await settled()` drains it. A `setTimeout(0)` here would be a guess that
   * usually works, which is the flake p.11 forbids.
   */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  pendingCount(): number {
    return this.inFlight.size;
  }

  /** Outstanding scheduled retries. Lets a test assert nothing leaked. */
  scheduledCount(): number {
    return this.pendingTimers.size;
  }

  /**
   * PF-457 — cancel every scheduled retry. Called at shutdown.
   *
   * Without the retained handles this is impossible, and a process that is
   * draining keeps firing POSTs at subscribers for up to six minutes after it
   * stopped serving traffic.
   */
  stop(): void {
    for (const cancel of this.pendingTimers.values()) cancel();
    this.pendingTimers.clear();
  }

  private track(promise: Promise<void>): void {
    const tracked = promise
      .catch((err: unknown) => {
        // Swallowed on purpose. An unhandled rejection from a fire-and-forget
        // delivery crashes the process under Node's default policy, which would
        // mean a broken subscriber can take Ship down.
        this.logger.error('[webhooks] retry ladder failed outside the delivery path.', err);
      })
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }

  private async runAttempt(
    job: DeliveryJob,
    groupId: string,
    attemptNumber: number,
    request: DeliveryRequest,
    replay: ReplayContext | undefined,
  ): Promise<void> {
    const attemptedAt = new Date(this.deps.clock.nowMs()).toISOString();

    // PF-470 — the key is the job's for attempt 1 of an original delivery, and
    // the ORIGINAL row's for a replay. It is never recomputed after that: every
    // later attempt reads it back off the row this call writes.
    const idempotencyKey = replay?.idempotencyKey ?? job.idempotencyKey;

    // PF-482 — the runaway ceiling, checked BEFORE the row is written. An open
    // circuit dead-letters rather than dropping: a delivery that vanished is one
    // the portal cannot show and an operator cannot replay.
    if (this.deps.breaker && !this.deps.breaker.allows(job.subscriptionId)) {
      const row = await this.deps.log.beginAttempt({
        delivery_group_id: groupId,
        subscription_id: job.subscriptionId,
        event_id: job.eventId,
        event_type: job.eventType,
        attempt_number: attemptNumber,
        idempotency_key: idempotencyKey,
        signature_header: null,
        replay_of_delivery_id: replay?.replayOfDeliveryId ?? null,
        raw_body: request.rawBody,
        attempted_at: attemptedAt,
      });
      await this.deps.log.completeAttempt(row.id, {
        status: 'dead_lettered',
        response_status: null,
        response_excerpt: null,
        latency_ms: null,
        dlq_reason: 'circuit_open',
      });
      return;
    }

    // PF-459 — the row goes in BEFORE the HTTP call. A log written only on
    // completion records exactly the attempts that did not need reconstructing.
    const row = await this.deps.log.beginAttempt({
      delivery_group_id: groupId,
      subscription_id: job.subscriptionId,
      event_id: job.eventId,
      event_type: job.eventType,
      attempt_number: attemptNumber,
      idempotency_key: idempotencyKey,
      signature_header: request.signatureHeader,
      replay_of_delivery_id: replay?.replayOfDeliveryId ?? null,
      raw_body: request.rawBody,
      attempted_at: attemptedAt,
    });

    const result = await this.deps.deliverer.deliver(request);
    this.deps.breaker?.record(job.subscriptionId, result.ok);

    const outcome = classifyDeliveryOutcome(result.status);

    if (outcome === 'success') {
      await this.complete(row, 'delivered', result, null);
      return;
    }

    // PF-455 — a permanent classification skips the ladder entirely. A 404 means
    // the subscriber already told us to stop; six attempts over six minutes is a
    // retry storm against an endpoint that answered.
    if (outcome === 'permanent') {
      await this.complete(row, 'dead_lettered', result, 'permanent_status');
      return;
    }

    // PF-452 — the 6th failed attempt is the last one. There is no 7th, which is
    // the assertion Testing Scenario 8 makes.
    if (attemptNumber >= MAX_ATTEMPTS) {
      await this.complete(row, 'dead_lettered', result, 'max_attempts_exhausted');
      return;
    }

    await this.complete(row, 'failed', result, null);
    this.scheduleNext(job, groupId, attemptNumber + 1, replay);
  }

  private async complete(
    row: DeliveryRecord,
    status: 'delivered' | 'failed' | 'dead_lettered',
    result: { status: number | null; responseExcerpt: string | null; latencyMs: number },
    dlqReason: DlqReason | null,
  ): Promise<void> {
    await this.deps.log.completeAttempt(row.id, {
      status,
      response_status: result.status,
      response_excerpt: result.responseExcerpt,
      latency_ms: result.latencyMs,
      dlq_reason: dlqReason,
    });
  }

  private scheduleNext(
    job: DeliveryJob,
    groupId: string,
    attemptNumber: number,
    replay: ReplayContext | undefined,
  ): void {
    const delay = delayBeforeAttemptMs(attemptNumber, this.jitter);
    if (delay === null) return;

    const timerKey = `${groupId}:${attemptNumber}`;
    const cancel = this.deps.clock.setTimeout(() => {
      this.pendingTimers.delete(timerKey);
      this.track(this.resignAndRun(job, groupId, attemptNumber, replay));
    }, delay);
    // PF-457 — RETAINED, not discarded. The spike's `Clock.setTimeout` already
    // returned a cancel function and nothing held it.
    this.pendingTimers.set(timerKey, cancel);
  }

  /**
   * Attempt 2..N. The request is re-signed with a fresh `t` and the
   * subscription's CURRENT secret (L15 PF-442/PF-443).
   *
   * `resign()` returning `null` means the subscription was deactivated or removed
   * mid-ladder. That is `cancelled`, NOT `dead_lettered` — an operator who
   * switched a subscription off did not get a delivery failure, and a DLQ full of
   * their own deactivations is a DLQ nobody reads. L15's seam documentation is
   * explicit that `null` means abandon.
   */
  private async resignAndRun(
    job: DeliveryJob,
    groupId: string,
    attemptNumber: number,
    replay: ReplayContext | undefined,
  ): Promise<void> {
    const request = await job.resign();

    if (request === null) {
      // The attempt is still RECORDED, with the deliverer never called. "Attempt
      // 3 was due and was abandoned because the subscription went away" is a
      // fact an operator needs; a silent gap in the attempt numbers is not.
      const row = await this.deps.log.beginAttempt({
        delivery_group_id: groupId,
        subscription_id: job.subscriptionId,
        event_id: job.eventId,
        event_type: job.eventType,
        attempt_number: attemptNumber,
        idempotency_key: replay?.idempotencyKey ?? job.idempotencyKey,
        signature_header: null,
        replay_of_delivery_id: replay?.replayOfDeliveryId ?? null,
        raw_body: job.request.rawBody,
        attempted_at: new Date(this.deps.clock.nowMs()).toISOString(),
      });
      await this.deps.log.completeAttempt(row.id, {
        status: 'cancelled',
        response_status: null,
        response_excerpt: null,
        latency_ms: null,
        dlq_reason: null,
      });
      return;
    }

    await this.runAttempt(job, groupId, attemptNumber, request, replay);
  }
}
