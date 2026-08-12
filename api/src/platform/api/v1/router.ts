/**
 * createPublicRouter — the ONLY public surface. A FRESH router: it shares no
 * middleware with internal /api (sessions+CSRF and bearer tokens are different
 * security models; the ESLint boundary rule enforces the import side).
 *
 * Middleware order (each concern separate — see architecture.md):
 *   requestId → audit → bearer auth (401) → [per-route] requireScope (403) →
 *   rate limit (429 + headers) → handler → apiErrorMiddleware
 *
 * Audit moved above auth in L07 PF-193 — see the comment at its mount point.
 */
import { Router, json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { apiErrorMiddleware, ApiError } from './errors.js';
import { requestIdMiddleware } from './requestId.js';
import type { IAuditSink } from '../../audit/audit.js';
import { publicAuditMiddleware } from '../../audit/audit.js';
import type { IRateLimiter } from '../../ratelimit/limiter.js';
import { rateLimitMiddleware } from '../../ratelimit/limiter.js';

export interface PublicRouterDeps {
  /** Resolves a bearer token → PlatformAuthContext on res.locals.platformAuth. */
  bearerAuth: (req: Request, res: Response, next: NextFunction) => void;
  perAppLimiter: IRateLimiter;
  perTokenLimiter: IRateLimiter;
  auditSink: IAuditSink;
  /**
   * Where resource routers get mounted (L08 → L10, L14 → L16).
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

export function createPublicRouter(deps: PublicRouterDeps): Router {
  const router = Router();

  router.use(requestIdMiddleware());

  // Audit sits ABOVE auth and rate limiting, not below them (moved by L07 PF-193).
  //
  // It registers a `res.on('finish')` hook and returns; everything it records —
  // status, clientId, scopeUsed, latency — is read at finish time, so mounting it
  // early costs nothing and changes none of the recorded values. Mounted below
  // auth, as it originally was, a 401 or a 429 short-circuits before the hook is
  // ever registered and the call is NEVER AUDITED — which silently exempts
  // exactly the traffic an audit trail exists to capture (PRD p.4: every public
  // API call). PF-193's fitness assertion is what caught this.
  router.use(publicAuditMiddleware(deps.auditSink));

  router.use(json({ limit: '1mb' })); // public payloads are small; internal 10mb limit does not apply
  router.use(deps.bearerAuth);
  router.use(rateLimitMiddleware(deps.perAppLimiter, deps.perTokenLimiter));

  // ── resources ──────────────────────────────────────────────────────────
  // Mounted through the hook so they land ABOVE the catch-all below.
  // TODO(josh) E2: GET /me (SDK-skeleton gate: new ShipClient({token}).me())
  // TODO(josh) E2: /documents — GET list (cursor), GET :id, POST (scoped)
  // TODO(josh) E4: /webhooks/subscriptions CRUD + /webhooks/deliveries/:id/replay
  // TODO(josh) E3: GET /openapi.json (mounted in app.ts via serveGeneratedSpec)
  deps.mountResources?.(router);

  // Unknown /api/v1 path → ApiError envelope, not Express's HTML 404.
  router.use((req: Request, _res: Response, next: NextFunction) => {
    next(new ApiError('not_found', `No such endpoint: ${req.method} ${req.path}`));
  });

  router.use(apiErrorMiddleware());
  return router;
}
