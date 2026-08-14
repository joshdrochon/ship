/**
 * Shared measurement for the +10% regression budget (PRD p.2 gate item 9, p.6).
 *
 * Extracted from `measure-baseline.ts` (PF-020) by PF-802 so that the two sides of
 * the comparison cannot drift apart. `measure-baseline.ts` writes the denominator;
 * `compare-baseline.ts` measures the numerator. If each owned its own copy of the
 * route list, the sample count, the percentile rule or the bundle glob, then a
 * later edit to one would silently redefine what "+10%" means — the delta would
 * still compute, and it would be comparing two different experiments.
 *
 * The schema of the file this produces is documented in `docs/baseline-schema.md`,
 * which both scripts cite. That document is the single place PF-802 requires.
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
 * count, so this builds a fixed fixture (one workspace, one user, one session,
 * FIXTURE_DOCUMENTS documents and issues), measures against it, and deletes it.
 * Two runs on two machines then differ by the machine, not by what happened to be
 * in the database. This is also why a measurement taken straight after `pnpm test`
 * is still valid: the suite TRUNCATEs, but the fixture is built after that and the
 * measured routes only ever see fixture rows.
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
import { Agent } from 'node:http';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { createApp } from '../../app.js';
import { pool } from '../../db/client.js';
import { REPO, WEB_DIST } from './perf-paths.js';

export { BASELINE_PATH, REPO, WEB_DIST } from './perf-paths.js';

/** Requests per route that count toward the percentile. */
export const SAMPLES = 60;

/**
 * How many independent 60-sample passes each route gets. The reported p95 is
 * the MEDIAN of the per-pass p95 values, not one pass's.
 *
 * PF-806. One pass cannot resolve a ±10% budget on this workload. Measured on
 * an idle machine, the SAME code three times running gave `GET /api/issues`
 * p95 of 5.12, 9.29 and 7.24 ms — an 81% spread against a 10% gate. A
 * single-pass comparison therefore reports the machine, not the diff, and it
 * does so in both directions: the first `--strict-latency` run that ever went
 * green was as meaningless as the four that failed after it.
 *
 * Five passes because that is where the median stopped moving between repeats
 * here; it is not a magic number, and `PERF_TRIALS` exists so a noisier or
 * quieter machine can say so. Sampling harder inside one pass does not fix
 * this — the variance is between passes, from scheduling and cache state, not
 * within them.
 */
export const TRIALS = Math.max(1, Number(process.env.PERF_TRIALS ?? 5));
/** Requests per route discarded first — JIT warm-up, pool fill, plan caching. */
export const WARMUP = 15;
/** Rows the list endpoints page over. Fixed so the numbers are comparable. */
export const FIXTURE_DOCUMENTS = 25;

export interface RouteSpec {
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
export const ROUTES: RouteSpec[] = [
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
// types — the shape of docs/baseline-part1.json. See docs/baseline-schema.md.
// ---------------------------------------------------------------------------

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

export interface RouteMeasurement {
  method: string;
  path: string;
  status: number;
  samples: number;
  latencyMs: LatencyStats;
  queriesPerRequest: number;
  note: string;
  /**
   * How many independent passes produced `latencyMs`, and the spread of the
   * per-pass p95 values it is the median of. Optional: baselines captured
   * before PF-806 are single-pass and carry neither.
   *
   * `p95Trials` is the honesty check on the headline number. If those values
   * are 5.11 and 10.80, the median is real but the budget comparison against
   * it is not, and the reader can see that without re-running anything.
   */
  trials?: number;
  p95Trials?: number[];
}

export interface BundleMeasurement {
  totalBytes: number;
  totalGzipBytes: number;
  javascriptBytes: number;
  javascriptGzipBytes: number;
  cssBytes: number;
  cssGzipBytes: number;
  fileCount: number;
  largestChunks: { file: string; bytes: number; gzipBytes: number }[];
}

/**
 * The environment fingerprint. Recorded by PF-020 and *read* by PF-803's
 * comparator: latency is only comparable between two runs on the same machine
 * class, and this is what lets the comparator know whether it is.
 */
export interface MethodBlock {
  transport: string;
  samplesPerRoute: number;
  /**
   * Independent passes per route, the median of whose p95s is reported.
   * Optional: baselines captured before PF-806 are single-pass.
   */
  trialsPerRoute?: number;
  warmupPerRoute: number;
  percentile: string;
  fixtureDocuments: number;
  node: string;
  platform: string;
  cpuCount: number;
  /**
   * 1-minute load average at the end of the run, and that figure divided by
   * `cpuCount`. Optional: baselines captured before PF-802 do not carry them.
   *
   * Added because the platform/node/cpuCount fingerprint turned out to be
   * necessary but not sufficient. Measured on 2026-08-13: three consecutive runs
   * of this script, same commit, same machine, produced P95 spreads of up to 6x
   * per route while query counts stayed bit-identical — because the machine was
   * at load 13.25 on 10 cores. A fingerprint match says "same box"; it does not
   * say "the box was idle enough to time anything on".
   */
  loadAvg1?: number;
  loadRatio?: number;
}

export interface BudgetBlock {
  maxRegressionPercent: number;
  appliesTo: string[];
  source: string;
}

export interface SummaryBlock {
  routeCount: number;
  worstP95Ms: number;
  totalQueriesAcrossRoutes: number;
  bundleTotalGzipBytes: number;
}

export interface Baseline {
  $schema: string;
  _comment: string;
  capturedAt: string;
  gitRef: string | null;
  method: MethodBlock;
  budget: BudgetBlock;
  summary: SummaryBlock;
  routes: Record<string, RouteMeasurement>;
  bundle: BundleMeasurement;
}

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
export function currentGitSha(): string | null {
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
export function percentile(sortedMs: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedMs.length);
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, rank - 1))]!;
}

export function round(n: number, dp = 2): number {
  return Number(n.toFixed(dp));
}

// ---------------------------------------------------------------------------
// bundle size
// ---------------------------------------------------------------------------

export function measureBundle(): BundleMeasurement {
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
// the measurement
// ---------------------------------------------------------------------------

export async function describeMethod(): Promise<MethodBlock> {
  const os = await import('node:os');
  const cpuCount = os.cpus().length;
  const loadAvg1 = round(os.loadavg()[0]!, 2);
  return {
    transport:
      'one app.listen(0) for the run, one kept-alive loopback socket (PF-806) — ' +
      'a before/after pair, not a production SLO. NOT comparable to a baseline ' +
      'captured with the old per-request supertest bind.',
    samplesPerRoute: SAMPLES,
    trialsPerRoute: TRIALS,
    warmupPerRoute: WARMUP,
    percentile: 'nearest-rank, median across trials',
    fixtureDocuments: FIXTURE_DOCUMENTS,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuCount,
    loadAvg1,
    loadRatio: round(loadAvg1 / cpuCount, 2),
  };
}

/**
 * Drive every route in ROUTES against a freshly built fixture and return the
 * per-route latency and query-count measurements. The fixture is torn down in a
 * `finally`, so a throw mid-run does not leave rows behind that would move the
 * next run's list-endpoint numbers.
 *
 * @param onRoute called after each route, for progress output.
 */
export async function measureRoutes(
  onRoute?: (id: string, m: RouteMeasurement) => void,
): Promise<Record<string, RouteMeasurement>> {
  const app = createApp();
  const fixture = await createFixture();
  const routes: Record<string, RouteMeasurement> = {};

  // PF-806 — ONE listener and ONE kept-alive socket for the whole run.
  //
  // This used to be `request(app)` per call, which makes supertest bind a fresh
  // ephemeral server, accept one connection and tear both down — for EVERY
  // sampled request, inside the timed region. Two consequences, and the second
  // is why the budget was unmeasurable:
  //
  //   · at 25 trials the run died with ECONNRESET. 25 x 60 x 6 routes is 9000
  //     listen/close pairs, and the ephemeral port range does not recycle
  //     through TIME_WAIT that fast.
  //
  //   · the bind/accept/close cost was being MEASURED as route latency. It is
  //     scheduler-dependent and swamps the routes it is measuring: per-trial
  //     p95 spread on unchanged code was 21-87% against a 10% budget, and
  //     `GET /health` — which runs no query and touches no database — moved
  //     32% between runs of identical code.
  //
  // Binding once and reusing a keep-alive socket takes connection setup out of
  // the measurement entirely. It does introduce a real loopback TCP hop, so
  // `describeMethod().transport` says so: these numbers are not comparable to a
  // baseline captured by the old in-process path, which is why the Part 1
  // baseline is re-captured with this same code rather than reused.
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('perf: server did not bind a port');
  const base = `http://127.0.0.1:${addr.port}`;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });

  try {
    for (const route of ROUTES) {
      // The concrete URL is what gets requested; `route.path` is what gets
      // recorded. A fixture UUID in the output would change on every run and
      // make a diff of two baselines unreadable.
      const path = route.path === '__DOC__' ? `/api/documents/${fixture.documentId}` : route.path;
      const recordedPath = route.path === '__DOC__' ? '/api/documents/:id' : route.path;

      const send = () => {
        const req = request(base).get(path).agent(agent);
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

      // Latency. TRIALS independent passes, each of SAMPLES requests; the
      // reported statistic is the MEDIAN across passes, per percentile.
      //
      // Taking the median of per-pass p95s rather than the p95 of all pooled
      // samples is deliberate. Pooling would let one bad pass — a GC pause, a
      // scheduler migration, Spotlight waking up — pull the combined tail up
      // and be indistinguishable from a real regression. The median across
      // passes discards that pass entirely, which is the whole point.
      const perTrial: LatencyStats[] = [];
      for (let t = 0; t < TRIALS; t++) {
        const durations: number[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          const started = performance.now();
          await send();
          durations.push(performance.now() - started);
        }
        durations.sort((a, b) => a - b);
        perTrial.push({
          p50: percentile(durations, 50),
          p95: percentile(durations, 95),
          p99: percentile(durations, 99),
          min: durations[0]!,
          max: durations[durations.length - 1]!,
          mean: durations.reduce((a, b) => a + b, 0) / durations.length,
        });
      }

      const medianOf = (pick: (s: LatencyStats) => number): number => {
        const xs = perTrial.map(pick).sort((a, b) => a - b);
        const mid = Math.floor(xs.length / 2);
        return xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
      };

      const measurement: RouteMeasurement = {
        method: route.method,
        path: recordedPath,
        status,
        samples: SAMPLES,
        latencyMs: {
          p50: round(medianOf((s) => s.p50)),
          p95: round(medianOf((s) => s.p95)),
          p99: round(medianOf((s) => s.p99)),
          // min/max stay the true extremes across every pass, not medians of
          // extremes — they exist to show the range the median came out of.
          min: round(Math.min(...perTrial.map((s) => s.min))),
          max: round(Math.max(...perTrial.map((s) => s.max))),
          mean: round(medianOf((s) => s.mean)),
        },
        queriesPerRequest,
        note: route.note,
        trials: TRIALS,
        p95Trials: perTrial.map((s) => round(s.p95)),
      };

      routes[route.id] = measurement;
      onRoute?.(route.id, measurement);
    }
  } finally {
    await destroyFixture(fixture);
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return routes;
}

export function summarize(
  routes: Record<string, RouteMeasurement>,
  bundle: BundleMeasurement,
): SummaryBlock {
  const allP95 = Object.values(routes).map((r) => r.latencyMs.p95);
  return {
    routeCount: Object.keys(routes).length,
    worstP95Ms: Math.max(...allP95),
    totalQueriesAcrossRoutes: Object.values(routes).reduce((a, r) => a + r.queriesPerRequest, 0),
    bundleTotalGzipBytes: bundle.totalGzipBytes,
  };
}
