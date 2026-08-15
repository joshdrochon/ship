/**
 * PF-802 / PF-803 — the +10% regression comparator, as pure functions.
 *
 * MVP gate item 9 (PRD p.2, verbatim):
 *
 *   "Existing Playwright regression suite passes on main; P95 latency, bundle size,
 *    and per-route query counts within +10% of the Part 1 baseline."
 *
 * and p.6's Performance Targets row:
 *
 *   "Telemetry / regression vs Part 1 baseline — ≤ +10% on P95, bundle size, query counts"
 *
 * Everything here is deliberately I/O-free so the failure modes can be tested
 * directly rather than by doctoring files on disk: `compare-baseline.ts` is the
 * CLI shell, and `perf-compare.test.ts` drives these functions.
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 * L01's audit note flagged the handoff between the lane that CAPTURES the
 * baseline (PF-020) and the lane that ENFORCES it (this one) as a possible gap
 * between lanes. It was one: `docs/baseline-part1.json` was written and nothing
 * read it. The failure mode that matters is not a missing job — it is a job that
 * runs, finds no baseline, and reports success. Hence `loadBaseline` throws on
 * every degenerate input rather than returning a default, and hence
 * `assertComparable` rejects a baseline whose route set does not match the one
 * being measured. A comparator with nothing to compare against must be red.
 *
 * The schema both sides cite is `docs/baseline-schema.md`.
 */
import type { Baseline, BundleMeasurement, RouteMeasurement } from './perf-measure.js';

/** Thrown for every unusable-baseline condition. Never caught into a pass. */
export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineError';
  }
}

export type MetricKind = 'p95' | 'bundle' | 'queries';

export type DeltaStatus =
  /** Within budget, enforced. */
  | 'pass'
  /** Over budget on an enforced metric. Fails the job. */
  | 'fail'
  /** Over or under budget, but not enforced here (see `advisoryReason`). */
  | 'advisory';

export interface Delta {
  kind: MetricKind;
  /** Human label: the metric and, where applicable, the route it belongs to. */
  label: string;
  /** Route id for per-route metrics, `null` for whole-bundle metrics. */
  route: string | null;
  unit: string;
  baseline: number;
  current: number;
  /**
   * Percentage change from baseline. `null` when the baseline is 0 and the
   * current value is greater — the change is unbounded and no finite percentage
   * describes it. That case is always a regression; see `unboundedRegression`.
   */
  percent: number | null;
  /** Baseline was 0 and current is > 0. `/health` at 0 queries makes this reachable. */
  unboundedRegression: boolean;
  status: DeltaStatus;
  advisoryReason?: string;
}

export interface EnvComparison {
  comparable: boolean;
  /** Populated when `comparable` is false — one line per differing dimension. */
  differences: string[];
  baseline: { platform: string; node: string; cpuCount: number };
  current: { platform: string; node: string; cpuCount: number };
}

/**
 * Above this 1-minute-load-average-per-core ratio, in-process latency is not
 * worth timing.
 *
 * 0.8 rather than 1.0 because the measurement itself occupies roughly one core,
 * so a machine already at 0.8 is fully subscribed once this script is on it.
 * Measured justification, not a guess: on 2026-08-13 at load 13.25 on 10 cores
 * (ratio 1.33), three consecutive runs of the same commit produced per-route P95
 * spreads up to 6x — 60 times the +10% budget — while query counts stayed
 * bit-identical across all three. Enforcing a 10% budget through that much noise
 * produces failures unrelated to the diff, and a perf job that cries wolf is
 * disabled within a week.
 */
export const MAX_LOAD_RATIO = 0.8;

export interface LoadCheck {
  /** False when the machine was too busy for the latency numbers to mean anything. */
  acceptable: boolean;
  /** Undefined for baselines/measurements captured before load was recorded. */
  loadAvg1?: number;
  loadRatio?: number;
  reason?: string;
}

/**
 * Was the machine quiet enough for the latency measurement to mean anything?
 *
 * The platform/node/cpuCount fingerprint answers "same box". This answers "was
 * the box idle enough to time on" — which turned out to be the question that
 * actually decides whether a latency delta is signal.
 */
export function checkLoad(current: CurrentMeasurement): LoadCheck {
  const { loadAvg1, loadRatio, cpuCount } = current.method;
  if (loadAvg1 === undefined || loadRatio === undefined) {
    return {
      acceptable: false,
      reason:
        'this measurement records no load average, so there is no evidence the machine was ' +
        'idle enough to time on (re-measure with a build that records it)',
    };
  }
  if (loadRatio > MAX_LOAD_RATIO) {
    return {
      acceptable: false,
      loadAvg1,
      loadRatio,
      reason:
        `machine under load: 1-minute load average ${loadAvg1} across ${cpuCount} cores ` +
        `(ratio ${loadRatio}, limit ${MAX_LOAD_RATIO}). In-process latency measured on a ` +
        `contended machine describes the contention`,
    };
  }
  return { acceptable: true, loadAvg1, loadRatio };
}

/**
 * The three answers this report can give about the +10% budget.
 *
 * `indeterminate` exists because the second one was previously spelled `pass`.
 * A run whose latency was vetoed emitted `ok: true` and `failures: []` — a clean
 * green on the artifact a grader opens — while the P95 half of PRD p.2 gate item 9
 * had not been judged at all. An unjudged budget is not a passed budget.
 */
export type Verdict = 'pass' | 'fail' | 'indeterminate';

export interface ComparisonReport {
  budgetPercent: number;
  baselineCapturedAt: string;
  baselineGitRef: string | null;
  currentGitRef: string | null;
  comparedAt: string;
  env: EnvComparison;
  load: LoadCheck;
  latencyEnforced: boolean;
  /** True when latency was enforced only because `--strict-latency` overrode a veto. */
  latencyForced: boolean;
  deltas: Delta[];
  failures: Delta[];
  /**
   * Metrics that were measured but NOT judged against the budget on this run.
   *
   * Mirrors `failures` deliberately: a reader who scans for "is anything wrong"
   * by checking one array should find the other in the same shape right next to
   * it. An empty `failures` alongside a populated `unjudged` is not a pass.
   */
  unjudged: Delta[];
  /**
   * `pass` — every budget in this report was judged and met.
   * `fail` — something judged exceeded its budget.
   * `indeterminate` — nothing exceeded its budget, but not every budget was judged.
   */
  verdict: Verdict;
  /**
   * True only when `verdict === 'pass'`.
   *
   * Kept boolean on purpose. A tri-state string here would be truthy in every
   * naive `if (report.ok)` consumer, so `"indeterminate"` would read as success
   * in exactly the code paths this field exists to protect. False is the safe
   * value for a consumer that has not been taught about `verdict`.
   */
  ok: boolean;
  /** What the measurement ran against — stated, per the standing measurement warning. */
  databaseState: string;
}

export interface CurrentMeasurement {
  routes: Record<string, RouteMeasurement>;
  bundle: BundleMeasurement;
  method: Baseline['method'];
  gitRef: string | null;
  /** Free text describing the database the routes were measured against. */
  databaseState: string;
}

// ---------------------------------------------------------------------------
// loading and validating the denominator
// ---------------------------------------------------------------------------

const REQUIRED_ROUTE_FIELDS: (keyof RouteMeasurement)[] = ['latencyMs', 'queriesPerRequest', 'path'];

/**
 * Parse and validate `docs/baseline-part1.json`.
 *
 * PF-802's acceptance criterion is that this fails loudly on a missing, empty or
 * schema-mismatched baseline rather than passing vacuously. Every `throw` below
 * is one of those cases; there is no branch that returns a usable default.
 *
 * @param raw file contents, or `null` when the file does not exist
 * @param path where it was looked for, for the error message
 */
export function loadBaseline(raw: string | null, path: string): Baseline {
  if (raw === null) {
    throw new BaselineError(
      `No baseline at ${path}.\n\n` +
        `The +10% regression budget (PRD p.2 gate item 9, p.6) has no denominator, so there is ` +
        `nothing to compare against and this check cannot pass. Capture one with:\n\n` +
        `    pnpm build:web && pnpm baseline:measure\n\n` +
        `This is deliberately fatal. A perf job that finds no baseline and reports success is ` +
        `the exact failure PF-802 exists to prevent.`,
    );
  }

  if (raw.trim() === '') {
    throw new BaselineError(`Baseline at ${path} is empty (0 bytes of content). Re-run \`pnpm baseline:measure\`.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BaselineError(
      `Baseline at ${path} is not valid JSON: ${(err as Error).message}. Re-run \`pnpm baseline:measure\`.`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BaselineError(`Baseline at ${path} is not a JSON object. See docs/baseline-schema.md.`);
  }

  const b = parsed as Partial<Baseline>;

  const missing: string[] = [];
  for (const key of ['capturedAt', 'method', 'budget', 'routes', 'bundle'] as const) {
    if (b[key] === undefined) missing.push(key);
  }
  if (missing.length > 0) {
    throw new BaselineError(
      `Baseline at ${path} is missing required top-level key(s): ${missing.join(', ')}.\n` +
        `See docs/baseline-schema.md for the required shape. Re-run \`pnpm baseline:measure\`.`,
    );
  }

  if (typeof b.budget!.maxRegressionPercent !== 'number' || !Number.isFinite(b.budget!.maxRegressionPercent)) {
    throw new BaselineError(
      `Baseline at ${path} has no usable budget.maxRegressionPercent. The budget is the whole point ` +
        `of the file; a baseline that does not state it cannot be enforced.`,
    );
  }

  if (typeof b.bundle!.totalGzipBytes !== 'number' || b.bundle!.totalGzipBytes <= 0) {
    throw new BaselineError(
      `Baseline at ${path} has bundle.totalGzipBytes = ${String(b.bundle!.totalGzipBytes)}. ` +
        `A zero or absent bundle figure means one of the three budgeted metrics has no denominator.`,
    );
  }

  const routeIds = Object.keys(b.routes!);
  if (routeIds.length === 0) {
    throw new BaselineError(
      `Baseline at ${path} records zero routes. P95 latency and per-route query counts both have no ` +
        `denominator, so two of the three budgeted metrics are unenforceable. Re-run \`pnpm baseline:measure\`.`,
    );
  }

  for (const id of routeIds) {
    const r = b.routes![id] as Partial<RouteMeasurement> | undefined;
    if (r === undefined || typeof r !== 'object') {
      throw new BaselineError(`Baseline route "${id}" at ${path} is not an object.`);
    }
    for (const field of REQUIRED_ROUTE_FIELDS) {
      if (r[field] === undefined) {
        throw new BaselineError(
          `Baseline route "${id}" at ${path} is missing "${String(field)}". See docs/baseline-schema.md.`,
        );
      }
    }
    if (typeof r.latencyMs!.p95 !== 'number' || !Number.isFinite(r.latencyMs!.p95) || r.latencyMs!.p95 <= 0) {
      throw new BaselineError(
        `Baseline route "${id}" at ${path} has latencyMs.p95 = ${String(r.latencyMs!.p95)}. ` +
          `A non-positive P95 is not a measurement.`,
      );
    }
    if (typeof r.queriesPerRequest !== 'number' || !Number.isInteger(r.queriesPerRequest) || r.queriesPerRequest < 0) {
      throw new BaselineError(
        `Baseline route "${id}" at ${path} has queriesPerRequest = ${String(r.queriesPerRequest)}, ` +
          `which is not a non-negative integer.`,
      );
    }
  }

  return b as Baseline;
}

/**
 * The route sets on both sides must match.
 *
 * A route present in the baseline and absent from the run means the thing being
 * budgeted was not measured — silently dropping it would let a regressing route
 * disappear from the report and the job stay green, which is the same vacuous
 * pass PF-802 rejects, one route at a time.
 */
export function assertComparable(baseline: Baseline, current: CurrentMeasurement): void {
  const baseIds = new Set(Object.keys(baseline.routes));
  const currIds = new Set(Object.keys(current.routes));

  const missing = [...baseIds].filter((id) => !currIds.has(id));
  if (missing.length > 0) {
    throw new BaselineError(
      `These routes are in the baseline but were not measured on this run:\n` +
        missing.map((m) => `    ${m}`).join('\n') +
        `\n\nThe budget covers them and this run cannot speak to them. Either the shared ROUTES list in ` +
        `api/src/scripts/lib/perf-measure.ts changed without the baseline being recaptured, or the run ` +
        `aborted early. Recapture with \`pnpm baseline:measure\` if the route list legitimately changed.`,
    );
  }
}

// ---------------------------------------------------------------------------
// environment fingerprint
// ---------------------------------------------------------------------------

function nodeMajor(v: string): string {
  return v.replace(/^v/, '').split('.')[0] ?? v;
}

/**
 * Latency is only comparable between two runs on the same machine class.
 *
 * The baseline's `method` block records platform, Node version and CPU count for
 * exactly this reason. Comparing a 10-core darwin-arm64 laptop against a 2-core
 * shared ubuntu runner measures the runner, not the code — in either direction:
 * it can hide a real regression behind a faster machine just as easily as it can
 * invent one on a slower machine. Bundle bytes and query counts are deterministic
 * and stay enforced regardless.
 */
export function compareEnvironments(baseline: Baseline, current: CurrentMeasurement): EnvComparison {
  const b = { platform: baseline.method.platform, node: baseline.method.node, cpuCount: baseline.method.cpuCount };
  const c = { platform: current.method.platform, node: current.method.node, cpuCount: current.method.cpuCount };

  const differences: string[] = [];
  if (b.platform !== c.platform) differences.push(`platform: baseline ${b.platform}, current ${c.platform}`);
  if (nodeMajor(b.node) !== nodeMajor(c.node)) differences.push(`node major: baseline ${b.node}, current ${c.node}`);
  if (b.cpuCount !== c.cpuCount) differences.push(`cpuCount: baseline ${b.cpuCount}, current ${c.cpuCount}`);

  return { comparable: differences.length === 0, differences, baseline: b, current: c };
}

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

function makeDelta(
  kind: MetricKind,
  label: string,
  route: string | null,
  unit: string,
  baselineValue: number,
  currentValue: number,
  budgetPercent: number,
  enforced: boolean,
  advisoryReason?: string,
): Delta {
  // A baseline of 0 with any current value above it is an unbounded regression.
  // `/health` records 0 queries per request, so an audit or rate-limit hook that
  // adds one statement to the shared path lands here — and `(1-0)/0` is Infinity,
  // not a number a report can print. Treated as a regression explicitly.
  const unbounded = baselineValue === 0 && currentValue > 0;
  const percent = baselineValue === 0 ? (currentValue === 0 ? 0 : null) : ((currentValue - baselineValue) / baselineValue) * 100;

  const overBudget = unbounded || (percent !== null && percent > budgetPercent);

  let status: DeltaStatus;
  if (!enforced) status = 'advisory';
  else status = overBudget ? 'fail' : 'pass';

  return {
    kind,
    label,
    route,
    unit,
    baseline: baselineValue,
    current: currentValue,
    percent: percent === null ? null : Number(percent.toFixed(2)),
    unboundedRegression: unbounded,
    status,
    ...(advisoryReason !== undefined ? { advisoryReason } : {}),
  };
}

export interface CompareOptions {
  /**
   * Enforce the latency budget even when the environment fingerprint differs
   * from the baseline's. Used for the recorded MVP evidence run, which is taken
   * on a machine matching the baseline.
   */
  strictLatency?: boolean;
  /** Overrides the budget in the baseline file. For testing the boundary only. */
  budgetPercentOverride?: number;
}

export function compare(
  baseline: Baseline,
  current: CurrentMeasurement,
  opts: CompareOptions = {},
): ComparisonReport {
  assertComparable(baseline, current);

  const budgetPercent = opts.budgetPercentOverride ?? baseline.budget.maxRegressionPercent;
  const env = compareEnvironments(baseline, current);
  const load = checkLoad(current);

  // Two independent vetoes on the latency budget, and both have to clear:
  //   - same machine class as the baseline (otherwise we compare boxes)
  //   - that machine quiet enough to time on (otherwise we compare contention)
  // Bundle bytes and query counts are deterministic and answer to neither.
  const latencyComparable = env.comparable && load.acceptable;
  const latencyEnforced = opts.strictLatency === true || latencyComparable;
  const latencyForced = opts.strictLatency === true && !latencyComparable;

  const vetoes: string[] = [];
  if (!env.comparable) {
    vetoes.push(
      `measured on a different machine than the baseline (${env.differences.join('; ')}), ` +
        `so a latency delta here describes the machine as much as the code`,
    );
  }
  if (!load.acceptable && load.reason !== undefined) vetoes.push(load.reason);
  const latencyAdvisoryReason = latencyEnforced ? undefined : vetoes.join('; and ');

  const deltas: Delta[] = [];

  // P95 latency, per route.
  for (const id of Object.keys(baseline.routes)) {
    deltas.push(
      makeDelta(
        'p95',
        `P95 latency · ${id}`,
        id,
        'ms',
        baseline.routes[id]!.latencyMs.p95,
        current.routes[id]!.latencyMs.p95,
        budgetPercent,
        latencyEnforced,
        latencyAdvisoryReason,
      ),
    );
  }

  // Bundle size. One number, gzipped: that is what a browser actually pulls.
  deltas.push(
    makeDelta(
      'bundle',
      'Bundle size · total gzipped',
      null,
      'bytes',
      baseline.bundle.totalGzipBytes,
      current.bundle.totalGzipBytes,
      budgetPercent,
      true,
    ),
  );

  // Query counts, PER ROUTE. p.2 says "per-route query counts"; an aggregate
  // hides a single route that tripled behind five that did not move.
  for (const id of Object.keys(baseline.routes)) {
    deltas.push(
      makeDelta(
        'queries',
        `Queries per request · ${id}`,
        id,
        'queries',
        baseline.routes[id]!.queriesPerRequest,
        current.routes[id]!.queriesPerRequest,
        budgetPercent,
        true,
      ),
    );
  }

  const failures = deltas.filter((d) => d.status === 'fail');
  const unjudged = deltas.filter((d) => d.status === 'advisory');

  // A measured breach outranks an unmeasured budget: if something we DID judge is
  // over, the run failed, and the unjudged rows are additional missing evidence
  // rather than a softener. Otherwise, any unjudged budget makes the whole verdict
  // indeterminate — the report covers three budgets from PRD p.2 and cannot claim
  // success while one of them went unanswered.
  const verdict: Verdict =
    failures.length > 0 ? 'fail' : unjudged.length > 0 ? 'indeterminate' : 'pass';

  return {
    budgetPercent,
    baselineCapturedAt: baseline.capturedAt,
    baselineGitRef: baseline.gitRef,
    currentGitRef: current.gitRef,
    comparedAt: new Date().toISOString(),
    env,
    load,
    latencyEnforced,
    latencyForced,
    deltas,
    failures,
    unjudged,
    verdict,
    ok: verdict === 'pass',
    databaseState: current.databaseState,
  };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function fmtPercent(d: Delta): string {
  if (d.unboundedRegression) return 'unbounded (baseline 0)';
  if (d.percent === null) return 'n/a';
  const sign = d.percent > 0 ? '+' : '';
  return `${sign}${d.percent.toFixed(2)}%`;
}

function statusMark(d: Delta): string {
  if (d.status === 'fail') return 'FAIL';
  if (d.status === 'advisory') return 'advisory';
  return 'pass';
}

/**
 * The one-line message for a failing metric. PF-804 requires it to name the
 * metric, the affected route where applicable, and both numbers — so that a
 * red build says what regressed and by how much without anyone opening an
 * artifact. `d.label` already carries the route for per-route metrics.
 */
export function renderFailure(d: Delta, budgetPercent: number): string {
  return (
    `${d.label}: ${d.current} ${d.unit} vs baseline ${d.baseline} ${d.unit} ` +
    `(${fmtPercent(d)}, budget +${budgetPercent}%)`
  );
}

export function renderMarkdown(report: ComparisonReport): string {
  const L: string[] = [];

  L.push('# Regression budget report — MVP gate item 9');
  L.push('');
  L.push('<!-- GENERATED by `pnpm baseline:compare` (api/src/scripts/compare-baseline.ts).');
  L.push('     Do not hand-edit: re-run the command. Schema: docs/baseline-schema.md. -->');
  L.push('');
  L.push(
    'PRD p.2 gate item 9: *"Existing Playwright regression suite passes on main; P95 latency, bundle ' +
      'size, and per-route query counts within +10% of the Part 1 baseline."* Budget restated on p.6.',
  );
  L.push('');
  const headline: Record<Verdict, string> = {
    pass: `**Result: WITHIN BUDGET** — budget is +${report.budgetPercent}% on each metric, and every metric was judged.`,
    fail: `**Result: OVER BUDGET** — budget is +${report.budgetPercent}% on each metric.`,
    indeterminate:
      `**Result: INDETERMINATE — this run does NOT establish that the budget is met.** ` +
      `${report.unjudged.length} of ${report.deltas.length} metrics were measured but not judged ` +
      `against the +${report.budgetPercent}% budget, so this report is not evidence of a pass. ` +
      `Nothing that *was* judged exceeded its budget.`,
  };
  L.push(headline[report.verdict]);
  L.push('');

  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Baseline captured | ${report.baselineCapturedAt} |`);
  L.push(`| Baseline git ref | \`${report.baselineGitRef ?? 'unknown'}\` |`);
  L.push(`| Compared at | ${report.comparedAt} |`);
  L.push(`| Current git ref | \`${report.currentGitRef ?? 'unknown'}\` |`);
  L.push(`| Database state | ${report.databaseState} |`);
  L.push(
    `| Environment | baseline ${report.env.baseline.platform}, node ${report.env.baseline.node}, ` +
      `${report.env.baseline.cpuCount} cpu · current ${report.env.current.platform}, node ` +
      `${report.env.current.node}, ${report.env.current.cpuCount} cpu |`,
  );
  L.push(
    `| Machine load during run | ${
      report.load.loadAvg1 === undefined
        ? 'not recorded'
        : `${report.load.loadAvg1} over ${report.env.current.cpuCount} cores (ratio ${report.load.loadRatio}, limit ${MAX_LOAD_RATIO})`
    } |`,
  );
  L.push(
    `| Latency budget | ${
      report.latencyForced ? '**enforced (forced by `--strict-latency`)**' : report.latencyEnforced ? '**enforced**' : 'advisory only'
    } |`,
  );
  L.push('');

  if (!report.latencyEnforced) {
    L.push('> **Latency deltas below are advisory on this run**, for the reason(s) below. Bundle size and');
    L.push('> query counts are deterministic — same tree, same numbers, any machine — and stay enforced.');
    L.push('>');
    if (!report.env.comparable) {
      L.push('> *Different machine than the baseline:*');
      for (const d of report.env.differences) L.push(`> - ${d}`);
      L.push('>');
      L.push('> An in-process P95 taken on a different core count and platform describes the machine as');
      L.push('> much as the code, in both directions — it can hide a real regression behind a faster box');
      L.push('> as easily as invent one on a slower box.');
      L.push('>');
    }
    if (!report.load.acceptable) {
      L.push(`> *Machine too busy to time on:* ${report.load.reason}.`);
      L.push('>');
      L.push('> A fingerprint match says "same box"; it does not say "the box was idle enough to time');
      L.push('> anything on". Measured 2026-08-13: at load ratio 1.33, three consecutive runs of one');
      L.push('> commit produced per-route P95 spreads up to 6x while query counts stayed bit-identical.');
      L.push('>');
    }
    L.push('> Re-run on an idle machine matching the baseline to get an enforceable latency verdict.');
    L.push('');
  }

  if (report.latencyForced) {
    L.push('> **`--strict-latency` overrode a veto on this run.** Latency was enforced even though:');
    L.push('>');
    if (!report.env.comparable) for (const d of report.env.differences) L.push(`> - ${d}`);
    if (!report.load.acceptable) L.push(`> - ${report.load.reason}`);
    L.push('>');
    L.push('> A latency **failure** in this report is therefore not by itself evidence of a code');
    L.push('> regression, and a latency **pass** is the stronger claim of the two.');
    L.push('');
  }

  if (report.failures.length > 0) {
    L.push(`## Over budget (${report.failures.length})`);
    L.push('');
    for (const f of report.failures) L.push(`- **${renderFailure(f, report.budgetPercent)}**`);
    L.push('');
  }

  if (report.unjudged.length > 0) {
    L.push(`## Not judged on this run (${report.unjudged.length})`);
    L.push('');
    L.push('These metrics were measured, but the measurement was not trustworthy enough to compare');
    L.push('against the budget, so **no verdict was reached on them** — neither pass nor fail. The');
    L.push('numbers are printed below for information only. Do not read them as a result in either');
    L.push('direction.');
    L.push('');
    for (const d of report.unjudged) {
      L.push(`- ${d.label}: ${d.current} ${d.unit} vs baseline ${d.baseline} ${d.unit} (${fmtPercent(d)}) — **not judged**`);
    }
    L.push('');
  }

  const section = (kind: MetricKind, heading: string, unit: string) => {
    const rows = report.deltas.filter((d) => d.kind === kind);
    if (rows.length === 0) return;
    L.push(`## ${heading}`);
    L.push('');
    L.push(`| Route | Baseline (${unit}) | Current (${unit}) | Delta | Status |`);
    L.push('|---|---:|---:|---:|---|');
    for (const d of rows) {
      L.push(
        `| ${d.route ?? 'total (gzipped)'} | ${d.baseline} | ${d.current} | ${fmtPercent(d)} | ${statusMark(d)} |`,
      );
    }
    L.push('');
  };

  section('p95', 'P95 latency, per route', 'ms');
  section('bundle', 'Bundle size', 'bytes');
  section('queries', 'Queries per request, per route', 'queries');

  L.push('## How these numbers were taken');
  L.push('');
  L.push('Both sides run the same code — `api/src/scripts/lib/perf-measure.ts` — so the route list, sample');
  L.push('counts, percentile rule, fixture and bundle glob cannot drift between the denominator and the');
  L.push('numerator. The app is bound once with `app.listen(0)` and every sample reuses one kept-alive');
  L.push('loopback socket (PF-806) — so the bind/accept/close cost is outside the timed region, but a real');
  L.push('loopback TCP hop is inside it. These are a before/after pair for this repo against itself, not a');
  L.push('production SLO, and they are not comparable to any baseline captured through the older');
  L.push('per-request supertest bind. Each route gets 15 discarded warm-up requests, then `PERF_TRIALS`');
  L.push('independent passes of 60 counted samples; the reported p95 is the nearest-rank p95 of each pass,');
  L.push('taken as the median across passes — pooling samples lets one bad pass pull the combined tail up');
  L.push('and look exactly like a regression. Query counts come from one clean request with the pool');
  L.push('instrumented, so a statement issued inside a transaction is still counted.');
  L.push('');
  L.push('Routes are measured against a purpose-built fixture (one workspace, one user, 25 documents)');
  L.push('created and destroyed by the run, not against seed or developer data — so the numbers do not');
  L.push('move with whatever happened to be in the database.');
  L.push('');

  return L.join('\n') + '\n';
}
