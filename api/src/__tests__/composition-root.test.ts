/**
 * PF-014 / PF-015 / PF-016 / PF-017 — the composition root and its two factories.
 *
 * What these assert, in order of how much they would cost to get wrong:
 *
 *   1. Injecting `testDeps()` does not change the assembled application. The
 *      whole safety argument for PF-014 is that the refactor is inert with
 *      respect to the internal `/api` surface; if the two wirings produced
 *      different stacks, every unit test that calls `createApp(testDeps(...))`
 *      would be testing a different app than production runs.
 *   2. Each factory picks the concretes it claims to. `productionDeps()` naming
 *      a `FakeClock` would be silent and catastrophic.
 *   3. `FakeClock` actually drives time. Retry ladders, rate-limit windows and
 *      token expiry all depend on it, and a `setTimeout` in any of those tests
 *      is a flake against a 0%-over-20-runs target (PRD p.9, p.11).
 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../app.js';
import { productionDeps, testDeps } from '../deps.js';
import {
  InProcessEventBus,
  InMemoryDeliverer,
  InMemoryTokenBucket,
  SystemClock,
  FakeClock,
} from '../platform/index.js';

interface RawLayer {
  name: string;
  regexp: RegExp;
  route?: { path: string };
}

function stackOf(app: ReturnType<typeof createApp>): string[] {
  const stack = (app as unknown as { _router: { stack: RawLayer[] } })._router.stack;
  return stack.map((l) => `${l.name} @ ${l.route?.path ?? String(l.regexp)}`);
}

describe('PF-014 · createApp(deps)', () => {
  it('assembles an identical application whether wired for production or for test', () => {
    // The point of the ticket: the seam is open, and opening it changed nothing.
    expect(stackOf(createApp(testDeps())), 'Injecting test concretes must not alter the internal stack').toEqual(
      stackOf(createApp(productionDeps())),
    );
  });

  it('still accepts zero arguments', () => {
    // ~40 existing call sites are `createApp()`. The default must remain a
    // complete, production-shaped bundle rather than a partial one.
    expect(() => createApp()).not.toThrow();
  });
});

describe('PF-015 / PF-016 · dependency factories', () => {
  it('productionDeps picks the production concretes', () => {
    const deps = productionDeps();
    expect(deps.clock).toBeInstanceOf(SystemClock);
    expect(deps.bus).toBeInstanceOf(InProcessEventBus);
    expect(deps.limiter).toBeInstanceOf(InMemoryTokenBucket);
    expect(deps.db).toBeDefined();
  });

  it('testDeps picks in-memory concretes and never the wall clock', () => {
    const deps = testDeps();
    expect(deps.clock, 'a test must never read the system clock').toBeInstanceOf(FakeClock);
    expect(deps.clock).not.toBeInstanceOf(SystemClock);
    expect(deps.deliverer, 'a test must never reach the network').toBeInstanceOf(InMemoryDeliverer);
    expect(deps.bus).toBeInstanceOf(InProcessEventBus);
    expect(deps.limiter).toBeInstanceOf(InMemoryTokenBucket);
  });

  it('overrides replace exactly one concrete and leave the rest alone', () => {
    const clock = new FakeClock(1_000);
    const deps = productionDeps({ clock, corsOrigin: 'https://example.test' });
    expect(deps.clock).toBe(clock);
    expect(deps.corsOrigin).toBe('https://example.test');
    expect(deps.bus).toBeInstanceOf(InProcessEventBus);
  });
});

describe('PF-017 · FakeClock', () => {
  it('does not run a timer before its time', () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => (fired = true), 1_000);

    clock.advance(999);
    expect(fired).toBe(false);
    clock.advance(1);
    expect(fired).toBe(true);
  });

  it('fires due timers in scheduled order, not registration order', () => {
    const clock = new FakeClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('16s'), 16_000);
    clock.setTimeout(() => order.push('1s'), 1_000);
    clock.setTimeout(() => order.push('4s'), 4_000);

    // The whole 1s/4s/16s ladder collapses into one call and zero real waiting.
    clock.advance(16_000);
    expect(order).toEqual(['1s', '4s', '16s']);
  });

  it('runs a timer scheduled from inside a callback in the same advance', () => {
    // This is exactly the retry scheduler's shape: attempt N's failure handler
    // schedules attempt N+1. If it needed a second advance(), the ladder tests
    // would be encoding the scheduler's internals instead of its behaviour.
    const clock = new FakeClock();
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(1);
      clock.setTimeout(() => fired.push(2), 0);
    }, 1_000);

    clock.advance(1_000);
    expect(fired).toEqual([1, 2]);
  });

  it('honours the cancel function', () => {
    const clock = new FakeClock();
    let fired = false;
    const cancel = clock.setTimeout(() => (fired = true), 100);
    cancel();

    clock.advance(1_000);
    expect(fired).toBe(false);
    expect(clock.pendingCount()).toBe(0);
  });

  it('advances nowMs so time-reading code sees the same timeline as timers', () => {
    const clock = new FakeClock(1_700_000_000_000);
    expect(clock.nowMs()).toBe(1_700_000_000_000);
    clock.advance(30 * 60 * 1_000);
    expect(clock.nowMs()).toBe(1_700_000_000_000 + 1_800_000);
  });
});
