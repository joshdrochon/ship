/**
 * `GET /api/v1/openapi.json` — the route MVP gate item 7 (p.2) names.
 *
 * Tickets: PF-365 (it is actually reachable), PF-366 (it resolves with no
 * credentials), PF-367 (what it bypasses, and that this is deliberate).
 *
 * ## Finding F11 — the two ways this endpoint would not have worked
 *
 * The Composition Root section of `docs/architecture.md` used to show
 * `app.get('/api/v1/openapi.json', serveGeneratedSpec())` mounted AFTER
 * `app.use('/api/v1', v1)`. Both halves of that are wrong against the router L08
 * actually built, and neither failure is loud. (Both documents now show the
 * `mountUnauthenticated` hook instead, and cite this finding by name — cited by
 * SECTION rather than by line, because the line numbers in this file's earlier
 * citations all went stale the first time the document was rewritten.)
 *
 *   **404.** `createPublicRouter` ends with `notFoundHandler()` followed by
 *   `apiErrorMiddleware()`. Express matches the `/api/v1` mount first, the
 *   catch-all raises `not_found`, and the terminal handler answers. A route
 *   registered on the app below that line is never consulted. It does not error
 *   — it returns a well-formed 404 envelope, which reads exactly like "the URL is
 *   wrong" rather than "the mount order is wrong".
 *
 *   **401.** `router.use(deps.bearerAuth)` blankets every path below it. A spec a
 *   grader cannot fetch without first obtaining a token fails MVP item 10.
 *
 * The fix is the seam L08 built: `mountUnauthenticated`, which runs INSIDE the
 * router, above `bearerAuth` and above the catch-all. This module is the handler
 * that seam was built for; until now `router.test.ts` mounted a stub returning
 * `{openapi:'3.1.0', paths:{}}`, so the allowlist test was proving the seam
 * worked rather than proving the endpoint did.
 *
 * ## PF-367 — what the mount position bypasses, corrected
 *
 * The ticket predicted the spec route would bypass the audit sink as well as the
 * rate limiter, on the assumption that the stack was `bearerAuth → rateLimit →
 * audit`. **That is not the order L08 shipped.** F7 moved audit ABOVE bearer
 * auth, precisely so 401s and 429s are audited, so the live order is
 * `requestId → audit → body → bodyErrors → unauthenticated → bearerAuth →
 * rateLimit`. The consequence:
 *
 *   - **Audit: NOT bypassed.** A spec fetch writes an audit row like any other
 *     public call, with a null `clientId`/`userId` because there is no token.
 *     `route.test.ts` asserts the row exists.
 *   - **Rate limiting: bypassed, deliberately.** The buckets are keyed `app:` and
 *     `token:`; an anonymous request has neither key, so there is nothing to
 *     bucket against. Accepted rather than worked around — the alternative is a
 *     per-IP bucket, which is a different limiter with different semantics that
 *     L11 does not own and nothing in the PRD asks for. The endpoint serves one
 *     cached object with no database access, so the cost of an unthrottled fetch
 *     is a JSON write.
 *
 * Written down here and in `platform/README.md` so L11 and L12 do not spend an
 * afternoon treating the gap as their own bug.
 */
import type { Router } from 'express';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from 'zod';
import { declareV1Route } from '../api/v1/declareV1Route.js';

/** The path within the v1 router. The full public path adds `/api/v1`. */
export const OPENAPI_SPEC_PATH = '/openapi.json';

/**
 * The response schema for the spec endpoint itself.
 *
 * `.passthrough()` rather than a full OpenAPI object model: the authority on
 * whether this body is a valid OpenAPI document is the 3.1 JSON schema in
 * `schemaValidation.ts` (PF-370/371), not a hand-rolled Zod restatement of a
 * 300-line meta-schema. What this schema is for is PF-360's response contract —
 * it catches "the handler served `undefined`" or "the handler served an array",
 * and leaves "is it valid OpenAPI" to the validator that exists for that.
 */
export const openApiDocumentSchema = z
  .object({
    openapi: z.literal('3.1.0'),
    info: z.object({ title: z.string(), version: z.string() }).passthrough(),
    paths: z.record(z.unknown()),
  })
  .passthrough();

/**
 * Declared at module load, exactly like L09's three routes and for the same
 * reason: `routeMetadata.declare()` throws on a duplicate key and a test suite
 * builds many apps.
 *
 * `scope: null` is a CLAIM, not a default — the route requires no permission,
 * which is the whole point of it. `unauthenticated: true` gives the generated
 * operation `security: []` and no `401` response, because it cannot produce one.
 *
 * Declaring it through `declareV1Route` rather than mounting it raw has three
 * consequences worth stating: it satisfies `assertEveryRouteDeclaresList` and
 * `assertEveryRouteDeclaresScope` at boot without an exemption list; it makes the
 * spec describe itself, so `servers[0].url + '/openapi.json'` resolves; and it
 * means PF-373's parity clause covers this route like any other rather than
 * skipping it.
 */
const specGuard = declareV1Route({
  method: 'get',
  path: OPENAPI_SPEC_PATH,
  scope: null,
  list: false,
  unauthenticated: true,
  response: openApiDocumentSchema,
  summary: 'The OpenAPI 3.1 description of this API.',
  description:
    'Generated from route metadata at boot — never hand-written. Requires no ' +
    'credentials: a specification a consumer cannot fetch before authenticating is ' +
    'a specification they cannot use to authenticate.',
});

/**
 * Builds the `mountUnauthenticated` callback the composition root passes to
 * `createPublicRouter`.
 *
 * Takes the already-generated document rather than generating per request. The
 * document cannot change while the process lives — it is derived entirely from
 * module-load-time registrations — so generating per request would be work with
 * no possible different answer, on the endpoint most likely to be polled.
 */
export function mountOpenApiSpec(document: OpenAPIObject): (router: Router) => void {
  return (router: Router): void => {
    router.get(OPENAPI_SPEC_PATH, specGuard, (_req, res) => {
      // `type()` explicitly rather than relying on `res.json`'s default, because
      // PF-365's assertion is on the `content-type` header and an SDK's content
      // negotiation is a real thing that reads it.
      res.type('application/json').json(document);
    });
  };
}
