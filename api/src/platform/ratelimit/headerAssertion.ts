/**
 * PF-314 — L11's clause on L07's route-fitness seam.
 *
 * PRD p.6 is a Performance Target, not a Testing Scenario: *"Public API
 * responses with rate-limit headers · 100%"*. A percentage is only a number if
 * something counts the denominator, and this file is that counter — it runs over
 * `enumerateV1Routes`, not over a hand-written list, so a route added by a lane
 * that does not exist yet is inside the measurement automatically.
 *
 * Registered through `registerRouteAssertion` (PF-202) rather than walking the
 * routes itself. Three route walks would be three definitions of "every route",
 * and the one that is subtly wrong is the one that passes.
 *
 * ── What the denominator includes, and why (PF-313) ─────────────────────────
 * Every `/api/v1` response class, including the ones the per-app/per-token
 * limiter never runs for: a 401 from bearer auth, a 404 on an unmatched path,
 * and `/api/v1/openapi.json`. That is only assertable because PF-313 chose
 * option (b) — an IP-keyed backstop mounted above bearer auth — so those
 * responses carry a REAL decision rather than a back-filled placeholder.
 */
import type { RouteAssertionContext } from '../api/v1/routeFitness.js';
import { registerRouteAssertion } from '../api/v1/routeFitness.js';
import { concretePath } from '../api/v1/envelopeAssertion.js';
import { RATE_LIMIT_HEADERS, RETRY_AFTER_HEADER } from './limiter.js';

/** The three headers, lower-cased the way Node reports them. */
const REQUIRED = [
  RATE_LIMIT_HEADERS.limit,
  RATE_LIMIT_HEADERS.remaining,
  RATE_LIMIT_HEADERS.reset,
].map((h) => h.toLowerCase());

/**
 * Asserts the three headers are present and integer-valued on one response.
 *
 * `context` is prose, because a bare "missing X-RateLimit-Limit" from a harness
 * that ran forty requests tells you nothing about which one.
 */
export function assertRateLimitHeaders(
  headers: Record<string, unknown>,
  context: string,
): void {
  for (const name of REQUIRED) {
    const raw = headers[name];
    if (raw === undefined) {
      throw new Error(
        `${context}: missing ${name}. PRD p.6 targets 100% of public API responses ` +
          `carrying rate-limit headers; a response class with none is the denominator ` +
          `quietly shrinking.`,
      );
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${context}: ${name} is "${String(raw)}", not a non-negative integer`);
    }
  }
}

/**
 * Asserts a 429 carries `Retry-After` as an integer of at least one second, and
 * that nothing else does.
 *
 * The second half matters: `Retry-After` on a 200 tells a well-behaved SDK to
 * back off after a request that succeeded.
 */
export function assertRetryAfter(
  status: number,
  headers: Record<string, unknown>,
  context: string,
): void {
  const raw = headers[RETRY_AFTER_HEADER.toLowerCase()];
  if (status === 429) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(
        `${context}: a 429 must carry ${RETRY_AFTER_HEADER} as an integer >= 1, got "${String(raw)}"`,
      );
    }
    return;
  }
  if (raw !== undefined) {
    throw new Error(
      `${context}: ${RETRY_AFTER_HEADER} is set on a ${status}. It belongs on a 429 and ` +
        `nowhere else — on a success it tells an SDK to back off after a request that worked.`,
    );
  }
}

/**
 * The clause. Drives the anonymous request every route has and asserts the
 * headers on whatever comes back.
 *
 * Anonymous rather than authenticated, for the same reason L07's clause is: it
 * is the one response every route produces without fixtures, per-route setup, or
 * any knowledge of the resource. The authenticated 2xx and the real 429 are
 * asserted separately, on a composed router, in `headers.test.ts` — this clause
 * is the part that has to hold for routes nobody has written yet.
 */
export async function assertRateLimitHeadersOnEveryRoute({
  route,
  app,
}: RouteAssertionContext): Promise<void> {
  // Deferred import: this module is reachable from production code through the
  // platform barrel, and supertest is a devDependency. See the long note at the
  // top of `envelopeAssertion.ts` for how that took down a deploy once.
  const { default: request } = await import('supertest');

  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const res = await request(app)[method](concretePath(route.path));
  const where = `${route.method} ${route.path} (${res.status})`;

  assertRateLimitHeaders(res.headers as Record<string, unknown>, where);
  assertRetryAfter(res.status, res.headers as Record<string, unknown>, where);
}

/** Registers L11's clause. Import this module from any spec that runs the harness. */
export function registerRateLimitHeaderAssertion(): void {
  registerRouteAssertion(
    'L11 (p.6): every public response carries the rate-limit headers',
    assertRateLimitHeadersOnEveryRoute,
  );
}
