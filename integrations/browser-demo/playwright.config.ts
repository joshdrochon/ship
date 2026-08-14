/**
 * A Playwright project scoped to THIS package.
 *
 * Deliberately separate from the repo-root `playwright.config.ts`, for three
 * reasons and none of them are taste:
 *
 *   1. The root config's `testDir` is `./e2e` and its suite is ~600 tests. Ship's
 *      own CLAUDE.md forbids running it directly. A six-test MVP-gate proof must
 *      be runnable in seconds, on its own, by a human who wants to see the flow.
 *   2. `retries: process.env.CI ? 2 : 1` at the root. L99 F27 records what a
 *      retry does to a graded drill: it converts a flake into a pass. This
 *      config sets `retries: 0` — if the PKCE round trip is not deterministic,
 *      the honest outcome is red.
 *   3. The root suite provisions per-worker testcontainers. This one runs
 *      against the lane database with a real `pnpm db:seed` behind it, because
 *      what it proves is that a REAL Ship, booted the way production boots,
 *      completes the flow.
 *
 * Run it with:
 *   pnpm --filter @ship/browser-demo exec playwright test -c playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.DEMO_API_PORT ?? 3124);
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 4173);

export const SHIP_BASE_URL = `http://localhost:${API_PORT}`;
export const DEMO_BASE_URL = `http://localhost:${DEMO_PORT}`;

/**
 * The lane database. `ship_l24` is L24's and L24's alone — every api test file
 * TRUNCATEs, so sharing one would mean two lanes destroying each other's data.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://ship:ship_dev_password@localhost:5432/ship_l24';

export default defineConfig({
  testDir: './tests',
  // ONLY `*.spec.ts`. Playwright's default `testMatch` also picks up
  // `*.test.ts`, which is what the vitest suite in this same directory is
  // named — loading it here makes `@vitest/expect` and Playwright's expect
  // fight over the same global symbol and the run dies with
  // "Cannot redefine property: Symbol($$jest-matchers-object)" before a single
  // test starts. Two runners, one directory, two disjoint globs.
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // See (2) above. A drill that can be retried into green proves nothing.
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: DEMO_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  // Registers the PUBLIC OAuth app. Lives outside `integrations/` on purpose —
  // see the header of that file (PF-722).
  globalSetup: '../../scripts/l24-browser-demo-setup.ts',

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // A real Ship, booted from its real entry point. Not a hand-assembled
      // Express app: PF-734's claim is about the shipped server, and an app
      // wired by the test is an app whose wiring the test cannot vouch for.
      command: 'pnpm --filter @ship/api exec tsx src/index.ts',
      url: `${SHIP_BASE_URL}/health`,
      cwd: '../..',
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL,
        NODE_ENV: 'development',
        // Ship's own escape hatch (`api/src/app.ts` — `isTestEnv`). It raises
        // the LOGIN limiter's ceiling from 5-failures-per-15-minutes, which six
        // sequential sign-ins would otherwise trip, and it changes nothing else
        // about the server. Without it the suite's later tests fail with 429 —
        // a failure about the harness, not about PKCE.
        E2E_TEST: '1',
        // The demo's origin is NOT Ship's origin, and that is the point: a
        // registered web app is a third party. `CORS_ORIGIN` here is the
        // INTERNAL policy's origin and is irrelevant to `/api/v1` — the public
        // surface has its own policy (`platform/publicCors.ts`, L99 F38).
        CORS_ORIGIN: DEMO_BASE_URL,
        PUBLIC_BASE_URL: SHIP_BASE_URL,
      },
    },
    {
      // Build, then serve STATIC FILES. `vite preview` is a static file server
      // with no proxy configured (see vite.config.ts) — PF-733's "no server
      // process of its own beyond a static file server".
      command: 'pnpm exec vite build && pnpm exec vite preview --port ' + DEMO_PORT,
      url: DEMO_BASE_URL,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      env: {
        VITE_SHIP_BASE_URL: SHIP_BASE_URL,
        VITE_SHIP_CLIENT_ID: 'ship_demo_browser_pkce',
        VITE_REDIRECT_URI: `${DEMO_BASE_URL}/`,
        VITE_SHIP_SCOPES: 'documents:read',
      },
    },
  ],
});
