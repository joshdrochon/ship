#!/usr/bin/env node
/**
 * A/A self-check — can this machine resolve the regression budget at all?
 *
 * Measures the SAME tree four times, each in its own SEPARATE process, in A B B A
 * order, and reports the largest per-route p95 difference between the A mean and
 * the B mean. Nothing changes between the runs, so whatever difference appears is
 * the instrument's own noise. If that noise exceeds the budget, no verdict from a
 * single `baseline:compare` on this machine means anything -- pass or fail, it is
 * luck.
 *
 * The order is what makes the number honest on a shared runner: see the A B B A
 * note further down. Sequential A-then-B attributes every bit of machine drift to
 * B and reports it as noise the tree cannot do anything about.
 *
 * WHY THIS EXISTS
 *
 * The P95 evidence for MVP gate item 9 was accepted, then failed review. Three
 * defects sat underneath it (a baseline that was not Part 1; a harness that
 * timed its own server binds; mismatched rate-limit ceilings), and all three
 * were invisible because nobody ever compared the tree to itself. One A/A run
 * would have shown `GET /health` -- no query, no database -- moving 32%, and a
 * route that does nothing cannot regress.
 *
 * WHY SEPARATE PROCESSES, which is the whole design
 *
 * Doing this in-process does not work, and the two failed attempts are worth
 * keeping because both looked plausible:
 *
 *   1. Measure twice in one process, diff. Reported 98.9% noise that was not
 *      noise: every database route was slower on pass two while /health was
 *      faster. `measureRoutes` builds a fixture and deletes it, so pass two ran
 *      against pass one's dead tuples.
 *
 *   2. VACUUM between passes. Still systematic, and now /health moved 388% as
 *      well -- `measureRoutes` calls `createApp()` per pass and never disposes
 *      it, so later passes compete with earlier apps' live timers.
 *
 * The real comparison measures baseline and current in their own processes.
 * This has to match that or it measures its own setup and fails every run,
 * which is the one behaviour guaranteed to get a guard deleted.
 *
 * Usage:
 *   node scripts/perf-self-check.mjs [--budget 10]
 *
 * Environment: DATABASE_URL is required, and PERF_TRIALS / API_RATE_LIMIT_MAX
 * are passed through so the check runs under the same conditions as the
 * comparison it is vouching for.
 *
 * Exit codes:  0 usable   1 could not run   2 too noisy to enforce the budget
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const budgetIdx = process.argv.indexOf('--budget');
const BUDGET = budgetIdx === -1 ? 10 : Number(process.argv[budgetIdx + 1]);

if (!process.env.DATABASE_URL) {
  console.error('perf-self-check: DATABASE_URL is required.');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'ship-selfcheck-'));

/** One measurement, in its own process, written to `out`. */
function measure(label, out) {
  console.log(`  pass ${label} ...`);
  const r = spawnSync(
    'pnpm',
    [
      '--filter', '@ship/api', 'exec', 'tsx', 'src/scripts/compare-baseline.ts',
      '--no-self-check',
      '--measure-out', out,
      // The comparison itself is irrelevant here; only the measurement is kept.
      // It still needs somewhere to put its report, and that must not be the
      // committed one -- this script must never touch docs/regression-report.md.
      '--out', join(work, `report-${label}.md`),
      '--json-out', join(work, `report-${label}.json`),
    ],
    { cwd: REPO, encoding: 'utf8', env: process.env },
  );
  if (r.status !== 0 && !r.stdout?.includes('measuring against')) {
    console.error(r.stdout ?? '');
    console.error(r.stderr ?? '');
    throw new Error(`perf-self-check: pass ${label} could not measure (exit ${r.status}).`);
  }
  return JSON.parse(readFileSync(out, 'utf8'));
}

try {
  console.log(`\nA/A self-check — same tree, separate processes, budget +${BUDGET}%\n`);

  // FIVE passes, and the first is thrown away.
  //
  // Process isolation alone was not enough: pass B still came in 60% slower
  // than pass A on identical code, and slower on almost every route rather than
  // scattered in both directions. The database is shared even when the
  // processes are not, so the FIRST pass to touch it gets clean tables and no
  // later pass ever does -- `measureRoutes` creates a fixture and deletes it,
  // leaving dead tuples behind each time.
  //
  // Discarding one pass equalises that: every pass that gets compared has run
  // after a fixture cycle. That fixes the DATABASE term.
  measure('warm-up (discarded)', join(work, 'warm.json'));

  // ── A B B A, not A then B ──────────────────────────────────────────────────
  //
  // The warm-up above equalises the database. It does nothing about drift in the
  // MACHINE, and on a shared runner that is the larger term: CI job 68841
  // measured A at 5.97 ms and B at 36.87 ms on identical code, with every route
  // slower on B and `/health` -- no query, no database -- among them. Six-fold,
  // one-directional, on a route that does nothing: that is not random noise a
  // higher sample count averages away, it is the runner getting busier between
  // two passes taken one after the other.
  //
  // A B B A is the standard cancellation for exactly that. Under drift that is
  // linear in time the two A slots and the two B slots have the same mean
  // elapsed offset, so the drift lands identically on both sides and divides
  // out. Sequential A-then-B puts the whole of it on B, which is what the job
  // was reporting as instrument noise.
  //
  // This measures the instrument, so the passes stay untouched otherwise --
  // same command, same process isolation, same fixture cycle as the real
  // comparison. Only their ORDER changes.
  const order = ['A', 'B', 'B', 'A'];
  const samples = { A: [], B: [] };
  order.forEach((side, i) => {
    samples[side].push(measure(`${side} (${i + 1}/${order.length})`, join(work, `p${i}.json`)));
  });

  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const sideP95 = (side, id) =>
    mean(samples[side].filter((s) => s.routes[id]).map((s) => s.routes[id].latencyMs.p95));

  const rows = Object.keys(samples.A[0].routes)
    .filter((id) => samples.A.every((s) => s.routes[id]) && samples.B.every((s) => s.routes[id]))
    .map((id) => {
      const first = sideP95('A', id);
      const second = sideP95('B', id);
      // Symmetric: a pass that comes back 30% FASTER is exactly as much
      // evidence of an untrustworthy instrument as one 30% slower, and only the
      // slower direction would ever be noticed by a human reading a report.
      return { id, first, second, delta: first === 0 ? 0 : Math.abs((second - first) / first) * 100 };
    })
    .sort((x, y) => y.delta - x.delta);

  console.log(`\n  ${'route'.padEnd(30)}${'A'.padStart(9)}${'B'.padStart(9)}${'diff'.padStart(9)}`);
  console.log('  ' + '-'.repeat(57));
  for (const r of rows) {
    console.log(
      `  ${r.id.padEnd(30)}${r.first.toFixed(2).padStart(9)}${r.second.toFixed(2).padStart(9)}` +
        `${(r.delta.toFixed(1) + '%').padStart(9)}`,
    );
  }

  const worst = rows[0];
  const noise = worst ? worst.delta : 0;
  console.log('');

  if (noise > BUDGET) {
    console.error(
      `  TOO NOISY — ${worst.id} moved ${noise.toFixed(1)}% between two runs of identical code.\n\n` +
        `  That is larger than the +${BUDGET}% budget, so a single baseline:compare on this\n` +
        `  machine cannot tell a regression from a scheduler hiccup. Raise PERF_TRIALS\n` +
        `  (currently ${process.env.PERF_TRIALS ?? '5'}), quieten the machine, or use the paired\n` +
        `  protocol in scripts/perf-paired-runs.sh, which re-measures both sides alternately.\n`,
    );
    process.exit(2);
  }

  console.log(
    `  USABLE — worst drift ${noise.toFixed(1)}% on ${worst?.id ?? '(none)'}, under the +${BUDGET}% budget.\n` +
      `  A single comparison on this machine can be trusted to that resolution.\n`,
  );
  process.exit(0);
} finally {
  rmSync(work, { recursive: true, force: true });
}
