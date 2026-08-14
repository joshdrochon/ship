#!/usr/bin/env node
/**
 * PF-600 / PF-603 / PF-606 — the gates no single run can produce.
 *
 *     node scripts/ttfe/check-series.mjs [--soak]
 *
 * ── Two gates on the < 60 s target, on purpose (PF-600) ────────────────────
 * p.8's example ends on `expect(performance.now() - t0).toBeLessThan(60_000)`
 * and the drill ships that assertion literally. But p.8's TARGET is a P95, which
 * no single run can produce. The per-run assertion catches a regression on the
 * PR that caused it; the P95 over the last `p95WindowRuns` runs catches a slow
 * drift that never trips any individual run. Reporting one and calling it the
 * other is the easiest way to claim this target without meeting it.
 *
 * ── The delivery target nobody else measured (PF-603) ──────────────────────
 * L99's U5: L15's timing assertions all run on `FakeClock` per p.11's no-sleeps
 * rule, and L16's `latency_ms` brackets the HTTP call only — so the drill is the
 * one place an end-to-end `documentCreatedAt → firstPostReceivedAt` exists at
 * all. It is a sample of ONE per run, which is why it needs the same series to
 * be a P95 rather than a mean wearing a P95's name. Stated plainly because it is
 * the weakest of the four targets this lane claims.
 *
 * ── The soak (PF-606) ──────────────────────────────────────────────────────
 * `--soak` asserts `p95WindowRuns` consecutive runs against ONE commit with a
 * pass count of 20 of 20. A failing run is not re-run to clear it; it is
 * diagnosed, and the diagnosis names either the drill or the platform. An
 * unrecorded soak is indistinguishable from a soak nobody ran, so the series
 * file is the record.
 *
 * ── F80 ────────────────────────────────────────────────────────────────────
 * Runs taken above the load-ratio veto are counted for FLAKE (a pass is a pass
 * however loaded the box) and reported separately for TIMING, because a P95
 * assembled from contended samples measures the machine, not the platform.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SERIES = join(REPO_ROOT, 'test-results', 'ttfe-series.jsonl');
const T = JSON.parse(readFileSync(join(REPO_ROOT, 'ttfe.thresholds.json'), 'utf8'));

const soak = process.argv.includes('--soak');

if (!existsSync(SERIES)) {
  fail(`no series at ${SERIES}. Run \`pnpm drill ttfe\` at least once.`);
}

const runs = readFileSync(SERIES, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
  // Only the fast mode is budgeted at 60 s. `--clean` carries its own number and
  // a `mode` field precisely so the two can never be averaged together.
  .filter((run) => run.mode === 'fast');

const window = runs.slice(-T.p95WindowRuns);
if (window.length === 0) fail('the series contains no fast-mode runs.');

/** Nearest-rank P95 — no interpolation, so a 20-sample window has an exact answer. */
function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

const passes = window.filter((run) => run.pass).length;
const certified = window.filter((run) => run.metrics?.loadCertified === true);
const totals = window.filter((run) => run.pass).map((run) => run.totalMs);
const deliveries = window
  .filter((run) => run.pass && typeof run.metrics?.eventToPostMs === 'number')
  .map((run) => run.metrics.eventToPostMs);

const problems = [];

process.stdout.write(`\nTTFE series — ${window.length} run(s) of the last ${T.p95WindowRuns}\n`);
process.stdout.write(`  pass rate            ${passes}/${window.length}\n`);
if (totals.length > 0) {
  process.stdout.write(`  totalMs P95          ${Math.round(p95(totals))} ms  (budget ${T.p95TotalMs})\n`);
}
if (deliveries.length > 0) {
  process.stdout.write(
    `  event→POST P95       ${Math.round(p95(deliveries))} ms  (budget ${T.p95EventToPostMs})\n`,
  );
}
process.stdout.write(
  `  load-certified runs  ${certified.length}/${window.length}  (F80: a P95 from contended samples measures the machine)\n`,
);

if (totals.length > 0 && p95(totals) > T.p95TotalMs) {
  problems.push(
    `totalMs P95 is ${Math.round(p95(totals))} ms against the ${T.p95TotalMs} ms budget in ttfe.thresholds.json`,
  );
}
if (deliveries.length > 0 && p95(deliveries) > T.p95EventToPostMs) {
  problems.push(
    `event→POST P95 is ${Math.round(p95(deliveries))} ms against the ${T.p95EventToPostMs} ms budget ` +
      '(p.6: webhook delivery latency, P95, first attempt)',
  );
}

if (soak) {
  const commits = new Set(window.map((run) => run.commit));
  if (window.length < T.p95WindowRuns) {
    problems.push(
      `--soak needs ${T.p95WindowRuns} consecutive runs; the series holds ${window.length}. ` +
        'A short series is a mean wearing a P95\'s name.',
    );
  }
  if (commits.size !== 1) {
    problems.push(
      `--soak measures ONE commit; this window spans ${commits.size} (${[...commits].join(', ')}). ` +
        'p.9 reads any flake as a bug in the drill or the platform, which is only decidable against a fixed commit.',
    );
  }
  if (passes !== window.length) {
    problems.push(
      `flake rate is ${window.length - passes}/${window.length}, and p.9's target is 0%. ` +
        'Do NOT re-run to clear it — diagnose it, and name either the drill or the platform.',
    );
  }
}

if (problems.length > 0) {
  process.stderr.write('\nttfe series check FAILED:\n');
  for (const problem of problems) process.stderr.write(`  · ${problem}\n`);
  process.stderr.write(`\nThe thresholds are in ttfe.thresholds.json. Argue with the file.\n`);
  process.exit(1);
}

process.stdout.write('\nttfe series check OK\n');

function fail(message) {
  process.stderr.write(`ttfe series check: ${message}\n`);
  process.exit(1);
}
