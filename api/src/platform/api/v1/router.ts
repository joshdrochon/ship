/**
 * createPublicRouter — the ONLY public surface. A FRESH router: it shares no
 * middleware with internal /api (sessions+CSRF and bearer tokens are different
 * security models; the ESLint boundary rule enforces the import side).
 *
 * Middleware order (each concern separate — see architecture.md):
 *   requestId → bearer auth (401) → [per-route] requireScope (403) →
 *   rate limit (429 + headers) → audit → handler → apiErrorMiddleware
 */
import { Router, json } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { apiErrorMiddleware, requestIdMiddleware, ApiError } from './errors.js';
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
}

export function createPublicRouter(deps: PublicRouterDeps): Router {
  const router = Router();

  router.use(requestIdMiddleware());
  router.use(json({ limit: '1mb' })); // public payloads are small; internal 10mb limit does not apply
  router.use(deps.bearerAuth);
  router.use(rateLimitMiddleware(deps.perAppLimiter, deps.perTokenLimiter));
  router.use(publicAuditMiddleware(deps.auditSink));

  // ── resources ──────────────────────────────────────────────────────────
  // TODO(josh) E2: GET /me (SDK-skeleton gate: new ShipClient({token}).me())
  // TODO(josh) E2: /documents — GET list (cursor), GET :id, POST (scoped)
  // TODO(josh) E4: /webhooks/subscriptions CRUD + /webhooks/deliveries/:id/replay
  // TODO(josh) E3: GET /openapi.json (mounted in app.ts via serveGeneratedSpec)

  // Unknown /api/v1 path → ApiError envelope, not Express's HTML 404.
  router.use((req: Request, _res: Response, next: NextFunction) => {
    next(new ApiError('not_found', `No such endpoint: ${req.method} ${req.path}`));
  });

  router.use(apiErrorMiddleware());
  return router;
}
