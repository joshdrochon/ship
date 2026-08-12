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
  InMemoryDeliverer,
  InMemoryTokenBucket,
  SystemClock,
  FakeClock,
  PgOAuthAppRepo,
  InMemoryOAuthAppRepo,
  PgTokenRepo,
  InMemoryTokenRepo,
  DEFAULT_TOKEN_TTL,
  type IEventBus,
  type IWebhookDeliverer,
  type IRateLimiter,
  type IOAuthAppRepo,
  type ITokenRepo,
  type TokenTtlConfig,
  type Clock,
} from './platform/index.js';
import { InMemoryAuditSink, type IAuditSink } from './platform/audit/audit.js';
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
  /** Public API token bucket (per-app and per-token keys). */
  limiter: IRateLimiter;
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
 * Rate-limit ceiling for the public API.
 *
 * Derived, not invented: the internal limiter in `app.ts` has run at 100
 * requests/minute in production since Part 1, so the public surface starts at
 * parity rather than at a number nobody can defend. Burst capacity equals the
 * per-minute allowance, which is what a token bucket is for — an integration
 * that fires ten calls at once and then idles is normal traffic, not abuse.
 *
 * L11 owns the real numbers and the `X-RateLimit-*` contract (PRD p.6). When it
 * lands, this constant moves into its config and this comment goes away.
 */
const PUBLIC_RATE_LIMIT_PER_MINUTE = 100;

/**
 * Production wiring. The only place a production concrete is named.
 *
 * Overrides exist for the deployment-shaped cases — a smoke test that wants the
 * real database but a fake clock, for instance — not as a general escape hatch.
 * Anything that needs to override three of these wants `testDeps()`.
 */
export function productionDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    bus: new InProcessEventBus(),

    // TODO(L16): replace with the HTTP deliverer. `InMemoryDeliverer` is a test
    // double and does not belong in a production factory — it is here only
    // because L16 owns the concrete and nothing in `createApp` subscribes the
    // webhook pipeline yet, so today this object is constructed and never
    // called. Do not read this as "webhooks are in-memory in production".
    deliverer: new InMemoryDeliverer(),

    limiter: new InMemoryTokenBucket({
      capacity: PUBLIC_RATE_LIMIT_PER_MINUTE,
      refillPerSecond: PUBLIC_RATE_LIMIT_PER_MINUTE / 60,
    }),
    clock: new SystemClock(),
    db: pool,

    // PF-037: the ONLY construction site for the Postgres app repository.
    // A `new PgOAuthAppRepo(...)` anywhere else is the bug — the fitness test
    // in `oauth-app-repo.test.ts` fails on a second one.
    appsRepo: new PgOAuthAppRepo(pool),

    // PF-154: the ONLY construction site for the Postgres token repository.
    // `tokenRepo.test.ts` fails on a second one, exactly as PF-037's does for
    // the app repository.
    tokenRepo: new PgTokenRepo(pool),

    tokenTtl: DEFAULT_TOKEN_TTL,

    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

    // TODO(L12): the Postgres sink, from migration block 057–059. In-memory here
    // means audit rows do not survive a restart — acceptable only because no
    // public route is reachable yet (bearerAuth below rejects everything).
    auditSink: new InMemoryAuditSink(),

    // TODO(L06): the real bearer middleware. Fails closed until then.
    bearerAuth: rejectAllBearerAuth,
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
  return {
    bus: new InProcessEventBus(),
    deliverer: new InMemoryDeliverer(),
    limiter: new InMemoryTokenBucket({
      capacity: PUBLIC_RATE_LIMIT_PER_MINUTE,
      refillPerSecond: PUBLIC_RATE_LIMIT_PER_MINUTE / 60,
    }),
    clock: new FakeClock(),
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
