/**
 * L11 S2 — PF-304, PF-305, PF-306, PF-309.
 *
 * Two limiters, not one, and correct behaviour when one of them says no. Every
 * assertion here drives the real `rateLimitMiddleware` through a real Express
 * stack rather than calling the bucket directly, because the bugs this slice
 * fixes are all in the middleware's arbitration between the two buckets and are
 * invisible from either bucket alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { FakeClock } from '../clock.js';
import { apiErrorMiddleware } from '../api/v1/errorMiddleware.js';
import { requestIdMiddleware } from '../api/v1/requestId.js';
import type { PlatformAuthContext } from '../scopes/auth-context.js';
import {
  InMemoryTokenBucket,
  rateLimitMiddleware,
  RATE_KEY_PREFIX,
  type IRateLimiter,
} from './limiter.js';
import {
  PUBLIC_RATE_LIMIT_DEFAULTS,
  PUBLIC_RATE_LIMIT_ENV_NAMES,
  publicRateLimiters,
} from '../../deps.js';

function authContext(overrides: Partial<PlatformAuthContext> = {}): PlatformAuthContext {
  return {
    appId: 'app_1',
    clientId: 'client_1',
    userId: 'user_1',
    scopes: [],
    tokenId: 'token_a',
    workspaceId: 'ws_1',
    ...overrides,
  };
}

/**
 * The smallest stack that exercises the real middleware: request id (so the
 * envelope has one), an auth stub, the limiter, a handler, the terminal handler.
 */
function appWith(
  perApp: IRateLimiter,
  perToken: IRateLimiter,
  auth: PlatformAuthContext | (() => PlatformAuthContext),
) {
  const app = express();
  app.use(requestIdMiddleware());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.platformAuth = typeof auth === 'function' ? auth() : auth;
    next();
  });
  app.use(rateLimitMiddleware(perApp, perToken));
  app.get('/thing', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(apiErrorMiddleware());
  return app;
}

const bucket = (capacity: number, refillPerSecond: number, clock: FakeClock) =>
  new InMemoryTokenBucket({ capacity, refillPerSecond, maxKeys: 1_000 }, clock);

describe('PF-304 — per-app and per-token are independent limiters', () => {
  it('exhausting token A leaves token B, under the SAME app, still served', async () => {
    const clock = new FakeClock(0);
    // A generous app bucket so it cannot be the thing that denies.
    const perApp = bucket(1_000, 1_000, clock);
    const perToken = bucket(2, 0.01, clock);

    let tokenId = 'token_a';
    const app = appWith(perApp, perToken, () => authContext({ tokenId }));

    await request(app).get('/thing').expect(200);
    await request(app).get('/thing').expect(200);
    await request(app).get('/thing').expect(429); // token A is out

    tokenId = 'token_b';
    // Same app, different token. If these shared one bucket instance — or one
    // key namespace — this would be a 429 and one noisy install would starve
    // every other user of the app.
    await request(app).get('/thing').expect(200);
  });

  it('exhausting the APP bucket denies every token under it', async () => {
    const clock = new FakeClock(0);
    const perApp = bucket(2, 0.01, clock);
    const perToken = bucket(1_000, 1_000, clock);

    let tokenId = 'token_a';
    const app = appWith(perApp, perToken, () => authContext({ tokenId }));

    await request(app).get('/thing').expect(200);
    await request(app).get('/thing').expect(200);

    // A brand-new token with a completely full bucket of its own is still
    // denied, because its app has no allowance left. This is the direction a
    // per-token-only limiter gets wrong.
    tokenId = 'token_never_seen_before';
    await request(app).get('/thing').expect(429);
  });

  it('the two key namespaces are disjoint, so an appId can never collide with a tokenId', () => {
    expect(RATE_KEY_PREFIX.app).not.toBe(RATE_KEY_PREFIX.token);
    // The failure this guards: an app whose id equals some token's id sharing a
    // bucket. Prefixes make that unrepresentable.
    const shared = bucket(1, 0.01, new FakeClock(0));
    expect(shared.consume(`${RATE_KEY_PREFIX.app}same`).allowed).toBe(true);
    expect(shared.consume(`${RATE_KEY_PREFIX.token}same`).allowed).toBe(true);
  });
});

describe('PF-305 — a denied request must not spend the other bucket', () => {
  it('50 app-denied requests leave the token bucket untouched', async () => {
    const clock = new FakeClock(0);
    const perApp = bucket(1, 0.0001, clock);
    const perToken = bucket(100, 0.0001, clock);
    const app = appWith(perApp, perToken, authContext());

    await request(app).get('/thing').expect(200); // spends 1 from both

    const tokenRemainingBefore = perToken.peek(`${RATE_KEY_PREFIX.token}token_a`).remaining;
    for (let i = 0; i < 50; i++) {
      await request(app).get('/thing').expect(429);
    }
    const tokenRemainingAfter = perToken.peek(`${RATE_KEY_PREFIX.token}token_a`).remaining;

    // The sketch called `perApp.consume()` and `perToken.consume()`
    // unconditionally. Under it these 50 rejected requests would have burned 50
    // of the caller's own tokens — a client that is app-limited quietly losing
    // quota it never got to use.
    expect(tokenRemainingAfter).toBe(tokenRemainingBefore);
  });

  it('the symmetric case holds too — token-denied requests leave the app bucket alone', async () => {
    const clock = new FakeClock(0);
    const perApp = bucket(100, 0.0001, clock);
    const perToken = bucket(1, 0.0001, clock);
    const app = appWith(perApp, perToken, authContext());

    await request(app).get('/thing').expect(200);
    const appRemainingBefore = perApp.peek(`${RATE_KEY_PREFIX.app}app_1`).remaining;
    for (let i = 0; i < 50; i++) {
      await request(app).get('/thing').expect(429);
    }
    expect(perApp.peek(`${RATE_KEY_PREFIX.app}app_1`).remaining).toBe(appRemainingBefore);
  });

  it('an allowed request spends exactly one token in each bucket, never two', async () => {
    const clock = new FakeClock(0);
    const perApp = bucket(10, 0.0001, clock);
    const perToken = bucket(10, 0.0001, clock);
    const app = appWith(perApp, perToken, authContext());

    for (let i = 0; i < 5; i++) await request(app).get('/thing').expect(200);

    // Peek-then-commit must not double-count: five requests, five tokens.
    expect(perApp.peek(`${RATE_KEY_PREFIX.app}app_1`).remaining).toBe(10 - 5 - 1);
    expect(perToken.peek(`${RATE_KEY_PREFIX.token}token_a`).remaining).toBe(10 - 5 - 1);
  });
});

describe('PF-306 — Retry-After comes from the bucket that actually denied', () => {
  it('the app bucket needs 30 s while the token bucket is fine → Retry-After: 30', async () => {
    const clock = new FakeClock(0);
    // 1/30 tokens per second ⇒ exactly 30 s to the next token.
    const perApp = bucket(1, 1 / 30, clock);
    const perToken = bucket(1_000, 1_000, clock);
    const app = appWith(perApp, perToken, authContext());

    await request(app).get('/thing').expect(200);
    const res = await request(app).get('/thing').expect(429);

    // The sketch selected the decision with the lower `remaining`, which here is
    // the ALLOWED token decision (999 vs 0 — so it happens to pick right), but
    // reverse the capacities and it picks an allowed decision whose
    // retryAfterSeconds is null and falls back to `?? 1`.
    expect(res.headers['retry-after']).toBe('30');
  });

  it('never falls back to 1 when the denying bucket needs longer', async () => {
    const clock = new FakeClock(0);
    // The denying bucket has MORE remaining headroom in absolute terms than the
    // allowed one — the exact shape that defeats a `remaining`-based comparison.
    const perApp = bucket(1, 1 / 45, clock);
    const perToken = bucket(3, 1, clock);
    const app = appWith(perApp, perToken, authContext());

    await request(app).get('/thing').expect(200);
    const res = await request(app).get('/thing').expect(429);
    expect(res.headers['retry-after']).toBe('45');
    expect(res.headers['retry-after']).not.toBe('1');
  });

  it('when BOTH deny, Retry-After is the max of the two', async () => {
    const clock = new FakeClock(0);
    const perApp = bucket(1, 1 / 12, clock);
    const perToken = bucket(1, 1 / 37, clock);
    const app = appWith(perApp, perToken, authContext());

    await request(app).get('/thing').expect(200);
    const res = await request(app).get('/thing').expect(429);

    // Retrying at 12 s would meet a second 429 from the token bucket.
    expect(res.headers['retry-after']).toBe('37');
  });

  it('Retry-After is an integer >= 1 on every 429, however fast the bucket refills', async () => {
    const clock = new FakeClock(0);
    // Sub-second refill: the naive value would be 0.2 s, i.e. `Retry-After: 0`,
    // which invites an immediate retry that is guaranteed to fail.
    const perApp = bucket(1, 5, clock);
    const perToken = bucket(1_000, 1_000, clock);
    const app = appWith(perApp, perToken, authContext());

    await request(app).get('/thing').expect(200);
    const res = await request(app).get('/thing').expect(429);

    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe('PF-309 — limits are configuration, not constants in the module', () => {
  it('no numeric limit is written inside ratelimit/', () => {
    const source = readFileSync(fileURLToPath(new URL('./limiter.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    // The three configured numbers must never appear as literals here. A default
    // in this module is a limit nobody chose and a deployment cannot change.
    for (const field of ['capacity', 'refillPerSecond', 'maxKeys']) {
      expect(code, `${field} must not be defaulted inside ratelimit/`).not.toMatch(
        new RegExp(`${field}\\s*[:=]\\s*[0-9]`),
      );
      expect(code, `${field} must not have a ?? fallback inside ratelimit/`).not.toMatch(
        new RegExp(`${field}\\s*\\?\\?`),
      );
    }
  });

  it('TokenBucketOptions has no optional members — an unset limit will not compile', () => {
    // The type-level half. If any of the three became optional, `deps.ts` could
    // silently stop choosing it and the module would need a default again.
    const source = readFileSync(fileURLToPath(new URL('./limiter.ts', import.meta.url)), 'utf8');
    const block = source.slice(
      source.indexOf('export interface TokenBucketOptions'),
      source.indexOf('interface BucketState'),
    );
    expect(block).not.toMatch(/^\s*\w+\?\s*:/m);
  });

  it('the composition root reads every limit from a named environment variable', () => {
    const previous = PUBLIC_RATE_LIMIT_ENV_NAMES.map((n) => process.env[n]);
    try {
      process.env.PUBLIC_RATE_LIMIT_APP_PER_MINUTE = '17';
      process.env.PUBLIC_RATE_LIMIT_TOKEN_PER_MINUTE = '5';
      process.env.PUBLIC_RATE_LIMIT_ANON_PER_MINUTE = '23';

      const { perAppLimiter, perTokenLimiter, anonLimiter } = publicRateLimiters(new FakeClock(0));
      expect(perAppLimiter.peek('app:x').limit).toBe(17);
      expect(perTokenLimiter.peek('token:x').limit).toBe(5);
      expect(anonLimiter.peek('client:x').limit).toBe(23);
    } finally {
      PUBLIC_RATE_LIMIT_ENV_NAMES.forEach((name, i) => {
        const value = previous[i];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      });
    }
  });

  it('a malformed or non-positive override falls back to the documented default', () => {
    const previous = process.env.PUBLIC_RATE_LIMIT_APP_PER_MINUTE;
    try {
      for (const bad of ['', 'lots', '0', '-5']) {
        process.env.PUBLIC_RATE_LIMIT_APP_PER_MINUTE = bad;
        const { perAppLimiter } = publicRateLimiters(new FakeClock(0));
        // A zero capacity is a bucket that denies forever. Taking the public API
        // down because a tuning knob was mistyped is the wrong failure.
        expect(perAppLimiter.peek('app:x').limit).toBe(PUBLIC_RATE_LIMIT_DEFAULTS.perAppPerMinute);
      }
    } finally {
      if (previous === undefined) delete process.env.PUBLIC_RATE_LIMIT_APP_PER_MINUTE;
      else process.env.PUBLIC_RATE_LIMIT_APP_PER_MINUTE = previous;
    }
  });

  it('the anon backstop is configured ABOVE the per-app ceiling', () => {
    // Not cosmetic. The anon bucket charges authenticated requests too, so if it
    // were the tighter of the two it would be the limit that actually binds for
    // a legitimate app — a backstop quietly becoming the working limit.
    expect(PUBLIC_RATE_LIMIT_DEFAULTS.anonPerMinute).toBeGreaterThan(
      PUBLIC_RATE_LIMIT_DEFAULTS.perAppPerMinute,
    );
    expect(PUBLIC_RATE_LIMIT_DEFAULTS.perAppPerMinute).toBeGreaterThan(
      PUBLIC_RATE_LIMIT_DEFAULTS.perTokenPerMinute,
    );
  });
});
