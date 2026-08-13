/**
 * PF-451 · PF-452 · PF-453 · PF-454 — the ladder, the off-by-one, jitter, and
 * the classifier.
 *
 * Pure functions only; the scheduler is `retryScheduler.test.ts`. No database,
 * no clock, no `setTimeout` — see `retryClockFitness.test.ts`, which asserts the
 * absence mechanically rather than by review.
 */
import { describe, it, expect } from 'vitest';
import {
  RETRY_SCHEDULE_SECONDS,
  MAX_ATTEMPTS,
  WAITS_CONSUMED,
  JITTER_FRACTION,
  LADDER_TOTAL_WAIT_SECONDS,
  delayBeforeAttemptMs,
} from './retry.js';
import {
  classifyDeliveryOutcome,
  TRANSIENT_CLIENT_STATUSES,
  type DeliveryOutcome,
} from './classify.js';

describe('PF-451 — RETRY_SCHEDULE_SECONDS is the p.4 ladder, once', () => {
  it('deep-equals [1, 4, 16, 60, 300, 1800] — the p.4 ladder in seconds, in order', () => {
    // PRD p.4: "Exponential backoff with jitter: 1s, 4s, 16s, 1m, 5m, 30m."
    expect([...RETRY_SCHEDULE_SECONDS]).toEqual([1, 4, 16, 60, 300, 1800]);
  });

  it('has six rungs, and they are strictly increasing', () => {
    expect(RETRY_SCHEDULE_SECONDS).toHaveLength(6);
    for (let i = 1; i < RETRY_SCHEDULE_SECONDS.length; i += 1) {
      expect(RETRY_SCHEDULE_SECONDS[i]!).toBeGreaterThan(RETRY_SCHEDULE_SECONDS[i - 1]!);
    }
  });
});

describe('PF-452 — six attempts, five waits, and the 30m rung never fires', () => {
  it('MAX_ATTEMPTS is 6 and is NOT derived from the ladder length', () => {
    expect(MAX_ATTEMPTS).toBe(6);
    // They are equal today. The point of the ticket is that the code must not
    // depend on that: the ladder is "how long do we wait", MAX_ATTEMPTS is "how
    // many times do we try", and the spike's `= RETRY_SCHEDULE_SECONDS.length`
    // conflated them. Changing the array must not change the attempt count, so
    // this asserts the literal rather than the relationship.
    expect(WAITS_CONSUMED).toBe(5);
  });

  it('attempt 1 is IMMEDIATE — this is the half Testing Scenario 7 pins', () => {
    // p.5, TS-7: "1s, 4s, 16s ≥ wait times before each attempt" for attempts 2,
    // 3 and 4. That is only true if attempt 1 does not wait. The spike's
    // SCHEDULE[k-1] put a 1 s sleep here and shifted every TS-7 rung by one.
    expect(delayBeforeAttemptMs(1, () => 0.5)).toBeNull();
    expect(delayBeforeAttemptMs(0, () => 0.5)).toBeNull();
  });

  it('the wait before attempt k is rung k-2: 1s, 4s, 16s, 1m, 5m', () => {
    const noJitter = () => 0.5;
    expect(delayBeforeAttemptMs(2, noJitter)).toBe(1_000);
    expect(delayBeforeAttemptMs(3, noJitter)).toBe(4_000);
    expect(delayBeforeAttemptMs(4, noJitter)).toBe(16_000);
    expect(delayBeforeAttemptMs(5, noJitter)).toBe(60_000);
    expect(delayBeforeAttemptMs(6, noJitter)).toBe(300_000);
  });

  it('(a) a six-attempt run consumes exactly five waits summing to 381 s', () => {
    // PF-452's acceptance criterion says "five waits summing to 386 s". That is
    // an arithmetic error in the ticket: 1 + 4 + 16 + 60 + 300 = 381. Filed as
    // F62 and corrected here rather than in the code, because the decision the
    // ticket makes is right and only its addition is wrong.
    const noJitter = () => 0.5;
    const waits: number[] = [];
    for (let k = 1; k <= MAX_ATTEMPTS; k += 1) {
      const delay = delayBeforeAttemptMs(k, noJitter);
      if (delay !== null) waits.push(delay);
    }
    expect(waits).toHaveLength(5);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(LADDER_TOTAL_WAIT_SECONDS * 1000);
    expect(LADDER_TOTAL_WAIT_SECONDS).toBe(381);
    // The exported constant is the sum of the rungs the ladder actually uses —
    // asserted against the array so the two cannot drift.
    expect(RETRY_SCHEDULE_SECONDS.slice(0, WAITS_CONSUMED).reduce((a, b) => a + b, 0)).toBe(
      LADDER_TOTAL_WAIT_SECONDS,
    );
  });

  it('(b) 1800 s is NEVER produced by any reachable attempt number', () => {
    // The 30 m rung is in the array because the PRD names it; it is unreachable
    // because six attempts have five gaps. This is the assertion that stops
    // someone "fixing" the dead constant by raising MAX_ATTEMPTS to 7 — which
    // would break Testing Scenario 8, whose whole claim is that the delivery is
    // IN the DLQ after the 6th failure rather than scheduled for a 7th.
    const produced = new Set<number>();
    for (let k = 0; k <= 20; k += 1) {
      const delay = delayBeforeAttemptMs(k, () => 0.5);
      if (delay !== null) produced.add(delay);
    }
    expect(produced.has(1_800_000)).toBe(false);
    expect(RETRY_SCHEDULE_SECONDS).toContain(1800);
  });

  it('(c) delayBeforeAttemptMs(7) is null — there is no seventh attempt', () => {
    expect(delayBeforeAttemptMs(7, () => 0.5)).toBeNull();
    expect(delayBeforeAttemptMs(8, () => 0.5)).toBeNull();
    expect(delayBeforeAttemptMs(100, () => 0.5)).toBeNull();
  });
});

describe('PF-453 — jitter is injected, bounded, and cannot reorder the ladder', () => {
  const rungs = [1_000, 4_000, 16_000, 60_000, 300_000];

  it('stays within ±10% of the rung at both extremes of the jitter source', () => {
    for (let k = 2; k <= MAX_ATTEMPTS; k += 1) {
      const rung = rungs[k - 2]!;
      const low = delayBeforeAttemptMs(k, () => 0)!;
      const high = delayBeforeAttemptMs(k, () => 1)!;
      expect(low).toBe(Math.round(rung * (1 - JITTER_FRACTION)));
      expect(high).toBe(Math.round(rung * (1 + JITTER_FRACTION)));
      expect(low).toBeGreaterThanOrEqual(rung * 0.9);
      expect(high).toBeLessThanOrEqual(rung * 1.1);
    }
  });

  it('a jittered rung n is always strictly less than a jittered rung n+1', () => {
    // The property that makes jitter safe: 1.1·1 < 0.9·4, 1.1·4 < 0.9·16, …
    // Without it a later retry could arrive before an earlier one and the ladder
    // would not be a ladder.
    for (let k = 2; k < MAX_ATTEMPTS; k += 1) {
      const latestOfN = delayBeforeAttemptMs(k, () => 1)!;
      const earliestOfNext = delayBeforeAttemptMs(k + 1, () => 0)!;
      expect(latestOfN).toBeLessThan(earliestOfNext);
    }
  });

  it('never returns a delay ≤ 0, even for a pathological jitter source', () => {
    for (const jitter of [() => -100, () => 0, () => Number.NEGATIVE_INFINITY]) {
      for (let k = 2; k <= MAX_ATTEMPTS; k += 1) {
        expect(delayBeforeAttemptMs(k, jitter)!).toBeGreaterThan(0);
      }
    }
  });

  it('takes the random source as a parameter — no test passes Math.random', () => {
    // Determinism by construction. Two calls with the same stub are equal; the
    // signature is what makes that possible.
    expect(delayBeforeAttemptMs(3, () => 0.25)).toBe(delayBeforeAttemptMs(3, () => 0.25));
  });
});

describe('PF-454 — classifyDeliveryOutcome, one row per status', () => {
  // One assertion per row, exactly the table the ticket names, plus null.
  const table: [number | null, DeliveryOutcome, string][] = [
    [100, 'permanent', '1xx is never a final response; we do not retry into it'],
    [200, 'success', ''],
    [204, 'success', 'a subscriber acknowledging with no body is a success'],
    [301, 'permanent', 'redirects are not followed — a moved target is a config fix'],
    [400, 'permanent', ''],
    [401, 'permanent', 'the subscriber rejected our signature; retrying re-sends it'],
    [403, 'permanent', ''],
    [404, 'permanent', 'the endpoint is gone — PF-455 dead-letters on attempt 1'],
    [408, 'transient', 'Request Timeout says "not now", not "never"'],
    [409, 'permanent', ''],
    [410, 'permanent', 'p.16 names 410 Gone as the permanent example'],
    [418, 'permanent', ''],
    [425, 'transient', 'Too Early is an explicit ask to send it again'],
    [429, 'transient', 'THE departure from p.4 — see D9'],
    [500, 'transient', ''],
    [502, 'transient', ''],
    [503, 'transient', ''],
    [504, 'transient', ''],
    [null, 'transient', 'no response arrived: DNS, refused, TLS, or our own abort'],
  ];

  for (const [status, expected, why] of table) {
    it(`${status === null ? 'null (no response)' : status} → ${expected}${why ? ` — ${why}` : ''}`, () => {
      expect(classifyDeliveryOutcome(status)).toBe(expected);
    });
  }

  it('D9 — the three transient 4xx are exactly 408, 425 and 429', () => {
    // p.4 says "4xx responses are treated as permanent failures and
    // dead-lettered", flat. p.16 asks the question and names "429 transient".
    // This lane took p.16. The exception list is data so the departure is one
    // array rather than a chain of || in a branch.
    expect([...TRANSIENT_CLIENT_STATUSES].sort((a, b) => a - b)).toEqual([408, 425, 429]);

    for (let status = 400; status <= 499; status += 1) {
      const expected = TRANSIENT_CLIENT_STATUSES.includes(status) ? 'transient' : 'permanent';
      expect(classifyDeliveryOutcome(status), `status ${status}`).toBe(expected);
    }
  });

  it('every 5xx is transient and every 2xx is a success, with no gaps', () => {
    for (let status = 500; status <= 599; status += 1) {
      expect(classifyDeliveryOutcome(status), `status ${status}`).toBe('transient');
    }
    for (let status = 200; status <= 299; status += 1) {
      expect(classifyDeliveryOutcome(status), `status ${status}`).toBe('success');
    }
  });
});
