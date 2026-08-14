/**
 * L06's route-fitness clause — the enumeration half of MVP gate item 3.
 *
 * The gate says the middleware validates tokens on **every** `/api/v1/*` route.
 * "Every" is an enumeration claim, and the only honest way to make it is to walk
 * the live Express stack and check each route individually. A route added later
 * by a lane that does not exist yet must fail CI unaided.
 *
 * Registered through L07's `registerRouteAssertion` seam (PF-202) rather than by
 * forking `enumerateV1Routes`. Three route walks would mean three different
 * definitions of "every route", and the subtly wrong one is the one that passes.
 * `envelopeAssertion.ts` is the worked example this copies.
 *
 * WHAT THIS ADDS OVER L07's CLAUSE (c). L07 asserts an unauthenticated request
 * ships the envelope with `code: 'unauthorized'`. This clause asserts the two
 * things the gate names beyond that: the 401 for a MISSING credential carries
 * `details.reason === 'missing'`, and a GARBAGE credential — a real header, a
 * real-looking token, no matching row — is also 401 and carries
 * `details.reason === 'invalid'`. Those two are route-agnostic and need no
 * fixtures, which is what lets one assertion cover every route in the app.
 *
 * The EXPIRED case is deliberately not here. It needs a minted token and a clock
 * advance, which is app-level rather than route-level state; PF-163's gate test
 * asserts it once, against a booted app.
 */
// Deferred, not top-level: `supertest` is a devDependency and this module sits in
// the production bundle. A top-level import kills the server at boot with
// ERR_MODULE_NOT_FOUND under `pnpm install --prod`, the one install that omits
// it. See the long note in `../api/v1/envelopeAssertion.ts`.
async function loadRequest() {
  return (await import('supertest')).default;
}
import { apiErrorBodySchema } from '../api/v1/errors.js';
import { registerRouteAssertion, type RouteAssertionContext } from '../api/v1/routeFitness.js';
import { concretePath } from '../api/v1/envelopeAssertion.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A syntactically plausible token that matches no row. */
const GARBAGE_TOKEN = 'ship_at_ZZZZnot-a-real-token-ZZZZ';

function reasonOf(body: unknown): string | undefined {
  const parsed = apiErrorBodySchema.safeParse(body);
  if (!parsed.success) return undefined;
  if (parsed.data.code !== 'unauthorized') return undefined;
  return parsed.data.details?.reason;
}

/** Gate clause (a): no `Authorization` header at all → 401, reason `missing`. */
export async function assertMissingTokenIs401({
  route,
  app,
}: RouteAssertionContext): Promise<void> {
  const request = await loadRequest();
  const method = route.method.toLowerCase() as Method;
  const res = await request(app)[method](concretePath(route.path));

  if (res.status !== 401) {
    throw new Error(`unauthenticated request returned ${res.status}, expected 401`);
  }
  const reason = reasonOf(res.body);
  if (reason !== 'missing') {
    throw new Error(
      `expected details.reason 'missing', got ${JSON.stringify(reason)} — ` +
        `body was ${JSON.stringify(res.body)}`,
    );
  }
  const challenge = res.headers['www-authenticate'];
  if (typeof challenge !== 'string' || !challenge.startsWith('Bearer')) {
    throw new Error(`RFC 6750 §3 requires a Bearer challenge; got ${JSON.stringify(challenge)}`);
  }
}

/** Gate clause (b): a garbage credential → 401, reason `invalid`. */
export async function assertInvalidTokenIs401({
  route,
  app,
}: RouteAssertionContext): Promise<void> {
  const request = await loadRequest();
  const method = route.method.toLowerCase() as Method;
  const agent = request(app);
  const res = await agent[method](concretePath(route.path)).set(
    'Authorization',
    `Bearer ${GARBAGE_TOKEN}`,
  );

  if (res.status !== 401) {
    throw new Error(`request with a garbage token returned ${res.status}, expected 401`);
  }
  const reason = reasonOf(res.body);
  if (reason !== 'invalid') {
    throw new Error(
      `expected details.reason 'invalid', got ${JSON.stringify(reason)} — ` +
        `body was ${JSON.stringify(res.body)}`,
    );
  }
}

/** Registers L06's clauses. Import this module from any spec that runs the harness. */
export function registerBearerAssertions(): void {
  registerRouteAssertion('L06: a missing token is 401 with reason=missing', assertMissingTokenIs401);
  registerRouteAssertion('L06: an invalid token is 401 with reason=invalid', assertInvalidTokenIs401);
}
