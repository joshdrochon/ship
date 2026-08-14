/**
 * PF-512 — the rate-limit triple, parsed ONCE and surfaced on both paths.
 *
 * PRD p.4 names the three headers. They arrive on successful responses too, not
 * only on a 429, and that is the point: a consumer that can see `remaining`
 * falling can back off BEFORE being told to, which is the difference between a
 * client that cooperates with a rate limit and one that discovers it.
 *
 * The one rule that matters here: a header that is ABSENT or unparseable yields
 * `null`, never `0` and never `NaN`. A `remaining: 0` that actually means
 * "unknown" is worse than no value at all — it is a value a consumer will act
 * on, by sleeping.
 */

export interface RateLimitStatus {
  /** Requests permitted in the current window, or `null` when not reported. */
  limit: number | null;
  /** Requests left in the current window, or `null` when not reported. */
  remaining: number | null;
  /** Unix seconds at which the window resets, or `null` when not reported. */
  resetAtSeconds: number | null;
}

/** Header names, lowercase. `Headers.get` is case-insensitive; a plain object is not. */
export const RATE_LIMIT_HEADERS = {
  limit: 'x-ratelimit-limit',
  remaining: 'x-ratelimit-remaining',
  reset: 'x-ratelimit-reset',
} as const;

interface HeaderReader {
  get(name: string): string | null;
}

/**
 * A non-negative integer, or `null`.
 *
 * Deliberately strict: `Number('')` is 0 and `Number('abc')` is NaN, and both
 * would otherwise become a number a consumer trusts.
 */
function parseCount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads the triple off a response.
 *
 * Returns `null` — not a status with three nulls — when NONE of the three
 * headers is present, so a consumer can distinguish "this deployment does not
 * report rate limits" from "this response reported some of them".
 */
export function parseRateLimit(headers: HeaderReader | null | undefined): RateLimitStatus | null {
  if (!headers) return null;

  const limit = parseCount(headers.get(RATE_LIMIT_HEADERS.limit));
  const remaining = parseCount(headers.get(RATE_LIMIT_HEADERS.remaining));
  const resetAtSeconds = parseCount(headers.get(RATE_LIMIT_HEADERS.reset));

  if (limit === null && remaining === null && resetAtSeconds === null) return null;
  return { limit, remaining, resetAtSeconds };
}
