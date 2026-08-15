/**
 * PF-802 / PF-803 / PF-804 — the regression-budget comparator.
 *
 * Two things are proven here, and they are the two the tickets ask for:
 *
 *   PF-802  the comparator fails LOUDLY on a missing, empty or schema-mismatched
 *           baseline, rather than passing vacuously. Every degenerate input gets
 *           its own case, because "no denominator" silently becoming "no
 *           regression" is the exact defect this slice exists to close.
 *
 *   PF-804  a deliberate ~11% regression in each of the three metrics IN TURN
 *           fails the comparison, three separate times, each with a message
 *           naming the metric, the affected route where applicable, and both
 *           numbers.
 *
 * These drive `perf-compare.ts` directly rather than the CLI, so no database and
 * no built bundle are needed and the failure modes are reachable without
 * doctoring files on disk. The CLI wrapper's exit codes are proven separately by
 * the recorded evidence runs in `docs/mvp-gate-item-9.md`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Baseline, BundleMeasurement, RouteMeasurement } from './perf-measure.js';
import { BASELINE_PATH } from './perf-paths.js';
import {
  BaselineError,
  type CurrentMeasurement,
  MAX_LOAD_RATIO,
  checkLoad,
  compare,
  compareEnvironments,
  loadBaseline,
  renderFailure,
  renderMarkdown,
} from './perf-compare.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const METHOD: Baseline['method'] = {
  transport: 'in-process (supertest), no TCP — a before/after pair, not a production SLO',
  samplesPerRoute: 60,
  warmupPerRoute: 15,
  percentile: 'nearest-rank',
  fixtureDocuments: 25,
  node: 'v26.5.0',
  platform: 'darwin-arm64',
  cpuCount: 10,
  loadAvg1: 1.2,
  loadRatio: 0.12,
};

function route(p95: number, queries: number, path = '/api/documents'): RouteMeasurement {
  return {
    method: 'GET',
    path,
    status: 200,
    samples: 60,
    latencyMs: { p50: p95 * 0.7, p95, p99: p95 * 1.2, min: p95 * 0.5, max: p95 * 1.3, mean: p95 * 0.75 },
    queriesPerRequest: queries,
    note: 'fixture',
  };
}

function bundle(gzip: number): BundleMeasurement {
  return {
    totalBytes: gzip * 3,
    totalGzipBytes: gzip,
    javascriptBytes: gzip * 3 - 60000,
    javascriptGzipBytes: gzip - 13000,
    cssBytes: 60000,
    cssGzipBytes: 13000,
    fileCount: 300,
    largestChunks: [],
  };
}

/** A baseline shaped like the real one: a 0-query /health plus two real routes. */
function makeBaseline(): Baseline {
  return {
    $schema: 'https://ship.internal/schemas/baseline-part1.json',
    _comment: 'fixture',
    capturedAt: '2026-08-12T20:31:10.713Z',
    gitRef: 'b639059217e96664ba843c1847bc450e21367d31',
    method: METHOD,
    budget: {
      maxRegressionPercent: 10,
      appliesTo: ['latencyMs.p95 per route', 'bundle.totalGzipBytes', 'queriesPerRequest per route'],
      source: 'PRD p.2 (MVP gate item 9), p.6 (Performance Targets)',
    },
    summary: { routeCount: 3, worstP95Ms: 6.93, totalQueriesAcrossRoutes: 10, bundleTotalGzipBytes: 747644 },
    routes: {
      'GET /health': route(0.91, 0, '/health'),
      'GET /api/documents': route(3.63, 3),
      'GET /api/dashboard/my-work': route(6.93, 7, '/api/dashboard/my-work'),
    },
    bundle: bundle(747644),
  };
}

/** A current measurement identical to the baseline — the no-change case. */
function makeCurrent(b: Baseline): CurrentMeasurement {
  return {
    routes: structuredClone(b.routes),
    bundle: structuredClone(b.bundle),
    method: { ...METHOD },
    gitRef: 'deadbeef',
    databaseState: 'purpose-built fixture, 25 documents',
  };
}

// ---------------------------------------------------------------------------
// PF-802 — the baseline must be real, or the run must be red
// ---------------------------------------------------------------------------

describe('PF-802 — an unusable baseline fails loudly rather than passing vacuously', () => {
  const PATH = '/repo/docs/baseline-part1.json';

  it('a MISSING baseline throws, and says how to capture one', () => {
    expect(() => loadBaseline(null, PATH)).toThrow(BaselineError);
    try {
      loadBaseline(null, PATH);
      expect.unreachable('a missing baseline must not load');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(PATH);
      expect(msg).toContain('pnpm baseline:measure');
      // The whole point of the ticket: name the failure mode being prevented.
      expect(msg).toContain('reports success');
    }
  });

  it('an EMPTY baseline throws', () => {
    expect(() => loadBaseline('', PATH)).toThrow(/empty/i);
    expect(() => loadBaseline('   \n  ', PATH)).toThrow(/empty/i);
  });

  it('a non-JSON baseline throws', () => {
    expect(() => loadBaseline('{ not json', PATH)).toThrow(/not valid JSON/i);
  });

  it('a JSON array or literal is not a baseline', () => {
    expect(() => loadBaseline('[]', PATH)).toThrow(/not a JSON object/i);
    expect(() => loadBaseline('null', PATH)).toThrow(/not a JSON object/i);
    expect(() => loadBaseline('42', PATH)).toThrow(/not a JSON object/i);
  });

  it.each(['capturedAt', 'method', 'budget', 'routes', 'bundle'] as const)(
    'a baseline missing "%s" throws a schema-mismatch error naming the key',
    (key) => {
      const b = makeBaseline() as unknown as Record<string, unknown>;
      delete b[key];
      expect(() => loadBaseline(JSON.stringify(b), PATH)).toThrow(new RegExp(`missing required top-level key.*${key}`, 'i'));
    },
  );

  it('a baseline with no budget percentage throws', () => {
    const b = makeBaseline();
    (b.budget as unknown as Record<string, unknown>).maxRegressionPercent = 'ten';
    expect(() => loadBaseline(JSON.stringify(b), PATH)).toThrow(/maxRegressionPercent/);
  });

  it('a baseline with a zero bundle figure throws — one metric would have no denominator', () => {
    const b = makeBaseline();
    b.bundle.totalGzipBytes = 0;
    expect(() => loadBaseline(JSON.stringify(b), PATH)).toThrow(/totalGzipBytes/);
  });

  it('a baseline with ZERO routes throws — two metrics would have no denominator', () => {
    const b = makeBaseline();
    b.routes = {};
    expect(() => loadBaseline(JSON.stringify(b), PATH)).toThrow(/zero routes/i);
  });

  it('a route missing latencyMs or queriesPerRequest throws, naming the route', () => {
    const b1 = makeBaseline();
    delete (b1.routes['GET /api/documents'] as unknown as Record<string, unknown>).latencyMs;
    expect(() => loadBaseline(JSON.stringify(b1), PATH)).toThrow(/GET \/api\/documents.*latencyMs/s);

    const b2 = makeBaseline();
    delete (b2.routes['GET /api/documents'] as unknown as Record<string, unknown>).queriesPerRequest;
    expect(() => loadBaseline(JSON.stringify(b2), PATH)).toThrow(/GET \/api\/documents.*queriesPerRequest/s);
  });

  it('a non-positive P95 or a negative query count is not a measurement', () => {
    const b1 = makeBaseline();
    b1.routes['GET /api/documents']!.latencyMs.p95 = 0;
    expect(() => loadBaseline(JSON.stringify(b1), PATH)).toThrow(/p95/);

    const b2 = makeBaseline();
    b2.routes['GET /api/documents']!.queriesPerRequest = -1;
    expect(() => loadBaseline(JSON.stringify(b2), PATH)).toThrow(/queriesPerRequest/);
  });

  it('the REAL committed baseline loads and is enforceable', () => {
    // Anti-vacuity: every case above proves a rejection. If the validator were
    // simply "throw always", they would all pass and the comparator would never
    // run. This asserts the shipped denominator survives it.
    //
    // BASELINE_PATH comes from `perf-paths.js`, NOT `perf-measure.js`: the
    // latter imports `createApp()`, and pulling that into this worker made three
    // assertions in src/routes/iterations.test.ts fail while this file was in
    // the run. Import the path, not the app.
    const real = loadBaseline(readFileSync(BASELINE_PATH, 'utf8'), BASELINE_PATH);
    expect(real.budget.maxRegressionPercent).toBe(10);
    expect(Object.keys(real.routes).length).toBeGreaterThan(0);
    expect(real.bundle.totalGzipBytes).toBeGreaterThan(0);
  });

  it('a baselined route absent from the current run fails — not silently skipped', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    delete c.routes['GET /api/dashboard/my-work'];
    expect(() => compare(b, c)).toThrow(/GET \/api\/dashboard\/my-work/);
    expect(() => compare(b, c)).toThrow(BaselineError);
  });
});

// ---------------------------------------------------------------------------
// PF-803 — all three metrics, as explicit deltas
// ---------------------------------------------------------------------------

describe('PF-803 — every metric reports current, baseline and percentage delta', () => {
  it('an unchanged tree is within budget and every delta is 0%', () => {
    const b = makeBaseline();
    const report = compare(b, makeCurrent(b));
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    for (const d of report.deltas) expect(d.percent).toBe(0);
  });

  it('emits current, baseline and percent for all three metrics', () => {
    const b = makeBaseline();
    const report = compare(b, makeCurrent(b));

    const kinds = new Set(report.deltas.map((d) => d.kind));
    expect(kinds).toEqual(new Set(['p95', 'bundle', 'queries']));

    for (const d of report.deltas) {
      expect(d).toHaveProperty('baseline');
      expect(d).toHaveProperty('current');
      expect(d).toHaveProperty('percent');
    }
  });

  it('reports query counts PER ROUTE, not aggregated — an aggregate hides one tripled route', () => {
    const b = makeBaseline();
    const report = compare(b, makeCurrent(b));
    const queryDeltas = report.deltas.filter((d) => d.kind === 'queries');

    expect(queryDeltas).toHaveLength(Object.keys(b.routes).length);
    expect(new Set(queryDeltas.map((d) => d.route))).toEqual(new Set(Object.keys(b.routes)));

    // The concrete danger: one route triples while the total barely moves.
    // /health 0->0, documents 3->9, my-work 7->1  =>  total 10 -> 10, unchanged.
    const c = makeCurrent(b);
    c.routes['GET /api/documents']!.queriesPerRequest = 9;
    c.routes['GET /api/dashboard/my-work']!.queriesPerRequest = 1;
    const hidden = compare(b, c);
    expect(hidden.ok).toBe(false);
    expect(hidden.failures.some((f) => f.route === 'GET /api/documents' && f.kind === 'queries')).toBe(true);
  });

  it('improvements are never failures — the budget is one-directional', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.routes['GET /api/documents']!.latencyMs.p95 = 0.5;
    c.routes['GET /api/documents']!.queriesPerRequest = 1;
    c.bundle.totalGzipBytes = 100_000;

    const report = compare(b, c);
    expect(report.ok).toBe(true);
    expect(report.deltas.find((d) => d.kind === 'bundle')!.percent).toBeLessThan(0);
  });

  it('renders a markdown artifact carrying the numbers a grader reads', () => {
    const b = makeBaseline();
    const md = renderMarkdown(compare(b, makeCurrent(b)));
    expect(md).toContain('MVP gate item 9');
    expect(md).toContain('WITHIN BUDGET');
    expect(md).toContain('P95 latency, per route');
    expect(md).toContain('Queries per request, per route');
    expect(md).toContain('Bundle size');
    expect(md).toContain('747644');
  });
});

// ---------------------------------------------------------------------------
// PF-804 — a seeded ~11% regression fails, once per metric
// ---------------------------------------------------------------------------

describe('PF-804 — a deliberate ~11% regression fails the job, in each metric in turn', () => {
  it('METRIC 1/3 · P95 latency +11% on one route fails, naming route and both numbers', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    const before = b.routes['GET /api/documents']!.latencyMs.p95; // 3.63
    const after = Number((before * 1.11).toFixed(2)); // 4.03
    c.routes['GET /api/documents']!.latencyMs.p95 = after;

    const report = compare(b, c);

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    const f = report.failures[0]!;
    expect(f.kind).toBe('p95');
    expect(f.route).toBe('GET /api/documents');
    expect(f.percent).toBeGreaterThan(10);
    expect(f.percent).toBeLessThan(12);

    const msg = renderFailure(f, report.budgetPercent);
    expect(msg).toContain('P95 latency');
    expect(msg).toContain('GET /api/documents');
    expect(msg).toContain(String(after));
    expect(msg).toContain(String(before));
    expect(msg).toContain('budget +10%');
  });

  it('METRIC 2/3 · bundle size +11% fails, naming both numbers', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    const before = b.bundle.totalGzipBytes; // 747644
    const after = Math.round(before * 1.11); // 829785
    c.bundle.totalGzipBytes = after;

    const report = compare(b, c);

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    const f = report.failures[0]!;
    expect(f.kind).toBe('bundle');
    expect(f.route).toBeNull();
    expect(f.percent).toBeCloseTo(11, 1);

    const msg = renderFailure(f, report.budgetPercent);
    expect(msg).toContain('Bundle size');
    expect(msg).toContain(String(after));
    expect(msg).toContain(String(before));
  });

  it('METRIC 3/3 · query count +~11% on one route fails, naming route and both numbers', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    // Query counts are integers, so the smallest real regression on a 7-query
    // route is 7 -> 8, which is +14.3%. That IS the ~11%-class regression this
    // metric can express: there is no fractional query.
    const before = b.routes['GET /api/dashboard/my-work']!.queriesPerRequest; // 7
    const after = before + 1; // 8
    c.routes['GET /api/dashboard/my-work']!.queriesPerRequest = after;

    const report = compare(b, c);

    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    const f = report.failures[0]!;
    expect(f.kind).toBe('queries');
    expect(f.route).toBe('GET /api/dashboard/my-work');
    expect(f.percent).toBeCloseTo(14.29, 1);

    const msg = renderFailure(f, report.budgetPercent);
    expect(msg).toContain('Queries per request');
    expect(msg).toContain('GET /api/dashboard/my-work');
    expect(msg).toContain('8');
    expect(msg).toContain('7');
  });

  it('the boundary holds: exactly +10% passes, a hair over fails', () => {
    const b = makeBaseline();

    const at = makeCurrent(b);
    at.bundle.totalGzipBytes = Math.round(b.bundle.totalGzipBytes * 1.1);
    expect(compare(b, at).ok).toBe(true);

    const over = makeCurrent(b);
    over.bundle.totalGzipBytes = Math.round(b.bundle.totalGzipBytes * 1.1) + 1000;
    expect(compare(b, over).ok).toBe(false);
  });

  it('a query landing on the 0-query /health path is an unbounded regression and always fails', () => {
    // The likeliest regression PlugForge could cause: an audit or rate-limit
    // hook on the shared middleware path. (1-0)/0 is not a printable percentage,
    // so this must be handled explicitly rather than becoming NaN and passing.
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.routes['GET /health']!.queriesPerRequest = 1;

    const report = compare(b, c);
    expect(report.ok).toBe(false);
    const f = report.failures.find((x) => x.route === 'GET /health')!;
    expect(f.unboundedRegression).toBe(true);
    expect(f.percent).toBeNull();
    expect(renderFailure(f, 10)).toContain('unbounded');
  });

  it('all three metrics can fail at once, and all three are reported', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.routes['GET /api/documents']!.latencyMs.p95 *= 1.11;
    c.bundle.totalGzipBytes = Math.round(c.bundle.totalGzipBytes * 1.11);
    c.routes['GET /api/dashboard/my-work']!.queriesPerRequest += 1;

    const report = compare(b, c);
    expect(report.ok).toBe(false);
    expect(new Set(report.failures.map((f) => f.kind))).toEqual(new Set(['p95', 'bundle', 'queries']));

    const md = renderMarkdown(report);
    expect(md).toContain('OVER BUDGET');
    expect(md).toContain('Over budget (3)');
  });
});

// ---------------------------------------------------------------------------
// environment comparability
// ---------------------------------------------------------------------------

describe('latency is enforced only where it is meaningful', () => {
  it('a matching machine enforces all three metrics', () => {
    const b = makeBaseline();
    const report = compare(b, makeCurrent(b));
    expect(report.env.comparable).toBe(true);
    expect(report.latencyEnforced).toBe(true);
    expect(report.deltas.filter((d) => d.status === 'advisory')).toEqual([]);
  });

  it('a different machine downgrades latency to advisory but keeps bundle and queries enforced', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, platform: 'linux-x64', cpuCount: 2 };
    // A latency regression that would fail on a matching machine...
    c.routes['GET /api/documents']!.latencyMs.p95 *= 2;
    // ...and a query regression, which is deterministic and must still fail.
    c.routes['GET /api/dashboard/my-work']!.queriesPerRequest += 1;

    const report = compare(b, c);

    expect(report.env.comparable).toBe(false);
    expect(report.env.differences.join(' ')).toMatch(/platform/);
    expect(report.env.differences.join(' ')).toMatch(/cpuCount/);
    expect(report.latencyEnforced).toBe(false);

    // Latency: reported, not enforced.
    const lat = report.deltas.find((d) => d.kind === 'p95' && d.route === 'GET /api/documents')!;
    expect(lat.status).toBe('advisory');
    expect(lat.percent).toBeCloseTo(100, 0);
    expect(lat.advisoryReason).toMatch(/different machine/);

    // Queries: still enforced, still red.
    expect(report.ok).toBe(false);
    expect(report.failures.every((f) => f.kind !== 'p95')).toBe(true);
    expect(report.failures.some((f) => f.kind === 'queries')).toBe(true);

    // And the report says so, rather than quietly dropping a third of the gate.
    expect(renderMarkdown(report)).toContain('advisory on this run');
  });

  it('--strict-latency enforces latency regardless of the machine', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, platform: 'linux-x64', cpuCount: 2 };
    c.routes['GET /api/documents']!.latencyMs.p95 *= 1.11;

    const report = compare(b, c, { strictLatency: true });
    expect(report.latencyEnforced).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.failures.some((f) => f.kind === 'p95')).toBe(true);
  });

  it('a node PATCH difference is not a machine difference', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, node: 'v26.5.1' };
    expect(compareEnvironments(b, c).comparable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the load guard — F80
// ---------------------------------------------------------------------------

describe('a machine too busy to time on cannot produce an enforceable latency verdict', () => {
  it('an idle machine passes the load check', () => {
    const b = makeBaseline();
    expect(checkLoad(makeCurrent(b)).acceptable).toBe(true);
  });

  it('a SATURATED machine vetoes latency enforcement even when the fingerprint matches', () => {
    // The case measured on 2026-08-13: same box as the baseline, load 13.25 on
    // 10 cores, three runs of one commit spreading up to 6x per route. The
    // platform/node/cpuCount fingerprint matches perfectly and is not enough.
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, loadAvg1: 13.25, loadRatio: 1.33 };
    c.routes['GET /api/documents']!.latencyMs.p95 *= 3;

    const report = compare(b, c);

    expect(report.env.comparable).toBe(true); // same machine...
    expect(report.load.acceptable).toBe(false); // ...but not a quiet one
    expect(report.latencyEnforced).toBe(false);
    expect(report.deltas.find((d) => d.kind === 'p95')!.status).toBe('advisory');
    expect(report.load.reason).toMatch(/under load/);

    // The deterministic metrics are untouched by load and stay enforced — but the
    // run as a whole is NOT a pass, because a third of gate item 9 went unjudged.
    expect(report.verdict).toBe('indeterminate');
    expect(report.ok).toBe(false);
    expect(report.failures).toEqual([]);
    expect(report.unjudged.every((d) => d.kind === 'p95')).toBe(true);

    c.routes['GET /api/documents']!.queriesPerRequest += 2;
    const withQueryRegression = compare(b, c);
    expect(withQueryRegression.verdict).toBe('fail');
    expect(withQueryRegression.ok).toBe(false);
  });

  it('a measurement with no recorded load average cannot be trusted for latency', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, loadAvg1: undefined, loadRatio: undefined };
    const report = compare(b, c);
    expect(report.load.acceptable).toBe(false);
    expect(report.latencyEnforced).toBe(false);
    expect(report.load.reason).toMatch(/no load average/);
  });

  it('--strict-latency can override the load veto, and the report says the pass is the stronger claim', () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, loadAvg1: 13.25, loadRatio: 1.33 };
    c.routes['GET /api/documents']!.latencyMs.p95 *= 3;

    const report = compare(b, c, { strictLatency: true });
    expect(report.latencyEnforced).toBe(true);
    expect(report.latencyForced).toBe(true);
    expect(report.ok).toBe(false);

    const md = renderMarkdown(report);
    expect(md).toContain('overrode a veto');
    expect(md).toContain('not by itself evidence of a code');
  });

  it('the boundary sits at MAX_LOAD_RATIO', () => {
    const b = makeBaseline();
    const at = makeCurrent(b);
    at.method = { ...METHOD, loadAvg1: MAX_LOAD_RATIO * 10, loadRatio: MAX_LOAD_RATIO };
    expect(checkLoad(at).acceptable).toBe(true);

    const over = makeCurrent(b);
    over.method = { ...METHOD, loadAvg1: MAX_LOAD_RATIO * 10 + 1, loadRatio: MAX_LOAD_RATIO + 0.1 };
    expect(checkLoad(over).acceptable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// an unjudged budget is not a passed budget
// ---------------------------------------------------------------------------

describe('a run that did not judge a metric cannot report success on it', () => {
  /**
   * The committed `docs/regression-report.json`, reconstructed.
   *
   * That artifact carried `"ok": true` and `"failures": []` while all six P95 rows
   * sat between +14.29% and +68.36% against a +10% budget — advisory, because
   * loadRatio 0.89 vetoed latency enforcement. The veto was right. Reporting the
   * result of it as a pass was not, and it is the artifact a grader opens to check
   * gate item 9.
   */
  const contendedRun = () => {
    const b = makeBaseline();
    const c = makeCurrent(b);
    c.method = { ...METHOD, loadAvg1: 8.92, loadRatio: 0.89 };
    for (const id of Object.keys(c.routes)) c.routes[id]!.latencyMs.p95 *= 1.6;
    return { b, c };
  };

  it('the exact shape that reached the artifact is no longer a pass', () => {
    const { b, c } = contendedRun();
    const report = compare(b, c);

    expect(report.latencyEnforced).toBe(false);
    expect(report.failures).toEqual([]); // nothing judged was over...
    expect(report.ok).toBe(false); // ...and it is still not a pass
    expect(report.verdict).toBe('indeterminate');
  });

  it('`ok` stays a boolean, so a consumer that never heard of `verdict` still reads false', () => {
    // A tri-state string would be truthy in `if (report.ok)` and would report the
    // indeterminate case as success in precisely the consumers this protects.
    const { b, c } = contendedRun();
    const report = compare(b, c);
    expect(typeof report.ok).toBe('boolean');
    expect(report.ok ? 'pass' : 'not-a-pass').toBe('not-a-pass');
  });

  it('every unjudged metric is listed in `unjudged`, mirroring `failures`', () => {
    const { b, c } = contendedRun();
    const report = compare(b, c);

    expect(report.unjudged).toHaveLength(Object.keys(b.routes).length);
    expect(report.unjudged.every((d) => d.kind === 'p95')).toBe(true);
    expect(report.unjudged.every((d) => d.status === 'advisory')).toBe(true);
    expect(report.unjudged.every((d) => (d.advisoryReason ?? '').includes('under load'))).toBe(true);
    // `unjudged` and `failures` are disjoint and together cover everything not passing.
    expect(report.deltas.filter((d) => d.status === 'pass')).toHaveLength(
      report.deltas.length - report.unjudged.length - report.failures.length,
    );
  });

  it('the markdown a grader reads says INDETERMINATE, not WITHIN BUDGET', () => {
    const { b, c } = contendedRun();
    const md = renderMarkdown(compare(b, c));

    expect(md).toContain('INDETERMINATE');
    expect(md).toContain('does NOT establish that the budget is met');
    expect(md).toContain('Not judged on this run');
    expect(md).not.toContain('WITHIN BUDGET');
  });

  it('a measured breach outranks an unjudged metric — the verdict is fail, not indeterminate', () => {
    const { b, c } = contendedRun();
    c.bundle.totalGzipBytes = Math.round(b.bundle.totalGzipBytes * 1.11);

    const report = compare(b, c);
    expect(report.verdict).toBe('fail');
    expect(report.ok).toBe(false);
    expect(report.unjudged.length).toBeGreaterThan(0);
    expect(renderMarkdown(report)).toContain('OVER BUDGET');
  });

  it('a clean run on a quiet matching machine is still a plain pass', () => {
    // Anti-vacuity: a verdict that can only ever be non-pass is no better than one
    // that can only ever be pass.
    const b = makeBaseline();
    const report = compare(b, makeCurrent(b));

    expect(report.verdict).toBe('pass');
    expect(report.ok).toBe(true);
    expect(report.unjudged).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(renderMarkdown(report)).toContain('WITHIN BUDGET');
  });

  it('--strict-latency does not manufacture a pass — it makes latency judgeable, and it can fail', () => {
    const { b, c } = contendedRun();
    const report = compare(b, c, { strictLatency: true });

    // 1.6x is well over +10%, so forcing enforcement produces failures, not a green.
    expect(report.verdict).toBe('fail');
    expect(report.unjudged).toEqual([]);
    expect(report.failures.some((f) => f.kind === 'p95')).toBe(true);
  });
});
