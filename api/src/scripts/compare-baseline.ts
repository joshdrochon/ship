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
  type RouteMeasurement,
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

interface SelfCheck {
  /** Largest absolute per-route p95 difference between two runs of one tree, %. */
  noisePercent: number;
  /** The route that produced it. */
  worstRoute: string;
  /** The budget it is being judged against. */
  budgetPercent: number;
  /** True when the instrument is quiet enough to enforce that budget. */
  usable: boolean;
  perRoute: { route: string; first: number; second: number; deltaPercent: number }[];
}

/**
 * Compare two measurements of the SAME tree and decide whether the instrument
 * can resolve `budgetPercent`.
 *
 * The comparison is symmetric — `abs` — because noise in either direction is
 * disqualifying. A second run that comes in 30% FASTER is exactly as much
 * evidence that the harness is untrustworthy as one that comes in 30% slower,
 * and only the slower direction would ever have been noticed by a human reading
 * a regression report.
 */
function assessSelfCheck(
  first: Record<string, RouteMeasurement>,
  second: Record<string, RouteMeasurement>,
  budgetPercent: number,
): SelfCheck {
  const perRoute = Object.keys(first)
    .filter((id) => second[id] !== undefined)
    .map((id) => {
      const a = first[id]!.latencyMs.p95;
      const b = second[id]!.latencyMs.p95;
      return {
        route: id,
        first: a,
        second: b,
        deltaPercent: a === 0 ? 0 : Math.abs((b - a) / a) * 100,
      };
    })
    .sort((x, y) => y.deltaPercent - x.deltaPercent);

  const worst = perRoute[0];
  return {
    noisePercent: worst ? Math.round(worst.deltaPercent * 10) / 10 : 0,
    worstRoute: worst?.route ?? '(none)',
    budgetPercent,
    usable: worst === undefined || worst.deltaPercent <= budgetPercent,
    perRoute,
  };
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

  // PF-807 — a baseline measured through a different instrument is not a
  // denominator, it is a second unknown.
  //
  // `transport` is the harness's own fingerprint. When PF-806 replaced the
  // per-request supertest bind with one listener and a keep-alive socket, every
  // number moved — `GET /health` p95 fell from ~0.7ms to ~0.24ms on unchanged
  // code. Comparing across that change would have reported a 65% IMPROVEMENT
  // that nobody earned, and the same mechanism in reverse invents regressions.
  // Re-capture the baseline with the current harness instead of reasoning about
  // which direction the artifact points.
  const baselineTransport = baseline.method?.transport;
  const currentTransport = (await describeMethod()).transport;
  if (baselineTransport !== undefined && baselineTransport !== currentTransport) {
    throw new BaselineError(
      `The baseline was captured through a different measurement path.\n\n` +
        `  baseline: ${baselineTransport}\n` +
        `  current : ${currentTransport}\n\n` +
        `Latency numbers are not comparable across a harness change. Re-capture the ` +
        `baseline at its own commit with THIS harness (check the ref out into a worktree, ` +
        `copy api/src/scripts/lib/ in, run measure-baseline there), then compare. See ` +
        `docs/regression-paired-runs.md.`,
    );
  }

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

  // ── PF-807: the A/A self-check ────────────────────────────────────────────
  //
  // Measure the SAME tree a second time and compare it to the first. Nothing
  // changed between them, so every delta here is the instrument's own noise.
  // If that noise is larger than the budget, this run cannot tell a regression
  // from a scheduler hiccup, and the honest verdict is INCONCLUSIVE — not
  // "within budget", which is what it would have said by luck about half the
  // time.
  //
  // This is the check whose absence cost the MVP. The evidence that failed
  // review reported `GET /health` — a route with no query and no database — as
  // +32%, and once as +108%. One A/A run would have surfaced that instantly,
  // because a route that does nothing cannot regress. Instead the number was
  // trusted, and the three defects under it (a baseline that was not Part 1, a
  // harness timing its own server binds, mismatched rate-limit ceilings)
  // survived behind a green check.
  //
  // Skipped when --current replays a saved measurement: there is only one
  // sample and nothing to re-measure. Skippable with --no-self-check for a
  // quick local look, which is exactly why CI must not pass that flag.
  // The A/A self-check is NOT done here, in-process. Two attempts at that are
  // recorded in docs/regression-paired-runs.md because both failed instructively:
  //
  //   attempt 1 — measure twice, diff. Reported 98.9% "noise" that was not noise:
  //     every database-touching route was slower on the second pass and /health,
  //     which touches none, was faster. A signature, not a spread. `measureRoutes`
  //     builds a fixture and deletes it, so pass two ran against the first pass's
  //     dead tuples.
  //
  //   attempt 2 — VACUUM between passes. Still systematic, and now /health moved
  //     388% too. `measureRoutes` calls `createApp()` per pass and never disposes
  //     it, so the later pass competes with the earlier apps' still-running
  //     timers. No amount of database hygiene fixes that.
  //
  // The real comparison does not have this problem: baseline and current are each
  // measured in their OWN process. The self-check has to reproduce that, so it
  // lives in `scripts/perf-self-check.mjs`, which spawns this script twice with
  // --no-self-check --measure-out and diffs the two artifacts. A guard that fires
  // on its own setup is worse than no guard, because it gets deleted.
  const selfCheck = undefined as SelfCheck | undefined;

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
  if (selfCheck !== undefined) {
    console.log(
      `  noise      ${selfCheck.noisePercent}% (${selfCheck.worstRoute}) — same tree, measured twice`,
    );
  }
  console.log(`  report     ${outPath}`);
  console.log('');

  // PF-807 — the instrument gets judged before the tree does.
  //
  // Ordering matters: this runs BEFORE `report.ok` is consulted, so a noisy run
  // can never be reported as a pass. The failure that reached review was a pass
  // reported by an instrument that could not have detected the thing it was
  // clearing.
  if (selfCheck !== undefined && !selfCheck.usable) {
    console.error(
      `  INCONCLUSIVE — the measurement cannot resolve a +${selfCheck.budgetPercent}% budget.\n`,
    );
    console.error(
      `  Measuring the same tree twice moved ${selfCheck.worstRoute} by ` +
        `${selfCheck.noisePercent}%. Nothing changed between those two runs, so that ` +
        `figure is the instrument's noise, and it is larger than the budget it is being\n` +
        `  asked to enforce. Any verdict from this run — pass OR fail — would be luck.\n`,
    );
    for (const r of selfCheck.perRoute.slice(0, 6)) {
      console.error(
        `    ${r.route.padEnd(28)} ${String(r.first).padStart(7)} → ${String(r.second).padStart(7)} ms  ` +
          `${r.deltaPercent.toFixed(1)}%`,
      );
    }
    console.error(
      `\n  Quieten the machine and re-run, or raise PERF_TRIALS (currently ` +
        `${process.env.PERF_TRIALS ?? '5'}) so each p95 is a median over more passes.\n` +
        `  scripts/perf-paired-runs.sh is the protocol for a machine that will not go quiet.\n`,
    );
    await pool.end();
    process.exit(2);
  }

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
