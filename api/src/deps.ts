/**
 * PF-015 / PF-016 — the composition root's dependency factories.
 *
 * `docs/architecture.md` ("Composition Root") makes one claim about this
 * codebase: `createApp()` is the only place production concretes are chosen.
 * That claim is what Dependency Inversion buys — `InProcessEventBus` and a
 * queue-backed bus, `InMemoryDeliverer` and an HTTP deliverer, `SystemClock` and
 * `FakeClock` are Liskov pairs, and swapping one for another is supposed to be a
 * composition-root edit and nothing else.
 *
 * A claim like that is only true if there is exactly one file to point at. This
 * is it. If you find yourself writing `new SystemClock()` or `new
 * InProcessEventBus()` anywhere under `platform/`, that is the bug — take the
 * dependency as a constructor argument and let this file decide.
 *
 *   productionDeps()  real clock, real database pool, in-process bus
 *   testDeps()        FakeClock, in-memory everything, no network, no wall clock
 *
 * `testDeps()` is deliberately in `src/` rather than `src/test/`: it is part of
 * the contract this module exports, and putting it behind the test-only
 * directory (which `api/tsconfig.json` excludes) would mean the shape of the
 * production and test wiring could drift without tsc noticing.
 */
import type { Request, Response, NextFunction } from 'express';
import { pool, type Database } from './db/client.js';
import {
  InProcessEventBus,
  RecordingEventBus,
  InMemoryDeliverer,
  InMemoryTokenBucket,
  SystemClock,
  FakeClock,
  PgOAuthAppRepo,
  InMemoryOAuthAppRepo,
  PgTokenRepo,
  InMemoryTokenRepo,
  PgAuthCodeRepo,
  InMemoryAuthCodeRepo,
  bearerTokenMiddleware,
  DEFAULT_TOKEN_TTL,
  type IEventBus,
  type IWebhookDeliverer,
  type IRateLimiter,
  type IOAuthAppRepo,
  type ITokenRepo,
  type IAuthCodeRepo,
  type BrowserUser,
  type TokenTtlConfig,
  type Clock,
} from './platform/index.js';
import { validateSessionForConnection } from './db/sessions.js';
import { InMemoryAuditSink, type IAuditSink } from './platform/audit/audit.js';
import { PgAuditSink } from './platform/audit/pgAuditSink.js';
import { ApiError } from './platform/api/v1/errors.js';

/**
 * PF-211 — the bearer middleware the public router mounts, until L06 ships one.
 *
 * It rejects everything, with `details.reason: 'missing'`. That is not a
 * placeholder that "does nothing": a public router whose auth layer is a no-op
 * would let every route L09 lands answer anonymously, and the failure would look
 * like working software. Failing closed means the day L09's first route mounts,
 * it is unreachable until L06 is wired — which is the correct dependency
 * direction and is visible immediately.
 *
 * L06 replaces this by passing `bearerAuth` into `createApp(deps)`. Nothing else
 * changes.
 */
export function rejectAllBearerAuth(_req: Request, _res: Response, next: NextFunction): void {
  next(
    new ApiError('unauthorized', 'Bearer token required.', { details: { reason: 'missing' } }),
  );
}

/**
 * Everything `createApp` is allowed to be told about the outside world.
 *
 * `corsOrigin` is here rather than as a positional parameter because it is the
 * same kind of thing as the rest: an environment-dependent value the app should
 * be handed, not one it should look up. It was `createApp(corsOrigin)` before
 * PF-014; folding it in is what lets the signature be `createApp(deps)` without
 * an overload that means "sometimes a string".
 */
export interface AppDeps {
  /** Domain writes publish here; the webhook pipeline subscribes. */
  bus: IEventBus;
  /** Courier for signed webhook POSTs. */
  deliverer: IWebhookDeliverer;
  /**
   * PF-304 — the per-APP ceiling. One bucket instance, keyed `app:<appId>`.
   *
   * Three separate instances rather than one shared one with three key
   * namespaces, and that is the ticket rather than a style choice: a shared
   * instance gives all three the same capacity and the same refill rate, which
   * makes "per-app AND per-token limits" (PRD p.4) one limit charged three
   * times. The whole point of the pair is that an app's ceiling is larger than
   * any single token's share of it, and that is only expressible as two
   * differently-configured buckets.
   */
  perAppLimiter: IRateLimiter;
  /** PF-304 — the per-TOKEN ceiling. Keyed `token:<tokenId>`. */
  perTokenLimiter: IRateLimiter;
  /**
   * PF-313 (option b) — the IP-keyed backstop, above bearer auth.
   *
   * What makes the p.6 target ("100% of public API responses carry rate-limit
   * headers") literally true rather than true-for-authenticated-responses: a
   * 401, a 404 and `/api/v1/openapi.json` never reach the two buckets above,
   * because bearer auth rejected them or they were mounted over it.
   */
  anonLimiter: IRateLimiter;
  /**
   * Finding F29 — the `/oauth/*` throttle, which no lane owned.
   *
   * `POST /oauth/token` presents credentials and met no limit at all: L11 was
   * scoped to `/api/v1`, L04's PF-107 asserts the internal `apiLimiter` does not
   * reach the OAuth router (a `/api/` prefix mount does not match `/oauth`), and
   * L05's PF-132 covers only the device grant's `user_code` guess space.
   *
   * A separate instance from `anonLimiter` because the two protect different
   * things at different rates: `/oauth` is a handful of calls per authorization,
   * `/api/v1` is an integration's entire traffic. Sharing one bucket would mean
   * a busy integration's API calls throttle its own token refresh.
   */
  oauthLimiter: IRateLimiter;
  /** The only source of "now" under platform/. */
  clock: Clock;
  /**
   * The database handle. `Database` (api/src/db/client.ts), not `pg.Pool` — it is
   * the pool wrapped in the connect-retry and circuit-breaker behaviour every
   * other caller in this repo already goes through, and handing the platform a
   * raw pool would quietly opt it out of that.
   */
  db: Database;
  /**
   * The `oauth_apps` registry (PF-037).
   *
   * A repository rather than the raw `db` handle, because L04, L05 and L06 all
   * resolve apps and none of them should be writing SQL against a table this
   * lane owns. It is a field on `AppDeps` rather than something `createApp`
   * constructs from `db` so that `testDeps()` can hand over the in-memory
   * double without a database at all.
   */
  appsRepo: IOAuthAppRepo;
  /**
   * The `oauth_tokens` store (PF-154).
   *
   * A repository for the same reason `appsRepo` is one: L04, L05 and L06's own
   * rotation all read and write tokens, and none of them should be writing SQL
   * against a table this lane owns. It is the `tokenRepo(db)` argument the
   * composition-root sketch at `docs/architecture.md:52`/`:59` already passes to
   * `bearerTokenMiddleware` and `oauthRouter`.
   */
  tokenRepo: ITokenRepo;
  /**
   * The `oauth_authorization_codes` store (L04 PF-086).
   *
   * A repository for the same reason `tokenRepo` is one. It is on `AppDeps`
   * rather than constructed inside `createApp` so `testDeps()` can hand over the
   * in-memory double and drive the whole authorize → consent → token flow with
   * no database at all.
   */
  authCodeRepo: IAuthCodeRepo;
  /**
   * L04 PF-094 / PF-098 — resolves the browser's `session_id` cookie to the
   * human sitting at the consent screen, or `null` for an anonymous visitor.
   *
   * A function on `AppDeps` rather than an import inside `platform/oauth/`,
   * because `eslint.config.js` fences `platform/**` out of `middleware/**` —
   * and rightly: the platform having its own opinion about session auth is
   * exactly the drift the public/internal split exists to prevent. Production
   * delegates to `validateSessionForConnection`, which already owns Ship's
   * 15-minute inactivity and 12-hour absolute timeout rules, so the consent
   * screen cannot disagree with the rest of the application about whether a
   * session is still alive.
   */
  resolveBrowserUser: (req: Request) => Promise<BrowserUser | null>;
  /**
   * Access and refresh TTLs (PF-157), injected rather than imported (PF-173).
   *
   * This is the seam L24's rotation drill consumes: PF-727 requires token expiry
   * to be produced "by configuring a short TTL at boot, never by waiting",
   * because PRD p.11 rules out `setTimeout` waits and p.9 sets the drill's flake
   * budget at zero over twenty runs. A test wiring boots with a 2-second access
   * TTL; production takes `DEFAULT_TOKEN_TTL`.
   *
   * On `AppDeps` rather than a mutable module-level binding on purpose: a test
   * that reassigns a module export leaks that value into every later test in the
   * file, and the leak looks like a flake rather than like a bug.
   */
  tokenTtl: TokenTtlConfig;
  /** Allowed browser origin for the internal `/api` surface. */
  corsOrigin: string;
  /**
   * Where every public API call is recorded (PRD p.4). L12 replaces the in-memory
   * sink with the Postgres one; the router does not know the difference.
   */
  auditSink: IAuditSink;
  /**
   * AuthN for `/api/v1`. Defaults to `rejectAllBearerAuth` — fail closed — until
   * L06 passes the real one. See that function for why the default is not a no-op.
   */
  bearerAuth: (req: Request, res: Response, next: NextFunction) => void;
}

/**
 * PF-309 — the public API's rate limits, chosen HERE and nowhere else.
 *
 * `platform/ratelimit/` contains no numbers at all; `TokenBucketOptions` has no
 * defaults, so a limit that is not chosen in this file does not compile. This is
 * the whole ticket: a constant inside the module that enforces a limit is a
 * limit nobody decided on, and it is the one a deployment cannot change.
 *
 * ── The numbers, and where each comes from ───────────────────────────────────
 *
 *   per-token   100/min. Parity with the internal limiter, which has run at 100
 *               requests/minute in production since Part 1. Starting the public
 *               surface at a number this codebase already survives is a defence;
 *               inventing a rounder one is not.
 *
 *   per-app     600/min, six times a single token. An app is not one integration
 *               — it is every install of that integration — so an app ceiling
 *               equal to a token ceiling would mean the second user of an app
 *               starves the first. Six is the smallest multiple that makes the
 *               two limits observably different behaviour (PF-304 proves both
 *               directions) while keeping the app ceiling well under the anon
 *               backstop below.
 *
 *   anonymous   1200/min per client IP. DELIBERATELY ABOVE the per-app ceiling.
 *               It is an abuse backstop for traffic that never reaches the two
 *               buckets above (PF-313), not a working limit, and it charges
 *               authenticated requests too — so setting it below the per-app
 *               number would mean a legitimate app behind one NAT is throttled
 *               by a limiter that exists for anonymous callers. The residual
 *               caveat is real and recorded in `platform/README.md`: a very
 *               large single-egress deployment can still meet it.
 *
 * Burst capacity equals the per-minute allowance in all three cases, which is
 * what a token bucket is for — an integration that fires ten calls at once and
 * then idles is normal traffic, not abuse.
 *
 * ── Environment ──────────────────────────────────────────────────────────────
 * Every number is overridable, so a deployment tunes limits without a release.
 * The names below are what L21's `variables.tf` must declare; at the time of
 * writing it declares none of them, which is recorded as a gap rather than
 * papered over — the defaults are the shipped behaviour until it does.
 */
const RATE_LIMIT_ENV = {
  perAppPerMinute: 'PUBLIC_RATE_LIMIT_APP_PER_MINUTE',
  perTokenPerMinute: 'PUBLIC_RATE_LIMIT_TOKEN_PER_MINUTE',
  anonPerMinute: 'PUBLIC_RATE_LIMIT_ANON_PER_MINUTE',
  oauthPerMinute: 'OAUTH_RATE_LIMIT_PER_MINUTE',
  maxKeys: 'PUBLIC_RATE_LIMIT_MAX_KEYS',
} as const;

/** Documented defaults. See the rationale above for where each number is from. */
const RATE_LIMIT_DEFAULTS = {
  perAppPerMinute: 600,
  perTokenPerMinute: 100,
  anonPerMinute: 1200,
  /**
   * Finding F29 — `/oauth/*` per client IP. 30/min.
   *
   * An order of magnitude below the API ceilings, because the traffic shape is
   * completely different: a real client hits `/oauth/token` once per
   * authorization and once per access-token expiry, so single digits per minute
   * is normal and thirty is generous. The number is small on purpose — it is
   * the only thing standing between a stolen `client_id` and an unbounded
   * `client_secret` guessing loop.
   */
  oauthPerMinute: 30,
  /**
   * PF-308 — how many buckets one limiter keeps before it sweeps.
   *
   * A memory bound, not a rate limit. Bucket keys are app ids and TOKEN ids, and
   * token ids rotate on every refresh (L06), so without a ceiling the map grows
   * for the life of the process. 100 000 keys at roughly 100 bytes of state each
   * is single-digit megabytes — high enough that a real deployment never sweeps
   * on the hot path, low enough that the map cannot become the leak.
   */
  maxKeys: 100_000,
} as const;

/**
 * Reads a positive-integer override, falling back to the documented default.
 *
 * A malformed or non-positive value falls back rather than throwing. A zero
 * capacity is a bucket that denies every request forever, and taking the whole
 * public API down because someone typed `PUBLIC_RATE_LIMIT_APP_PER_MINUTE=` is
 * the wrong failure for a tuning knob.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SECONDS_PER_MINUTE = 60;

/** Per-minute allowance → token-bucket options, with burst equal to the rate. */
function bucketOptionsPerMinute(perMinute: number, maxKeys: number) {
  return {
    capacity: perMinute,
    refillPerSecond: perMinute / SECONDS_PER_MINUTE,
    maxKeys,
  };
}

/**
 * The three configured limiters. Exported so PF-309's test can assert the env
 * names bind and that the module under `ratelimit/` carries none of these
 * numbers itself.
 */
export function publicRateLimiters(clock: Clock): {
  perAppLimiter: IRateLimiter;
  perTokenLimiter: IRateLimiter;
  anonLimiter: IRateLimiter;
  oauthLimiter: IRateLimiter;
} {
  const maxKeys = positiveIntEnv(RATE_LIMIT_ENV.maxKeys, RATE_LIMIT_DEFAULTS.maxKeys);
  return {
    perAppLimiter: new InMemoryTokenBucket(
      bucketOptionsPerMinute(
        positiveIntEnv(RATE_LIMIT_ENV.perAppPerMinute, RATE_LIMIT_DEFAULTS.perAppPerMinute),
        maxKeys,
      ),
      clock,
    ),
    perTokenLimiter: new InMemoryTokenBucket(
      bucketOptionsPerMinute(
        positiveIntEnv(RATE_LIMIT_ENV.perTokenPerMinute, RATE_LIMIT_DEFAULTS.perTokenPerMinute),
        maxKeys,
      ),
      clock,
    ),
    anonLimiter: new InMemoryTokenBucket(
      bucketOptionsPerMinute(
        positiveIntEnv(RATE_LIMIT_ENV.anonPerMinute, RATE_LIMIT_DEFAULTS.anonPerMinute),
        maxKeys,
      ),
      clock,
    ),
    // Finding F29. Its own instance, not a share of the anon bucket: a busy
    // integration's API traffic must not throttle its own token refresh.
    oauthLimiter: new InMemoryTokenBucket(
      bucketOptionsPerMinute(
        positiveIntEnv(RATE_LIMIT_ENV.oauthPerMinute, RATE_LIMIT_DEFAULTS.oauthPerMinute),
        maxKeys,
      ),
      clock,
    ),
  };
}

/** The env var names, for the L21 hand-off and for PF-309's assertion. */
export const PUBLIC_RATE_LIMIT_ENV_NAMES: readonly string[] = Object.values(RATE_LIMIT_ENV);

/**
 * The defaults, exported so a test can assert the shipped numbers rather than
 * re-typing them and asserting its own copy.
 */
export const PUBLIC_RATE_LIMIT_DEFAULTS = RATE_LIMIT_DEFAULTS;

/**
 * A tiny bucket for tests — small enough to exhaust in a couple of requests.
 *
 * PF-309 asks `testDeps()` to supply one, and this is why it cannot just be a
 * smaller number passed inline: a spec that wants a 429 should say "exhaust the
 * bucket", not restate the arithmetic that produces one.
 */
export const TEST_RATE_LIMIT_PER_MINUTE = 2;

/**
 * Production wiring. The only place a production concrete is named.
 *
 * Overrides exist for the deployment-shaped cases — a smoke test that wants the
 * real database but a fake clock, for instance — not as a general escape hatch.
 * Anything that needs to override three of these wants `testDeps()`.
 */
export function productionDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  // Hoisted so the limiter and everything else share ONE clock instance. PF-302
  // made the bucket's clock a required argument; handing it a second
  // `new SystemClock()` would compile and would quietly mean the process has two
  // notions of now.
  const clock = overrides.clock ?? new SystemClock();
  return {
    bus: new InProcessEventBus(),

    // TODO(L16): replace with the HTTP deliverer. `InMemoryDeliverer` is a test
    // double and does not belong in a production factory — it is here only
    // because L16 owns the concrete and nothing in `createApp` subscribes the
    // webhook pipeline yet, so today this object is constructed and never
    // called. Do not read this as "webhooks are in-memory in production".
    deliverer: new InMemoryDeliverer(),

    // PF-304 / PF-309 — three separately-configured buckets, all reading the
    // one hoisted clock.
    ...publicRateLimiters(clock),
    clock,
    db: pool,

    // PF-037: the ONLY construction site for the Postgres app repository.
    // A `new PgOAuthAppRepo(...)` anywhere else is the bug — the fitness test
    // in `oauth-app-repo.test.ts` fails on a second one.
    appsRepo: new PgOAuthAppRepo(pool),

    // PF-154: the ONLY construction site for the Postgres token repository.
    // `tokenRepo.test.ts` fails on a second one, exactly as PF-037's does for
    // the app repository.
    tokenRepo: new PgTokenRepo(pool),

    // L04 PF-086: the ONLY construction site for the Postgres auth-code
    // repository, on the same rule as the two above.
    authCodeRepo: new PgAuthCodeRepo(pool),

    // L04 PF-098. Two queries on a page that renders once per authorization:
    // the shared session validator (which owns the timeout rules and the
    // activity throttle), then the user's own row for the display label. The
    // label is cosmetic — the consent screen says who it thinks you are, which
    // is what stops a user approving a grant on an account they forgot they
    // were signed into.
    resolveBrowserUser: async (req) => {
      const sessionId = (req as Request & { cookies?: Record<string, string> }).cookies?.session_id;
      if (!sessionId) return null;
      const session = await validateSessionForConnection(sessionId);
      if (!session) return null;
      const who = await pool.query<{ email: string; name: string | null }>(
        'SELECT email, name FROM users WHERE id = $1',
        [session.userId],
      );
      const row = who.rows[0];
      return {
        userId: session.userId,
        workspaceId: session.workspaceId,
        ...(row ? { label: row.name ?? row.email } : {}),
      };
    },

    tokenTtl: DEFAULT_TOKEN_TTL,

    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

    // PF-339 — the Postgres sink, on migration 057 from L12's reserved block.
    // The ONLY construction site, on the same rule as the three repositories
    // above. Rows survive a restart, which is the whole point of an audit trail
    // whose job is to still be there at the Epic 7 defense.
    auditSink: new PgAuditSink(pool),

    // L06 PF-158 — the real bearer middleware, wired here because this is the
    // only file allowed to choose a concrete.
    //
    // Wired by L04, whose PF-108 gate reads "…→ usable access token" and cannot
    // demonstrate the last word against a middleware that rejects everything.
    // `rejectAllBearerAuth` remains exported and remains the `testDeps()`
    // default, so the fail-closed posture it was written for still holds
    // wherever a test has not opted in.
    bearerAuth: bearerTokenMiddleware({
      tokenRepo: overrides.tokenRepo ?? new PgTokenRepo(pool),
      appsRepo: overrides.appsRepo ?? new PgOAuthAppRepo(pool),
      clock: overrides.clock ?? new SystemClock(),
    }),
    ...overrides,
  };
}

/**
 * Test wiring — same shape, in-memory concretes, no network and no wall clock.
 *
 * The clock is a `FakeClock` so retry-ladder and rate-limit-window tests advance
 * time instead of waiting for it (PRD p.11). A `setTimeout` in a webhook test is
 * a flake with a longer feedback loop, and the flake target for the week is 0%
 * over 20 runs (p.9).
 *
 * `db` still defaults to the shared pool: `api/src/test/setup.ts` already points
 * `DATABASE_URL` at a throwaway database and truncates it, so the integration
 * suites want the real driver against a disposable database, not a fake. Pass
 * `{ db }` when a caller has provisioned its own (testcontainers, e2e workers).
 */
export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const clock = overrides.clock ?? new FakeClock();
  return {
    // L14 PF-402/PF-016 — the recording double, not the production bus.
    //
    // `RecordingEventBus` EXTENDS `InProcessEventBus`, so every dispatch
    // semantic a test observes is the production one; what it adds is an
    // `events` array. That matters for PF-412 and for L15/L16's suites, which
    // need to assert on the envelope a real write produced rather than on a log
    // line — and it means the substitution is free, since the shared contract
    // suite runs green against both (PF-401).
    bus: new RecordingEventBus(),
    deliverer: new InMemoryDeliverer(),
    // PF-309 — a TINY bucket, so a spec that wants a 429 can produce one in two
    // requests instead of a hundred. Deliberately not the production numbers:
    // a test that has to send 601 requests to observe the app ceiling is a test
    // nobody writes, and the limit then goes untested.
    ...(() => {
      const tiny = {
        capacity: TEST_RATE_LIMIT_PER_MINUTE,
        refillPerSecond: TEST_RATE_LIMIT_PER_MINUTE / 60,
        maxKeys: 1_000,
      };
      return {
        perAppLimiter: new InMemoryTokenBucket(tiny, clock),
        perTokenLimiter: new InMemoryTokenBucket(tiny, clock),
        // The anon backstop stays generous even in tests: it charges every
        // request, so a tiny one here would 429 the third call of every spec in
        // the repo for reasons that have nothing to do with what they assert.
        anonLimiter: new InMemoryTokenBucket(
          { capacity: 1_000_000, refillPerSecond: 1_000_000, maxKeys: 1_000 },
          clock,
        ),
        // Generous for the same reason as the anon bucket: it is keyed by IP,
        // which is one key for every request supertest makes, so a tight
        // default would 429 unrelated OAuth specs on their third request.
        oauthLimiter: new InMemoryTokenBucket(
          { capacity: 1_000_000, refillPerSecond: 1_000_000, maxKeys: 1_000 },
          clock,
        ),
      };
    })(),
    clock,
    db: pool,

    // PF-016/PF-037: the in-memory double, so a unit test can drive the app
    // registry with no database. Integration suites that want the real thing
    // pass `{ appsRepo: new PgOAuthAppRepo(db) }` alongside their own `db`.
    appsRepo: new InMemoryOAuthAppRepo(),

    // PF-016/PF-154: the in-memory double, so a unit test can drive token
    // issuance, resolution and rotation with no database at all. Integration
    // suites that want the real thing pass `{ tokenRepo: new PgTokenRepo(db) }`
    // alongside their own `db`.
    tokenRepo: new InMemoryTokenRepo(),

    // L04 PF-016/PF-086: the in-memory double, so a unit test can drive the
    // whole authorize -> consent -> token flow with no database at all.
    authCodeRepo: new InMemoryAuthCodeRepo(),

    // Nobody is signed in by default. A test that wants the consent screen to
    // render overrides this with a fixed user — which is also what keeps the
    // consent tests free of a session table, a cookie and a login round trip.
    resolveBrowserUser: async () => null,

    // Production TTLs by default. A drill that needs expiry without waiting
    // overrides this — `testDeps({ tokenTtl: { accessSeconds: 2, refreshSeconds: 5 } })`
    // — which is the whole point of PF-173.
    tokenTtl: DEFAULT_TOKEN_TTL,

    corsOrigin: 'http://localhost:5173',
    auditSink: new InMemoryAuditSink(),
    bearerAuth: rejectAllBearerAuth,
    ...overrides,
  };
}
