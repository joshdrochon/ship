/**
 * PF-510 / PF-511 / PF-513 — the retry policy, as DATA.
 *
 * ── The mistake this file exists to name ────────────────────────────────────
 * PRD p.4 carries a 1s/4s/16s retry ladder. That ladder is the **server's
 * webhook delivery schedule**, not the client's. Copying it here would give the
 * SDK a 21-second worst case on a transient 503 and would couple two things that
 * have no reason to move together. The client's ladder is ours, and it is stated
 * here so it is arguable rather than accidental.
 *
 * ── What retries, and what does not ─────────────────────────────────────────
 * Retryable:  429 (with `Retry-After` honoured), 502, 503, 504, and transport
 *             failures (DNS, socket, TLS, connection reset).
 * Never:      every other 4xx — 400, 401, 403, 404, 409, 422 — and **a bare
 *             500**.
 *
 * The 500 call is the arguable one. The common industry choice is "all 5xx
 * retry". This SDK retries only the gateway statuses because a Ship 500 is a bug
 * in a handler: the same request will fail the same way, and four attempts turn
 * one alert into four while the user waits four times as long for the same
 * error. 502/503/504 are different — they are emitted by something in FRONT of
 * the handler and they genuinely do clear.
 *
 * ── No wall clock, anywhere (PF-513) ────────────────────────────────────────
 * Backoff waits through an injected `sleep`, defaulted to the real one. p.11 is
 * explicit that timing-based tests "are flaky tests", and `noSetTimeout.test.ts`
 * greps every `sdk/**\/*.test.ts` for `setTimeout` to keep it that way.
 */

/** Statuses that are worth trying again. Ordered as they appear in the comment above. */
export const RETRYABLE_STATUSES: readonly number[] = [429, 502, 503, 504];

/**
 * Statuses that are explicitly never retried, listed rather than left to the
 * default so the policy test can assert them by name. `500` is here on purpose
 * — see the header.
 */
export const NEVER_RETRY_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 422, 500];

/**
 * Total attempts, including the first. 3 = one try plus two retries.
 *
 * The PRD does not set this number; it is ours (the lane file records that).
 * Three because two retries covers the single-instance restart and the brief
 * limiter overshoot that are the realistic transient failures here, and a
 * fourth attempt mostly adds latency to a request that is going to fail.
 */
export const MAX_ATTEMPTS = 3;

/** First backoff step. Doubles per attempt: 250ms, 500ms, … */
export const BASE_RETRY_DELAY_MS = 250;

/**
 * The ceiling on any single wait, INCLUDING one the server asked for.
 *
 * PRD p.4 requires 429s to carry `Retry-After` and this SDK honours it, but a
 * hostile or mis-set header saying `Retry-After: 86400` must not park a CLI for
 * a day. Twenty seconds is long enough to outlast a limiter window and short
 * enough that a human does not assume the process hung.
 */
export const MAX_RETRY_DELAY_MS = 20_000;

/**
 * The whole policy as one exported object, so a consumer can read what the
 * client will do without reading the client, and a test can assert on it.
 */
export const RETRY_POLICY = {
  retryableStatuses: RETRYABLE_STATUSES,
  neverRetryStatuses: NEVER_RETRY_STATUSES,
  retryTransportErrors: true,
  maxAttempts: MAX_ATTEMPTS,
  baseDelayMs: BASE_RETRY_DELAY_MS,
  maxDelayMs: MAX_RETRY_DELAY_MS,
} as const;

/** Should a response with this status be tried again? */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.includes(status);
}

/**
 * The clock and timer the client uses. Both injectable; both default to the real
 * thing in `ShipClient`'s constructor and never inside a test.
 */
export interface SdkClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Jitter source, in [0, 1). Injected so a backoff test is deterministic. */
  random(): number;
}

export const realClock: SdkClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      // The ONE setTimeout in the package, in the one place that is allowed to
      // wait. `noSetTimeout.test.ts` asserts none appears in any test file.
      setTimeout(resolve, ms);
    }),
  random: () => Math.random(),
};

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * `retryAfterSeconds` — the server's own instruction — WINS over the computed
 * ladder when present, because the server knows when its window resets and the
 * client is guessing. Both are clamped to `MAX_RETRY_DELAY_MS`.
 *
 * Jitter is full-jitter (uniform over [0, ceiling]) on the computed path only.
 * A server-specified delay is not jittered downward: waiting less than the
 * server asked is the one thing a `Retry-After` exists to prevent.
 */
export function computeRetryDelayMs(args: {
  attempt: number;
  retryAfterSeconds: number | null;
  random: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}): number {
  const maxDelay = args.maxDelayMs ?? MAX_RETRY_DELAY_MS;

  if (args.retryAfterSeconds !== null && Number.isFinite(args.retryAfterSeconds)) {
    const asMs = Math.max(0, args.retryAfterSeconds) * 1000;
    return Math.min(asMs, maxDelay);
  }

  const base = args.baseDelayMs ?? BASE_RETRY_DELAY_MS;
  const exponential = base * 2 ** Math.max(0, args.attempt);
  const ceiling = Math.min(exponential, maxDelay);
  return Math.round(ceiling * args.random);
}
