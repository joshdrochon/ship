/**
 * PF-017 — the platform's clock.
 *
 * Dependency Inversion applied to time. Three things under `platform/` read the
 * clock: the retry scheduler (`webhooks/retry.ts`), the token bucket
 * (`ratelimit/limiter.ts`) and OAuth expiry checks. All three take a `Clock`
 * rather than calling `Date.now()` and `setTimeout` directly, which is what
 * makes their tests deterministic instead of timing-dependent.
 *
 * The standing rule this exists to satisfy (PRD p.11): a retry test must never
 * wait. `FakeClock.advance(16_000)` fires the 16-second attempt immediately and
 * in order, so a six-attempt ladder with a 30-minute tail is asserted in
 * microseconds. A test that sleeps for real is a flaky test with a longer
 * feedback loop, and a suite of them cannot hold a 0% flake target over 20 runs
 * (p.9).
 *
 * It lives beside the eight modules rather than inside one because it belongs to
 * none of them — `ratelimit/` previously imported it from `webhooks/retry.ts`,
 * which made the rate limiter depend on the webhook pipeline for no reason. The
 * layout fitness test (PF-022) treats it as a file, not a module.
 */

export interface Clock {
  /** Milliseconds since the epoch. The only source of "now" under platform/. */
  nowMs(): number;
  /** Schedule a callback; returns a cancel function. */
  setTimeout(fn: () => void, delayMs: number): () => void;
}

/** Production: the real clock. Chosen in `productionDeps()` and nowhere else. */
export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, delayMs: number): () => void {
    const handle = setTimeout(fn, delayMs);
    return () => clearTimeout(handle);
  }
}

/**
 * Deterministic clock for tests: `advance()` fires due timers synchronously and
 * in scheduled order.
 *
 * Timers scheduled *by* a callback during an `advance()` are collected and fired
 * within the same call if they are already due — a retry that schedules the next
 * retry at +0ms must not need a second `advance()`, or the ladder tests would
 * encode the scheduler's internals rather than its behaviour.
 */
export class FakeClock implements Clock {
  private now: number;
  private timers: { at: number; seq: number; fn: () => void; cancelled: boolean }[] = [];
  private seq = 0;

  constructor(startMs = 0) {
    this.now = startMs;
  }

  nowMs(): number {
    return this.now;
  }

  setTimeout(fn: () => void, delayMs: number): () => void {
    const timer = { at: this.now + delayMs, seq: this.seq++, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  advance(ms: number): void {
    this.now += ms;
    // Loop rather than a single pass: a callback may schedule another timer that
    // is already due at the new `now`.
    for (;;) {
      const due = this.timers
        .filter((t) => !t.cancelled && t.at <= this.now)
        .sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (due.length === 0) return;
      this.timers = this.timers.filter((t) => !due.includes(t));
      for (const t of due) {
        if (!t.cancelled) t.fn();
      }
    }
  }

  /** Number of timers still outstanding — lets a test assert nothing leaked. */
  pendingCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }
}
