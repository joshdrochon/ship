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
import { createDocumentService } from './services/documents.js';
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
import { createAppsRouter } from './routes/apps.js';
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
import { createPublicRouter } from './platform/api/v1/router.js';
import { createOAuthRouter } from './platform/oauth/index.js';
// Finding F29 — the /oauth throttle. See the mount below.
import { oauthRateLimitMiddleware } from './platform/ratelimit/index.js';
import { assertEveryRouteDeclaresList } from './platform/api/v1/routeMetadata.js';
import { assertEveryRouteDeclaresScope } from './platform/api/v1/declareV1Route.js';
import { enumerateV1Routes } from './platform/api/v1/routeFitness.js';
import { documentsResources } from './platform/api/v1/documents/routes.js';
import { issuesResources } from './platform/api/v1/issues/routes.js';
import { meResources } from './platform/api/v1/me/routes.js';
import { mountAllResources } from './platform/api/v1/mountResources.js';
import { generatePublicOpenAPIDocumentOrDie } from './platform/openapi/registry.js';
import { mountOpenApiSpec } from './platform/openapi/route.js';

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
// L14: the TEST ceiling was 10000 and the suite had grown close enough to it to
// go intermittently red. `apiLimiter` is a MODULE-LEVEL const, so its bucket is
// shared by every `createApp()` in a worker process and accumulates across test
// FILES for the whole 60s window — it is one budget for the run, not per app and
// not per file. At ~1680 tests the suite was tipping over near the end, and the
// symptom is a 429 surfacing as an unrelated assertion failing in a DIFFERENT
// file on each run (observed in auth, files, openapi/route and
// internal-limiter-scope). Measured, not inferred: the full suite failed one
// random test on three consecutive runs at 10000 and passed 1682/1682 twice in a
// row with the ceiling raised.
//
// Raising the test-only default is safe because the one test that needs a low
// ceiling — `internal-limiter-scope.test.ts` (PF-214) — sets
// `API_RATE_LIMIT_MAX=1` itself before importing `createApp`. Production and dev
// are untouched.
const rateLimitMaxOverride = Number.parseInt(process.env.API_RATE_LIMIT_MAX ?? '', 10);
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number.isFinite(rateLimitMaxOverride) && rateLimitMaxOverride > 0
    ? rateLimitMaxOverride
    : isTestEnv ? 1_000_000 : isDevEnv ? 1000 : 100, // High limit for tests/dev
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
 * Two defects were noted here by PF-014 and left for this lane. BOTH ARE NOW
 * FIXED, by mount position alone — see the public-API block below:
 *
 *   F1  `app.use('/api/', apiLimiter)` prefix-matches onto `/api/v1/*`, so the
 *       internal limiter reached the public API and answered with the internal
 *       error shape. Fixed by PF-214: the public router is mounted above that
 *       line, so a v1 request never reaches it. The line itself is untouched and
 *       internal behaviour is unchanged.
 *   F2  `express.json({ limit: '10mb' })` ran app-wide, above every router, so a
 *       router-level `json({ limit: '1mb' })` under `/api/v1` was dead code.
 *       Fixed by PF-215: same mount position, so the public router's own 1 MB
 *       parser is the first to see a v1 body. Internal routes still get 10 MB.
 *
 * `internal-limiter-scope.test.ts` and `public-body-limit.test.ts` are what stop
 * either from silently regressing if this function is reordered again.
 */
export function createApp(deps: AppDeps = productionDeps()): express.Express {
  // ── ONE cookie parser and ONE session instance, named rather than inline ──
  //
  // L04 PF-094: `/oauth/authorize`'s consent screen needs the browser's session
  // and the csrf-sync synchroniser, but it is mounted ABOVE this block (as a
  // sibling of /api/v1, per PF-107). Constructing a SECOND `session()` there
  // would create a second MemoryStore, and the consent screen would silently not
  // see the user's login.
  //
  // So both are built once here and the same instances are handed to the OAuth
  // router and used by `app.use` below. Constructed per `createApp` call rather
  // than at module scope, so two apps in one test process still get separate
  // stores. The internal stack's layer ORDER and COUNT are unchanged — these two
  // lines replace inline construction with a named local and nothing else.
  const cookieMiddleware = cookieParser(sessionSecret);
  const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000, // 15 minutes
    },
  });

  // `deps.bus`, `deps.deliverer`, `deps.limiter`, `deps.clock` and `deps.db` are
  // not destructured yet because nothing below reads them — the routers that do
  // are L02–L16's. Destructuring them into unused locals now would be five lint
  // suppressions pretending to be wiring.
  //
  // `appsRepo` IS read: L02's `/api/apps` router takes it (PF-037/PF-039).
  const { corsOrigin, appsRepo } = deps;

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

  // ── THE PUBLIC API (PF-211, PF-214, PF-215) ────────────────────────────────
  //
  // Mount position is the whole ticket. Both of the defects noted in this
  // function's docstring — F1 and F2 — are fixed by mounting HERE and nowhere
  // else, and neither internal middleware below is changed at all.
  //
  //   F1 (PF-214). `app.use('/api/', apiLimiter)` is a PATH-PREFIX mount, so it
  //   matches `/api/v1/...` too. Confirmed by execution: a public route answered
  //   429 with `{ error: 'Too many requests. Please slow down.' }` — the internal
  //   body, `ratelimit-*` headers instead of the platform's `X-RateLimit-*`, and
  //   short-circuited ABOVE the public router, so no request_id, no envelope, no
  //   audit row. Mounting the public router above that line means a v1 request is
  //   answered before the internal limiter is ever consulted. The alternative was
  //   a `skip` predicate on `apiLimiter`; rejected because it changes the internal
  //   limiter's configuration to fix a public-API problem, and "internal /api is
  //   byte-for-byte what Part 1 shipped" is the one-way-door promise (p.11).
  //
  //   F2 (PF-215). `express.json({ limit: '10mb' })` below runs app-wide, so any
  //   router-level `json({ limit: '1mb' })` mounted BELOW it is dead code — the
  //   body is already parsed. Above it, the public router's own 1 MB parser is
  //   the first to see the body and the ceiling is real. Internal routes still
  //   get 10 MB, because they still reach the line below.
  //
  // What the public router deliberately sits BELOW: helmet, and only helmet —
  // security headers apply to every surface. What it deliberately sits ABOVE:
  // the internal limiter, the 10 MB parser, cookieParser, session, and CSRF.
  // That last group IS the internal security model, and PRD p.11 requires the
  // public router share none of it.
  //
  // It also sits above `cors`, which means /api/v1 serves NO CORS headers. That
  // is deliberate and it is a decision, not an oversight. The internal cors
  // config is `origin: <the Ship frontend>, credentials: true` — precisely wrong
  // for a public API, which has many origins and no cookies. Reusing it would
  // advertise one arbitrary origin; moving the public router below it would
  // reorder the INTERNAL stack (cors currently sits below the limiter) and break
  // the byte-for-byte promise for no benefit. A browser-based public consumer
  // needs its own CORS policy keyed on the registered app's origins; that is a
  // real ticket and it belongs with the developer portal, not here.
  //
  // Insertion point chosen so the internal stack's ORDER is untouched: every
  // internal layer keeps its relative position and exactly one layer is added.
  app.use('/api/v1', createPublicRouter({
    bearerAuth: deps.bearerAuth,
    // L11 PF-304 — TWO separately-configured bucket instances, not one instance
    // with two key namespaces. Namespacing alone would give per-app and
    // per-token the same capacity and the same refill rate, which makes PRD
    // p.4's "per-app AND per-token limits" one limit charged twice. The numbers
    // are chosen in `deps.ts` (PF-309).
    perAppLimiter: deps.perAppLimiter,
    perTokenLimiter: deps.perTokenLimiter,
    // L11 PF-313 — the IP-keyed backstop that sits above bearer auth, so a 401,
    // a 404 and the openapi.json route all carry rate-limit headers too.
    anonLimiter: deps.anonLimiter,
    auditSink: deps.auditSink,

    // L13 (PF-357, PF-365, PF-366) — the generated spec, served from INSIDE the
    // v1 router and ABOVE bearer auth.
    //
    // Generated HERE, once, during assembly. Three consequences, all deliberate:
    //
    //   - `generatePublicOpenAPIDocumentOrDie` THROWS on a generation failure, so
    //     `createApp()` throws and the entry point exits non-zero without ever
    //     opening a socket. Serving /api/v1 without its contract is the drift the
    //     parity test exists to prevent (docs/architecture.md, Failure Modes).
    //     **This is our decision, not the PRD's** — p.12 only requires the
    //     architecture document to answer the question. The defensible
    //     alternative is boot-and-serve-503 on the spec route alone.
    //   - Once, not per request. The document is derived entirely from
    //     module-load-time registrations and cannot change while the process
    //     lives, so per-request generation would be work with no possible
    //     different answer, on the endpoint most likely to be polled.
    //   - Inside the router, so the spec request carries a request_id and lands
    //     in the audit trail like every other public call. See the PF-367 note in
    //     platform/openapi/route.ts for what it does bypass (the rate limiter,
    //     and only that) and why that is accepted.
    mountUnauthenticated: mountOpenApiSpec(generatePublicOpenAPIDocumentOrDie()),

    // L09 built `documents` first, and that ordering was Build Strategy §4
    // (p.11) rather than an unfinished list: *"Get the generator working
    // end-to-end with one resource (documents) before adding issues, sprints,
    // and me."* That prerequisite is now met, so L10 adds `me` — and the proof
    // the pattern is generic is what this diff does NOT contain: zero lines
    // under `platform/openapi/` (PF-294 / L13's PF-363). The generator learned
    // about `/api/v1/me` from `declareV1Route`, the same call that records the
    // scope and builds the guard.
    //
    // `me` is MVP gate item 8's server half (p.2) and Testing Scenario 3's last
    // clause (p.5). `issues` landed with L10's slice S2; `sprints` is S3 and is
    // not here yet — see the lane report.
    //
    // Composed as an array rather than by nesting calls: each resource keeps its
    // own mount function and the composition root stays a list of what is
    // mounted, which is the thing a reader comes to this file to find out.
    mountResources: mountAllResources([
      documentsResources({ db: deps.db, bus: deps.bus }),
      issuesResources({ db: deps.db, bus: deps.bus }),
      meResources({ db: deps.db, appsRepo }),
    ]),
  }));

  // ── THE OAUTH SURFACE (L04 PF-107) ────────────────────────────────────────
  //
  // Mounted as a SIBLING of /api/v1, exactly as the composition-root sketch in
  // `docs/architecture.md` has it, and sharing NO middleware with the v1 stack:
  // no bearer auth (there is no token yet — that is the point of the endpoint),
  // no requireScope, no apiErrorMiddleware, no publicAuditMiddleware.
  //
  // Position, and what each side of it buys:
  //
  //   ABOVE `app.use('/api/', apiLimiter)`  — the internal limiter is a PATH
  //     PREFIX mount on `/api/`, which does not match `/oauth`. Asserted by path
  //     rather than assumed from the prefix (`oauthBoundary.test.ts`).
  //   ABOVE `express.urlencoded({ limit: '10mb' })` — so the OAuth router's own
  //     64 kb form limit is the first parser to see the body and is real code
  //     rather than dead code. Mounted below it, this would be finding F2 again.
  //   ABOVE the SPA fallback regex — which would otherwise serve index.html for
  //     `/oauth/authorize` on any deployment that has a `web/dist`.
  //   BELOW helmet — security headers apply to every surface. The OAuth router
  //     then sets `frame-ancestors`, `X-Frame-Options` and `no-store` itself,
  //     because helmet's configuration above sets none of the three (PF-096).
  //
  // THE CONSEQUENCE, STATED RATHER THAN LEFT TO BE FOUND: L12's audit middleware
  // lives inside the v1 router, so no `public_api_calls` row will ever record a
  // token exchange. That is exactly the gap L02's `recordSecretAuth` fills with
  // its own signal. If a later lane moves `/oauth` under `/api/v1`, the boundary
  // test fails — which is the intended trigger to revisit both.
  //
  // FINDING F29 — and it is fixed HERE, one line above the router.
  //
  // `/oauth/*` met no rate limit at all. Three separately true statements added
  // up to it: L11 was scoped to `/api/v1`; PF-107 (above) asserts the internal
  // `apiLimiter` does not reach this router, which is correct and is the reason
  // it does not; and L05's PF-132 throttles only the device grant's `user_code`
  // guess space. So `POST /oauth/token` — an endpoint whose whole job is to say
  // whether a `client_secret`, an authorization code or a refresh token is
  // right — answered an unbounded number of guesses per second.
  //
  // Mounted in the composition root rather than inside the OAuth router:
  // throttling is not one of that router's concerns, and this is the file that
  // already knows which `IRateLimiter` this deployment has. Above the router so
  // it runs before the body is parsed and before any credential is checked — a
  // limiter that only counts requests it has already done the work for has
  // already done the work.
  //
  // The 429 keeps the RFC 6749 error shape, NOT the ApiError envelope. See
  // platform/ratelimit/oauthThrottle.ts.
  app.use('/oauth', oauthRateLimitMiddleware(deps.oauthLimiter));

  app.use('/oauth', createOAuthRouter({
    appsRepo,
    tokenRepo: deps.tokenRepo,
    authCodeRepo: deps.authCodeRepo,
    // L05 PF-121/PF-122 — the device grant's store and the origin its
    // `verification_uri` is built from.
    deviceCodeRepo: deps.deviceCodeRepo,
    publicBaseUrl: deps.publicBaseUrl,
    clock: deps.clock,
    ttl: deps.tokenTtl,
    browser: {
      // The SAME instances used by the internal stack below. See the note at the
      // top of this function for why a second `session()` would be a bug.
      sessionMiddleware: [cookieMiddleware, sessionMiddleware],
      // The UNCONDITIONAL synchroniser, deliberately not `conditionalCsrf`:
      // that one skips CSRF on any Bearer header (L99 F26), and the consent
      // route refuses bearer outright rather than depending on that coupling.
      csrfProtection: csrfSynchronisedProtection,
      generateCsrfToken: (req) => generateToken(req),
      resolveBrowserUser: deps.resolveBrowserUser,
      loginPath: '/login',
    },
  }));

  // PF-228 — every mounted public route must carry a metadata record declaring
  // `list`. Enforced HERE, at wiring time, walking the live Express stack rather
  // than any hand-maintained list.
  //
  // The failure mode this prevents is not a crash, it is silence: Testing
  // Scenario 4 clause (d) asks "does this route paginate, if it is a list
  // endpoint", and a route with no declaration is a route the clause skips. One
  // undeclared route is one route the fitness harness reports as green without
  // having checked anything.
  assertEveryRouteDeclaresList(app, (a) => enumerateV1Routes(a));

  // PF-248 — and every mounted public route must declare its SCOPE on that same
  // record. MVP gate item 4 (p.2) asks for routes that "declare their required
  // scope via a require(scope) middleware factory"; this is the half that makes
  // "declare" checkable rather than a description of what the code happens to do.
  //
  // A route with `scope: null` passes — that is a claim the author made (L10's
  // `GET /api/v1/me`), and it is a different thing from never having thought
  // about scopes. See platform/scopes/route-metadata.ts.
  assertEveryRouteDeclaresScope(app, (a) => enumerateV1Routes(a));

  // Apply rate limiting to all API routes
  //
  // Still `/api/` and still prefix-matching — but `/api/v1` was fully handled
  // above, so this now reaches only the internal surface. `internal-limiter-
  // scope.test.ts` is what keeps that true, in both directions: it asserts a v1
  // caller never sees this limiter AND that an internal caller still does.
  app.use('/api/', apiLimiter);
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));
  app.use(express.json({ limit: '10mb' }));  // Large wiki documents can be several MB
  app.use(express.urlencoded({ extended: true, limit: '10mb' })); // For HTML form submissions
  app.use(cookieMiddleware);

  // Session middleware for CSRF token storage
  app.use(sessionMiddleware);

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
  // L14 PF-405 — the internal surface gets a bus-carrying document service, so
  // `document.created`/`document.deleted` fire for a document made through the
  // Ship UI exactly as they do for one made through `POST /api/v1/documents`.
  // `docs/architecture.md`'s "same service, same publish" was previously true
  // only of the public router; this is the line that makes it true of both.
  //
  // On `app.locals` rather than a module-level binding because tests construct
  // many apps in one process, and a module-level service would mean the last
  // app built silently owned every earlier app's events.
  app.locals.documentService = createDocumentService({ bus: deps.bus });
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

  // L02 PF-039/PF-046 — OAuth app CRUD on the INTERNAL session surface.
  //
  // Not `/api/v1`: p.2's actor is an admin with a session, you cannot register
  // your first app through an API that needs an OAuth token, and p.3's registry
  // has no scope that could gate this. Mounted inside `conditionalCsrf` like
  // every other session route; the router additionally refuses bearer auth
  // outright, so the `conditionalCsrf` bearer skip cannot bypass CSRF here.
  //
  // The router is constructed from `deps.appsRepo` rather than importing a
  // module-level singleton, which is what keeps `createApp(testDeps())` able to
  // drive it with the in-memory double.
  app.use('/api/apps', conditionalCsrf, createAppsRouter(appsRepo));

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
