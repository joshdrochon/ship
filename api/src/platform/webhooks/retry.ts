/**
 * Retry policy + injectable clock.
 *
 * Schedule: 1s, 4s, 16s, 1m, 5m, 30m (+ jitter). 5xx/timeout = transient →
 * retry; 4xx = permanent → dead-letter immediately. After the 6th failed
 * attempt → DLQ, replayable from the portal with the ORIGINAL Idempotency-Key.
 *
 * The clock is injected so retry tests advance a FakeClock — never setTimeout.
 * Timing-based webhook tests are flaky tests (standing order, Annex 12). The
 * Clock itself lives in platform/clock.ts; it is re-exported below.
 */

export const RETRY_SCHEDULE_SECONDS = [1, 4, 16, 60, 300, 1800] as const;
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length; // then DLQ

// Clock moved to platform/clock.ts (PF-017): the token bucket reads it too, and
// `ratelimit/` importing it from `webhooks/` made the rate limiter depend on the
// webhook pipeline for nothing. Re-exported here so `retry.ts` stays the place
// you look when you want the schedule and the clock that drives it.
export type { Clock } from '../clock.js';
export { SystemClock, FakeClock } from '../clock.js';

/** Delay before attempt N (1-indexed), with ±10% jitter. Null = dead-letter. */
export function delayBeforeAttemptMs(attemptNumber: number, jitter: () => number = Math.random): number | null {
  const base = RETRY_SCHEDULE_SECONDS[attemptNumber - 1];
  if (base === undefined) return null;
  const jitterFactor = 0.9 + jitter() * 0.2;
  return Math.round(base * 1000 * jitterFactor);
}

// TODO(josh): RetryScheduler — consumes delayBeforeAttemptMs + Clock, drives
// IWebhookDeliverer attempts, writes the delivery log row per attempt (E4 slice 6).
