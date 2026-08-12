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
import { pool, type Database } from './db/client.js';
import {
  InProcessEventBus,
  InMemoryDeliverer,
  InMemoryTokenBucket,
  SystemClock,
  FakeClock,
  type IEventBus,
  type IWebhookDeliverer,
  type IRateLimiter,
  type Clock,
} from './platform/index.js';

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
  /** Allowed browser origin for the internal `/api` surface. */
  corsOrigin: string;
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
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
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
    corsOrigin: 'http://localhost:5173',
    ...overrides,
  };
}
