/**
 * Token-bucket rate limiting, per-app AND per-token.
 *
 * Buckets allow the bursts real integrations produce while enforcing a mean
 * rate; two keys stop one noisy install from starving an app's other users.
 * In-memory is correct for the single-instance Render topology — behind the
 * interface, a Redis bucket is a composition-root swap.
 *
 * Contract: 100% of public responses carry X-RateLimit-Limit / -Remaining /
 * -Reset; a 429 adds Retry-After. (Fitness-tested.)
 */
import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../api/v1/errors.js';
import type { PlatformAuthContext } from '../scopes/auth-context.js';
import type { Clock } from '../clock.js';
import { SystemClock } from '../clock.js';

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the bucket refills enough for one request. */
  resetAtSeconds: number;
  retryAfterSeconds: number | null;
}

export interface IRateLimiter {
  consume(key: string): RateDecision;
}

export interface TokenBucketOptions {
  capacity: number;        // burst size
  refillPerSecond: number; // sustained rate
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class InMemoryTokenBucket implements IRateLimiter {
  private buckets = new Map<string, BucketState>();

  constructor(
    private readonly options: TokenBucketOptions,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  consume(key: string): RateDecision {
    const now = this.clock.nowMs();
    const state = this.buckets.get(key) ?? { tokens: this.options.capacity, lastRefillMs: now };

    // Refill continuously based on elapsed time.
    const elapsedSeconds = (now - state.lastRefillMs) / 1000;
    state.tokens = Math.min(this.options.capacity, state.tokens + elapsedSeconds * this.options.refillPerSecond);
    state.lastRefillMs = now;

    const allowed = state.tokens >= 1;
    if (allowed) state.tokens -= 1;
    this.buckets.set(key, state);

    const deficit = allowed ? 0 : 1 - state.tokens;
    const secondsToNextToken = deficit / this.options.refillPerSecond;
    return {
      allowed,
      limit: this.options.capacity,
      remaining: Math.floor(state.tokens),
      resetAtSeconds: Math.ceil(now / 1000 + secondsToNextToken),
      retryAfterSeconds: allowed ? null : Math.max(1, Math.ceil(secondsToNextToken)),
    };
  }
}

export function rateLimitMiddleware(perApp: IRateLimiter, perToken: IRateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = res.locals.platformAuth as PlatformAuthContext | undefined;
    if (!auth) {
      next(new ApiError('unauthorized', 'Authentication required.'));
      return;
    }
    const appDecision = perApp.consume(`app:${auth.appId}`);
    const tokenDecision = perToken.consume(`token:${auth.tokenId}`);
    const binding = appDecision.remaining <= tokenDecision.remaining ? appDecision : tokenDecision;

    res.setHeader('X-RateLimit-Limit', String(binding.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, binding.remaining)));
    res.setHeader('X-RateLimit-Reset', String(binding.resetAtSeconds));

    if (!appDecision.allowed || !tokenDecision.allowed) {
      res.setHeader('Retry-After', String(binding.retryAfterSeconds ?? 1));
      next(new ApiError('rate_limited', 'Rate limit exceeded. Slow down.'));
      return;
    }
    next();
  };
}
