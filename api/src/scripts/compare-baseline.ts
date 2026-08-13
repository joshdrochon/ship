/**
 * PF-802 / PF-803 / PF-804 — enforce the +10% regression budget.
 *
 *     pnpm baseline:compare                       (from the repo root)
 *     pnpm baseline:compare -- --strict-latency
 *
 * Re-measures P95 latency, bundle size and per-route query counts the same way
 * `measure-baseline.ts` captured them, compares each against
 * `docs/baseline-part1.json`, writes `docs/regression-report.md` (+ `.json`), and
 * **exits non-zero if any enforced metric is more than +10% above baseline**.
 *
 * MVP gate item 9 (PRD p.2): "Existing Playwright regression suite passes on main;
 * P95 latency, bundle size, and per-route query counts within +10% of the Part 1
 * baseline." p.6 restates the budget. p.18's Pre-Search question asks how the
 * budget will be enforced — "manual benchmark, automated baseline comparison,
 * perf job that fails the PR?" — and this script is the third answer.
 *
 * Flags:
 *   --baseline <path>    read the denominator from somewhere else. Used by the
 *                        PF-804 evidence runs, which point it at deliberately
 *                        doctored baselines to show the job actually fails.
 *   --current <path>     skip measuring and load a previously saved measurement.
 *                        Lets one real measurement drive several comparisons.
 *   --measure-out <path> save this run's measurement for later `--current` use.
 *   --out <path>         markdown report destination.
 *   --json-out <path>    machine-readable report destination.
 *   --strict-latency     enforce the latency budget even when the machine does
 *                        not match the baseline's fingerprint.
 *   --db-state <text>    describe what the database held. Recorded in the report.
 *
 * ── The measurement warning ──────────────────────────────────────────────────
 * `pnpm test` TRUNCATEs the database. That does not corrupt this measurement —
 * the routes are driven against a fixture this script creates and destroys, not
 * against seed data — but the state is recorded in the report anyway, because
 * "which database did you measure against" is the first question the number
 * invites and the report should answer it without being asked.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  BASELINE_PATH,
  REPO,
  currentGitSha,
  describeMethod,
  measureBundle,
  measureRoutes,
} from './lib/perf-measure.js';
import {
  BaselineError,
  type CurrentMeasurement,
  compare,
  loadBaseline,
  renderFailure,
  renderMarkdown,
} from './lib/perf-compare.js';
import { pool } from '../db/client.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/**
 * Resolve a path flag against the REPO ROOT, not the process cwd.
 *
 * `pnpm baseline:compare` is run from the repo root but executes with cwd set to
 * `api/` by the pnpm filter, so a relative `--out docs/x.md` would otherwise
 * silently land in `api/docs/` — or, as it did the first time, throw ENOENT
 * after a two-minute measurement had already been taken.
 */
function pathFlag(name: string, fallback: string): string {
  const v = flag(name);
  if (v === undefined) return fallback;
  return isAbsolute(v) ? v : join(REPO, v);
}

async function main(): Promise<void> {
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

  const baselinePath = pathFlag('baseline', BASELINE_PATH);
  const outPath = pathFlag('out', join(REPO, 'docs', 'regression-report.md'));
  const jsonOutPath = pathFlag('json-out', join(REPO, 'docs', 'regression-report.json'));
  const currentPath = flag('current') === undefined ? undefined : pathFlag('current', '');
  const measureOutPath = flag('measure-out') === undefined ? undefined : pathFlag('measure-out', '');
  const strictLatency = has('strict-latency');

  // Load and validate the denominator FIRST. Measuring for two minutes and then
  // discovering there is nothing to compare against wastes the time and, worse,
  // invites someone to "just skip the comparison this once".
  const raw = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : null;
  const baseline = loadBaseline(raw, baselinePath);

  let current: CurrentMeasurement;

  if (currentPath !== undefined) {
    if (!existsSync(currentPath)) {
      throw new BaselineError(`--current ${currentPath} does not exist.`);
    }
    current = JSON.parse(readFileSync(currentPath, 'utf8')) as CurrentMeasurement;
    console.log(`  loaded saved measurement from ${currentPath}`);
  } else {
    console.log(`  measuring against ${process.env.DATABASE_URL?.replace(/:[^:@]*@/, ':***@') ?? '(no DATABASE_URL)'}\n`);
    const routes = await measureRoutes((id, m) => {
      console.log(
        `  ${id.padEnd(26)} p95 ${String(m.latencyMs.p95).padStart(7)} ms   ` +
          `${String(m.queriesPerRequest).padStart(2)} quer${m.queriesPerRequest === 1 ? 'y' : 'ies'}`,
      );
    });
    current = {
      routes,
      bundle: measureBundle(),
      method: await describeMethod(),
      gitRef: process.env.GIT_SHA ?? currentGitSha(),
      databaseState:
        flag('db-state') ??
        'purpose-built fixture (1 workspace, 1 user, 25 documents) created and destroyed by this run',
    };
    if (measureOutPath !== undefined) {
      writeFileSync(measureOutPath, JSON.stringify(current, null, 2) + '\n');
      console.log(`\n  saved measurement to ${measureOutPath}`);
    }
  }

  const report = compare(baseline, current, { strictLatency });

  writeFileSync(outPath, renderMarkdown(report));
  writeFileSync(jsonOutPath, JSON.stringify(report, null, 2) + '\n');

  console.log('');
  console.log(`  baseline   ${baselinePath}`);
  console.log(`  captured   ${report.baselineCapturedAt}  (${report.baselineGitRef ?? 'unknown ref'})`);
  console.log(`  budget     +${report.budgetPercent}% on P95 latency, bundle size, per-route query counts`);
  console.log(
    `  load       ${
      report.load.loadAvg1 === undefined
        ? 'not recorded'
        : `${report.load.loadAvg1} over ${report.env.current.cpuCount} cores (ratio ${report.load.loadRatio})`
    }`,
  );
  console.log(
    `  latency    ${report.latencyForced ? 'ENFORCED (forced by --strict-latency)' : report.latencyEnforced ? 'ENFORCED' : 'advisory'}`,
  );
  if (!report.latencyEnforced || report.latencyForced) {
    for (const d of report.env.differences) console.log(`               - ${d}`);
    if (!report.load.acceptable && report.load.reason !== undefined) {
      console.log(`               - ${report.load.reason}`);
    }
  }
  console.log(`  report     ${outPath}`);
  console.log('');

  if (report.ok) {
    const enforced = report.deltas.filter((d) => d.status !== 'advisory').length;
    console.log(`  WITHIN BUDGET — ${enforced} enforced metric(s) at or under +${report.budgetPercent}%.`);
    await pool.end();
    process.exit(0);
  }

  console.error(`  OVER BUDGET — ${report.failures.length} metric(s) above +${report.budgetPercent}%:\n`);
  for (const f of report.failures) console.error(`    ${renderFailure(f, report.budgetPercent)}`);
  console.error('');
  console.error(`  MVP gate item 9 (PRD p.2) is not satisfied on this tree. See ${outPath}.`);
  await pool.end();
  process.exit(1);
}

main().catch(async (err) => {
  // A BaselineError is the loud failure PF-802 demands: no denominator, no pass.
  if (err instanceof BaselineError) {
    console.error(`\nBASELINE UNUSABLE\n\n${err.message}\n`);
  } else {
    console.error(err);
  }
  try {
    await pool.end();
  } catch {
    /* the pool may never have opened; the exit code is what matters */
  }
  process.exit(1);
});
