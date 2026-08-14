/**
 * Token-bucket rate limiting for the public API — per-app AND per-token.
 *
 * Tickets: PF-301 (`IRateLimiter`), PF-302 (injected clock), PF-303 (arithmetic
 * over `FakeClock`), PF-305 (peek-then-commit), PF-306 (`Retry-After` from the
 * denying bucket), PF-307 (`Reset` semantics), PF-308 (bounded map),
 * PF-309 (limits are configuration), PF-310/PF-312 (headers), PF-311 (envelope).
 *
 * Buckets allow the bursts real integrations produce while enforcing a mean
 * rate; two keys stop one noisy install from starving an app's other users.
 * In-memory is correct for the single-instance Render topology — behind the
 * interface, a Redis or `@upstash/ratelimit` bucket is a composition-root swap
 * (PRD p.10). See the single-process note in `platform/README.md` (PF-315) for
 * what "in-memory" costs on a multi-replica deployment.
 *
 * Contract (PRD p.6, a Performance Target): 100% of public responses carry
 * `X-RateLimit-Limit` / `-Remaining` / `-Reset`; a 429 adds `Retry-After`.
 *
 * ── THERE ARE NO NUMBERS IN THIS FILE, AND THAT IS PF-309 ────────────────────
 * `capacity`, `refillPerSecond` and `maxKeys` are all REQUIRED options with no
 * defaults. A default here is a limit nobody chose, living in the module that
 * enforces it rather than in the composition root that is supposed to own it.
 * `api/src/deps.ts` reads them from the environment and documents the fallbacks.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../api/v1/errors.js';
import type { PlatformAuthContext } from '../scopes/auth-context.js';
import type { Clock } from '../clock.js';

/** Milliseconds in a second. Not a limit — a unit conversion. */
const MS_PER_SECOND = 1000;

/**
 * Ceiling for `Retry-After` and `X-RateLimit-Reset`, in seconds. One day.
 *
 * Not a rate limit either — a header sanity bound. `Retry-After` is defined as a
 * decimal integer (RFC 9110 §10.2.3), and a very slow bucket can compute a delta
 * of `1e9` seconds or, on a degenerate configuration, a non-finite one; both
 * serialise to something a client either cannot parse or should never obey. A
 * caller told to come back in a day will come back sooner and get a fresh, real
 * answer, which is the correct failure direction.
 */
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** Clamps a computed second-delta into something a header may legally carry. */
function boundedSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return MAX_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, seconds));
}

/**
 * The answer a limiter gives about one key.
 *
 * `resetAtSeconds` means two different things depending on `allowed`, and that
 * is PF-307's recorded decision rather than an inconsistency — see
 * `InMemoryTokenBucket.decide` and the rejected options in `platform/README.md`.
 */
export interface RateDecision {
  allowed: boolean;
  /** Bucket capacity — the `X-RateLimit-Limit` value. */
  limit: number;
  /** Whole tokens left after this call. Never negative. */
  remaining: number;
  /**
   * Unix seconds. When `allowed`, the moment the bucket is FULL again (option b);
   * when denied, the moment ONE token is available (option a). PF-307.
   */
  resetAtSeconds: number;
  /** Whole seconds, `>= 1`, only on a denial. `null` when allowed. */
  retryAfterSeconds: number | null;
}

/**
 * The only contract the public router knows about throttling (PF-301).
 *
 * ── DEVIATION FROM PF-301 AS WRITTEN: `peek` ─────────────────────────────────
 * The ticket's literal signature is `{ consume(key): RateDecision }`. This
 * interface adds `peek`, and PF-305 is the reason it has to.
 *
 * A request is checked against TWO buckets. With `consume` alone the middleware
 * must spend a token in one bucket before it can know whether the other will
 * reject the request — which is the sketch's bug: a request the *app* bucket
 * denies still burns one of the caller's own per-token tokens, so an app-limited
 * client silently loses quota it never got to use. Peek-then-commit is the fix
 * the ticket names, and peek-then-commit needs a peek.
 *
 * It does not cost the Liskov property PF-301 exists to protect. `peek` is a
 * pure read of state every candidate backend already exposes: an in-memory map,
 * a Redis `GET`+TTL, `@upstash/ratelimit`'s `getRemaining`, and a Cloudflare
 * rule's own counter. Nothing here is implementable only in-process.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export interface IRateLimiter {
  /**
   * What `consume` WOULD return, without spending anything.
   *
   * Pure with respect to the token count. Implementations may lazily refill —
   * that is bookkeeping, not spending — but two `peek`s with no intervening
   * `consume` and no clock movement must agree.
   */
  peek(key: string): RateDecision;
  /** Spend one token if there is one. Returns the decision either way. */
  consume(key: string): RateDecision;
}

/**
 * All three REQUIRED — see the PF-309 note in the module docstring.
 */
export interface TokenBucketOptions {
  /** Burst size, in tokens. Also the `X-RateLimit-Limit` value. */
  capacity: number;
  /** Sustained rate. `capacity / refillPerSecond` is the time to refill fully. */
  refillPerSecond: number;
  /**
   * PF-308 — the ceiling above which `consume` sweeps before inserting.
   *
   * Not a rate limit; a memory bound. The map is keyed by token id and token ids
   * ROTATE (L06 refresh rotation), so without this the map grows for the life of
   * the process and every rotated token leaves a bucket behind forever.
   */
  maxKeys: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class InMemoryTokenBucket implements IRateLimiter {
  private readonly buckets = new Map<string, BucketState>();

  /**
   * `clock` is REQUIRED — PF-302.
   *
   * The sketch defaulted it to `new SystemClock()`. A default there means a test
   * that forgets to inject silently reads wall time and becomes timing-dependent,
   * which is a flake with a long feedback loop and is exactly what PRD p.11's
   * "a retry test must never wait" rule exists to prevent. Making it required
   * turns that mistake into a `pnpm type-check` failure. The production clock is
   * chosen in `api/src/deps.ts` and nowhere else.
   */
  constructor(
    private readonly options: TokenBucketOptions,
    private readonly clock: Clock,
  ) {}

  /** Live key count. Exposed so PF-308's test can assert the map is bounded. */
  get size(): number {
    return this.buckets.size;
  }

  /**
   * Seconds a fully-drained bucket needs to reach capacity. The eviction horizon.
   */
  private get fullRefillSeconds(): number {
    return this.options.capacity / this.options.refillPerSecond;
  }

  /**
   * PF-308 — drop every bucket that is certainly full.
   *
   * The test is `now - lastRefillMs >= fullRefillSeconds`, and it is safe
   * regardless of the stored token count: a bucket drained to zero refills
   * completely in exactly that long, so any bucket untouched for that interval is
   * at capacity. A bucket at capacity carries no state worth keeping — deleting
   * it and recreating it on the next request produces the identical decision,
   * which is why this can never loosen a limit.
   *
   * Returns the number evicted, so a caller (and PF-308's test) can see it work.
   */
  sweep(): number {
    const now = this.clock.nowMs();
    const horizonMs = this.fullRefillSeconds * MS_PER_SECOND;
    let evicted = 0;
    for (const [key, state] of this.buckets) {
      if (now - state.lastRefillMs >= horizonMs) {
        this.buckets.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  peek(key: string): RateDecision {
    const state = this.refilled(key);
    return this.decide(state, state.tokens >= 1, false);
  }

  consume(key: string): RateDecision {
    // Sweep BEFORE inserting, not after, so the map never exceeds `maxKeys` by
    // more than the one key this call is about to add. Sweeping only evicts
    // provably-full buckets (see `sweep`), so this cannot change any decision.
    if (this.buckets.size >= this.options.maxKeys && !this.buckets.has(key)) {
      this.sweep();
    }

    const state = this.refilled(key);
    const allowed = state.tokens >= 1;
    if (allowed) state.tokens -= 1;
    this.buckets.set(key, state);
    return this.decide(state, allowed, true);
  }

  /** Current state for `key`, refilled to now. Not stored — callers decide that. */
  private refilled(key: string): BucketState {
    const now = this.clock.nowMs();
    const existing = this.buckets.get(key);
    if (!existing) return { tokens: this.options.capacity, lastRefillMs: now };

    const elapsedSeconds = (now - existing.lastRefillMs) / MS_PER_SECOND;
    return {
      tokens: Math.min(
        this.options.capacity,
        existing.tokens + elapsedSeconds * this.options.refillPerSecond,
      ),
      lastRefillMs: now,
    };
  }

  /**
   * PF-307 — what `X-RateLimit-Reset` means for a bucket that has no window.
   *
   * A token bucket has no window boundary, so "reset" has to be defined rather
   * than read off the algorithm. The sketch returned `ceil(now/1000)` on every
   * allowed request — i.e. *now* — which tells a client nothing it did not
   * already know and is never in the future.
   *
   *   allowed → the moment the bucket is FULL again (option b). A client reading
   *             Reset while it is being served wants to know when it can resume
   *             its normal rate, not when its next single token lands.
   *   denied  → the moment ONE token is available (option a), which is the
   *             earliest useful retry and agrees with `Retry-After`.
   *
   * Rejected: seconds-remaining rather than an epoch (option c) — every other
   * `X-RateLimit-Reset` in the wild is an epoch, and `Retry-After` already
   * carries the relative form on the one response that needs it. Recorded with
   * the rejected options in `platform/README.md`.
   *
   * Both branches are `floor(now) + ceil(delta)` with `delta > 0`, so the value
   * is STRICTLY in the future and rises monotonically as the bucket drains.
   */
  private decide(state: BucketState, allowed: boolean, spent: boolean): RateDecision {
    const nowSeconds = Math.floor(state.lastRefillMs / MS_PER_SECOND);
    const tokensAfter = allowed && spent ? state.tokens : state.tokens - (allowed ? 1 : 0);

    if (allowed) {
      const secondsToFull = boundedSeconds(
        (this.options.capacity - tokensAfter) / this.options.refillPerSecond,
      );
      return {
        allowed: true,
        limit: this.options.capacity,
        remaining: Math.max(0, Math.floor(tokensAfter)),
        resetAtSeconds: nowSeconds + Math.ceil(secondsToFull),
        retryAfterSeconds: null,
      };
    }

    const secondsToNextToken = boundedSeconds(
      (1 - state.tokens) / this.options.refillPerSecond,
    );
    return {
      allowed: false,
      limit: this.options.capacity,
      remaining: 0,
      resetAtSeconds: nowSeconds + Math.ceil(secondsToNextToken),
      // `Retry-After` is an integer number of seconds (RFC 9110 §10.2.3) and a
      // `Retry-After: 0` invites an immediate retry that is guaranteed to fail.
      retryAfterSeconds: Math.max(1, Math.ceil(secondsToNextToken)),
    };
  }
}

/**
 * A limiter that allows everything, for wirings that must not throttle.
 *
 * Exists for PF-301's Liskov proof, and it is not only a test fixture: it is the
 * shape a "rate limiting disabled" deployment takes without the router growing a
 * conditional.
 */
export class NullLimiter implements IRateLimiter {
  private static readonly ALWAYS: RateDecision = {
    allowed: true,
    limit: Number.MAX_SAFE_INTEGER,
    remaining: Number.MAX_SAFE_INTEGER,
    resetAtSeconds: 0,
    retryAfterSeconds: null,
  };
  peek(_key: string): RateDecision {
    return NullLimiter.ALWAYS;
  }
  consume(_key: string): RateDecision {
    return NullLimiter.ALWAYS;
  }
}

/** A limiter that denies everything. PF-301's other substitution. */
export class AlwaysDenyLimiter implements IRateLimiter {
  constructor(private readonly retryAfterSeconds: number) {}
  private deny(): RateDecision {
    return {
      allowed: false,
      limit: 0,
      remaining: 0,
      resetAtSeconds: this.retryAfterSeconds,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
  peek(_key: string): RateDecision {
    return this.deny();
  }
  consume(_key: string): RateDecision {
    return this.deny();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Header emission and binding selection
// ─────────────────────────────────────────────────────────────────────────────

/** The three headers PRD p.4 names, spelled exactly as it spells them. */
export const RATE_LIMIT_HEADERS = {
  limit: 'X-RateLimit-Limit',
  remaining: 'X-RateLimit-Remaining',
  reset: 'X-RateLimit-Reset',
} as const;

/** RFC 9110 §10.2.3. Only on a 429. */
export const RETRY_AFTER_HEADER = 'Retry-After';

/**
 * PF-306 — which decision the headers describe when two buckets were consulted.
 *
 * The sketch picked `remaining <= remaining`, which is right for the allowed
 * case and WRONG for the denied one: with the app bucket empty (30 s to refill)
 * and the token bucket full, the token decision has more remaining, so the app
 * decision wins on that comparison only by accident — reverse the numbers and
 * the ALLOWED decision is selected, its `retryAfterSeconds` is `null`, and the
 * `?? 1` fallback tells a client to retry in one second against a bucket that
 * needs thirty. A client that believes it retries 30 times and gets 30 more 429s.
 *
 * So the rule is split by outcome, because the two cases are asking different
 * questions:
 *
 *   any denied → among the DENIED decisions only, the one that makes the caller
 *                wait longest. Retrying before the slowest bucket is ready is a
 *                guaranteed second 429.
 *   all allowed → the one with the least headroom. That is the constraint the
 *                caller is actually about to hit.
 */
export function chooseBinding(decisions: readonly RateDecision[]): RateDecision {
  if (decisions.length === 0) {
    throw new Error('chooseBinding requires at least one decision');
  }
  const denied = decisions.filter((d) => !d.allowed);
  if (denied.length > 0) {
    return denied.reduce((worst, d) =>
      (d.retryAfterSeconds ?? 0) > (worst.retryAfterSeconds ?? 0) ? d : worst,
    );
  }
  return decisions.reduce((tightest, d) => (d.remaining < tightest.remaining ? d : tightest));
}

/**
 * PF-310 / PF-312 — write the headers.
 *
 * `res.setHeader` rather than `res.writeHead`, and always BEFORE `next(err)`.
 * Express's terminal handler calls `res.status().json()`, which merges into the
 * header map rather than replacing it, so headers written here survive the error
 * path and appear on the 429 itself. `writeHead` would replace the map and drop
 * `X-Request-Id` along with these — that is the regression PF-312 guards.
 */
export function applyRateLimitHeaders(res: Response, decision: RateDecision): void {
  res.setHeader(RATE_LIMIT_HEADERS.limit, String(decision.limit));
  res.setHeader(RATE_LIMIT_HEADERS.remaining, String(Math.max(0, decision.remaining)));
  res.setHeader(RATE_LIMIT_HEADERS.reset, String(decision.resetAtSeconds));
}

/** The 429's `Retry-After`. Separate because it must appear on nothing else. */
export function applyRetryAfterHeader(res: Response, decision: RateDecision): void {
  res.setHeader(RETRY_AFTER_HEADER, String(Math.max(1, decision.retryAfterSeconds ?? 1)));
}

/**
 * The `ApiError` a denial becomes (PF-311).
 *
 * The limiter NEVER writes a response. It raises, and L07's terminal handler
 * turns the raise into the envelope — which is the only way a 429 gets the same
 * `{code, message, details?, request_id}` shape as every other public failure.
 * PF-198 permits `details.retry_after_seconds`; it is set here so the value a
 * JSON-only client reads is the same integer as the header.
 */
export function rateLimitedError(decision: RateDecision): ApiError {
  const retryAfter = Math.max(1, decision.retryAfterSeconds ?? 1);
  return new ApiError(
    'rate_limited',
    'Rate limit exceeded. Slow down and retry after the interval in `Retry-After`.',
    { details: { retry_after_seconds: retryAfter } },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The middlewares
// ─────────────────────────────────────────────────────────────────────────────

/** Key namespaces. Disjoint by construction — PF-304. */
export const RATE_KEY_PREFIX = {
  app: 'app:',
  token: 'token:',
  client: 'client:',
} as const;

/**
 * PF-304 / PF-305 / PF-306 — the authenticated limiter.
 *
 * Two INSTANCES, not one instance with two key namespaces. Sharing an instance
 * would give per-app and per-token the same capacity and the same refill rate,
 * which makes "per-app AND per-token limits" (PRD p.4) indistinguishable from
 * one limit applied twice — and the whole point of the pair is that an app's
 * ceiling is larger than any single token's share of it.
 *
 * Peek-then-commit, in that order, for PF-305: both buckets are asked first, and
 * a token is spent in NEITHER unless BOTH would allow it. A request the app
 * bucket rejects therefore leaves the caller's own token bucket untouched.
 */
export function rateLimitMiddleware(perApp: IRateLimiter, perToken: IRateLimiter) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const auth = res.locals.platformAuth as PlatformAuthContext | undefined;
    if (!auth) {
      // Unreachable in the composed router — bearer auth is upstream and 401s
      // first. Kept because this middleware must be safe to mount anywhere, and
      // an unkeyed bucket would be a global limit shared by every caller.
      next(new ApiError('unauthorized', 'Authentication required.'));
      return;
    }

    const appKey = `${RATE_KEY_PREFIX.app}${auth.appId}`;
    const tokenKey = `${RATE_KEY_PREFIX.token}${auth.tokenId}`;

    const appPeek = perApp.peek(appKey);
    const tokenPeek = perToken.peek(tokenKey);

    if (!appPeek.allowed || !tokenPeek.allowed) {
      const binding = chooseBinding([appPeek, tokenPeek]);
      applyRateLimitHeaders(res, binding);
      applyRetryAfterHeader(res, binding);
      next(rateLimitedError(binding));
      return;
    }

    const binding = chooseBinding([perApp.consume(appKey), perToken.consume(tokenKey)]);
    applyRateLimitHeaders(res, binding);
    next();
  };
}

/**
 * PF-313 (option b) — the unauthenticated fallback bucket, keyed by client IP.
 *
 * PRD p.6 targets **100% of public API responses** carrying rate-limit headers.
 * Taken literally that includes responses `rateLimitMiddleware` never runs for,
 * because bearer auth rejected them first: a 401 from a missing or bad token, a
 * 404 on an unmatched `/api/v1` path, and `/api/v1/openapi.json`, which is
 * mounted above bearer auth on purpose (PF-216) and which L13 measured as
 * bypassing the limiter entirely (finding F45).
 *
 * Three options were on the table; the rejected two are recorded in
 * `platform/README.md`. This is (b): limit those responses for real, so their
 * headers carry a decision rather than a placeholder. It also happens to be the
 * protection the surface wants anyway — before this, an anonymous caller could
 * hammer the spec endpoint and the 401 path without ever meeting a limit.
 *
 * Deliberately keyed on IP and deliberately COARSE. The default ceiling is
 * several times the per-app one (see `api/src/deps.ts`), so it binds on abuse
 * and not on a busy office behind one NAT. An authenticated request pays it too
 * — its headers are then overwritten a few layers down by the finer per-app /
 * per-token numbers, which are the ones that actually bind for a real client.
 */
export function anonymousRateLimitMiddleware(limiter: IRateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = limiter.consume(`${RATE_KEY_PREFIX.client}${clientKeyFor(req)}`);
    applyRateLimitHeaders(res, decision);
    if (!decision.allowed) {
      applyRetryAfterHeader(res, decision);
      next(rateLimitedError(decision));
      return;
    }
    next();
  };
}

/**
 * The IP a request is charged to.
 *
 * `req.ip` honours `trust proxy`, which is what makes this the deployment's
 * client address rather than the load balancer's. The `'unknown'` fallback
 * buckets every address-less request together — correct: it is one shared
 * ceiling for traffic we cannot attribute, not an exemption.
 */
export function clientKeyFor(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
