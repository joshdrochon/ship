/**
 * PF-020 — capture the Part 1 performance baseline.
 *
 *     pnpm --filter @ship/api exec tsx src/scripts/measure-baseline.ts
 *     pnpm baseline:measure                                    (from the repo root)
 *
 * Writes `docs/baseline-part1.json`. That file is the denominator for the +10%
 * regression budget on the MVP gate (PRD p.2 item 9, targets on p.6): after
 * PlugForge lands, L26's PF-802 re-runs this script and compares. It fails loudly
 * if the baseline is missing or empty, so this must produce real numbers — a
 * stubbed file would turn the one measured gate item into a rubber stamp.
 *
 * Three measurements, because the budget names three things:
 *
 *   P95 latency          per route, in-process through the Express app
 *   bundle size          web/dist JS + CSS, raw and gzipped
 *   per-route queries    how many SQL statements one request issues
 *
 * ── Why in-process rather than over a socket ─────────────────────────────────
 * The budget compares this repo to itself two weeks apart, on whoever's machine
 * runs it. A number that includes a TCP round trip, a listening socket and the
 * OS scheduler moves with the machine and with what else is running on it; the
 * comparison then measures the laptop. Driving the app through supertest removes
 * the transport and leaves routing, middleware, handler and database — which is
 * the part PlugForge can actually regress. The absolute figures are therefore
 * lower than production latency and are not a production SLO. They are a
 * before/after pair, and both sides are taken the same way.
 *
 * ── Why its own fixture rather than the seed ─────────────────────────────────
 * `pnpm db:seed` inserts 14 documents; a developer's database has whatever they
 * have been working on. List-endpoint latency and query counts both move with row
 * count, so the script builds a fixed fixture (one workspace, one user, one
 * session, FIXTURE_DOCUMENTS documents and issues), measures against it, and
 * deletes it. Two runs on two machines then differ by the machine, not by what
 * happened to be in the database.
 *
 * ── Query counting ───────────────────────────────────────────────────────────
 * `api/src/db/client.ts` exports `pool` as a single object literal, so wrapping
 * its `query` here is seen by every route module that imported it. `connect()` is
 * wrapped too, and the returned client proxied, so statements issued inside a
 * transaction are counted rather than silently missed.
 */
import request from 'supertest';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createApp } from '../app.js';
import { pool } from '../db/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const OUTPUT = join(REPO, 'docs', 'baseline-part1.json');
const WEB_DIST = join(REPO, 'web', 'dist', 'assets');

/** Requests per route that count toward the percentile. */
const SAMPLES = 60;
/** Requests per route discarded first — JIT warm-up, pool fill, plan caching. */
const WARMUP = 15;
/** Rows the list endpoints page over. Fixed so the numbers are comparable. */
const FIXTURE_DOCUMENTS = 25;

interface RouteSpec {
  /** Stable identifier used as the JSON key. Do not rename between runs. */
  id: string;
  method: 'GET';
  path: string;
  auth: boolean;
  note: string;
}

/**
 * The routes the budget is measured on.
 *
 * Read endpoints only, and deliberately so: a write endpoint's latency is
 * dominated by the write, and re-running the same POST 75 times changes the row
 * count underneath the list endpoints being measured in the same pass. The
 * regression PlugForge could plausibly cause — extra middleware on the shared
 * path, an extra query per request from an audit or rate-limit hook — shows up on
 * reads just as clearly.
 */
const ROUTES: RouteSpec[] = [
  {
    id: 'GET /health',
    method: 'GET',
    path: '/health',
    auth: false,
    note: 'Touches no database. The floor: middleware and routing only, so a regression here is a regression in the stack itself.',
  },
  {
    id: 'GET /api/documents',
    method: 'GET',
    path: '/api/documents',
    auth: true,
    note: 'The flagship list endpoint and the one /api/v1/documents will mirror.',
  },
  {
    id: 'GET /api/documents/:id',
    method: 'GET',
    path: '__DOC__',
    auth: true,
    note: 'Single-document read, the hottest shape in the UI.',
  },
  {
    id: 'GET /api/issues',
    method: 'GET',
    path: '/api/issues',
    auth: true,
    note: 'Second list endpoint, different sort key (priority + updated_at).',
  },
  {
    id: 'GET /api/weeks',
    method: 'GET',
    path: '/api/weeks',
    auth: true,
    note: 'Sprints under their internal name; the public contract calls these sprints.',
  },
  {
    id: 'GET /api/dashboard/my-work',
    method: 'GET',
    path: '/api/dashboard/my-work',
    auth: true,
    note: 'Read-only aggregate across documents, issues and memberships — the heaviest of the routine GETs, and the one an extra per-request query would show up on first.',
  },
];

// ---------------------------------------------------------------------------
// query counting
// ---------------------------------------------------------------------------

let queryCount = 0;
let counting = false;

const realQuery = pool.query.bind(pool);
const realConnect = pool.connect.bind(pool);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
pool.query = ((...args: any[]) => {
  if (counting) queryCount++;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (realQuery as any)(...args);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

pool.connect = (async (): Promise<PoolClient> => {
  const client = await realConnect();
  const clientQuery = client.query.bind(client);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).query = (...args: any[]) => {
    if (counting) queryCount++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (clientQuery as any)(...args);
  };
  return client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

/**
 * The commit these numbers were taken at. Without it a baseline is a set of
 * figures with no provenance, and the +10% comparison has nothing to say about
 * what changed between the two sides.
 */
function currentGitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile on a sorted sample.
 *
 * Nearest-rank rather than an interpolating variant because the sample is small
 * (60) and every reported value is then an observation that actually happened,
 * not an average of two that did not.
 */
function percentile(sortedMs: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedMs.length);
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, rank - 1))]!;
}

function round(n: number, dp = 2): number {
  return Number(n.toFixed(dp));
}

// ---------------------------------------------------------------------------
// bundle size
// ---------------------------------------------------------------------------

interface BundleMeasurement {
  totalBytes: number;
  totalGzipBytes: number;
  javascriptBytes: number;
  javascriptGzipBytes: number;
  cssBytes: number;
  cssGzipBytes: number;
  fileCount: number;
  largestChunks: { file: string; bytes: number; gzipBytes: number }[];
}

function measureBundle(): BundleMeasurement {
  if (!existsSync(WEB_DIST)) {
    throw new Error(
      `web/dist/assets does not exist. Run \`pnpm build:web\` first — a baseline with no bundle ` +
        `figure is exactly what L26's PF-802 is written to reject.`,
    );
  }

  const files = readdirSync(WEB_DIST).filter((f) => f.endsWith('.js') || f.endsWith('.css'));
  const measured = files.map((file) => {
    const buf = readFileSync(join(WEB_DIST, file));
    return { file, bytes: statSync(join(WEB_DIST, file)).size, gzipBytes: gzipSync(buf).length };
  });

  const sum = (pred: (f: string) => boolean, key: 'bytes' | 'gzipBytes') =>
    measured.filter((m) => pred(m.file)).reduce((acc, m) => acc + m[key], 0);

  return {
    totalBytes: sum(() => true, 'bytes'),
    totalGzipBytes: sum(() => true, 'gzipBytes'),
    javascriptBytes: sum((f) => f.endsWith('.js'), 'bytes'),
    javascriptGzipBytes: sum((f) => f.endsWith('.js'), 'gzipBytes'),
    cssBytes: sum((f) => f.endsWith('.css'), 'bytes'),
    cssGzipBytes: sum((f) => f.endsWith('.css'), 'gzipBytes'),
    fileCount: measured.length,
    largestChunks: measured.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

interface Fixture {
  workspaceId: string;
  userId: string;
  sessionCookie: string;
  documentId: string;
}

async function createFixture(): Promise<Fixture> {
  const tag = `baseline-${Date.now().toString(36)}`;

  const ws = await realQuery<{ id: string }>(`INSERT INTO workspaces (name) VALUES ($1) RETURNING id`, [
    `Baseline ${tag}`,
  ]);
  const workspaceId = ws.rows[0]!.id;

  const user = await realQuery<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'baseline-not-a-real-hash', 'Baseline') RETURNING id`,
    [`${tag}@ship.local`],
  );
  const userId = user.rows[0]!.id;

  await realQuery(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [
    workspaceId,
    userId,
  ]);

  let documentId = '';
  for (let i = 0; i < FIXTURE_DOCUMENTS; i++) {
    const doc = await realQuery<{ id: string }>(
      `INSERT INTO documents (workspace_id, document_type, title, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [workspaceId, i % 3 === 0 ? 'issue' : 'wiki', `Baseline document ${i}`, userId],
    );
    if (i === 0) documentId = doc.rows[0]!.id;
  }

  const sessionId = crypto.randomBytes(32).toString('hex');
  await realQuery(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '2 hours')`,
    [sessionId, userId, workspaceId],
  );

  return { workspaceId, userId, sessionCookie: `session_id=${sessionId}`, documentId };
}

async function destroyFixture(f: Fixture): Promise<void> {
  // Ordered by FK dependency; `workspaces` does not cascade to `users`.
  await realQuery(`DELETE FROM sessions WHERE user_id = $1`, [f.userId]);
  await realQuery(`DELETE FROM documents WHERE workspace_id = $1`, [f.workspaceId]);
  await realQuery(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [f.workspaceId]);
  await realQuery(`DELETE FROM workspaces WHERE id = $1`, [f.workspaceId]);
  await realQuery(`DELETE FROM users WHERE id = $1`, [f.userId]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

  const app = createApp();
  const fixture = await createFixture();

  const routes: Record<
    string,
    {
      method: string;
      path: string;
      status: number;
      samples: number;
      latencyMs: { p50: number; p95: number; p99: number; min: number; max: number; mean: number };
      queriesPerRequest: number;
      note: string;
    }
  > = {};

  try {
    for (const route of ROUTES) {
      // The concrete URL is what gets requested; `route.path` is what gets
      // recorded. A fixture UUID in the output would change on every run and
      // make a diff of two baselines unreadable.
      const path = route.path === '__DOC__' ? `/api/documents/${fixture.documentId}` : route.path;
      const recordedPath = route.path === '__DOC__' ? '/api/documents/:id' : route.path;

      const send = () => {
        const req = request(app).get(path);
        return route.auth ? req.set('Cookie', fixture.sessionCookie) : req;
      };

      // Warm-up, discarded.
      let status = 0;
      for (let i = 0; i < WARMUP; i++) {
        const res = await send();
        status = res.status;
      }

      if (status >= 400) {
        throw new Error(
          `${route.id} answered ${status} during warm-up. A baseline taken against an erroring route ` +
            `measures the error path. Fix the fixture or drop the route from ROUTES — do not record it.`,
        );
      }

      // Query count: one clean request, counted on its own.
      queryCount = 0;
      counting = true;
      await send();
      counting = false;
      const queriesPerRequest = queryCount;

      // Latency.
      const durations: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const started = performance.now();
        await send();
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);

      routes[route.id] = {
        method: route.method,
        path: recordedPath,
        status,
        samples: SAMPLES,
        latencyMs: {
          p50: round(percentile(durations, 50)),
          p95: round(percentile(durations, 95)),
          p99: round(percentile(durations, 99)),
          min: round(durations[0]!),
          max: round(durations[durations.length - 1]!),
          mean: round(durations.reduce((a, b) => a + b, 0) / durations.length),
        },
        queriesPerRequest,
        note: route.note,
      };

      console.log(
        `  ${route.id.padEnd(26)} p95 ${String(routes[route.id]!.latencyMs.p95).padStart(7)} ms   ` +
          `${String(queriesPerRequest).padStart(2)} quer${queriesPerRequest === 1 ? 'y' : 'ies'}`,
      );
    }
  } finally {
    await destroyFixture(fixture);
  }

  const bundle = measureBundle();
  const allP95 = Object.values(routes).map((r) => r.latencyMs.p95);
  const totalQueries = Object.values(routes).reduce((a, r) => a + r.queriesPerRequest, 0);

  const baseline = {
    $schema: 'https://ship.internal/schemas/baseline-part1.json',
    _comment:
      'GENERATED by api/src/scripts/measure-baseline.ts (PF-020). The denominator for the +10% ' +
      'regression budget on MVP gate item 9 (PRD p.2, targets p.6). Do not hand-edit — re-run the script.',
    capturedAt: new Date().toISOString(),
    gitRef: process.env.GIT_SHA ?? currentGitSha(),
    method: {
      transport: 'in-process (supertest), no TCP — a before/after pair, not a production SLO',
      samplesPerRoute: SAMPLES,
      warmupPerRoute: WARMUP,
      percentile: 'nearest-rank',
      fixtureDocuments: FIXTURE_DOCUMENTS,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cpuCount: (await import('node:os')).cpus().length,
    },
    budget: {
      maxRegressionPercent: 10,
      appliesTo: ['latencyMs.p95 per route', 'bundle.totalGzipBytes', 'queriesPerRequest per route'],
      source: 'PRD p.2 (MVP gate item 9), p.6 (Performance Targets)',
    },
    summary: {
      routeCount: Object.keys(routes).length,
      worstP95Ms: Math.max(...allP95),
      totalQueriesAcrossRoutes: totalQueries,
      bundleTotalGzipBytes: bundle.totalGzipBytes,
    },
    routes,
    bundle,
  };

  writeFileSync(OUTPUT, JSON.stringify(baseline, null, 2) + '\n');

  console.log(`\n  bundle  ${bundle.totalBytes} B raw / ${bundle.totalGzipBytes} B gzip across ${bundle.fileCount} files`);
  console.log(`  wrote   ${OUTPUT}`);

  await pool.end();

  // Explicit exit. `createApp()` starts things that outlive the measurement —
  // the CAIA initialiser's timers among them — so the event loop stays alive
  // after the last request and the process hangs with the file already written.
  // A script L26's PF-802 runs in CI must terminate; hanging at 100% success
  // looks identical to hanging at a failure.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
