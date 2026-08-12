/**
 * Test wiring for the public router — one builder, shared by every lane.
 *
 * Lives in `src/` rather than `src/test/` for the same reason `testDeps()` does
 * (see `api/src/deps.ts`): it is part of the contract this module exports, and
 * `api/tsconfig.json` excludes `src/test/**`, so hiding it there would let the
 * test wiring and the production wiring drift without `tsc` noticing.
 *
 * L03, L08 and L13 should build their route tests on `createTestPublicApp`
 * rather than assembling their own Express app. An app assembled by hand is an
 * app with a different middleware order, and middleware order is most of what
 * this lane's assertions are actually about.
 */
import express, { type Express, type Router, type Request, type Response, type NextFunction } from 'express';
import { createPublicRouter } from './router.js';
import { InMemoryAuditSink } from '../../audit/audit.js';
import { InMemoryTokenBucket } from '../../ratelimit/limiter.js';
import type { IRateLimiter } from '../../ratelimit/limiter.js';
import type { PlatformAuthContext, Scope } from '../../scopes/registry.js';

/** Where the public router is mounted. The prefix the enumerator reports under. */
export const V1_PREFIX = '/api/v1';

export interface TestPublicAppOptions {
  /**
   * The auth context bearer auth should attach, or `null` for an
   * unauthenticated caller (which the stub turns into the same 401 the real
   * bearer middleware produces).
   */
  auth?: PlatformAuthContext | null;
  /** Scopes granted to the default auth context. Ignored when `auth` is given. */
  scopes?: Scope[];
  /** Resource routes under test. Mounted above the catch-all, via the router hook. */
  mountResources?: (router: Router) => void;
  /** Override the rate limiters — e.g. a capacity-1 bucket to produce a 429. */
  perAppLimiter?: IRateLimiter;
  perTokenLimiter?: IRateLimiter;
  /** Routes mounted ABOVE bearer auth (PF-216). Paths must be in V1_UNAUTHENTICATED_PATHS. */
  mountUnauthenticated?: (router: Router) => void;
  /**
   * Body-parser ceiling for the app-wide parser mounted BELOW the v1 router.
   *
   * Present so a test can reproduce the production layering — in `createApp` the
   * public router is above `express.json({limit:'10mb'})`, and PF-215 is only
   * meaningful against a stack that has both parsers in the real order.
   */
  appWideBodyLimit?: string;
}

/** A believable authenticated caller. */
export function fakeAuthContext(scopes: Scope[] = []): PlatformAuthContext {
  return {
    appId: 'app_test',
    clientId: 'client_test',
    userId: 'user_test',
    scopes,
    tokenId: 'token_test',
  };
}

export interface TestPublicApp {
  app: Express;
  /** The audit sink the router wrote to — PF-193 asserts against `.records`. */
  auditSink: InMemoryAuditSink;
}

/**
 * Builds an Express app with the public router mounted at `/api/v1`.
 *
 * The bearer-auth stub deliberately fails the same way the real one will: by
 * calling `next(ApiError('unauthorized'))` rather than by writing a response
 * itself. That is what makes an unauthenticated request in these tests exercise
 * the error middleware, which is the path MVP gate item 5 is actually about.
 */
export function createTestPublicApp(options: TestPublicAppOptions = {}): TestPublicApp {
  const auditSink = new InMemoryAuditSink();
  const auth = options.auth === undefined ? fakeAuthContext(options.scopes ?? []) : options.auth;

  const bearerAuth = (_req: Request, res: Response, next: NextFunction): void => {
    if (auth) res.locals.platformAuth = auth;
    next();
  };

  const generousBucket = (): IRateLimiter =>
    new InMemoryTokenBucket({ capacity: 1_000_000, refillPerSecond: 1_000_000 });

  const app = express();
  app.use(
    V1_PREFIX,
    createPublicRouter({
      bearerAuth,
      perAppLimiter: options.perAppLimiter ?? generousBucket(),
      perTokenLimiter: options.perTokenLimiter ?? generousBucket(),
      auditSink,
      ...(options.mountUnauthenticated
        ? { mountUnauthenticated: options.mountUnauthenticated }
        : {}),
      ...(options.mountResources ? { mountResources: options.mountResources } : {}),
    }),
  );

  // The app-wide parser goes BELOW the v1 router, mirroring `createApp` after
  // PF-215. Opt-in rather than always-on so the several dozen existing specs
  // that build a bare v1 app keep exactly the stack they were written against.
  if (options.appWideBodyLimit) {
    app.use(express.json({ limit: options.appWideBodyLimit }));
  }

  return { app, auditSink };
}
