/**
 * Finding F29 — `/oauth/*` had no rate limit at all, and no lane owned it.
 *
 * The finding, restated so the fix is judged against it: L11 is scoped to
 * `/api/v1`; L04's PF-107 asserts the internal `apiLimiter` does **not** reach
 * the OAuth router (it is a `/api/` prefix mount, and `/oauth` is a sibling);
 * L05's PF-132 built a throttle for the device grant's `user_code` guess space
 * and nothing else. The intersection of those three true statements is that
 * `POST /oauth/token` — an endpoint whose entire job is to accept a
 * `client_secret`, an authorization code or a refresh token and say whether they
 * are right — answered an unbounded number of guesses per second.
 *
 * L11 takes it. Not because the lane file says so — it does not, it is scoped to
 * `/api/v1` — but because the alternative is that a rate-limiting finding stays
 * unowned through Final on the one public endpoint where "unthrottled" and
 * "credential-presenting" overlap. The bucket, the interface and the header
 * contract all already exist here; the marginal cost is this file.
 *
 * ── THE 429 KEEPS THE OAUTH ERROR SURFACE, NOT THE ApiError ENVELOPE ────────
 * `/oauth/*` emits RFC 6749 §5.2's `{error, error_description?}` and `/api/v1`
 * emits `{code, message, details?, request_id}`. That split is settled (L99 U3,
 * L04 PF-106, L06 PF-172) and this middleware does not get to re-open it because
 * it happens to be written by the lane that owns the other surface. An OAuth
 * client library looks for `error`; handing it `code` would make a throttled
 * token exchange indistinguishable from a malformed response.
 *
 * The code is `slow_down`. It is RFC 8628 §3.5's, defined for a client polling
 * the token endpoint too fast, which is exactly what this is — and it is already
 * in `OAUTH_ERROR_CODES`, so throttling costs no widening of a closed union.
 * RFC 6749 registers no rate-limit code at all; inventing one would be a seventh
 * member of a set two other lanes assert is closed.
 *
 * Headers are still the `X-RateLimit-*` family plus `Retry-After`, because those
 * are HTTP, not `/api/v1` — a caller has the same reason to want them here.
 */
import type { Request, Response, NextFunction } from 'express';
import {
  applyRateLimitHeaders,
  applyRetryAfterHeader,
  clientKeyFor,
  type IRateLimiter,
} from './limiter.js';

/** Key namespace, disjoint from the `/api/v1` ones so the surfaces cannot collide. */
export const OAUTH_RATE_KEY_PREFIX = 'oauth:';

/**
 * The RFC 6749 §5.2 body a throttled OAuth request gets.
 *
 * Shaped here rather than imported from `oauth/` on purpose: `ratelimit/` has no
 * other reason to depend on the OAuth module, and `oauthErrorBodySchema` is what
 * the tests validate against, so the two cannot drift without the suite saying
 * so. `oauthThrottle.test.ts` parses this through that schema.
 */
export function oauthRateLimitedBody(retryAfterSeconds: number): {
  error: 'slow_down';
  error_description: string;
} {
  return {
    error: 'slow_down',
    error_description:
      `Too many requests to the OAuth endpoints from this client. ` +
      `Retry after ${retryAfterSeconds} second(s).`,
  };
}

/**
 * Throttles `/oauth/*` by client IP.
 *
 * IP rather than `client_id`, and that is the point rather than a shortcut. The
 * attack this exists against is guessing — a wrong `client_secret`, a wrong
 * `code_verifier`, a stolen-and-expired refresh token — so keying on a field
 * the attacker supplies would let them rotate the key and reset their own
 * bucket. The IP is the one identifier the request cannot choose. It is also why
 * this must run BEFORE the body is parsed and before any credential is checked:
 * a limiter that only counts requests it has already done the work for is a
 * limiter that has already done the work.
 *
 * Mounted in the composition root (`api/src/app.ts`), not inside the OAuth
 * router. The router belongs to L04/L05/L06 and a throttle is not one of its
 * concerns; the composition root is where cross-cutting middleware is chosen,
 * and it is the file that already knows which `IRateLimiter` this deployment
 * has.
 *
 * This middleware writes its own response rather than calling `next(err)`. On
 * `/api/v1` the limiter must NOT write one, because L07's terminal handler owns
 * the envelope — but `/oauth` has no terminal handler of that kind, and routing
 * a `slow_down` through Express's default error handler would produce an HTML
 * error page for a machine client.
 */
export function oauthRateLimitMiddleware(limiter: IRateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const decision = limiter.consume(`${OAUTH_RATE_KEY_PREFIX}${clientKeyFor(req)}`);
    applyRateLimitHeaders(res, decision);
    if (decision.allowed) {
      next();
      return;
    }

    applyRetryAfterHeader(res, decision);
    const retryAfter = Math.max(1, decision.retryAfterSeconds ?? 1);
    // `no-store` for the same reason every other `/oauth` response carries it:
    // a cached 429 would outlive the condition that produced it.
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json(oauthRateLimitedBody(retryAfter));
  };
}
