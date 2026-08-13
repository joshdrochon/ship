/**
 * L11 S1 — PF-301, PF-302, PF-303.
 *
 * The bucket's arithmetic, proven over `FakeClock`. There is no `setTimeout` in
 * this file and there must never be one: PRD p.11 rules out waiting in tests and
 * p.9 sets the week's flake budget at 0% over 20 runs. PF-303 asserts the
 * absence mechanically at the bottom of the file rather than trusting review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../clock.js';
import {
  InMemoryTokenBucket,
  NullLimiter,
  AlwaysDenyLimiter,
  chooseBinding,
  type IRateLimiter,
  type RateDecision,
} from './limiter.js';

/** One token per second, ten-token burst — small enough to exhaust by hand. */
const SMALL = { capacity: 10, refillPerSecond: 1, maxKeys: 1000 };

describe('PF-302 — the clock is injected, and there is no default', () => {
  it('a bucket reads only the clock it was handed', () => {
    const clock = new FakeClock(1_000_000);
    const bucket = new InMemoryTokenBucket(SMALL, clock);

    const first = bucket.consume('k');
    clock.advance(5_000);
    const second = bucket.consume('k');

    // Five seconds of refill at 1/s: nine tokens left, then five back, capped at
    // capacity-1 after the second spend. If the bucket were reading wall time,
    // `advance` would be invisible and this number would be 8.
    expect(first.remaining).toBe(9);
    expect(second.remaining).toBe(9);
  });

  it('the constructor requires a clock — a missing one is a type error, not a flake', () => {
    // The compile-time half of PF-302. `@ts-expect-error` FAILS the build if the
    // call ever becomes legal again, so re-adding `clock: Clock = new SystemClock()`
    // breaks `pnpm type-check` rather than silently reintroducing wall-clock reads.
    // @ts-expect-error - clock is a required constructor argument (PF-302)
    const _illegal = () => new InMemoryTokenBucket(SMALL);
    expect(typeof _illegal).toBe('function');
  });

  it('no source file under ratelimit/ constructs a SystemClock', () => {
    // The runtime half. `api/src/deps.ts` is the only place a concrete clock is
    // chosen (PF-015); a `new SystemClock()` here would be that decision leaking
    // back into the module that is supposed to be told about it.
    const source = readFileSync(fileURLToPath(new URL('./limiter.ts', import.meta.url)), 'utf8');
    const code = stripComments(source);
    expect(code).not.toMatch(/new\s+SystemClock/);
  });
});

describe('PF-303 — burst, refill and the invariants that hold at every step', () => {
  it('a burst of exactly `capacity` is allowed and `capacity + 1` is denied', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);

    const burst = Array.from({ length: SMALL.capacity }, () => bucket.consume('k'));
    expect(burst.every((d) => d.allowed)).toBe(true);
    expect(burst.at(-1)!.remaining).toBe(0);

    const overflow = bucket.consume('k');
    expect(overflow.allowed).toBe(false);
    expect(overflow.remaining).toBe(0);
  });

  it('after one refill interval exactly one more request is allowed', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    for (let i = 0; i < SMALL.capacity; i++) bucket.consume('k');
    expect(bucket.consume('k').allowed).toBe(false);

    // One token's worth of time — 1000 ms at 1/s.
    clock.advance(1000 / SMALL.refillPerSecond);
    expect(bucket.consume('k').allowed).toBe(true);
    // …and exactly one. The second in the same instant has nothing to spend.
    expect(bucket.consume('k').allowed).toBe(false);
  });

  it('tokens never exceed capacity, however long the bucket idles', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    bucket.consume('k');

    clock.advance(60 * 60 * 1000); // an idle hour

    // If refill were unbounded, an hour at 1/s would bank 3600 tokens and the
    // burst below would run to 3600 rather than stopping at `capacity`.
    let allowed = 0;
    for (let i = 0; i < SMALL.capacity * 5; i++) {
      if (bucket.consume('k').allowed) allowed++;
    }
    expect(allowed).toBe(SMALL.capacity);
  });

  it('`remaining` is a non-negative integer at every step of a full drain and refill', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket({ capacity: 7, refillPerSecond: 3, maxKeys: 10 }, clock);
    const seen: RateDecision[] = [];

    for (let i = 0; i < 30; i++) {
      seen.push(bucket.consume('k'));
      clock.advance(120); // a fractional token per step — the case that produces .333
    }
    clock.advance(10_000);
    for (let i = 0; i < 20; i++) seen.push(bucket.consume('k'));

    for (const d of seen) {
      expect(Number.isInteger(d.remaining)).toBe(true);
      expect(d.remaining).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d.limit)).toBe(true);
      expect(Number.isInteger(d.resetAtSeconds)).toBe(true);
      if (!d.allowed) {
        expect(Number.isInteger(d.retryAfterSeconds)).toBe(true);
        expect(d.retryAfterSeconds!).toBeGreaterThanOrEqual(1);
      } else {
        expect(d.retryAfterSeconds).toBeNull();
      }
    }
  });

  it('`remaining` is strictly decreasing across successive requests with no refill', () => {
    // FakeClock does not move on its own, so this is the pure-drain case.
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    const remainings = Array.from({ length: SMALL.capacity }, () => bucket.consume('k').remaining);
    for (let i = 1; i < remainings.length; i++) {
      expect(remainings[i]).toBeLessThan(remainings[i - 1]!);
    }
  });

  it('keys are independent — draining one leaves another untouched', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    for (let i = 0; i < SMALL.capacity + 3; i++) bucket.consume('a');

    expect(bucket.consume('a').allowed).toBe(false);
    expect(bucket.consume('b').allowed).toBe(true);
  });
});

describe('PF-305 — `peek` reports without spending', () => {
  it('any number of peeks leave the token count unchanged', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);

    // `peek` answers "what would `consume` return", so on a full bucket it
    // reports `capacity - 1` — the headroom the caller would have AFTER being
    // served. What matters is that repeating it changes nothing.
    const before = bucket.peek('k');
    for (let i = 0; i < 100; i++) bucket.peek('k');
    const after = bucket.peek('k');

    expect(before.remaining).toBe(SMALL.capacity - 1);
    expect(after.remaining).toBe(before.remaining);
    // The first real spend still gets a full bucket — nothing above spent one.
    expect(bucket.consume('k').remaining).toBe(SMALL.capacity - 1);
    // …and only now has the count actually moved.
    expect(bucket.peek('k').remaining).toBe(SMALL.capacity - 2);
  });

  it('`peek` agrees with `consume` about whether a request would be allowed', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    for (let i = 0; i < SMALL.capacity; i++) {
      expect(bucket.peek('k').allowed).toBe(true);
      bucket.consume('k');
    }
    expect(bucket.peek('k').allowed).toBe(false);
    expect(bucket.consume('k').allowed).toBe(false);
  });
});

describe('PF-307 — `X-RateLimit-Reset` is a strictly-future epoch second', () => {
  it('an allowed response points at the moment the bucket is full again', () => {
    const clock = new FakeClock(1_700_000_000_000); // a real-looking epoch
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    const nowSeconds = Math.floor(clock.nowMs() / 1000);

    const first = bucket.consume('k');
    // One token spent at 1/s ⇒ full again in one second.
    expect(first.resetAtSeconds).toBe(nowSeconds + 1);
    expect(first.resetAtSeconds).toBeGreaterThan(nowSeconds);
  });

  it('Reset rises monotonically as the bucket drains', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    const resets = Array.from({ length: SMALL.capacity }, () => bucket.consume('k').resetAtSeconds);
    for (let i = 1; i < resets.length; i++) {
      expect(resets[i]).toBeGreaterThan(resets[i - 1]!);
    }
  });

  it('a denied response points at the next single token, and agrees with Retry-After', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const bucket = new InMemoryTokenBucket({ capacity: 1, refillPerSecond: 0.1, maxKeys: 10 }, clock);
    const nowSeconds = Math.floor(clock.nowMs() / 1000);

    bucket.consume('k');
    const denied = bucket.consume('k');

    expect(denied.allowed).toBe(false);
    // 0.1 tokens/s ⇒ ten seconds to the next token, not "the bucket is full".
    expect(denied.retryAfterSeconds).toBe(10);
    expect(denied.resetAtSeconds).toBe(nowSeconds + 10);
  });

  it('the sketch behaviour — Reset === now on an allowed response — is gone', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const bucket = new InMemoryTokenBucket(SMALL, clock);
    const nowSeconds = Math.ceil(clock.nowMs() / 1000);
    expect(bucket.consume('k').resetAtSeconds).not.toBe(nowSeconds);
  });
});

describe('PF-308 — the bucket map is bounded', () => {
  it('10 000 distinct keys consumed once, one sweep, and the map empties', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket({ ...SMALL, maxKeys: 1_000_000 }, clock);

    for (let i = 0; i < 10_000; i++) bucket.consume(`token:${i}`);
    expect(bucket.size).toBe(10_000);

    // Nothing is evicted before the buckets have provably refilled.
    expect(bucket.sweep()).toBe(0);
    expect(bucket.size).toBe(10_000);

    clock.advance((SMALL.capacity / SMALL.refillPerSecond) * 1000);
    expect(bucket.sweep()).toBe(10_000);
    expect(bucket.size).toBe(0);
  });

  it('limits still enforce correctly after a sweep', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket(SMALL, clock);

    for (let i = 0; i < SMALL.capacity; i++) bucket.consume('k');
    expect(bucket.consume('k').allowed).toBe(false);

    // A sweep now must NOT drop the drained bucket — dropping it would hand the
    // caller a fresh full bucket, i.e. silently remove the limit.
    bucket.sweep();
    expect(bucket.consume('k').allowed).toBe(false);
    expect(bucket.size).toBe(1);
  });

  it('`maxKeys` bounds the map without a caller ever invoking sweep', () => {
    const clock = new FakeClock(0);
    const bucket = new InMemoryTokenBucket({ ...SMALL, maxKeys: 50 }, clock);

    for (let i = 0; i < 500; i++) {
      // Each key is touched once and then never again; after one full refill
      // interval it is provably full and eligible for eviction.
      bucket.consume(`k${i}`);
      clock.advance(((SMALL.capacity / SMALL.refillPerSecond) * 1000) / 10);
    }

    expect(bucket.size).toBeLessThanOrEqual(50 + 1);
  });
});

describe('PF-306 — chooseBinding', () => {
  const allowed = (remaining: number): RateDecision => ({
    allowed: true,
    limit: 100,
    remaining,
    resetAtSeconds: 10,
    retryAfterSeconds: null,
  });
  const denied = (retryAfterSeconds: number): RateDecision => ({
    allowed: false,
    limit: 100,
    remaining: 0,
    resetAtSeconds: retryAfterSeconds,
    retryAfterSeconds,
  });

  it('picks the denying decision, never the allowed one — the sketch bug', () => {
    // App bucket needs 30 s; token bucket is wide open with lots of headroom.
    // The sketch compared `remaining` and would have selected the ALLOWED token
    // decision, whose retryAfterSeconds is null, then fallen back to `?? 1`.
    const binding = chooseBinding([denied(30), allowed(99)]);
    expect(binding.allowed).toBe(false);
    expect(binding.retryAfterSeconds).toBe(30);
  });

  it('takes the MAX Retry-After when both buckets denied', () => {
    expect(chooseBinding([denied(4), denied(31)]).retryAfterSeconds).toBe(31);
    expect(chooseBinding([denied(31), denied(4)]).retryAfterSeconds).toBe(31);
  });

  it('when everything is allowed, reports the bucket with the least headroom', () => {
    expect(chooseBinding([allowed(80), allowed(3)]).remaining).toBe(3);
    expect(chooseBinding([allowed(3), allowed(80)]).remaining).toBe(3);
  });
});

describe('PF-301 — IRateLimiter is the only contract, and substitutes cleanly', () => {
  it('every implementation satisfies the same interface', () => {
    const implementations: IRateLimiter[] = [
      new InMemoryTokenBucket(SMALL, new FakeClock(0)),
      new NullLimiter(),
      new AlwaysDenyLimiter(7),
    ];
    for (const limiter of implementations) {
      const peeked = limiter.peek('k');
      const consumed = limiter.consume('k');
      for (const d of [peeked, consumed]) {
        expect(typeof d.allowed).toBe('boolean');
        expect(typeof d.limit).toBe('number');
        expect(typeof d.remaining).toBe('number');
        expect(typeof d.resetAtSeconds).toBe('number');
      }
    }
  });

  it('NullLimiter never denies and AlwaysDenyLimiter never allows', () => {
    const nul = new NullLimiter();
    const deny = new AlwaysDenyLimiter(7);
    for (let i = 0; i < 50; i++) {
      expect(nul.consume('k').allowed).toBe(true);
      expect(deny.consume('k').allowed).toBe(false);
    }
    expect(deny.consume('k').retryAfterSeconds).toBe(7);
  });
});

describe('PF-303 — the spec file contains no wall-clock waiting', () => {
  it('no setTimeout, no setInterval, no real sleep', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const code = stripComments(source);
    expect(code).not.toMatch(/setTimeout\s*\(/);
    expect(code).not.toMatch(/setInterval\s*\(/);
    expect(code).not.toMatch(/\bawait\s+new\s+Promise/);
  });
});

/**
 * Strips comments so a grep assertion cannot be satisfied or defeated by prose.
 * Deliberately simple: these are our own files, not arbitrary input.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
