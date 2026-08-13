/**
 * PF-482 — the runaway-queue cost ceiling. **Reuses `@ship/shared`'s
 * `CircuitBreaker`; there is no second breaker.**
 *
 * Pre-Search 1.2 (PRD p.15): *"If your webhook deliverer's queue runs away (a
 * subscriber that 5xx's forever multiplied by every event), what is your
 * runaway-cost ceiling and what mechanism enforces it?"*
 *
 * ─── The DLQ is NOT the answer, and dispute B4 says so ───────────────────────
 *
 * The DLQ caps attempts per *delivery* — six, then stop. It does not cap
 * deliveries per *subscription*. A subscriber that 5xx's forever still costs
 * **6 attempts × every matching event, indefinitely**: the ladder is bounded,
 * the number of ladders is not. Anyone reading "DLQ after 6 attempts" as the
 * cost answer has answered a different question.
 *
 * The actual ceiling is a breaker per `subscription_id`: after
 * `failureThreshold` consecutive failures the circuit opens, and while it is
 * open new deliveries for that subscription go **straight to the DLQ** with
 * `dlq_reason = 'circuit_open'` rather than being attempted or dropped. Dropped
 * would be worse than either — a delivery that vanished is one the portal cannot
 * show and an operator cannot replay.
 *
 * ─── Two adaptations, and neither is a fork ──────────────────────────────────
 *
 * `api/src/services/circuitBreaker.ts` records the standing rule in its header:
 * *"the agent needs the same breaker — engineering requirement 4 says reuse it,
 * do not write a second one."* This module obeys it.
 *
 *   1. The shared breaker takes `now?: () => number`; L01's `Clock` is an
 *      interface with `nowMs()`. One lambda bridges them, and it is what makes
 *      the cooldown testable without waiting.
 *   2. It is a SINGLE-circuit object, and this needs one per subscription. A
 *      keyed map of instances, with a bound on the map for the same reason
 *      L11's token bucket has one — subscription ids are unbounded over the life
 *      of a process.
 *
 * Both adaptations live here, in `platform/webhooks/`, and not in `shared/`:
 * "one breaker per webhook subscription" is a fact about this lane, not about
 * circuit breaking. `ceilingFitness.test.ts` greps `platform/` for a second
 * breaker class.
 */
import { CircuitBreaker } from '@ship/shared';
import type { Clock } from '../clock.js';
import type { ISubscriptionCircuit } from './retry.js';

export interface SubscriptionCircuitOptions {
  clock: Clock;
  /**
   * Consecutive failed attempts before a subscription's circuit opens.
   *
   * **5**, chosen against the ladder rather than picked round: one full
   * six-attempt ladder ending in the DLQ is five failures plus the final one, so
   * a threshold of 5 means a single dead delivery opens the circuit at the point
   * the ladder itself has already concluded the subscriber is down. A lower
   * value would trip on a subscriber having one bad minute; a higher one lets a
   * second full ladder run before anything notices.
   */
  failureThreshold?: number;
  /**
   * How long the circuit stays open before one probe is allowed through.
   *
   * **60 s.** It is the rung after the ones a single ladder consumes (1s, 4s,
   * 16s, 1m, 5m), so a recovering subscriber is retried on roughly the cadence
   * the retry schedule already establishes rather than on a second, unrelated
   * timescale. The shared breaker's half-open state lets exactly one probe
   * through, which is what stops a recovering subscriber being hit by every
   * queued delivery at once.
   */
  cooldownMs?: number;
  /** Memory bound on the keyed map. See `sweep`. */
  maxCircuits?: number;
}

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_MAX_CIRCUITS = 10_000;

/**
 * The ceiling, as a NUMBER — which is what Pre-Search 1.2 actually asks for.
 *
 * With the defaults above, one permanently-broken subscription costs at most:
 *
 *   before the circuit opens   6 attempts (one full ladder)
 *   while open                 0 attempts — deliveries dead-letter without a
 *                              request, so the cost is a row, not a socket
 *   per cooldown               1 half-open probe every 60 s
 *
 * So the steady-state ceiling is **60 attempts per hour per subscription**,
 * independent of event volume — which is the property that matters, because the
 * unbounded term in the runaway is events, not attempts per event. Without the
 * breaker the same subscriber costs 6 × (events per hour), which at p.9's
 * 100 000-user tier is roughly 6 × 208 000 = 1.25 M outbound requests per hour
 * from ONE broken endpoint.
 */
export const ATTEMPTS_PER_HOUR_CEILING = 3_600_000 / DEFAULT_COOLDOWN_MS;

/**
 * One `CircuitBreaker` per subscription, keyed.
 *
 * Implements `ISubscriptionCircuit`, which is the two-method seam the scheduler
 * declares — so the scheduler never imports a breaker and cannot grow an opinion
 * about how the ceiling is enforced.
 */
export class SubscriptionCircuits implements ISubscriptionCircuit {
  private readonly circuits = new Map<string, CircuitBreaker>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxCircuits: number;

  constructor(private readonly options: SubscriptionCircuitOptions) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxCircuits = options.maxCircuits ?? DEFAULT_MAX_CIRCUITS;
  }

  private circuitFor(subscriptionId: string): CircuitBreaker {
    const existing = this.circuits.get(subscriptionId);
    if (existing) return existing;

    if (this.circuits.size >= this.maxCircuits) this.sweep();

    const breaker = new CircuitBreaker({
      name: `webhook-subscription:${subscriptionId}`,
      failureThreshold: this.failureThreshold,
      cooldownMs: this.cooldownMs,
      // Adaptation 1: L01's Clock, in one lambda. This is what makes the
      // cooldown assertable with `FakeClock.advance` rather than a sleep.
      now: () => this.options.clock.nowMs(),
    });
    this.circuits.set(subscriptionId, breaker);
    return breaker;
  }

  /**
   * May we attempt a delivery to this subscription right now?
   *
   * `state !== 'open'` rather than the shared breaker's `run()`: the scheduler
   * needs to know BEFORE it writes the attempt row, so it can dead-letter with
   * `circuit_open` instead of throwing mid-attempt. `half-open` allows the probe
   * through, which is the recovery path.
   */
  allows(subscriptionId: string): boolean {
    return this.circuitFor(subscriptionId).state !== 'open';
  }

  /**
   * Record an outcome. **Returns a promise, and callers must await it.**
   *
   * The shared breaker's only state transition is `run()`, which is async — so
   * recording through it and returning `void` would leave the state update in a
   * microtask, and a caller that checked `allows()` on the next line would read
   * a circuit that has not opened yet. That is not theoretical: it is what the
   * first draft of this file did, and `ceilings.test.ts` caught it by asserting
   * `allows()` immediately after a threshold-tripping failure.
   *
   * The alternative was a synchronous `recordFailure()` on the shared breaker,
   * which would mean editing `@ship/shared` to suit one consumer and giving the
   * class a second way to change state. Awaiting is one keyword at the two call
   * sites, both of which are already async.
   */
  async record(subscriptionId: string, ok: boolean): Promise<void> {
    const breaker = this.circuitFor(subscriptionId);
    // `run()` with an already-settled promise, so the breaker's own state
    // machine does the counting. Re-implementing "count consecutive failures,
    // open at N, half-open after the cooldown" here would be the second breaker
    // the standing rule forbids — it is the same 40 lines, and the copy is the
    // one that drifts.
    try {
      await breaker.run(() =>
        ok ? Promise.resolve() : Promise.reject(new Error('delivery failed')),
      );
    } catch {
      // Both the injected failure and `CircuitOpenError` land here. Neither is
      // an error for this caller: the first IS the fact being recorded, and the
      // second means the circuit was already open, which `allows()` reports.
    }
  }

  /** Diagnostics, for a log line or a portal panel. */
  stateOf(subscriptionId: string): string {
    return this.circuitFor(subscriptionId).state;
  }

  openCount(): number {
    let open = 0;
    for (const breaker of this.circuits.values()) if (breaker.state === 'open') open += 1;
    return open;
  }

  size(): number {
    return this.circuits.size;
  }

  /**
   * Drop every CLOSED circuit.
   *
   * A memory bound, not a policy: a closed circuit carries no state worth
   * keeping — it is indistinguishable from a subscription that has never
   * failed — while an open or half-open one is actively suppressing traffic and
   * must survive. Same shape as L11's `maxKeys` sweep, and the same reasoning:
   * subscription ids accumulate for the life of a process.
   */
  private sweep(): void {
    for (const [id, breaker] of this.circuits) {
      if (breaker.state === 'closed') this.circuits.delete(id);
    }
  }
}
