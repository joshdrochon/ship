import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { csrfSync } from 'csrf-sync';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import issuesRoutes from './routes/issues.js';
import feedbackRoutes, { publicFeedbackRouter } from './routes/feedback.js';
import programsRoutes from './routes/programs.js';
import projectsRoutes from './routes/projects.js';
import weeksRoutes from './routes/weeks.js';
import standupsRoutes from './routes/standups.js';
import iterationsRoutes from './routes/iterations.js';
import teamRoutes from './routes/team.js';
import workspacesRoutes from './routes/workspaces.js';
import adminRoutes from './routes/admin.js';
import invitesRoutes from './routes/invites.js';
import setupRoutes from './routes/setup.js';
import backlinksRoutes from './routes/backlinks.js';
import { searchRouter } from './routes/search.js';
import { filesRouter } from './routes/files.js';
import caiaAuthRoutes from './routes/caia-auth.js';
import apiTokensRoutes from './routes/api-tokens.js';
import adminCredentialsRoutes from './routes/admin-credentials.js';
import claudeRoutes from './routes/claude.js';
import activityRoutes from './routes/activity.js';
import dashboardRoutes from './routes/dashboard.js';
import associationsRoutes from './routes/associations.js';
import accountabilityRoutes from './routes/accountability.js';
import aiRoutes from './routes/ai.js';
import weeklyPlansRoutes, { weeklyRetrosRouter } from './routes/weekly-plans.js';
import fleetgraphRoutes from './routes/fleetgraph/index.js';
import readyRoutes from './routes/ready.js';
import { documentCommentsRouter, commentsRouter } from './routes/comments.js';
import { setupSwagger } from './swagger.js';
import { initializeCAIA } from './services/caia.js';
import { productionDeps, type AppDeps } from './deps.js';

// Validate SESSION_SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required in production');
}

const sessionSecret = process.env.SESSION_SECRET || 'dev-only-secret-do-not-use-in-production';

// The git commit this build came from. Set by the Dockerfile (`ARG GIT_SHA` →
// `ENV GIT_SHA`), which CI passes as a --build-arg; see docs/artifact-lifecycle.md.
//
// Read once at module load, not per request: it cannot change while the process
// is alive, and a health check that Render polls every few seconds should not do
// work it does not have to.
//
// Falls back to 'unknown' rather than throwing or omitting the field. A missing
// key would make every consumer write `body.revision ?? '...'`; an explicit
// 'unknown' means "this build did not record a commit", which is the true and
// useful answer for `pnpm dev`, `docker build` with no --build-arg, and any
// artifact that did not come through CI. That last case is the point: a
// production /health reporting 'unknown' is itself the Rule 5 violation showing.
const revision = process.env.GIT_SHA || 'unknown';

// CSRF protection setup
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
});

// Conditional CSRF middleware - skip for API token auth (Bearer tokens are not vulnerable to CSRF)
import { Request, Response, NextFunction } from 'express';
const conditionalCsrf = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    // Skip CSRF for API token requests - Bearer tokens are not auto-attached by browsers
    return next();
  }
  // Apply CSRF protection for session-based auth
  return csrfSynchronisedProtection(req, res, next);
};

// Rate limiting configurations
// In test/dev environment, use much higher limits to avoid issues
// Production limits: login=5/15min (failed only), api=100/min
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.E2E_TEST === '1';
const isDevEnv = process.env.NODE_ENV !== 'production';

// Strict rate limit for login (5 failed attempts / 15 min) - brute force protection
// skipSuccessfulRequests: true means only failed attempts count toward the limit
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 1000 : 5, // High limit for tests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  skipSuccessfulRequests: true, // Only count failed login attempts
});

// General API rate limit (100 req/min in prod, 1000 in dev)
//
// API_RATE_LIMIT_MAX overrides the ceiling. This exists because the limit binds long
// before the process does -- at the default dev ceiling of 1000/min the server is
// throttled at 16.7 req/s, so a load generator measures the limiter rather than the
// endpoint and latency comes out flat across every concurrency level (audit W3-1/W3-3).
// Benchmarks must raise it identically on both sides of a before/after pair; see
// docs/audit/raw/cat3-lane3-*.md. It is deliberately opt-in: unset, behaviour is
// byte-for-byte what it was.
const rateLimitMaxOverride = Number.parseInt(process.env.API_RATE_LIMIT_MAX ?? '', 10);
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number.isFinite(rateLimitMaxOverride) && rateLimitMaxOverride > 0
    ? rateLimitMaxOverride
    : isTestEnv ? 10000 : isDevEnv ? 1000 : 100, // High limit for tests/dev
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});


/**
 * The composition root. PF-014.
 *
 * Signature changed from `createApp(corsOrigin: string)` to `createApp(deps)` so
 * that this stays the *only* file in the application that chooses a concrete
 * implementation — the claim `docs/architecture.md` makes and that Dependency
 * Inversion is worth nothing without. `productionDeps()` and `testDeps()` live
 * in `api/src/deps.ts`; see that file for what each one picks and why.
 *
 * Zero-argument callers are unaffected: the default is `productionDeps()`, which
 * reads `CORS_ORIGIN` from the environment exactly as the old default parameter
 * did. Callers that passed a CORS origin positionally now pass
 * `productionDeps({ corsOrigin })` — same value, one indirection, no overload
 * that means "sometimes a string".
 *
 * ── What this function deliberately does NOT do yet ────────────────────────────
 * Nothing below consumes `bus`, `deliverer`, `limiter` or `clock`. The public
 * router, the OAuth router and the webhook pipeline are L02–L16's work, and they
 * mount here when they exist. The seam is opened first, on purpose: PRD Build
 * Strategy §2 (p.10) is explicit that the boundary is cheaper to enforce than to
 * retrofit, and the same is true of the wiring it hangs on.
 *
 * ── Internal stack: unchanged, and pinned ─────────────────────────────────────
 * Every `app.use` below is in the same order it was in Part 1. That is not a
 * comment, it is asserted: `api/src/__tests__/internal-middleware-stack.test.ts`
 * compares the assembled 76-layer stack against a snapshot captured before this
 * refactor and pins `middleware/auth.ts` by content hash (PF-018). If the
 * internal stack changes, the +10% regression budget (p.2, p.6) is measuring two
 * different applications and means nothing.
 *
 * Two known defects are visible in this function and are deliberately NOT fixed
 * here, because fixing them changes internal behaviour and this refactor must
 * not:
 *
 *   F1  `app.use('/api/', apiLimiter)` prefix-matches onto `/api/v1/*`, so the
 *       internal limiter will reach the public API and answer with the internal
 *       error shape. Owned by L08/L11. Left exactly as it was — it is not made
 *       worse here, and the fix belongs with the router that has to serve the
 *       correct `X-RateLimit-*` headers.
 *   F2  `express.json({ limit: '10mb' })` runs app-wide, above every router, so
 *       a router-level `json({ limit: '1mb' })` under `/api/v1` is dead code —
 *       the body is already parsed by the time the public router sees it. The
 *       public router will have to mount its own parser *before* this one or
 *       accept the 10 MB ceiling. Owned by L08. Noted here so it is not
 *       rediscovered as a mystery.
 */
export function createApp(deps: AppDeps = productionDeps()): express.Express {
  // `deps.bus`, `deps.deliverer`, `deps.limiter`, `deps.clock` and `deps.db` are
  // not destructured yet because nothing below reads them — the routers that do
  // are L02–L16's. Destructuring them into unused locals now would be five lint
  // suppressions pretending to be wiring.
  const { corsOrigin } = deps;

  const app = express();

  // Trust proxy headers (CloudFront) for secure cookies and correct protocol detection
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);

    // CloudFront with viewer_protocol_policy="redirect-to-https" always serves viewers over HTTPS.
    // However, CloudFront -> EB uses HTTP (origin_protocol_policy="http-only"), so CloudFront
    // sets X-Forwarded-Proto to "http". Override it to "https" when request comes via CloudFront.
    app.use((req, _res, next) => {
      // CloudFront adds Via header like "2.0 <id>.cloudfront.net (CloudFront)"
      const viaHeader = req.headers['via'] as string;
      if (viaHeader && viaHeader.includes('cloudfront')) {
        req.headers['x-forwarded-proto'] = 'https';
      }
      next();
    });
  }

  // Middleware - Security headers
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },  // Allow images to be loaded cross-origin
    // Content Security Policy - prevents XSS attacks
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Admin credentials page uses inline scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // TipTap editor needs inline styles
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "ws:"], // WebSocket connections
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      }
    },
    // HTTP Strict Transport Security
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
  }));

  // Apply rate limiting to all API routes
  app.use('/api/', apiLimiter);
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));  // Large wiki documents can be several MB
  app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For HTML form submissions
  app.use(cookieParser(sessionSecret));

  // Session middleware for CSRF token storage
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes
    },
  }));

  // CSRF token endpoint (must be before CSRF protection middleware)
  app.get('/api/csrf-token', (req, res) => {
    res.json({ token: generateToken(req) });
  });

  // Health check (no CSRF needed).
  //
  // Two jobs, not one. Render polls it as the deploy gate
  // (health_check_path in terraform/render/main.tf), and it is the only way to
  // ask a *running* deployment which commit it is serving:
  //
  //   curl -s https://<host>/health   → {"status":"ok","revision":"<sha>"}
  //
  // Unauthenticated, deliberately, because it has to be reachable by Render's
  // prober before any session exists. The SHA is not a secret — the repository
  // it names is what controls access to the source.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', revision });
  });

  // Readiness probe (no auth, no CSRF), mounted next to /health and for the same
  // reason: a prober reaches it before any session exists.
  //
  // Separate from /health on purpose. /health is liveness and touches nothing, so
  // a database blip cannot restart every healthy container; /ready reaches the
  // dependencies and answers whether this process can serve a request. See
  // routes/ready.ts for what makes it 503 and what deliberately does not.
  app.use(readyRoutes);

  // API documentation (no auth needed)
  setupSwagger(app);

  // Setup routes (CSRF protected - first-time setup only)
  app.use('/api/setup', conditionalCsrf, setupRoutes);

  // Public feedback routes - no auth or CSRF required (must be before protected routes)
  app.use('/api/feedback', publicFeedbackRouter);

  // Apply stricter rate limiting to login endpoint (brute force protection)
  app.use('/api/auth/login', loginLimiter);

  // Apply CSRF protection to all state-changing API routes
  app.use('/api/auth', conditionalCsrf, authRoutes);
  app.use('/api/documents', conditionalCsrf, documentsRoutes);
  app.use('/api/documents', conditionalCsrf, backlinksRoutes);
  app.use('/api/documents', conditionalCsrf, associationsRoutes);
  app.use('/api/issues', conditionalCsrf, issuesRoutes);
  app.use('/api/feedback', conditionalCsrf, feedbackRoutes);
  app.use('/api/programs', conditionalCsrf, programsRoutes);
  app.use('/api/projects', conditionalCsrf, projectsRoutes);
  app.use('/api/weeks', conditionalCsrf, weeksRoutes);
  app.use('/api/weeks', conditionalCsrf, iterationsRoutes);
  app.use('/api/standups', conditionalCsrf, standupsRoutes);
  app.use('/api/team', conditionalCsrf, teamRoutes);
  app.use('/api/workspaces', conditionalCsrf, workspacesRoutes);
  app.use('/api/admin', conditionalCsrf, adminRoutes);
  app.use('/api/invites', conditionalCsrf, invitesRoutes);
  app.use('/api/api-tokens', conditionalCsrf, apiTokensRoutes);

  // Claude context routes - read-only GET endpoints for Claude skills
  app.use('/api/claude', claudeRoutes);

  // Search routes are read-only GET endpoints - no CSRF needed
  app.use('/api/search', searchRouter);

  // Activity routes are read-only GET endpoints - no CSRF needed
  app.use('/api/activity', activityRoutes);

  // Dashboard routes are read-only GET endpoints - no CSRF needed
  app.use('/api/dashboard', dashboardRoutes);

  // Accountability routes - inference-based action items (read-only GET)
  app.use('/api/accountability', accountabilityRoutes);

  // AI analysis routes - plan and retro quality feedback (CSRF protected)
  app.use('/api/ai', conditionalCsrf, aiRoutes);

  // Weekly plans routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-plans', conditionalCsrf, weeklyPlansRoutes);

  // Weekly retros routes - per-person accountability documents (CSRF protected)
  app.use('/api/weekly-retros', conditionalCsrf, weeklyRetrosRouter);

  // CAIA auth routes - no CSRF protection (OAuth flow with external callback)
  // This is the single identity provider for PIV authentication
  // Mount at both /caia and /piv paths - /piv/callback is registered with CAIA
  app.use('/api/auth/caia', caiaAuthRoutes);
  app.use('/api/auth/piv', caiaAuthRoutes);

  // Admin credentials management (CSRF protected, super-admin only)
  app.use('/api/admin/credentials', conditionalCsrf, adminCredentialsRoutes);

  // File upload routes (CSRF protected for POST endpoints)
  app.use('/api/files', conditionalCsrf, filesRouter);

  // FleetGraph routes — agent notifications, the approve path, and on-demand chat.
  // CSRF protected: five of the six are POSTs, and accept/dismiss/snooze resolve a
  // finding permanently. authMiddleware is applied inside the router, once, so a
  // seventh route cannot be added without it.
  app.use('/api/fleetgraph', conditionalCsrf, fleetgraphRoutes);

  // Comments routes
  app.use('/api/documents', conditionalCsrf, documentCommentsRouter);
  app.use('/api/comments', conditionalCsrf, commentsRouter);

  // Serve the built frontend from the same origin as the API, when it is present.
  //
  // On AWS the frontend is a separate S3/CloudFront deployment, so this directory
  // does not exist and the block is skipped — behaviour there is unchanged.
  //
  // Same-origin is not a convenience here, it is required: the session cookie is
  // sameSite:'strict' (see above), so a frontend served from a different domain
  // could never send it and login would fail silently.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1y' }));

    // SPA fallback — client-side routes like /docs/:id have no file on disk.
    // Anything under /api, /health, /ready or /collaboration has already been
    // handled above; this must not swallow them.
    //
    // /ready is in the lookahead even though route order already covers the GET.
    // A probe that misspells the method, or a future reorder, would otherwise get
    // index.html with a 200 — a readiness probe that reports healthy by serving
    // the frontend is the worst possible failure of a readiness probe.
    app.get(/^\/(?!api\/|health$|ready$|collaboration\/).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'));
    });
    console.log(`Serving frontend from ${webDist}`);
  }

  // Initialize CAIA OAuth client at startup
  initializeCAIA().catch((err) => {
    console.warn('CAIA initialization failed:', err);
  });

  return app;
}
