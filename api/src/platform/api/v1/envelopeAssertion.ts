/**
 * Testing Scenario 4 clause (c) — L07's clause, registered through the same
 * public seam L03, L08 and L13 use.
 *
 * Deliberately NOT special-cased inside `routeFitness.ts`. If the lane that owns
 * the harness got a privileged back door, the seam would never be exercised by
 * its author and the first lane to use it would be the one discovering it is
 * broken. This module is the worked example the other three copy.
 *
 * PF-201 (envelope on every route's failure path), PF-202 (proves the seam runs).
 */
import request from 'supertest';
import { apiErrorBodySchema } from './errors.js';
import { registerRouteAssertion, type RouteAssertionContext } from './routeFitness.js';
import { isBareAsyncHandler } from './errorMiddleware.js';

/** Stand-in for a `:param` segment. Auth fails long before it is ever read. */
const PARAM_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

/** `/documents/:id` → `/documents/00000000-…`, so the request actually routes. */
export function concretePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? PARAM_PLACEHOLDER : segment))
    .join('/');
}

/**
 * Clause (c): an unauthenticated request to this route returns a body that
 * satisfies `apiErrorBodySchema` with `code: 'unauthorized'`.
 *
 * The unauthenticated path is used because it is the one failure EVERY route
 * has, whatever it does — no fixtures, no per-route setup, no knowledge of the
 * resource. That is what makes one assertion cover routes written by six lanes
 * that do not exist yet.
 *
 * KNOWN LIMIT, stated rather than glossed. Bearer auth sits above every route
 * registered through `mountResources`, so for those routes the 401 is produced
 * by the shared stack and this clause proves the STACK behaves — not that each
 * handler's own error paths do. Two things follow:
 *
 *   1. It genuinely catches a route mounted OUTSIDE `createPublicRouter`, which
 *      is the realistic way the envelope gets lost, and it catches routes whose
 *      middleware answers anonymously when it should not.
 *   2. It does NOT substitute for per-resource negative tests. L09/L10: a route
 *      that returns its own hand-rolled 404 body still passes this clause. Your
 *      lane owns asserting the envelope on your resource's own failure paths;
 *      PF-203's per-code table is the pattern to copy.
 */
export async function assertEnvelopeOnFailure({ route, app }: RouteAssertionContext): Promise<void> {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const res = await request(app)[method](concretePath(route.path));

  if (res.status !== 401) {
    throw new Error(
      `expected 401 for an unauthenticated request, got ${res.status}. ` +
        `Every /api/v1 route must reject an anonymous caller through the envelope.`,
    );
  }

  const parsed = apiErrorBodySchema.safeParse(res.body);
  if (!parsed.success) {
    throw new Error(
      `body does not satisfy apiErrorBodySchema: ${JSON.stringify(res.body)} — ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  if (parsed.data.code !== 'unauthorized') {
    throw new Error(`expected code 'unauthorized', got '${parsed.data.code}'`);
  }

  const header = res.headers['x-request-id'];
  if (header !== parsed.data.request_id) {
    throw new Error(`X-Request-Id (${header}) does not match body request_id`);
  }
}

/**
 * PF-195's build-time half: a bare `async` handler is a handler whose rejections
 * Express 4.22.1 silently drops, so the envelope stops applying to it. Catching
 * it here means the whole class of bug fails the suite instead of hanging a
 * request in production.
 */
export function assertNoBareAsyncHandler({ route }: RouteAssertionContext): void {
  const bare = route.handlers.filter(isBareAsyncHandler);
  if (bare.length > 0) {
    throw new Error(
      `${bare.length} unwrapped async handler(s). Express 4.22.1 does not forward ` +
        `async rejections — wrap with asyncRoute() from platform/api/v1.`,
    );
  }
}

/** Registers L07's clauses. Import this module from any spec that runs the harness. */
export function registerEnvelopeAssertions(): void {
  registerRouteAssertion('L07 (c): failures ship the ApiError envelope', assertEnvelopeOnFailure);
  registerRouteAssertion('L07: no unwrapped async handler (F4)', assertNoBareAsyncHandler);
}
