/**
 * Isolated E2E Test Environment
 *
 * Each Playwright worker gets its own:
 * - PostgreSQL container (via testcontainers)
 * - API server instance (dynamic port)
 * - Vite preview server (dynamic port, lightweight static server)
 *
 * CRITICAL: We use `vite preview` instead of `vite dev` because:
 * - vite dev starts HMR, file watchers, and uses 300-500MB per instance
 * - vite preview is a lightweight static server using ~30-50MB
 * - Running 8 vite dev servers caused 90GB memory explosion and system crash
 *
 * This eliminates flakiness from shared database state.
 */

import { test as base } from '@playwright/test';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { spawn, ChildProcess } from 'child_process';
import { Pool } from 'pg';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import getPort, { portNumbers } from 'get-port';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import os from 'os';
import { startMockBedrock, type MockBedrock } from './mock-bedrock';

/**
 * Get port for a worker with collision avoidance.
 *
 * Each worker gets its own port range to avoid race conditions when
 * multiple workers call getPort() simultaneously. Uses a base port of 50000
 * with 100-port ranges per worker:
 * - Worker 0: 50000-50099
 * - Worker 1: 50100-50199
 * - etc.
 */
async function getWorkerPort(workerIndex: number): Promise<number> {
  const BASE_PORT = 10000;
  const MAX_PORT = 65535;
  const PORTS_PER_WORKER = 100;
  const AVAILABLE_RANGE = MAX_PORT - BASE_PORT; // 55535 ports available
  const MAX_WORKERS = Math.floor(AVAILABLE_RANGE / PORTS_PER_WORKER); // 555 workers max

  // Wrap worker index to stay within valid port range
  const wrappedIndex = workerIndex % MAX_WORKERS;
  const startPort = BASE_PORT + wrappedIndex * PORTS_PER_WORKER;
  const endPort = Math.min(startPort + PORTS_PER_WORKER - 1, MAX_PORT);

  return getPort({ port: portNumbers(startPort, endPort) });
}

// Get project root (fixtures is at e2e/fixtures/, so go up 2 levels)
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Get available system memory in GB.
 * Used to warn if running too many workers.
 */
function getAvailableMemoryGB(): number {
  const freeMem = os.freemem();
  return freeMem / (1024 * 1024 * 1024);
}

/**
 * Calculate safe number of workers based on available memory.
 * Each worker needs roughly: 150MB (Postgres) + 100MB (API) + 50MB (preview) = ~300MB minimum
 * Add buffer for tests, browser, etc = ~500MB per worker safe estimate
 */
function getSafeWorkerCount(): number {
  const availableGB = getAvailableMemoryGB();
  const memPerWorker = 0.5; // 500MB per worker
  const reserveGB = 2; // Keep 2GB free for OS and other processes
  const safeCount = Math.max(1, Math.floor((availableGB - reserveGB) / memPerWorker));
  return Math.min(safeCount, 8); // Cap at 8 regardless
}

// Only warn if memory is critically low (config handles worker calculation)
const availableMem = getAvailableMemoryGB();
if (availableMem < 4) {
  console.warn(`⚠️  Low memory (${availableMem.toFixed(1)}GB). Consider reducing workers.`);
}

/**
 * Build a child-process environment with every ambient third-party credential removed.
 *
 * Implementation Rule 3 (stable fakes, not live external calls). Two processes spawn
 * from this fixture and both make outbound model calls: the API
 * (`api/src/services/ai-analysis.ts` → Bedrock InvokeModel) and, from
 * `e2e/fleetgraph-agent.spec.ts`, the FleetGraph cron (`agent/src/llm/client.ts` →
 * Bedrock Converse, plus LangSmith tracing). Both go through here.
 *
 * This fixture used to spread `process.env` straight into the child, so a developer with
 * `AWS_ACCESS_KEY_ID`/`AWS_PROFILE` exported — or a CI runner with an instance role —
 * gave the API under test working credentials and `e2e/ai-analysis-api.spec.ts` made
 * real, billed InvokeModel calls against `bedrock-runtime.us-east-1.amazonaws.com`.
 *
 * Two independent guards, because either one alone can be defeated:
 *
 *  1. Every `AWS_*` variable is dropped, then only dummy values are put back. That
 *     removes exported keys, `AWS_PROFILE`, `AWS_SESSION_TOKEN`,
 *     `AWS_CONTAINER_CREDENTIALS_*`, `AWS_WEB_IDENTITY_TOKEN_FILE` and
 *     `AWS_ENDPOINT_URL*` in one sweep, rather than listing names that will drift.
 *     `AWS_SHARED_CREDENTIALS_FILE`/`AWS_CONFIG_FILE` point at /dev/null so the SDK
 *     cannot fall back to `~/.aws`, and IMDS lookups are disabled so it cannot fall
 *     back to an instance role.
 *  2. `BEDROCK_ENDPOINT` points at the in-process mock, so even if a credential did
 *     survive, the request goes to loopback and never leaves the machine.
 *
 * Note that the dummy credentials are required, not belt-and-braces: the SDK still
 * SigV4-signs requests to an overridden endpoint and throws
 * `CredentialsProviderError` if it cannot resolve any. The mock ignores the signature.
 *
 * ── LANGCHAIN_* / LANGSMITH_* go too, and for the same reason ────────────────────
 * `agent/src/observability/tracing.ts` configures nothing — LangChain reads the
 * environment itself, so `LANGCHAIN_TRACING_V2=true` plus a key on a developer's
 * machine would upload every E2E graph run to a real LangSmith project. Same class of
 * failure as the billed Bedrock calls above (unintended live traffic from a test run),
 * so it is closed the same way: sweep the prefix rather than name the variables.
 */
export function sandboxedChildEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (name.startsWith('AWS_')) continue;
    if (name.startsWith('LANGCHAIN_') || name.startsWith('LANGSMITH_')) continue;
    env[key] = value;
  }

  return {
    ...env,
    AWS_ACCESS_KEY_ID: 'e2e-mock-access-key',
    AWS_SECRET_ACCESS_KEY: 'e2e-mock-secret-key',
    AWS_REGION: 'us-east-1',
    AWS_DEFAULT_REGION: 'us-east-1',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_CONFIG_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true',
    ...extra,
  };
}

/**
 * All a worker needs from its database is a connection string.
 *
 * Locally that comes from a testcontainers Postgres. In CI it comes from a plain
 * service container, because testcontainers needs a Docker daemon and reaching one
 * from inside a CI job means docker-in-docker, which means a runner willing to grant
 * privileged mode. Depending on that made the E2E gate a property of how one machine
 * happens to be configured rather than a property of the commit.
 *
 * Set `E2E_DATABASE_URL` to a server the job can reach and each worker gets its own
 * database on it. Leave it unset and nothing changes: testcontainers as before.
 */
type TestDatabase = { getConnectionUri: () => string };

// Types for our worker-scoped fixtures
type WorkerFixtures = {
  dbContainer: TestDatabase;
  bedrockMock: MockBedrock;
  apiServer: { url: string; process: ChildProcess };
  webServer: { url: string; process: ChildProcess };
  /** Resets the database to freshly-seeded state when the spec file changes. */
  resetDatabaseForFile: (specFile: string) => Promise<void>;
};

// Extend the base test with our isolated environment
// Worker fixtures are accessible in tests but live at worker scope
export const test = base.extend<
  {
    apiServer: { url: string; process: ChildProcess };
    /** Auto fixture; no test references it directly. See `freshState` below. */
    freshState: void;
  },
  WorkerFixtures
>({
  // Override context to disable action items modal for ALL pages (including multi-page tests)
  context: async ({ context }, use) => {
    // Set localStorage flag to disable action items modal before any navigation
    // This applies to all pages created from this context
    await context.addInitScript(() => {
      localStorage.setItem('ship:disableActionItemsModal', 'true');
    });
    await use(context);
  },

  // PostgreSQL container - one per worker, starts fresh for each test run
  // CRITICAL: Use try-finally to ensure container cleanup even on errors
  dbContainer: [
    async ({}, use, workerInfo) => {
      const workerTag = `[Worker ${workerInfo.workerIndex}]`;
      const debug = process.env.DEBUG === '1';

      // CI path: a Postgres the job can already reach, one database per worker.
      //
      // Isolation is what matters here, not who owns the server. Testcontainers gives a
      // whole instance per worker; a named database per worker gives the same guarantee
      // that no two workers share tables, which is the property every fixture below
      // relies on. `DROP ... IF EXISTS` first so a re-run on a reused service container
      // starts from nothing rather than inheriting the previous run's rows.
      //
      // The name is derived from the worker index, so it is stable and collision-free
      // without coordination between workers.
      const external = process.env.E2E_DATABASE_URL;
      if (external) {
        const dbName = `ship_e2e_w${workerInfo.workerIndex}`;
        if (debug) console.log(`${workerTag} Using external Postgres, database ${dbName}`);

        const admin = new Pool({ connectionString: external });
        try {
          // Identifier, not a value — it cannot be parameterised, so it is built from
          // the worker index alone and never from anything caller-supplied.
          await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
          await admin.query(`CREATE DATABASE ${dbName}`);
        } finally {
          await admin.end();
        }

        const url = new URL(external);
        url.pathname = `/${dbName}`;
        const dbUrl = url.toString();

        await runMigrations(dbUrl);
        if (debug) console.log(`${workerTag} Migrations complete`);

        // Deliberately not dropped on teardown. The server is a throwaway service
        // container in CI, and dropping while the API child process still holds a
        // connection fails noisily for no benefit.
        await use({ getConnectionUri: () => dbUrl });
        return;
      }

      if (debug) console.log(`${workerTag} Starting PostgreSQL container...`);

      // Retry container startup to handle intermittent Docker port binding failures
      // Under parallel load, Docker's port allocation can get congested
      let container!: StartedPostgreSqlContainer;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          container = await new PostgreSqlContainer('postgres:15')
            .withDatabase('ship_test')
            .withUsername('test')
            .withPassword('test')
            .withStartupTimeout(120000)
            .start();
          break;
        } catch (err) {
          if (debug) console.log(`${workerTag} Container start attempt ${attempt} failed: ${(err as Error).message}`);
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }

      try {
        const dbUrl = container.getConnectionUri();
        if (debug) console.log(`${workerTag} PostgreSQL ready on port ${container.getMappedPort(5432)}`);

        // Run schema and migrations
        if (debug) console.log(`${workerTag} Running migrations...`);
        await runMigrations(dbUrl);
        if (debug) console.log(`${workerTag} Migrations complete`);

        await use(container);
      } finally {
        if (debug) console.log(`${workerTag} Stopping PostgreSQL container...`);
        await container.stop();
      }
    },
    { scope: 'worker' },
  ],

  // Mock AWS Bedrock - one per worker, on its own ephemeral loopback port.
  // Rule 3: the AI analysis paths must be exercised against a stable fake, never
  // against the real (billed) service. See apiChildEnv above and mock-bedrock.ts.
  bedrockMock: [
    async ({}, use) => {
      const mock = await startMockBedrock();
      try {
        await use(mock);
      } finally {
        await mock.close();
      }
    },
    { scope: 'worker' },
  ],

  // API server - one per worker
  // CRITICAL: Use try-finally to ensure process cleanup even on errors
  apiServer: [
    async ({ dbContainer, bedrockMock }, use, workerInfo) => {
      const workerTag = `[Worker ${workerInfo.workerIndex}]`;
      const debug = process.env.DEBUG === '1';
      // Use worker-specific port range to avoid collisions between parallel workers
      const port = await getWorkerPort(workerInfo.workerIndex);
      const dbUrl = dbContainer.getConnectionUri();

      if (debug) console.log(`${workerTag} Starting API server on port ${port}...`);

      // Use the built API (faster than dev server)
      const proc = spawn('node', ['dist/index.js'], {
        cwd: path.join(PROJECT_ROOT, 'api'),
        env: sandboxedChildEnv({
          PORT: String(port),
          DATABASE_URL: dbUrl,
          CORS_ORIGIN: '*', // Allow any origin during tests
          NODE_ENV: 'test',
          // Prevent dotenv from overriding our DATABASE_URL
          DOTENV_CONFIG_PATH: '/dev/null',
          // Rule 3: pin the only outbound third-party call to the in-process fake.
          // Set last so it also wins over anything api/.env.local might carry.
          BEDROCK_ENDPOINT: bedrockMock.url,
          // L99 F165. `/oauth` is throttled at `RATE_LIMIT_DEFAULTS.oauthPerMinute`
          // = 30/min, keyed by IP — which for this harness is ONE key shared by
          // every request every spec makes. That default is a correct production
          // policy for a credential endpoint and is deliberately left alone; it is
          // simply not a policy a single-IP test harness can live under. The
          // in-memory double in `api/src/deps.ts` already reasons its way to the
          // same conclusion and sets capacity 1e6 for exactly this reason — the
          // real-server E2E path never inherited that reasoning, so it does now.
          //
          // What it unblocks, concretely: `oauth-pkce.spec.ts`'s P95 measurement
          // (PF-110, PRD p.6) drives 20 iterations × 2 `/oauth/*` requests = 40,
          // and 40 > 30, so it 429s around iteration 15 EVERY run. Deterministic
          // arithmetic, not flake. The alternative fix — lowering `RUNS` — would
          // shrink a graded sample to fit a harness artifact, so it is not taken.
          OAUTH_RATE_LIMIT_PER_MINUTE: '100000',
          // L21 / L99 F91. `api/src/deps.ts` builds the subscription repository
          // with `envSecretCipher()`, which resolves this LAZILY — so a server
          // without it boots green, answers /health, and then throws
          // `WebhookSecretCryptoError` out of the FIRST `POST /api/v1/webhooks`.
          // Every webhook spec then fails as a missing element rather than as a
          // missing variable, three layers from the cause.
          //
          // Generated per worker, exactly as `scripts/ttfe/harness.ts` does it:
          // 32 random bytes, base64, the shape `secretCipher.ts` decodes. A
          // constant would be a checked-in 32-byte AES key that greps like a
          // real one, and a per-run value additionally proves the encryption is
          // genuinely round-tripping within the run rather than matching a
          // fixture someone could have pinned.
          //
          // Each worker owns its own database, so nothing needs the key to be
          // the same across workers or across runs.
          WEBHOOK_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        // Log server output for debugging
        proc.stdout?.on('data', (data) => {
          if (process.env.DEBUG) {
            console.log(`${workerTag} API: ${data.toString().trim()}`);
          }
        });
        proc.stderr?.on('data', (data) => {
          console.error(`${workerTag} API ERROR: ${data.toString().trim()}`);
        });

        // Wait for server to be ready
        const apiUrl = `http://localhost:${port}`;
        await waitForServer(`${apiUrl}/health`, 30000);
        if (debug) console.log(`${workerTag} API server ready at ${apiUrl}`);

        await use({ url: apiUrl, process: proc });
      } finally {
        if (debug) console.log(`${workerTag} Stopping API server...`);
        proc.kill('SIGTERM');
      }
    },
    { scope: 'worker' },
  ],

  // Vite preview server - one per worker (lightweight static server, NOT dev server)
  // CRITICAL: We use vite preview instead of vite dev to avoid memory explosion
  // vite dev = 300-500MB per instance (HMR, file watchers, dependency graph)
  // vite preview = 30-50MB per instance (simple static file server)
  // CRITICAL: Use try-finally to ensure process cleanup even on errors
  webServer: [
    async ({ apiServer }, use, workerInfo) => {
      const workerTag = `[Worker ${workerInfo.workerIndex}]`;
      const debug = process.env.DEBUG === '1';
      // Use worker-specific port range (separate from API port)
      const port = await getWorkerPort(workerInfo.workerIndex);

      // Extract API port from URL
      const apiPort = new URL(apiServer.url).port;

      // Verify web dist exists (globalSetup should have built it)
      const distPath = path.join(PROJECT_ROOT, 'web/dist');
      if (!existsSync(distPath)) {
        throw new Error(
          `${workerTag} Web dist not found at ${distPath}. ` +
          `globalSetup should build it. Run: pnpm build:web`
        );
      }

      if (debug) console.log(`${workerTag} Starting Vite preview server on port ${port} (API proxy to ${apiPort})...`);

      // Use vite preview instead of vite dev - much lighter weight
      // We pass the API port via env var so vite.config.ts can set up the proxy
      //
      // `--host 127.0.0.1` is load-bearing, not tidying. Left to itself `vite preview`
      // binds the IPv6 loopback only (`::1`), while Node's `fetch('http://localhost:...')`
      // resolves to `127.0.0.1` -- so nothing is listening where `waitForServer` looks and
      // every worker dies with "did not start within 30000ms". It reproduces in
      // `node:22-bookworm`, which is the CI image, and not on macOS, which is why the
      // suite was green locally and failed every test in CI. Measured inside the image:
      // `curl [::1]:PORT` 200, `curl 127.0.0.1:PORT` refused; with this flag, both the
      // curl and the Node fetch return 200.
      const proc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
        cwd: path.join(PROJECT_ROOT, 'web'),
        env: {
          ...process.env,
          API_PORT: apiPort, // Our env var for Vite proxy
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      try {
        // Log output for debugging
        proc.stdout?.on('data', (data) => {
          if (process.env.DEBUG) {
            console.log(`${workerTag} Preview: ${data.toString().trim()}`);
          }
        });
        proc.stderr?.on('data', (data) => {
          // Vite uses stderr for some normal output
          if (process.env.DEBUG) {
            console.log(`${workerTag} Preview: ${data.toString().trim()}`);
          }
        });

        const webUrl = `http://localhost:${port}`;
        await waitForServer(webUrl, 30000); // Preview starts much faster than dev
        if (debug) console.log(`${workerTag} Vite preview server ready at ${webUrl}`);

        await use({ url: webUrl, process: proc });
      } finally {
        if (debug) console.log(`${workerTag} Stopping Vite preview server...`);
        proc.kill('SIGTERM');
      }
    },
    { scope: 'worker' },
  ],

  // Override baseURL to use our isolated web server
  baseURL: async ({ webServer }, use) => {
    await use(webServer.url);
  },

  // Restores the seeded state at each spec-file boundary.
  //
  // Every worker gets one Postgres container with one workspace, seeded once. Before this,
  // all 72 spec files shared it with no reset, so a file inherited whatever the previous
  // files left behind — extra documents, renamed projects, consumed sprint slots. Triage
  // measured the cost: of 20 tests observed flaking across three full runs, 16 passed 5/5
  // when run alone and only failed inside the suite. Ordering also shifts with machine
  // load, which is why the flake set changed shape between a quiet baseline and a
  // contended run and looked like new defects.
  //
  // Per FILE, deliberately not per test. Specs routinely build across tests within a file
  // (create a document in one, assert on it in the next); resetting per test would break
  // far more than it fixes. The file boundary is where ownership actually changes.
  resetDatabaseForFile: [
    async ({ dbContainer }, use, workerInfo) => {
      const dbUrl = dbContainer.getConnectionUri();
      const debug = process.env.DEBUG === '1';

      // The marker lives on disk, not in a closure. Playwright restarts a worker after
      // certain failures, which rebuilds this fixture and would reset an in-memory value
      // to null -- so the next test, still inside the same spec file, would truncate and
      // destroy setup its own earlier tests created. That is the exact opposite of the
      // per-file contract, and it fires precisely when a run is already going badly.
      //
      // outputDir is wiped by Playwright at the start of every run, so markers cannot
      // leak between runs and no cleanup is needed.
      const markerPath = path.join(
        workerInfo.project.outputDir,
        `.reseed-worker-${workerInfo.workerIndex}`
      );

      const lastPrepared = (): string | null =>
        existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() || null : null;

      await use(async (specFile: string) => {
        if (specFile === lastPrepared()) return;

        const started = Date.now();
        await resetToSeededState(dbUrl);
        mkdirSync(path.dirname(markerPath), { recursive: true });
        writeFileSync(markerPath, specFile, 'utf8');

        if (debug) {
          console.log(
            `[Worker ${workerInfo.workerIndex}] reseeded for ${specFile} in ${Date.now() - started}ms`
          );
        }
      });
    },
    { scope: 'worker' },
  ],

  // `auto` so no spec file has to opt in — all 72 keep working unchanged. It runs before
  // every test but only does work when the file changes, so the cost is one reseed per
  // file per worker rather than one per test.
  freshState: [
    async ({ resetDatabaseForFile }, use, testInfo) => {
      await resetDatabaseForFile(testInfo.file);
      await use(undefined);
    },
    { auto: true },
  ],
});

/**
 * Truncate every application table and re-seed.
 *
 * `schema_migrations` is preserved — the schema is already applied and re-running
 * migrations per file would be slow and pointless. TRUNCATE ... CASCADE in one statement
 * so foreign keys never block, and RESTART IDENTITY so sequence-derived values do not
 * drift upward across files and make row ids depend on test order.
 */
async function resetToSeededState(dbUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    // `checkpoint_migrations` is preserved for the same reason as `schema_migrations`,
    // one library over. LangGraph's PostgresSaver creates and versions its own tables
    // (`agent/src/graph/checkpointer.ts` says so at length) and reads that table to
    // decide which of its migrations still need applying. Truncating it tells the
    // library it has never migrated, so the next `setup()` replays ALTERs against
    // columns that already exist. Its data tables ARE truncated below, so no run's
    // suspended state leaks into the next spec file.
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT IN ('schema_migrations', 'checkpoint_migrations')`
    );
    if (rows.length > 0) {
      const list = rows.map((r) => `"${r.tablename}"`).join(', ');
      await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    }
    await seedMinimalTestData(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Run database schema, migrations, and seed minimal test data
 */
async function runMigrations(dbUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Step 1: Run schema.sql for initial setup
    const schemaPath = path.join(PROJECT_ROOT, 'api/src/db/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    await pool.query(schema);

    // Step 2: Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    // Step 3: Mark all migrations as applied since schema.sql represents the full current state.
    // schema.sql includes all table definitions from all migrations, so running migrations
    // again would fail on CREATE TABLE statements that don't use IF NOT EXISTS.
    const migrationsDir = path.join(PROJECT_ROOT, 'api/src/db/migrations');
    let migrationFiles: string[] = [];

    try {
      migrationFiles = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      // No migrations directory
    }

    for (const file of migrationFiles) {
      const version = file.replace('.sql', '');
      await pool.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
        [version]
      );
    }

    // Step 4: Apply the migrations whose objects schema.sql does NOT contain.
    //
    // Step 3's assumption — "schema.sql represents the full current state" — is the
    // one every worker database depends on, and it is only true while someone keeps
    // schema.sql in step with the migration directory. It was not true for 038:
    // `fleetgraph_observations`, `fleetgraph_notifications` and `fleetgraph_watermarks`
    // exist in `api/src/db/migrations/038_fleetgraph.sql` and nowhere in schema.sql, so
    // every E2E worker ran against a database with no FleetGraph tables at all. The
    // symptom is not a missing table error in the test — it is
    // `GET /api/fleetgraph/notifications` answering 500, which reads as "the agent
    // surfaced nothing", which is exactly the quiet failure the agent exists to prevent.
    //
    // schema.sql really does carry 001-037, and re-running those fails on CREATE
    // TABLE statements that predate the IF NOT EXISTS convention. So the cut-off
    // below is a fact about schema.sql, not a preference.
    //
    // ─────────────────────────────────────────────────────────────────────────
    // 2026-08-12 (L04). THE SAME BUG HAD RECURRED, SILENTLY, FOR THE WHOLE
    // PLUGFORGE MIGRATION BLOCK — so the list became a RULE.
    // ─────────────────────────────────────────────────────────────────────────
    // The hard-coded list said `['038_fleetgraph.sql']`. Every migration from
    // 039 on — L02's `oauth_apps`, L02's `client_secret_auth_log`, L02's
    // platform-app seed, L06's `oauth_tokens`, L08's keyset indexes, L04's
    // `oauth_authorization_codes` — was marked applied by step 3 and then never
    // run. Every E2E worker was therefore running against a database with no
    // OAuth tables at all, and step 3's INSERT meant nothing would ever notice:
    // `schema_migrations` claimed they were applied.
    //
    // The symptom is exactly the one the 038 note above describes: not a missing
    // table error in a test, but `POST /api/apps` answering 500, which reads as
    // "app registration is broken" rather than "the fixture never created the
    // table". L04's PF-108 gate test is what surfaced it.
    //
    // Fixed as a rule rather than by appending six filenames, because appending
    // is what produced the bug: the list is a second place to remember, and the
    // person adding migration NNN is not reading this file. Everything numbered
    // above the cut-off is applied in filename order, which is also `migrate.ts`'s
    // order. All of 039+ are idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING),
    // and the assertion below fails loudly the day one is not.
    const SCHEMA_SQL_COVERS_THROUGH = 37;
    const migrationNumber = (file: string): number => Number.parseInt(file.slice(0, 3), 10);

    const missingFromSchemaSql = migrationFiles.filter((f) => {
      const n = migrationNumber(f);
      return Number.isFinite(n) && n > SCHEMA_SQL_COVERS_THROUGH;
    });

    if (missingFromSchemaSql.length === 0) {
      throw new Error(
        `No migrations above ${SCHEMA_SQL_COVERS_THROUGH} were found. Either the migrations ` +
          `directory is not being read, or SCHEMA_SQL_COVERS_THROUGH in ` +
          `e2e/fixtures/isolated-env.ts is stale. Both leave every worker database ` +
          `missing tables while schema_migrations claims otherwise.`
      );
    }

    for (const file of missingFromSchemaSql) {
      const filePath = path.join(migrationsDir, file);
      if (!existsSync(filePath)) {
        throw new Error(`Migration ${file} disappeared between listing and reading.`);
      }
      try {
        await pool.query(readFileSync(filePath, 'utf-8'));
      } catch (err) {
        // Loud, and naming the file. A migration above the cut-off that is not
        // idempotent is a real problem for every worker, and swallowing it here
        // is how it would come back as a 500 in an unrelated test.
        throw new Error(
          `E2E fixture failed to apply ${file}. Migrations above ` +
            `${SCHEMA_SQL_COVERS_THROUGH} must be idempotent (IF NOT EXISTS / ` +
            `ON CONFLICT DO NOTHING) because this fixture applies them to a database ` +
            `schema.sql has already partially built.`,
          { cause: err }
        );
      }
    }

    // Step 5: Seed minimal test data
    await seedMinimalTestData(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Seed comprehensive test data matching the full seed script:
 * - 1 workspace with sprint_start_date 3 months ago
 * - 1 user (dev@ship.local / admin123)
 * - workspace membership + person document
 * - 5 programs (Ship Core, Authentication, API Platform, Design System, Infrastructure)
 * - Sprints for each program
 * - Issues with various states
 */
async function seedMinimalTestData(pool: Pool): Promise<void> {
  // Hash the test password
  const passwordHash = await bcrypt.hash('admin123', 10);

  // Create workspace with sprint_start_date 3 months ago (matches full seed)
  // IMPORTANT: Use UTC throughout to match the API's date math (team.ts parses as UTC)
  const nowUtc = new Date();
  const threeMonthsAgoUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth() - 3, nowUtc.getUTCDate()));
  const sprintStartDateStr = threeMonthsAgoUtc.toISOString().split('T')[0];
  const workspaceResult = await pool.query(
    `INSERT INTO workspaces (name, sprint_start_date)
     VALUES ('Test Workspace', $1)
     RETURNING id`,
    [sprintStartDateStr]
  );
  const workspaceId = workspaceResult.rows[0].id;

  // Create test user
  const userResult = await pool.query(
    `INSERT INTO users (email, password_hash, name, is_super_admin, last_workspace_id)
     VALUES ('dev@ship.local', $1, 'Dev User', true, $2)
     RETURNING id`,
    [passwordHash, workspaceId]
  );
  const userId = userResult.rows[0].id;

  // Create workspace membership
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'admin')`,
    [workspaceId, userId]
  );

  // Create person document for user
  const personResult = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
     VALUES ($1, 'person', 'Dev User', $2, $3)
     RETURNING id`,
    [workspaceId, JSON.stringify({ user_id: userId, email: 'dev@ship.local' }), userId]
  );
  const personId = personResult.rows[0].id;

  // Create a member user (non-admin) for authorization tests
  const memberResult = await pool.query(
    `INSERT INTO users (email, password_hash, name, is_super_admin, last_workspace_id)
     VALUES ('bob.martinez@ship.local', $1, 'Bob Martinez', false, $2)
     RETURNING id`,
    [passwordHash, workspaceId]
  );
  const memberId = memberResult.rows[0].id;

  // Create workspace membership as regular member (not admin)
  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [workspaceId, memberId]
  );

  // Create person document for member
  await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
     VALUES ($1, 'person', 'Bob Martinez', $2, $3)`,
    [workspaceId, JSON.stringify({ user_id: memberId, email: 'bob.martinez@ship.local' }), userId]
  );

  // Bench: people deliberately left out of every sprint allocation below.
  //
  // The assignments grid renders an "Unassigned" group only while at least one person
  // has no current-sprint allocation. Before this, exactly one person qualified — Bob,
  // since the allocation sprint further down carries `assignee_ids: [personId]` and
  // names only Dev User. `fullyParallel: true` runs the tests of one spec file across
  // workers, and several of them assign a project to `.first()` unassigned row. When one
  // of those landed on the only unassigned person, the group header stopped existing and
  // every Collapse/Expand test failed with `element(s) not found` rather than a
  // meaningful assertion. Measured at 5 failures in 195 attempts.
  //
  // Four, not one, so the invariant survives concurrent mutation: CLAUDE.md asks for
  // N+2 rows where a test needs N, and the group needs only one survivor to render.
  // Nothing else may allocate these people.
  const benchNames = ['Casey Bench', 'Devon Bench', 'Emery Bench', 'Frankie Bench'];
  for (const name of benchNames) {
    const slug = name.toLowerCase().replace(/\s+/g, '.');
    const benchUser = await pool.query(
      `INSERT INTO users (email, password_hash, name, is_super_admin, last_workspace_id)
       VALUES ($1, $2, $3, false, $4)
       RETURNING id`,
      [`${slug}@ship.local`, passwordHash, name, workspaceId]
    );
    const benchId = benchUser.rows[0].id;
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [workspaceId, benchId]
    );
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
       VALUES ($1, 'person', $2, $3, $4)`,
      [workspaceId, name, JSON.stringify({ user_id: benchId, email: `${slug}@ship.local` }), userId]
    );
  }

  // Create programs (matching full seed)
  // 'key' is used for test referencing only, not stored in database
  const programs = [
    { key: 'SHIP', name: 'Ship Core', color: '#3B82F6' },
    { key: 'AUTH', name: 'Authentication', color: '#8B5CF6' },
    { key: 'API', name: 'API Platform', color: '#10B981' },
    { key: 'UI', name: 'Design System', color: '#F59E0B' },
    { key: 'INFRA', name: 'Infrastructure', color: '#EF4444' },
  ];

  const programIds: Record<string, string> = {};
  for (const prog of programs) {
    const result = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
       VALUES ($1, 'program', $2, $3, $4)
       RETURNING id`,
      [workspaceId, prog.name, JSON.stringify({ color: prog.color }), userId]
    );
    programIds[prog.key] = result.rows[0].id;
  }

  // Calculate current sprint number (1-week sprints) using UTC to match API (team.ts:1639-1647)
  const todayUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()));
  const daysSinceStart = Math.floor((todayUtc.getTime() - threeMonthsAgoUtc.getTime()) / (1000 * 60 * 60 * 24));
  const currentSprintNumber = Math.max(1, Math.floor(daysSinceStart / 7) + 1);

  // Create sprints for each program (current-2 to current+2)
  // IMPORTANT: Must create document_associations for sprints to programs
  // The API queries via junction table, not legacy program_id column
  // IMPORTANT: Must include start_date for allocation queries to work
  const sprintIds: Record<string, Record<number, string>> = {};
  for (const prog of programs) {
    sprintIds[prog.key] = {};
    for (let sprintNum = currentSprintNumber - 2; sprintNum <= currentSprintNumber + 2; sprintNum++) {
      if (sprintNum > 0) {
        // Calculate sprint start date (1-week sprints starting from threeMonthsAgoUtc)
        const sprintStartDate = new Date(threeMonthsAgoUtc.getTime() + (sprintNum - 1) * 7 * 24 * 60 * 60 * 1000);
        const startDateStr = sprintStartDate.toISOString().split('T')[0];

        const result = await pool.query(
          `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
           VALUES ($1, 'sprint', $2, $3, $4)
           RETURNING id`,
          [
            workspaceId,
            `Week ${sprintNum}`,
            JSON.stringify({ sprint_number: sprintNum, owner_id: userId, start_date: startDateStr }),
            userId,
          ]
        );
        const sprintId = result.rows[0].id;
        sprintIds[prog.key][sprintNum] = sprintId;

        // Create association to program via junction table (required for API queries)
        await pool.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'program')`,
          [sprintId, programIds[prog.key]]
        );
      }
    }
  }

  // Create issues for Ship Core with various states and estimates
  // IMPORTANT: Bulk selection tests need 6+ rows in each state filter
  // Tests will skip with "Not enough rows" if insufficient data exists
  const shipCoreIssues = [
    // Done issues (past sprint)
    { title: 'Initial project setup', state: 'done', priority: 'high', sprintOffset: -1, estimate: 4 },
    { title: 'Database schema design', state: 'done', priority: 'high', sprintOffset: -1, estimate: 8 },
    { title: 'User authentication setup', state: 'done', priority: 'high', sprintOffset: -1, estimate: 6 },
    { title: 'CI/CD pipeline configuration', state: 'done', priority: 'medium', sprintOffset: -1, estimate: 4 },
    // Current sprint - mixed states with estimates for capacity tracking
    { title: 'Implement sprint management', state: 'done', priority: 'high', sprintOffset: 0, estimate: 5 },
    { title: 'Build issue assignment flow', state: 'in_progress', priority: 'high', sprintOffset: 0, estimate: 8 },
    { title: 'Add sprint velocity metrics', state: 'todo', priority: 'medium', sprintOffset: 0, estimate: 4 },
    { title: 'Implement burndown chart', state: 'todo', priority: 'medium', sprintOffset: 0, estimate: 6 },
    { title: 'Review dashboard design', state: 'in_review', priority: 'medium', sprintOffset: 0, estimate: 3 },
    { title: 'Update API documentation', state: 'in_review', priority: 'low', sprintOffset: 0, estimate: 2 },
    // Additional todo items
    { title: 'Refactor notification system', state: 'todo', priority: 'medium', sprintOffset: 0, estimate: 5 },
    { title: 'Add email notifications', state: 'todo', priority: 'low', sprintOffset: 0, estimate: 8 },
    // Additional in_progress items
    { title: 'Build settings page', state: 'in_progress', priority: 'medium', sprintOffset: 0, estimate: 6 },
    { title: 'Implement search feature', state: 'in_progress', priority: 'high', sprintOffset: 0, estimate: 10 },
    // Future sprint
    { title: 'Add team workload view', state: 'todo', priority: 'high', sprintOffset: 1, estimate: 12 },
    { title: 'Build analytics dashboard', state: 'todo', priority: 'medium', sprintOffset: 1, estimate: 16 },
    // Backlog (no sprint) - with estimates so they can be moved to sprints
    // Bulk selection tests filter by state=backlog and need 6+ items
    { title: 'Add dark mode support', state: 'backlog', priority: 'low', sprintOffset: null, estimate: 16 },
    { title: 'Create mobile app', state: 'backlog', priority: 'low', sprintOffset: null, estimate: 40 },
    { title: 'Implement webhooks', state: 'backlog', priority: 'medium', sprintOffset: null, estimate: 12 },
    { title: 'Add keyboard shortcuts', state: 'backlog', priority: 'low', sprintOffset: null, estimate: 8 },
    { title: 'Build export to PDF', state: 'backlog', priority: 'low', sprintOffset: null, estimate: 10 },
    { title: 'Create Slack integration', state: 'backlog', priority: 'medium', sprintOffset: null, estimate: 20 },
    { title: 'Add calendar view', state: 'backlog', priority: 'low', sprintOffset: null, estimate: 24 },
    { title: 'Implement file versioning', state: 'backlog', priority: 'low', sprintOffset: null, estimate: 16 },
  ];

  let ticketNumber = 0;
  for (const issue of shipCoreIssues) {
    ticketNumber++;
    const sprintId = issue.sprintOffset !== null
      ? sprintIds['SHIP'][currentSprintNumber + issue.sprintOffset] || null
      : null;

    const issueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
       VALUES ($1, 'issue', $2, $3, $4, $5)
       RETURNING id`,
      [
        workspaceId,
        issue.title,
        JSON.stringify({
          state: issue.state,
          priority: issue.priority,
          source: 'internal',
          assignee_id: userId,
          ...(issue.estimate !== null ? { estimate: issue.estimate } : {}),
        }),
        ticketNumber,
        userId,
      ]
    );

    const issueId = issueResult.rows[0].id;

    // Create program association via document_associations (replaces legacy program_id column)
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'program')`,
      [issueId, programIds['SHIP']]
    );

    // Create sprint association via document_associations
    if (sprintId) {
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
         VALUES ($1, $2, 'sprint')`,
        [issueId, sprintId]
      );
    }
  }

  // Create issues for other programs (with estimates for capacity testing)
  // Each program gets multiple issues so program-specific views have enough data
  const otherProgramIssues = [
    { state: 'in_progress', priority: 'medium', estimate: 8, titleSuffix: 'initial setup' },
    { state: 'todo', priority: 'high', estimate: 6, titleSuffix: 'documentation' },
    { state: 'backlog', priority: 'low', estimate: 10, titleSuffix: 'improvements' },
    { state: 'done', priority: 'medium', estimate: 4, titleSuffix: 'configuration' },
  ];

  for (const prog of programs.filter(p => p.key !== 'SHIP')) {
    for (const issueTemplate of otherProgramIssues) {
      ticketNumber++;
      const progSprintId = issueTemplate.state !== 'backlog'
        ? sprintIds[prog.key][currentSprintNumber] || null
        : null;
      const progIssueResult = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
         VALUES ($1, 'issue', $2, $3, $4, $5)
         RETURNING id`,
        [
          workspaceId,
          `${prog.name} ${issueTemplate.titleSuffix}`,
          JSON.stringify({
            state: issueTemplate.state,
            priority: issueTemplate.priority,
            source: 'internal',
            assignee_id: userId,
            estimate: issueTemplate.estimate,
          }),
          ticketNumber,
          userId,
        ]
      );

      const progIssueId = progIssueResult.rows[0].id;

      // Create program association via document_associations
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
         VALUES ($1, $2, 'program')`,
        [progIssueId, programIds[prog.key]]
      );

      // Create sprint association via document_associations
      if (progSprintId) {
        await pool.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'sprint')`,
          [progIssueId, progSprintId]
        );
      }
    }
  }

  // Create external issues for feedback consolidation testing
  const externalIssues = [
    // Issue in triage (awaiting review)
    { title: 'External feature request from user', state: 'triage', rejection_reason: null },
    { title: 'Bug report from customer', state: 'triage', rejection_reason: null },
    // Accepted external feedback (moved to backlog)
    { title: 'Accepted user suggestion', state: 'backlog', rejection_reason: null },
    // Rejected external feedback
    { title: 'Rejected spam submission', state: 'cancelled', rejection_reason: 'Not relevant to product' },
  ];

  for (const issue of externalIssues) {
    ticketNumber++;
    const properties: Record<string, unknown> = {
      state: issue.state,
      priority: 'medium',
      source: 'external',
    };
    if (issue.rejection_reason) {
      properties.rejection_reason = issue.rejection_reason;
    }
    const extIssueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
       VALUES ($1, 'issue', $2, $3, $4, $5)
       RETURNING id`,
      [workspaceId, issue.title, JSON.stringify(properties), ticketNumber, userId]
    );

    // Create program association via document_associations
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'program')`,
      [extIssueResult.rows[0].id, programIds['SHIP']]
    );
  }

  // Create project documents for team-mode tests
  // Team allocation grid needs projects to assign team members to
  const projects = [
    { name: 'Ship Core Redesign', color: '#3B82F6', programKey: 'SHIP' },
    { name: 'Auth System v2', color: '#8B5CF6', programKey: 'AUTH' },
    { name: 'API Gateway', color: '#10B981', programKey: 'API' },
    { name: 'Component Library', color: '#F59E0B', programKey: 'UI' },
  ];

  const projectIds: Record<string, string> = {};
  for (const project of projects) {
    const projectResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
       VALUES ($1, 'project', $2, $3, $4)
       RETURNING id`,
      [
        workspaceId,
        project.name,
        JSON.stringify({ color: project.color }),
        userId,
      ]
    );
    projectIds[project.programKey] = projectResult.rows[0].id;

    // Create association to program via junction table
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type)
       VALUES ($1, $2, 'program')`,
      [projectResult.rows[0].id, programIds[project.programKey]]
    );
  }

  // Create issues with project associations for Status Overview heatmap tests
  // These issues create "allocations" (person assigned to project in sprint)
  const allocationIssues = [
    { title: 'Status Overview test issue 1', programKey: 'SHIP', sprintOffset: 0 },
    { title: 'Status Overview test issue 2', programKey: 'SHIP', sprintOffset: 0 },
    { title: 'API work for current week', programKey: 'API', sprintOffset: 0 },
  ];

  for (const issue of allocationIssues) {
    ticketNumber++;
    const sprintId = sprintIds[issue.programKey][currentSprintNumber];
    const projId = projectIds[issue.programKey];

    if (!sprintId || !projId) continue;

    const issueResult = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number, created_by)
       VALUES ($1, 'issue', $2, $3, $4, $5)
       RETURNING id`,
      [
        workspaceId,
        issue.title,
        JSON.stringify({
          state: 'todo',
          priority: 'medium',
          source: 'internal',
          assignee_id: personId, // Person document ID, not user ID
        }),
        ticketNumber,
        userId,
      ]
    );
    const issueId = issueResult.rows[0].id;

    // Create associations for sprint, project, and program
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'sprint')`,
      [issueId, sprintId]
    );
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'project')`,
      [issueId, projId]
    );
    await pool.query(
      `INSERT INTO document_associations (document_id, related_id, relationship_type) VALUES ($1, $2, 'program')`,
      [issueId, programIds[issue.programKey]]
    );
  }

  // Create sprint allocation documents (person assigned to project for a week)
  // The team/reviews endpoint queries sprints with assignee_ids
  const allocationSprintResult = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, properties, created_by)
     VALUES ($1, 'sprint', $2, $3, $4)
     RETURNING id`,
    [
      workspaceId,
      `Week ${currentSprintNumber} - Ship Core`,
      JSON.stringify({
        sprint_number: currentSprintNumber,
        owner_id: userId,
        project_id: projectIds['SHIP'],
        assignee_ids: [personId],
        start_date: new Date(threeMonthsAgoUtc.getTime() + (currentSprintNumber - 1) * 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      }),
      userId,
    ]
  );
  const allocationSprintId = allocationSprintResult.rows[0].id;

  // Associate allocation sprint with program
  await pool.query(
    `INSERT INTO document_associations (document_id, related_id, relationship_type)
     VALUES ($1, $2, 'program')`,
    [allocationSprintId, programIds['SHIP']]
  );

  // Create wiki documents with nested structure for tree testing
  // Include content for content-caching tests to work
  const welcomeContent = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Ship helps your team track work, plan sprints, and write documentation—all in one place.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'This is the welcome document with example content for testing.' }] },
    ],
  };
  const parentDocResult = await pool.query(
    `INSERT INTO documents (workspace_id, document_type, title, content, created_by)
     VALUES ($1, 'wiki', 'Welcome to Ship', $2, $3)
     RETURNING id`,
    [workspaceId, JSON.stringify(welcomeContent), userId]
  );
  const parentDocId = parentDocResult.rows[0].id;

  // Create child documents to enable tree expand/collapse testing
  const childDocs = [
    { title: 'Getting Started' },
    { title: 'Advanced Topics' },
  ];

  for (const child of childDocs) {
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, parent_id, created_by)
       VALUES ($1, 'wiki', $2, $3, $4)`,
      [workspaceId, child.title, parentDocId, userId]
    );
  }

  // Create additional top-level wiki documents for tests that require multiple documents
  // (e.g., content-caching tests that toggle between documents).
  //
  // W7-6: the count here is load-bearing, not padding. `DocumentsTree` in
  // web/src/pages/App.tsx caps the sidebar at SIDEBAR_ITEM_LIMIT = 10 root documents and
  // only then renders the "N more..." row (App.tsx:651-659). This fixture used to create
  // 3 workspace root documents, so that branch never rendered, so the axe scans in
  // e2e/accessibility.spec.ts never saw its markup and reported zero violations on a page
  // that has them at real scale. The suite was not passing because the app conformed; it
  // was passing because the fixture was too small to reach the code under test.
  //
  // 'Welcome to Ship' above is root #1, so the 12 below give 13 workspace roots: 10 shown
  // plus a "3 more..." row. That clears the limit by more than the N+2 margin CLAUDE.md
  // asks for, so an off-by-one in the limit cannot silently switch the branch back off.
  // Anything that raises SIDEBAR_ITEM_LIMIT above 11 must raise this list with it.
  const additionalWikiDocs = [
    { title: 'Project Overview', content: 'Overview of the Ship project and its goals.' },
    { title: 'Architecture Guide', content: 'Technical architecture and design decisions.' },
    { title: 'API Reference', content: 'REST endpoints, request shapes and error codes.' },
    { title: 'Onboarding Checklist', content: 'What a new engineer does in their first week.' },
    { title: 'Release Process', content: 'How a change gets from a branch to production.' },
    { title: 'Incident Runbook', content: 'Paging, triage and rollback steps for an outage.' },
    { title: 'Testing Strategy', content: 'Unit, integration and end-to-end coverage rules.' },
    { title: 'Security Practices', content: 'Session handling, secrets and dependency review.' },
    { title: 'Design System', content: 'Tokens, spacing scale and component conventions.' },
    { title: 'Data Model Notes', content: 'The unified document model and its associations.' },
    { title: 'Deployment Topology', content: 'Environments, regions and the CDN in front of web.' },
    { title: 'Glossary', content: 'Terms this workspace uses and what they mean here.' },
  ];

  for (let i = 0; i < additionalWikiDocs.length; i++) {
    const doc = additionalWikiDocs[i]!;
    const contentJson = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: doc.content }] }],
    };
    await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, content, position, created_by)
       VALUES ($1, 'wiki', $2, $3, $4, $5)`,
      [workspaceId, doc.title, JSON.stringify(contentJson), i + 1, userId]
    );
  }
}

// ---------------------------------------------------------------------------
// FG-242 · FleetGraph agent scenario fixtures
// ---------------------------------------------------------------------------

/**
 * The bearer the FleetGraph cron authenticates with in E2E runs.
 *
 * A plain string here, its SHA-256 in `api_tokens.token_hash` — that is the shape
 * `api/src/middleware/auth.ts#validateApiToken` verifies. Q29 gives the agent an
 * `api_tokens` bearer rather than a session because sessions expire after 15 minutes
 * of inactivity and a cron container has no session to keep alive.
 *
 * Without it, `agent/src/entrypoints/cron.ts#resolveAct` substitutes `refuseToAct`,
 * every autonomous comment reports `ok: false`, and the run exits 1 with an error —
 * a degraded run that still delivers its notification. A test that asserted only on
 * the notification would pass against that, which is the class of assertion this
 * suite exists to avoid.
 */
export const FLEETGRAPH_AGENT_TOKEN = 'fleetgraph-e2e-agent-token';

export interface FleetGraphScenario {
  workspaceId: string;
  /** dev@ship.local — the week owner, and so the accountable recipient (Q6). */
  ownerUserId: string;
  /** The week that is one working day from its end date. */
  weekId: string;
  weekTitle: string;
  /** Issues already under way in that week. None of them is a signal. */
  startedIssueIds: string[];
  /** `api_tokens` bearer for the agent process. Equals FLEETGRAPH_AGENT_TOKEN. */
  agentToken: string;
}

/**
 * Build the stage for the agent scenarios — deliberately NOT part of the base seed.
 *
 * ── Why this is a function and not rows in `seedMinimalTestData` ─────────────────
 * The base seed is shared by all 74 spec files, and several of them are sensitive to
 * its exact shape: the sidebar's "N more…" branch needs 13 workspace roots, the
 * assignments grid needs exactly four unallocated people, bulk selection needs six
 * rows per state filter. Adding a week and four issues to it would shift week lists,
 * issue counts and program views under every one of those. The blast radius of a
 * FleetGraph fixture should be FleetGraph's specs.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────────
 * It does not create the triggering condition. The workspace it leaves behind is
 * QUIET — every detector in `agent/src/detectors/` measures zero against it:
 *
 *   stalled_work       the issues below are `in_progress` with a fresh updated_at
 *   review_bottleneck  nothing sits in `in_review`
 *   sprint_miss_risk   the week ends today but has no unstarted work
 *   load_imbalance     one assignee in the week, and the guard needs three
 *   rework_churn       no `done -> in_progress` history rows, no reopened_at
 *
 * That is the whole point. FG-238 has to introduce the event itself and time it, so
 * a fixture that pre-loads a finding would make the test measure nothing. The
 * baseline scan asserting `quiet_no_signals` is what proves this stayed true.
 *
 * ── Sizes ───────────────────────────────────────────────────────────────────────
 * CLAUDE.md asks for N+2 rows where a test needs N. The scenario needs one started
 * issue for the detector to have something to NOT count; four are created, so the
 * "started work is not unstarted work" distinction survives a test consuming a
 * couple of them.
 */
export async function seedFleetGraphScenario(dbUrl: string): Promise<FleetGraphScenario> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { rows: wsRows } = await pool.query(`SELECT id FROM workspaces LIMIT 1`);
    const workspaceId = wsRows[0]?.id as string;
    if (!workspaceId) throw new Error('seedFleetGraphScenario: no workspace — base seed missing');

    const { rows: userRows } = await pool.query(
      `SELECT id FROM users WHERE email = 'dev@ship.local'`
    );
    const ownerUserId = userRows[0]?.id as string;
    if (!ownerUserId) throw new Error('seedFleetGraphScenario: dev@ship.local missing');

    const { rows: progRows } = await pool.query(
      `SELECT id FROM documents
        WHERE workspace_id = $1 AND document_type = 'program' AND title = 'Ship Core'`,
      [workspaceId]
    );
    const programId = progRows[0]?.id as string | undefined;

    // The agent's bearer. `revoked_at`/`expires_at` stay null so the token is live.
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
       VALUES ($1, $2, 'FleetGraph E2E agent', $3, $4)
       ON CONFLICT (user_id, workspace_id, name) DO UPDATE SET token_hash = EXCLUDED.token_hash`,
      [
        ownerUserId,
        workspaceId,
        crypto.createHash('sha256').update(FLEETGRAPH_AGENT_TOKEN).digest('hex'),
        FLEETGRAPH_AGENT_TOKEN.slice(0, 8),
      ]
    );

    // The week must END TODAY, and Ship does not store that date anywhere.
    //
    // `detectSprintMissRisk` keeps a week whose end date is today or later and whose
    // `businessDaysBetween(today, end_date)` is within SPRINT_MISS_DAYS. Today gives 0,
    // which clears the threshold on every calendar day of the year — including a
    // Saturday, a Monday before a federal holiday, and the far side of a DST change.
    // Any future offset has to be counted in business days against
    // `@ship/shared`'s holiday calendar, and a fixture that only triggers on some
    // weekdays is a fixture that fails a Friday CI run for reasons nobody will find.
    //
    // What changed: this used to write `end_date` into the sprint's properties, and the
    // detector used to read it. Neither was how Ship works — sprints store
    // `sprint_number`, and the window is computed from the workspace's
    // `sprint_start_date` (`computeSprintDates`, web/src/components/week/WeekTimeline.tsx).
    // The detector now computes it too, so this fixture has to express "ends today" the
    // way Ship would: by placing the workspace epoch such that week 99 lands on today.
    //
    //   end = sprint_start_date + (sprint_number - 1) * 7 + 6
    //
    // Moving the workspace epoch is safe here and would not be in a shared fixture: the
    // E2E database resets per spec FILE, and `seedFleetGraphScenario` has exactly one
    // caller, `fleetgraph-agent.spec.ts`.
    const WEEK_NUMBER = 99;
    const epochOffsetDays = (WEEK_NUMBER - 1) * 7 + 6;
    const weekTitle = `Week ${WEEK_NUMBER} · FleetGraph scenario`;

    await pool.query(
      `UPDATE workspaces
          SET sprint_start_date = CURRENT_DATE - ($2::int)
        WHERE id = $1`,
      [workspaceId, epochOffsetDays]
    );

    const { rows: weekRows } = await pool.query(
      `INSERT INTO documents (workspace_id, document_type, title, properties, created_by,
                              created_at, updated_at)
       VALUES ($1, 'sprint', $2, $3, $4, NOW(), NOW())
       RETURNING id`,
      [
        workspaceId,
        weekTitle,
        JSON.stringify({
          sprint_number: WEEK_NUMBER,
          // The accountable party for a sprint_miss_risk finding is the week owner,
          // never an assignee — the unstarted issues may have no assignee at all
          // (PRESEARCH.md Q6). This is the id the notification must be addressed to.
          owner_id: ownerUserId,
          // No `start_date` / `end_date`. `api/src/routes/weeks.ts` does not write them
          // and neither does anything else in Ship, so putting them here would let the
          // detector pass against a document the application cannot produce — which is
          // exactly the failure this fixture used to hide.
        }),
        ownerUserId,
      ]
    );
    const weekId = weekRows[0].id as string;

    if (programId) {
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
         VALUES ($1, $2, 'program')`,
        [weekId, programId]
      );
    }

    // Work already under way. `updated_at` is NOW() explicitly: stalled_work and
    // review_bottleneck both measure how long a row has NOT moved, so a fixture that
    // let these age would start failing the baseline assertion five days later.
    const { rows: maxTicket } = await pool.query(
      `SELECT COALESCE(MAX(ticket_number), 0)::int AS n FROM documents
        WHERE workspace_id = $1 AND document_type = 'issue'`,
      [workspaceId]
    );
    let ticketNumber = maxTicket[0].n as number;

    const startedIssueIds: string[] = [];
    const started = [
      { title: 'FleetGraph scenario · migration cutover', state: 'in_progress' },
      { title: 'FleetGraph scenario · index backfill', state: 'in_progress' },
      { title: 'FleetGraph scenario · rollout checklist', state: 'done' },
      { title: 'FleetGraph scenario · dashboard wiring', state: 'done' },
    ];

    for (const issue of started) {
      ticketNumber++;
      const { rows } = await pool.query(
        `INSERT INTO documents (workspace_id, document_type, title, properties, ticket_number,
                                created_by, created_at, updated_at)
         VALUES ($1, 'issue', $2, $3, $4, $5, NOW(), NOW())
         RETURNING id`,
        [
          workspaceId,
          issue.title,
          JSON.stringify({
            state: issue.state,
            priority: 'medium',
            source: 'internal',
            assignee_id: ownerUserId,
          }),
          ticketNumber,
          ownerUserId,
        ]
      );
      const issueId = rows[0].id as string;
      startedIssueIds.push(issueId);

      // Through `document_associations` — the legacy `sprint_id` column was dropped by
      // migration 027, and a detector reading it would report a clean week.
      await pool.query(
        `INSERT INTO document_associations (document_id, related_id, relationship_type)
         VALUES ($1, $2, 'sprint')`,
        [issueId, weekId]
      );
      if (programId) {
        await pool.query(
          `INSERT INTO document_associations (document_id, related_id, relationship_type)
           VALUES ($1, $2, 'program')`,
          [issueId, programId]
        );
      }
    }

    return {
      workspaceId,
      ownerUserId,
      weekId,
      weekTitle,
      startedIssueIds,
      agentToken: FLEETGRAPH_AGENT_TOKEN,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Wait for a server to respond successfully
 */
async function waitForServer(url: string, timeout: number): Promise<void> {
  const start = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401 || res.status === 403) {
        // 401/403 means server is running, just needs auth
        return;
      }
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  throw new Error(`Server at ${url} did not start within ${timeout}ms. Last error: ${lastError?.message}`);
}

/**
 * L22 PF-662 — the dead-lettered ladder Testing Scenario 8 starts from.
 *
 * TS-8 (p.5) begins *"a subscriber that fails 6 times"*. Driving that for real
 * costs the retry schedule p.4 mandates — 1s, 4s, 16s, 1m, 5m — which is six and
 * a half minutes of wall clock before the DLQ row exists, against a suite whose
 * per-test budget is 60 s. **L16's PF-481 owns proving the ladder produces the
 * dead letter**; the portal's half of TS-8 begins after it, so the six attempts
 * are written straight into the log here and the browser test asserts what the
 * portal does with them.
 *
 * The one property that must be real rather than convenient: all six attempts
 * share ONE `idempotency_key` and ONE `delivery_group_id`, because "the replay
 * carries the original idempotency key" is the half of TS-8 a naive replay
 * loses, and a fixture that minted a fresh key per attempt would make that
 * assertion vacuous.
 *
 * Lives in this module rather than in the spec because `pg` resolves here and
 * not from `e2e/*.spec.ts` — same reason `seedFleetGraphScenario` is here.
 *
 * @param subscriptionId a subscription created through the real API, so its
 *   signing secret is genuinely encrypted at rest and a replay can sign with it.
 */
export async function seedDeadLetteredLadder(
  dbUrl: string,
  subscriptionId: string
): Promise<{ idempotencyKey: string; deliveryGroupId: string; eventId: string }> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { rows } = await pool.query(
      `SELECT app_id FROM webhook_subscriptions WHERE id = $1`,
      [subscriptionId]
    );
    const appId = rows[0]?.app_id as string | undefined;
    if (!appId) {
      throw new Error(
        `seedDeadLetteredLadder: no webhook_subscriptions row ${subscriptionId}. ` +
          'The subscription must be created through the API first.'
      );
    }

    const deliveryGroupId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    // The bytes a replay re-sends. `raw_body` is what the deliverer stored, and
    // replay POSTs it verbatim rather than re-deriving it from current state.
    const body = Buffer.from(
      JSON.stringify({ id: eventId, type: 'issue.created', data: { id: crypto.randomUUID() } })
    );
    const base = Date.now() - 60 * 60 * 1000;

    for (let attempt = 1; attempt <= 6; attempt++) {
      const attemptedAt = new Date(base + attempt * 60_000).toISOString();
      await pool.query(
        `INSERT INTO webhook_deliveries (
           delivery_group_id, subscription_id, app_id, event_id, event_type,
           attempt_number, status, response_status, response_excerpt, latency_ms,
           idempotency_key, dlq_reason, attempted_at, raw_body, signature_header
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          deliveryGroupId,
          subscriptionId,
          appId,
          eventId,
          'issue.created',
          attempt,
          attempt === 6 ? 'dead_lettered' : 'failed',
          500,
          '{"error":"upstream unavailable"}',
          120 + attempt,
          idempotencyKey,
          // The schema's `webhook_deliveries_dlq_reason_coherent` check makes
          // this NOT NULL exactly when the status is `dead_lettered`.
          attempt === 6 ? 'max_attempts_exhausted' : null,
          attemptedAt,
          body,
          `t=${Math.floor(new Date(attemptedAt).getTime() / 1000)},v1=seeded`,
        ]
      );
    }

    return { idempotencyKey, deliveryGroupId, eventId };
  } finally {
    await pool.end();
  }
}

// Re-export expect for convenience
export { expect, Page, APIRequestContext } from '@playwright/test';
