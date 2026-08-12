/**
 * Retry policy + injectable clock.
 *
 * Schedule: 1s, 4s, 16s, 1m, 5m, 30m (+ jitter). 5xx/timeout = transient →
 * retry; 4xx = permanent → dead-letter immediately. After the 6th failed
 * attempt → DLQ, replayable from the portal with the ORIGINAL Idempotency-Key.
 *
 * The clock is injected so retry tests advance a FakeClock — never setTimeout.
 * Timing-based webhook tests are flaky tests (standing order, Annex 12).
 */

export const RETRY_SCHEDULE_SECONDS = [1, 4, 16, 60, 300, 1800] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length; // then DLQ

export interface Clock {
  nowMs(): number;
  /** Schedule a callback; returns a cancel function. */
  setTimeout(fn: () => void, delayMs: number): () => void;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, delayMs: number): () => void {
    const handle = setTimeout(fn, delayMs);
    return () => clearTimeout(handle);
  }
}

/** Deterministic clock for tests: advance() fires due timers synchronously. */
export class FakeClock implements Clock {
  private now = 0;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  nowMs(): number {
    return this.now;
  }

  setTimeout(fn: () => void, delayMs: number): () => void {
    const timer = { at: this.now + delayMs, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  advance(ms: number): void {
    this.now += ms;
    const due = this.timers
      .filter((t) => !t.cancelled && t.at <= this.now)
      .sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((t) => !due.includes(t));
    for (const t of due) t.fn();
  }
}

/** Delay before attempt N (1-indexed), with ±10% jitter. Null = dead-letter. */
export function delayBeforeAttemptMs(attemptNumber: number, jitter: () => number = Math.random): number | null {
  const base = RETRY_SCHEDULE_SECONDS[attemptNumber - 1];
  if (base === undefined) return null;
  const jitterFactor = 0.9 + jitter() * 0.2;
  return Math.round(base * 1000 * jitterFactor);
}

// TODO(josh): RetryScheduler — consumes delayBeforeAttemptMs + Clock, drives
// IWebhookDeliverer attempts, writes the delivery log row per attempt (E4 slice 6).
