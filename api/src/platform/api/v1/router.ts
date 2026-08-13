/**
 * createPublicRouter — the ONLY public surface (PF-211).
 *
 * A FRESH router: it shares no middleware with internal `/api`. Sessions+CSRF and
 * bearer tokens are different security models, and mixing them is the failure the
 * PRD's Build Strategy §2 (p.11) names outright — *"create /api/v1/ as a fresh
 * router that does NOT share middleware with the internal API."*
 *
 * The import half of that boundary is the ESLint fence (PF-009/PF-010). This file
 * is the RUNTIME half, and it is not redundant: a lint rule cannot see a
 * middleware handed in as a `deps` field, and `deps` is exactly how a
 * well-meaning future edit would reintroduce `conditionalCsrf` here.
 *
 * Stack order is declared as data in `middlewareOrder.ts` and asserted against
 * the live router by `router.test.ts` (PF-212). Read that file before adding a
 * layer here; the constant is the contract L11 and L12 attach to.
 */
import { Router, json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { apiErrorMiddleware, notFoundHandler } from './errorMiddleware.js';
import { requestIdMiddleware } from './requestId.js';
import { namedLayer } from './middlewareOrder.js';
import { bodyErrorMiddleware } from './bodyErrors.js';
import type { IAuditSink } from '../../audit/audit.js';
import { publicAuditMiddleware } from '../../audit/audit.js';
import type { IRateLimiter } from '../../ratelimit/limiter.js';
import { rateLimitMiddleware, anonymousRateLimitMiddleware } from '../../ratelimit/limiter.js';

/**
 * PF-216 — the paths inside `/api/v1` that answer WITHOUT an Authorization
 * header, as data rather than as a special case buried in a mount call.
 *
 * `deps.bearerAuth` is a `router.use`, so everything mounted below it 401s by
 * default — which is the correct default and the reason this list has to be
 * explicit. Two rejected alternatives:
 *
 *   - Mounting the spec OUTSIDE the v1 router. It would then skip
 *     `requestIdMiddleware` and the audit layer, so the single most-fetched
 *     public endpoint would be the one endpoint with no request id and no audit
 *     row. MVP gate item 7 wants the spec served; it does not want it served
 *     from outside the stack.
 *   - A `skip`-style predicate inside bearer auth. That puts the public/private
 *     decision inside L06's middleware, where this lane cannot test it and L06
 *     has no reason to look for it.
 *
 * Paths are FULL public paths, matched exactly. Clause (c) of the route-fitness
 * harness reads this list, which is what stops "every route 401s for an
 * anonymous caller" and "the spec is reachable anonymously" from contradicting
 * each other silently.
 */
export const V1_UNAUTHENTICATED_PATHS: readonly string[] = ['/api/v1/openapi.json'];

/** True when `path` (full, `/api/v1`-prefixed) is allowed to answer anonymously. */
export function isUnauthenticatedV1Path(path: string): boolean {
  return V1_UNAUTHENTICATED_PATHS.includes(path);
}

export interface PublicRouterDeps {
  /** Resolves a bearer token → PlatformAuthContext on res.locals.platformAuth. */
  bearerAuth: (req: Request, res: Response, next: NextFunction) => void;
  perAppLimiter: IRateLimiter;
  perTokenLimiter: IRateLimiter;
  /**
   * L11 PF-313 — the IP-keyed backstop mounted ABOVE bearer auth.
   *
   * Optional so the several dozen specs that build a bare v1 app keep exactly
   * the stack they were written against; `createApp` always supplies one. When
   * it is absent the layer is still mounted (as a pass-through) so the layer
   * ORDER does not change shape between a test app and the production one —
   * `middlewareOrder.ts` is asserted positionally.
   */
  anonLimiter?: IRateLimiter;
  auditSink: IAuditSink;
  /**
   * Routes that must answer without an Authorization header — the OpenAPI spec,
   * and nothing else today (PF-216). Mounted ABOVE `bearerAuth`.
   *
   * Anything mounted here MUST have its path listed in `V1_UNAUTHENTICATED_PATHS`;
   * `router.test.ts` asserts the two agree, so an unauthenticated route cannot be
   * added without the list — and therefore without the fitness harness — noticing.
   */
  mountUnauthenticated?: (router: Router) => void;
  /**
   * Where resource routers get mounted (L09 → L10, L14 → L16).
   *
   * This hook exists because the two things that MUST come last — the unknown-path
   * `not_found` catch-all and `apiErrorMiddleware` — are mounted by this function.
   * A resource router added after `createPublicRouter` returns would sit below the
   * catch-all and be permanently unreachable, which is a failure mode that looks
   * exactly like "my route 404s for no reason". Registering through the hook makes
   * the ordering impossible to get wrong.
   *
   * It is also the seam the fitness harness (PF-200) uses to mount a throwaway
   * route and prove the route enumerator is not stale-able.
   */
  mountResources?: (router: Router) => void;
}

/**
 * The public body ceiling (PF-215).
 *
 * 1 MB, against the internal 10 MB. The internal limit exists because a wiki
 * document with embedded images genuinely is megabytes; no public resource
 * representation is, and the parser runs BEFORE bearer auth can reject the
 * caller, so the ceiling is also the size of the work an anonymous request can
 * make us do.
 *
 * This only binds because the public router is mounted ABOVE the app-wide
 * `express.json({ limit: '10mb' })` in `createApp`. Mounted below it, the body is
 * already parsed by the time this router sees the request and this line is dead
 * code — which is what it was, and is finding F2.
 */
export const PUBLIC_BODY_LIMIT = '1mb';

export function createPublicRouter(deps: PublicRouterDeps): Router {
  const router = Router();

  // Each layer is renamed so `router.stack` is introspectable by name. See
  // `namedLayer` — without it every layer reports '' or a shared inner name and
  // the order assertion has nothing to assert on.
  router.use(namedLayer('v1_request_id', requestIdMiddleware()));

  // Audit sits ABOVE body parsing, auth and rate limiting (PF-213, and the
  // deviation note in middlewareOrder.ts).
  //
  // It registers a `res.on('finish')` hook and returns; everything it records —
  // status, clientId, scopeUsed, latency — is read at finish time, so mounting it
  // early costs nothing and changes none of the recorded values. Mounted below
  // any layer that can terminate a request, that layer's responses are NEVER
  // AUDITED, which silently exempts exactly the traffic an audit trail exists to
  // capture (PRD p.4: every public API call). 401 (bearer auth), 429 (bucket) and
  // 413 (body parser) are all such layers.
  router.use(namedLayer('v1_audit', publicAuditMiddleware(deps.auditSink)));

  router.use(namedLayer('v1_body_parser', json({ limit: PUBLIC_BODY_LIMIT })));

  // Directly below the parser, because an error handler only sees what was
  // raised above it. Turns `PayloadTooLargeError` and friends into the envelope
  // with a client-error code instead of letting them be scrubbed into a 500 that
  // an SDK would retry forever. See bodyErrors.ts.
  router.use(namedLayer('v1_body_errors', bodyErrorMiddleware()));

  // L11 PF-313 — the anonymous backstop, above BOTH the unauthenticated mount
  // and bearer auth.
  //
  // Above `v1_unauthenticated` on purpose: `/api/v1/openapi.json` is mounted
  // there, and L13's finding F45 measured it as bypassing the rate limiter
  // entirely. It is also the most-polled endpoint on the public surface and the
  // only one an anonymous caller can reach, so "unauthenticated and
  // unthrottled" was the wrong pair. Above bearer auth so a 401 carries the
  // three headers too — which is what makes p.6's 100% target literally true
  // rather than true-for-authenticated-responses.
  //
  // Mounted as a named layer even when no limiter is supplied, so the layer
  // order does not change shape between a test app and the production one.
  router.use(
    namedLayer(
      'v1_anon_rate_limit',
      deps.anonLimiter
        ? anonymousRateLimitMiddleware(deps.anonLimiter)
        : ((_req, _res, next) => {
            next();
          }),
    ),
  );

  // PF-216 — the anonymous-reachable routes, above bearer auth by necessity.
  // Mounted as one named layer even when the hook is absent, so the layer order
  // does not change shape between the production app and a test app.
  router.use(
    namedLayer('v1_unauthenticated', ((req, res, next) => {
      next();
    }) as (req: Request, res: Response, next: NextFunction) => void),
  );
  deps.mountUnauthenticated?.(router);

  router.use(namedLayer('v1_bearer_auth', deps.bearerAuth));
  router.use(
    namedLayer('v1_rate_limit', rateLimitMiddleware(deps.perAppLimiter, deps.perTokenLimiter)),
  );

  // ── resources ──────────────────────────────────────────────────────────
  // Mounted through the hook so they land ABOVE the catch-all below.
  deps.mountResources?.(router);

  // Unknown /api/v1 path → ApiError envelope, not Express's HTML 404 (PF-197).
  router.use(namedLayer('v1_not_found', notFoundHandler()));

  // Terminal handler. Must be last, and must be mounted HERE rather than on the
  // app: the internal /api surface keeps its own inline error shapes (PF-194).
  router.use(namedLayer('v1_error_handler', apiErrorMiddleware()));
  return router;
}
