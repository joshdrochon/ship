/**
 * PF-132 — throttling the `user_code` guess space.
 * Lane L05, slice S2.
 *
 * ---------------------------------------------------------------------------
 * ⚑ THIS TICKET SHRANK, AND ITS OWN ESCAPE HATCH IS WHY.
 * ---------------------------------------------------------------------------
 * PF-132 was written when `/oauth/*` had no rate limit at all, and it said so:
 * *"L11's limiter is scoped to `/api/v1` and the internal `apiLimiter` does not
 * reach `/oauth/*` (L04's PF-107), so **this throttle is this lane's and nothing
 * else provides it**."* It also wrote down what to do if that changed —
 * *"If the audit finds L11 extending to `/oauth`, PF-132 should become a
 * configuration of that limiter rather than a second mechanism, and the ticket
 * should shrink rather than be deleted."*
 *
 * That is exactly what happened. L11 adopted finding **F29** and now mounts
 * `oauthRateLimitMiddleware` over the whole `/oauth` prefix, keyed by client IP,
 * ABOVE the router and above body parsing (`api/src/app.ts`). So the premise
 * PF-132 rested on is no longer true, and building a second general-purpose
 * request counter here would be a duplicate mechanism competing with the one
 * that already runs first.
 *
 * ---------------------------------------------------------------------------
 * THE ARITHMETIC, BECAUSE RFC 8628 §5.1 IS A CLAIM ABOUT A PRODUCT.
 * ---------------------------------------------------------------------------
 * §5.1 does not set a bit target. It requires that entropy × throttling make
 * brute force impractical, so neither number means anything alone:
 *
 *   code space     28^8            = 3.78 x 10^11   (PF-123)
 *   live codes     ~10 in a demo, bounded by logins-per-10-minutes (PF-144)
 *   attempts       30/min per IP   = 300 over one code's 600 s life (L11, F29)
 *
 *   P(hit) over a code's whole life  ~  300 x 10 / 3.78e11  ~  8 x 10^-9
 *   P(hit) over a sustained day      ~  43 200 x 10 / 3.78e11  ~  1 x 10^-6
 *
 * `deviceThrottle.test.ts` pins that product against the SHIPPED constants
 * rather than against numbers copied into this comment, so lowering the entropy
 * or raising the rate limit fails a test instead of quietly invalidating the
 * paragraph.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LEFT, AND WHY IT IS NOT REDUNDANT.
 * ---------------------------------------------------------------------------
 * Two things L11's limiter structurally cannot do, both cheap:
 *
 *   1. A FAILED-ATTEMPT counter, not a request counter. L11 counts every
 *      `/oauth` request identically — a legitimate poll and a wrong `user_code`
 *      cost the same. This counts only lookups that found nothing, so the
 *      threshold can be far tighter (5, not 30) without touching the polling
 *      loop that has to run every few seconds on the same connection.
 *
 *   2. Keyed by SESSION as well as IP. The verification screen is
 *      session-authenticated, so a signed-in user grinding codes from one
 *      browser is a case the IP limiter treats as ordinary traffic — and behind
 *      a corporate NAT or a shared egress, IP is close to meaningless as an
 *      identity. PF-132 named both keys for this reason.
 *
 * And the consequence PF-132 asked for: a code that IS found while the origin is
 * over the threshold gets INVALIDATED rather than approved. After five wrong
 * guesses the only way to produce a right one is search, so the sixth being
 * correct is evidence about the guesser, not about the user. The legitimate
 * user re-runs `ship login`, which costs them one command.
 *
 * ---------------------------------------------------------------------------
 * ⚑ STATED LIMITATION: THIS COUNTER IS PER PROCESS.
 * ---------------------------------------------------------------------------
 * The map is module-local, so N app processes give an attacker N x threshold
 * attempts. That is a real weakening and it is written down rather than left to
 * be discovered. It is acceptable here for a reason that is measured rather than
 * assumed: the DURABLE bound is L11's limiter plus the entropy arithmetic above,
 * and this counter is a tightening on top of it, not the thing standing between
 * the code space and an attacker. If Ship ever runs more than one process, the
 * fix is to move this to the `oauth_device_codes` table's own row — which is
 * where PF-137 already puts the polling state, and for exactly this reason.
 */
import type { Clock } from '../clock.js';

/**
 * Failed `user_code` submissions tolerated before an origin is cut off.
 *
 * Five. A human mistypes a code they are reading off a screen once or twice —
 * `normalizeUserCode` (PF-131) already absorbs the case, hyphen and whitespace
 * mistakes, so a residual failure means the wrong characters, not the wrong
 * format. Five leaves room for genuine fumbling and is two orders of magnitude
 * below what the code space would tolerate.
 */
export const USER_CODE_MAX_FAILURES = 5;

/**
 * Failures after which a SUCCESSFUL lookup is treated as a guess rather than as
 * a user finally typing their own code correctly (PF-132's invalidation half).
 *
 * ⚑ THIS IS A SEPARATE, LOWER NUMBER THAN `USER_CODE_MAX_FAILURES`, AND IT HAS
 * TO BE. With a single threshold the invalidation clause is UNREACHABLE: the
 * attempt that crosses it also triggers the cooldown, so every later attempt is
 * refused before any lookup happens and a found code is never observed. The
 * clause would read as a control and be dead code — which is worse than not
 * having it, because it invites the reader to count it as protection.
 *
 * Three. A human is reading ONE code off their own terminal, and PF-131 already
 * absorbs the case, hyphen and whitespace mistakes — so a residual failure is
 * genuinely wrong CHARACTERS, and three DISTINCT wrong codes followed by a
 * correct one is not what fumbling looks like. The false-positive cost is
 * bounded and small: the user runs `ship login` again, one command.
 */
export const USER_CODE_SUSPICION_FAILURES = 3;

/**
 * How long an origin stays cut off after crossing the threshold.
 *
 * 15 minutes. Longer than the 600-second code TTL on purpose: a cooldown
 * shorter than the lifetime of the thing being guessed at lets an attacker
 * resume against the same live code, which makes the cooldown a speed bump
 * rather than a stop.
 */
export const USER_CODE_FAILURE_COOLDOWN_SECONDS = 15 * 60;

/**
 * The sliding window failures are counted over.
 *
 * Equal to the cooldown, so a slow grinder cannot stay permanently just under
 * the threshold by pacing themselves against a shorter window.
 */
export const USER_CODE_FAILURE_WINDOW_SECONDS = 15 * 60;

/**
 * Bound on tracked keys, so an attacker rotating source addresses cannot grow
 * this map without limit — the counter would otherwise be its own denial of
 * service. Oldest entry is evicted first.
 */
const MAX_TRACKED_KEYS = 10_000;

interface Entry {
  failures: number[];
  blockedUntilMs: number | null;
}

export interface ThrottleDecision {
  /** False means refuse the attempt outright, without a lookup. */
  allowed: boolean;
  /** Seconds until the caller may try again. Only set when blocked. */
  retryAfterSeconds?: number;
}

/**
 * A failed-attempt counter over an injected clock.
 *
 * Every temporal decision reads `clock.nowMs()`; there is no `setTimeout` and no
 * `Date.now()`, so the table test advances a `FakeClock` instead of sleeping
 * (PRD p.11).
 */
export class UserCodeAttemptThrottle {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly maxFailures: number = USER_CODE_MAX_FAILURES,
    private readonly cooldownSeconds: number = USER_CODE_FAILURE_COOLDOWN_SECONDS,
    private readonly windowSeconds: number = USER_CODE_FAILURE_WINDOW_SECONDS,
    private readonly suspicionFailures: number = USER_CODE_SUSPICION_FAILURES,
  ) {}

  /** May this key attempt a `user_code` right now? */
  check(key: string): ThrottleDecision {
    const now = this.clock.nowMs();
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };

    if (entry.blockedUntilMs !== null) {
      if (now < entry.blockedUntilMs) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((entry.blockedUntilMs - now) / 1000),
        };
      }
      // Cooldown served. Start clean rather than leaving the old failures to
      // re-trip the threshold on the next mistake.
      entry.blockedUntilMs = null;
      entry.failures = [];
    }

    return { allowed: true };
  }

  /**
   * Record a failed lookup. Returns the decision that now applies, so the caller
   * can tell the user they have been cut off on the attempt that cut them off
   * rather than on the next one.
   */
  recordFailure(key: string): ThrottleDecision {
    const now = this.clock.nowMs();
    const entry = this.entries.get(key) ?? { failures: [], blockedUntilMs: null };

    // Drop failures that have aged out of the window before counting.
    const cutoff = now - this.windowSeconds * 1000;
    entry.failures = entry.failures.filter((t) => t > cutoff);
    entry.failures.push(now);

    if (entry.failures.length >= this.maxFailures) {
      entry.blockedUntilMs = now + this.cooldownSeconds * 1000;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictIfNeeded();

    return entry.blockedUntilMs !== null
      ? { allowed: false, retryAfterSeconds: this.cooldownSeconds }
      : { allowed: true };
  }

  /** A successful, legitimate entry clears the record for that key. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Has this key failed enough that a SUCCESSFUL lookup should be treated as a
   * guess rather than as a user finally typing their own code correctly?
   *
   * Uses `suspicionFailures` (3), NOT `maxFailures` (5). See that constant: with
   * one threshold this predicate could never be true at a moment when a lookup
   * actually happens, because crossing it also starts the cooldown.
   */
  isSuspect(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    const cutoff = this.clock.nowMs() - this.windowSeconds * 1000;
    return entry.failures.filter((t) => t > cutoff).length >= this.suspicionFailures;
  }

  /** Test-only: number of tracked keys, for the eviction assertion. */
  size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > MAX_TRACKED_KEYS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The throttle key: session first, then IP.
 *
 * Both, because neither alone is right. A session id is the precise identity but
 * an anonymous or freshly-cleared browser has none; an IP is always present but
 * is shared by everyone behind one NAT. Combining them means a signed-in
 * attacker cannot escape by clearing cookies (the IP half still counts) and a
 * user behind a corporate gateway is not cut off by a stranger's mistakes (the
 * session half distinguishes them).
 */
export function throttleKeysFor(sessionId: string | undefined, ip: string | undefined): string[] {
  const keys: string[] = [];
  if (sessionId) keys.push(`session:${sessionId}`);
  keys.push(`ip:${ip ?? 'unknown'}`);
  return keys;
}
