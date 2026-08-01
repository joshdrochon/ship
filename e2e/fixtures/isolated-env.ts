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
 * Build the API child process environment with every ambient AWS credential removed.
 *
 * Implementation Rule 3 (stable fakes, not live external calls). The API's one outbound
 * third-party dependency is AWS Bedrock (`api/src/services/ai-analysis.ts`). This
 * fixture used to spread `process.env` straight into the child, so a developer with
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
 */
function apiChildEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith('AWS_')) continue;
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

// Types for our worker-scoped fixtures
type WorkerFixtures = {
  dbContainer: StartedPostgreSqlContainer;
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
        env: apiChildEnv({
          PORT: String(port),
          DATABASE_URL: dbUrl,
          CORS_ORIGIN: '*', // Allow any origin during tests
          NODE_ENV: 'test',
          // Prevent dotenv from overriding our DATABASE_URL
          DOTENV_CONFIG_PATH: '/dev/null',
          // Rule 3: pin the only outbound third-party call to the in-process fake.
          // Set last so it also wins over anything api/.env.local might carry.
          BEDROCK_ENDPOINT: bedrockMock.url,
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
      const proc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
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
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
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

// Re-export expect for convenience
export { expect, Page, APIRequestContext } from '@playwright/test';
