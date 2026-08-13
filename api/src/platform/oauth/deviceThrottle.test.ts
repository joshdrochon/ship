/**
 * PF-132 — the `user_code` guess throttle, and the RFC 8628 §5.1 product.
 * Lane L05, slice S2.
 *
 * Table-driven over a `FakeClock`. Nothing here sleeps, and nothing reads the
 * wall clock — PRD p.11 forbids timing-based tests by name.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeClock } from '../clock.js';
import {
  UserCodeAttemptThrottle,
  throttleKeysFor,
  USER_CODE_MAX_FAILURES,
  USER_CODE_SUSPICION_FAILURES,
  USER_CODE_FAILURE_COOLDOWN_SECONDS,
  USER_CODE_FAILURE_WINDOW_SECONDS,
} from './deviceThrottle.js';
import { USER_CODE_CHARSET, USER_CODE_RAW_LENGTH, DEVICE_CODE_TTL_SECONDS } from './deviceCodes.js';

let clock: FakeClock;
let throttle: UserCodeAttemptThrottle;

beforeEach(() => {
  clock = new FakeClock(0);
  throttle = new UserCodeAttemptThrottle(clock);
});

describe('PF-132: the failure counter', () => {
  it('allows an unseen key', () => {
    expect(throttle.check('ip:1.2.3.4').allowed).toBe(true);
  });

  it('blocks on the Nth failure and reports a Retry-After', () => {
    const key = 'ip:1.2.3.4';
    for (let i = 1; i < USER_CODE_MAX_FAILURES; i += 1) {
      expect(throttle.recordFailure(key).allowed, `failure ${i}`).toBe(true);
    }
    const tripped = throttle.recordFailure(key);
    expect(tripped.allowed).toBe(false);
    expect(tripped.retryAfterSeconds).toBe(USER_CODE_FAILURE_COOLDOWN_SECONDS);
    expect(throttle.check(key).allowed).toBe(false);
  });

  it('lifts the cooldown exactly when it expires, on the injected clock', () => {
    const key = 'ip:1.2.3.4';
    for (let i = 0; i < USER_CODE_MAX_FAILURES; i += 1) throttle.recordFailure(key);

    // One second short: still blocked.
    clock.advance((USER_CODE_FAILURE_COOLDOWN_SECONDS - 1) * 1000);
    expect(throttle.check(key).allowed).toBe(false);

    // Past it: allowed, and starting clean rather than one mistake from
    // re-tripping.
    clock.advance(2000);
    expect(throttle.check(key).allowed).toBe(true);
    expect(throttle.isSuspect(key)).toBe(false);
  });

  it('ages failures out of the sliding window', () => {
    const key = 'ip:1.2.3.4';
    // Four failures, then wait out the window: they should no longer count.
    for (let i = 0; i < USER_CODE_MAX_FAILURES - 1; i += 1) throttle.recordFailure(key);
    clock.advance(USER_CODE_FAILURE_WINDOW_SECONDS * 1000 + 1000);

    // A fresh failure is the FIRST in the window, not the fifth.
    expect(throttle.recordFailure(key).allowed).toBe(true);
    expect(throttle.check(key).allowed).toBe(true);
  });

  it('a slow grinder cannot pace under the threshold — window equals cooldown', () => {
    // The reason the two constants are equal is stated in the module; this pins
    // it so shortening the window silently becomes a test failure.
    expect(USER_CODE_FAILURE_WINDOW_SECONDS).toBe(USER_CODE_FAILURE_COOLDOWN_SECONDS);
  });

  it('a cooldown outlives the code it is protecting', () => {
    // A cooldown shorter than the code's TTL would let an attacker resume
    // against the SAME live code, making it a speed bump rather than a stop.
    expect(USER_CODE_FAILURE_COOLDOWN_SECONDS).toBeGreaterThan(DEVICE_CODE_TTL_SECONDS);
  });

  it('recordSuccess clears the key', () => {
    const key = 'ip:1.2.3.4';
    throttle.recordFailure(key);
    throttle.recordFailure(key);
    throttle.recordSuccess(key);
    expect(throttle.isSuspect(key)).toBe(false);
    expect(throttle.size()).toBe(0);
  });

  it('tracks keys independently — one IP cannot cut off another', () => {
    for (let i = 0; i < USER_CODE_MAX_FAILURES; i += 1) throttle.recordFailure('ip:1.1.1.1');
    expect(throttle.check('ip:1.1.1.1').allowed).toBe(false);
    expect(throttle.check('ip:2.2.2.2').allowed).toBe(true);
  });
});

describe('PF-132: suspicion is a LOWER threshold than the block', () => {
  it('is strictly below the block threshold, or the clause is dead code', () => {
    // With one threshold, the attempt that crosses it also starts the cooldown,
    // so every later attempt is refused before a lookup happens and a found
    // code is never observed. This is the assertion that keeps them apart.
    expect(USER_CODE_SUSPICION_FAILURES).toBeLessThan(USER_CODE_MAX_FAILURES);
  });

  it('becomes suspect at three, while still allowing attempts', () => {
    const key = 'ip:1.2.3.4';
    for (let i = 0; i < USER_CODE_SUSPICION_FAILURES; i += 1) throttle.recordFailure(key);
    expect(throttle.isSuspect(key)).toBe(true);
    // Crucially still ALLOWED — which is what makes the invalidation reachable.
    expect(throttle.check(key).allowed).toBe(true);
  });

  it('is not suspect below the threshold — fumbling is not guessing', () => {
    const key = 'ip:1.2.3.4';
    for (let i = 0; i < USER_CODE_SUSPICION_FAILURES - 1; i += 1) throttle.recordFailure(key);
    expect(throttle.isSuspect(key)).toBe(false);
  });
});

describe('PF-132: the throttle key', () => {
  it('uses session AND ip, so neither alone can be escaped', () => {
    expect(throttleKeysFor('sess-1', '1.2.3.4')).toEqual(['session:sess-1', 'ip:1.2.3.4']);
  });

  it('falls back to ip alone for an anonymous visitor', () => {
    expect(throttleKeysFor(undefined, '1.2.3.4')).toEqual(['ip:1.2.3.4']);
  });

  it('never produces an empty key set', () => {
    expect(throttleKeysFor(undefined, undefined)).toEqual(['ip:unknown']);
  });
});

describe('PF-123 x PF-132: the RFC 8628 §5.1 product, against the SHIPPED constants', () => {
  it('makes brute force impractical over a code’s whole life', () => {
    // §5.1 is a claim about entropy x throttling, so neither number means
    // anything alone. Computed from the constants that actually ship, so
    // lowering the entropy or loosening the throttle fails HERE rather than
    // quietly invalidating a paragraph in a header.
    const codeSpace = Math.pow(USER_CODE_CHARSET.length, USER_CODE_RAW_LENGTH);
    expect(codeSpace).toBeGreaterThan(3e11);

    // L11's `/oauth` limiter (finding F29) is 30 requests/minute per IP. This
    // lane's own counter is far tighter, so 30/min is the CONSERVATIVE bound.
    const attemptsPerMinute = 30;
    const attemptsOverCodeLife = attemptsPerMinute * (DEVICE_CODE_TTL_SECONDS / 60);
    expect(attemptsOverCodeLife).toBe(300);

    // Generous: assume 100 codes live at once, ten times a realistic demo.
    const liveCodes = 100;
    const pHit = (attemptsOverCodeLife * liveCodes) / codeSpace;
    expect(pHit).toBeLessThan(1e-6);
  });

  it('holds even for an attacker grinding for a full day', () => {
    const codeSpace = Math.pow(USER_CODE_CHARSET.length, USER_CODE_RAW_LENGTH);
    const attemptsPerDay = 30 * 60 * 24;
    const pHit = (attemptsPerDay * 100) / codeSpace;
    expect(pHit).toBeLessThan(1e-3);
  });

  it('this lane’s own counter is far tighter than the transport limiter', () => {
    // The point of keeping a second, failure-specific counter: it can be an
    // order of magnitude stricter than a request-rate limiter without touching
    // the polling loop, which has to run every few seconds on the same
    // connection and would be throttled by a tight request limit.
    expect(USER_CODE_MAX_FAILURES).toBeLessThan(30);
  });
});
