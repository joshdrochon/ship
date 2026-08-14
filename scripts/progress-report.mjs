#!/usr/bin/env node
/**
 * Project progress, measured rather than estimated.
 *
 * The unit is the CLAUDE HOUR: how long the remaining work takes me, derived
 * from how fast this project has actually been going. Not a human estimate — a
 * human-day figure would be meaningless here, because the bottleneck is not
 * typing speed. It is verification cycles, container startups, and the round
 * trips where something turns out to be wrong.
 *
 * Velocity comes from git, not from a feeling:
 *
 *   - only commits carrying a `Closes:` trailer count as delivering tickets
 *   - working time is measured by clustering commit timestamps and discarding
 *     any gap longer than IDLE_GAP_MIN, so time asleep or at dinner is not
 *     counted as throughput
 *   - the result is tickets per active hour, projected onto what is left
 *
 * The projection is honest about its own weakness: tickets are not equal. A
 * "commit this file" ticket and a "build a detector with tests" ticket both
 * count as one. Section-weighted figures are reported alongside the raw rate so
 * the difference is visible rather than hidden in an average.
 *
 *   node scripts/progress-report.mjs
 *   node scripts/progress-report.mjs --json
 */

import { readFileSync, appendFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

/**
 * PROJECTS — newest first.
 *
 * This script was written for one board and hardcoded to it: `TICKETS.md`,
 * `FG-\d{3}` ids, `- [ ] **FG-001**` checkboxes, `§M/§E/§F` buckets, and one
 * week's dates. That is fine until the next project, at which point it reports
 * 99% against work nobody is doing and stays silent about the deadline that is
 * actually live.
 *
 * So a project is now a descriptor: how to find its board, how to read a ticket
 * out of it, and which deadline each ticket answers to. `pick()` takes the first
 * whose board exists on disk, so a new week is a new entry rather than an edit
 * to the parser. `--project <id>` overrides.
 *
 * Deadlines are absolute, so a stale run cannot silently report against the
 * wrong week.
 */
const PROJECTS = [
  {
    id: 'plugforge',
    title: 'PLUGFORGE',
    board: 'tickets/plugforge',
    deadlines: [
      { bucket: 'M', label: 'MVP', at: '2026-08-14T11:59:00-05:00' },
      { bucket: 'E', label: 'Early Submission', at: '2026-08-13T23:59:00-05:00' },
      { bucket: 'F', label: 'Final', at: '2026-08-16T11:59:00-05:00' },
    ],
    /**
     * The eleven lanes the MVP gate depends on, from the spine's gate matrix.
     * Everything else answers to Final — the gate cuts across tiers 0–4 only,
     * so webhooks, SDK surface, CLI, drill, portal and the rewire are not due
     * Friday even though they are due Sunday.
     */
    parse() {
      const MVP = new Set(['L01','L02','L03','L04','L06','L07','L08','L09','L13','L17','L21']);
      const dir = join(REPO, 'tickets', 'plugforge');
      const tickets = [];
      for (const f of readdirSync(dir).filter((n) => /^lane-\d+.*\.md$/.test(n)).sort()) {
        const lane = 'L' + f.match(/^lane-(\d+)/)[1];
        if (lane === 'L99') continue; // findings register, not a ticket board
        const name = f.replace(/^lane-\d+-/, '').replace(/\.md$/, '');
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          const m = line.match(/^\|\s*(PF-\d{3})\s*\|\s*(☑|☐|✂|⚑|◐)/);
          if (!m) continue;
          tickets.push({
            done: m[2] === '☑',
            id: m[1],
            bucket: MVP.has(lane) ? 'M' : 'F',
            section: `${lane} · ${name}`,
            code: lane,
          });
        }
      }
      return tickets;
    },
  },
  {
    id: 'fleetgraph',
    title: 'FLEETGRAPH',
    board: 'TICKETS.md',
    deadlines: [
      { bucket: 'M', label: 'MVP', at: '2026-08-05T23:59:00-05:00' },
      { bucket: 'E', label: 'Early Submission', at: '2026-08-07T23:59:00-05:00' },
      { bucket: 'F', label: 'Final', at: '2026-08-09T12:00:00-05:00' },
    ],
    parse() {
      const text = readFileSync(join(REPO, 'TICKETS.md'), 'utf8');
      const tickets = [];
      let bucket = null, section = null;
      for (const line of text.split('\n')) {
        const b = line.match(/^#\s+§([MEF])\s+·\s+(.+)$/);
        if (b) { bucket = b[1]; section = null; continue; }
        const s = line.match(/^##\s+(.+)$/);
        if (s && bucket) { section = s[1].trim(); continue; }
        const m = line.match(/^- \[( |x)\] \*\*(FG-\d{3})\*\*\s+(.+)$/);
        if (m && bucket) {
          const code = (section ?? bucket).match(/^([MEF]\d*)\b/)?.[1] ?? bucket;
          tickets.push({ done: m[1] === 'x', id: m[2], bucket, section: section ?? bucket, code });
        }
      }
      return tickets;
    },
  },
];

function pickProject() {
  const flag = process.argv.indexOf('--project');
  if (flag !== -1 && process.argv[flag + 1]) {
    const p = PROJECTS.find((x) => x.id === process.argv[flag + 1]);
    if (!p) { console.error(`unknown --project (have: ${PROJECTS.map((x) => x.id).join(', ')})`); process.exit(2); }
    return p;
  }
  const found = PROJECTS.find((p) => existsSync(join(REPO, p.board)));
  if (!found) { console.error('no known ticket board found'); process.exit(2); }
  return found;
}

const PROJECT = pickProject();
const DEADLINES = PROJECT.deadlines;

// ---------------------------------------------------------------- tickets

function parseTickets() {
  return PROJECT.parse();
}

// ---------------------------------------------------------------- velocity

/**
 * Velocity cannot be derived from commit timestamps in this project, and the
 * first version of this script pretended otherwise.
 *
 * It measured gaps between commits carrying `Closes:` trailers and reported 98
 * tickets per hour. The real figure is nowhere near that. Two reasons the method
 * was wrong:
 *
 *   - work sat uncommitted for hours; the first four commits landed within one
 *     minute of each other and closed 39 tickets between them, so the gaps
 *     between commits measured almost none of the work
 *   - `git filter-branch` rewrote committer dates, and author dates were no
 *     better for the same reason
 *
 * A wrong velocity is worse than none: it produced a green "✓ fits" against the
 * MVP deadline, which is exactly the reassurance you must not manufacture.
 *
 * So the rate is measured from OBSERVED PROGRESS instead — each run of this
 * report appends its done-count and timestamp to a log, and the rate comes from
 * how the count actually moved between runs. The first run has no history and
 * says so rather than guessing. `--active-hours N` supplies a known figure when
 * you have one.
 *
 * ── The second way this went wrong ───────────────────────────────────────────
 * Observed deltas have their own failure, and it landed: a reconciliation pass
 * closed 18 tickets in six minutes without building anything. Thirteen had been
 * finished for days and were only unchecked because `Closes:` trailers were
 * inert (FG-275) and Linear had hit its free-tier issue cap; four more were
 * deployment checks closed on a live `curl`. The rate went to 155.8
 * tickets/claude-hour and the Final deadline turned green — nine tickets
 * including a demo video, reported as seven minutes of work.
 *
 * Same lie as the commit-timestamp version, from the opposite direction: that
 * one measured almost none of the work, this one measured work that had already
 * happened. So a run that is correcting the books rather than moving them marks
 * itself with `--reconciliation`, and any interval touching a marked entry is
 * excluded from the rate. Bookkeeping is not throughput.
 */
const LOG = join(REPO, '.claude', 'progress-log.jsonl');

function readLog() {
  try {
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      // Entries predate the project field; they are all fleetgraph. Without this
      // filter a PlugForge run sits next to a 282/285 FleetGraph reading and the
      // delta is NEGATIVE — a rate computed across two different boards is not a
      // slow rate, it is a meaningless one.
      .filter((e) => (e.project ?? 'fleetgraph') === PROJECT.id)
      .map((e) => ({ ...e, at: new Date(e.at) }));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, JSON.stringify(entry) + '\n');
  } catch {
    /* a report that cannot log is still a useful report */
  }
}

/**
 * Tickets per active hour, from observed deltas between report runs.
 *
 * Only intervals where the count actually moved are counted, and only those
 * shorter than MAX_INTERVAL_H — a delta measured across an overnight gap says
 * nothing about throughput.
 *
 * An interval is also dropped when the LATER endpoint is marked
 * `reconciliation` — that is the delta carrying the bookkeeping jump.
 *
 * Only the later one. The first draft of this dropped intervals touching a
 * marked entry at either end, which is over-correction: once the books are
 * straight, the corrected count is an accurate baseline, and real work measured
 * forward from it is real throughput. Discarding that would throw away the
 * first honest measurement after every reconciliation, which is the one most
 * worth having.
 */
const MAX_INTERVAL_H = 4;

function observedRate(log, doneNow, nowIsReconciliation = false) {
  const points = [...log, { at: new Date(), done: doneNow, kind: nowIsReconciliation ? 'reconciliation' : undefined }];
  let tickets = 0;
  let hours = 0;
  let excluded = 0;

  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].at - points[i - 1].at) / 3_600_000;
    const dn = points[i].done - points[i - 1].done;
    if (dn <= 0 || dt <= 0 || dt > MAX_INTERVAL_H) continue;
    if (points[i].kind === 'reconciliation') {
      excluded += dn;
      continue;
    }
    tickets += dn;
    hours += dt;
  }

  return hours > 0 ? { rate: tickets / hours, tickets, hours, excluded } : { rate: null, excluded };
}

// ---------------------------------------------------------------- report

const tickets = parseTickets();
const done = tickets.filter((t) => t.done);
const left = tickets.filter((t) => !t.done);

const overrideIdx = process.argv.indexOf('--active-hours');
const override = overrideIdx > -1 ? Number(process.argv[overrideIdx + 1]) : null;

// Marks this run as correcting the books rather than moving them, so its delta
// never becomes a throughput claim. Set it when a batch of tickets closes for
// bookkeeping reasons — a Linear sync, a trailer repair, deployment checks
// closed on evidence that already existed.
const RECONCILIATION = process.argv.includes('--reconciliation');

const log = readLog();
const observed = observedRate(log, done.length, RECONCILIATION);

// An explicit figure beats an inferred one; an inferred one beats a guess; and
// no number at all beats a wrong number.
const rate = override && override > 0 ? done.length / override : (observed?.rate ?? null);

const byBucket = {};
for (const t of tickets) {
  const b = (byBucket[t.bucket] ??= { total: 0, done: 0 });
  b.total++;
  if (t.done) b.done++;
}

const bySection = {};
for (const t of tickets) {
  const s = (bySection[t.code] ??= { total: 0, done: 0, bucket: t.bucket, name: t.section });
  s.total++;
  if (t.done) s.done++;
}

const pct = (d, t) => (t === 0 ? 100 : Math.round((d / t) * 100));
const bar = (d, t, w = 24) => {
  const filled = Math.round((d / Math.max(t, 1)) * w);
  return '█'.repeat(filled) + '░'.repeat(w - filled);
};
const claudeHours = (n) => (rate ? n / rate : null);
const fmtH = (h) =>
  h === null ? '—' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        total: tickets.length,
        done: done.length,
        remaining: left.length,
        percent: pct(done.length, tickets.length),
        measuredActiveHours: observed.rate ? Number(observed.hours.toFixed(2)) : null,
        reconciliationTicketsExcluded: observed.excluded || 0,
        ticketsPerClaudeHour: rate ? Number(rate.toFixed(1)) : null,
        claudeHoursRemaining: rate ? Number(claudeHours(left.length).toFixed(1)) : null,
        byBucket,
        bySection,
      },
      null,
      2
    )
  );
  process.exit(0);
}

console.log(`\n\x1b[1m${PROJECT.title} — PROGRESS\x1b[0m`);
console.log(`${bar(done.length, tickets.length, 40)}  ${pct(done.length, tickets.length)}%`);
console.log(`${done.length} done · ${left.length} remaining · ${tickets.length} total\n`);

console.log('\x1b[1mBY DEADLINE\x1b[0m');
for (const d of DEADLINES) {
  const b = byBucket[d.bucket];
  if (!b) continue;
  const remain = b.total - b.done;
  const hoursLeft = claudeHours(remain);
  const until = (new Date(d.at) - Date.now()) / 3_600_000;
  // No flag at all when the rate is unknown. A green tick from a rate we do not
  // have is worse than silence.
  const flag =
    hoursLeft === null
      ? '  \x1b[2m? no rate\x1b[0m'
      : until <= 0
        ? '  \x1b[31mPASSED\x1b[0m'
        : hoursLeft > until
          ? '  \x1b[31m⚠ over budget\x1b[0m'
          : '  \x1b[32m✓ fits\x1b[0m';
  console.log(
    `  ${d.label.padEnd(17)} ${bar(b.done, b.total)} ${String(pct(b.done, b.total)).padStart(3)}%` +
      `  ${String(remain).padStart(3)} left` +
      `  ${fmtH(hoursLeft).padStart(8)} claude` +
      `  ${until > 0 ? `${until.toFixed(0)}h wall` : 'PASSED'}${flag}`
  );
}

console.log('\n\x1b[1mBY SECTION\x1b[0m');
for (const [code, s] of Object.entries(bySection)) {
  const remain = s.total - s.done;
  const mark = remain === 0 ? '\x1b[32m✓\x1b[0m' : remain === s.total ? ' ' : '\x1b[33m~\x1b[0m';
  console.log(
    `  ${mark} ${code.padEnd(4)} ${bar(s.done, s.total, 16)} ${String(pct(s.done, s.total)).padStart(3)}%` +
      `  ${String(remain).padStart(3)} left  ${fmtH(claudeHours(remain)).padStart(8)}  ${s.name}`
  );
}

console.log('\n\x1b[1mVELOCITY\x1b[0m');
if (override && override > 0) {
  console.log(`  ${done.length} tickets in ${override} supplied active hours`);
  console.log(`  \x1b[1m${rate.toFixed(1)}\x1b[0m tickets / claude-hour`);
  console.log(`  \x1b[1m${fmtH(claudeHours(left.length))}\x1b[0m of claude-time remaining`);
} else if (observed.rate) {
  console.log(`  ${observed.tickets} tickets across ${observed.hours.toFixed(1)} observed hours, from ${log.length} prior report(s)`);
  console.log(`  \x1b[1m${rate.toFixed(1)}\x1b[0m tickets / claude-hour`);
  console.log(`  \x1b[1m${fmtH(claudeHours(left.length))}\x1b[0m of claude-time remaining`);
  if (observed.excluded) {
    console.log(`  \x1b[2m${observed.excluded} ticket(s) excluded as reconciliation — closed by bookkeeping, not built.\x1b[0m`);
  }
} else {
  if (observed.excluded) {
    console.log(`  \x1b[33mNo rate yet.\x1b[0m ${observed.excluded} ticket(s) closed since the last reading, all of`);
    console.log('  them marked reconciliation — records catching up with work that was');
    console.log('  already finished. That is not throughput, so it buys no rate. The next');
    console.log('  unmarked run that moves the count is the first real measurement.');
  } else {
    console.log('  \x1b[33mNo rate yet.\x1b[0m This is the first report, so there is no observed');
    console.log('  progress to measure against. Run it again later and the delta becomes');
    console.log('  the measurement.');
  }
  console.log('  Or pass a figure you already know:');
  console.log('    \x1b[2mnode scripts/progress-report.mjs --active-hours 6\x1b[0m');
  console.log('');
  console.log('  \x1b[2mDeliberately not derived from commit timestamps. That was tried and');
  console.log('  reported 98 tickets/hour, because work sat uncommitted for hours and');
  console.log('  then landed 39 tickets in one minute. It produced a green "fits" against');
  console.log('  the MVP deadline, which is the one reassurance you must not fake.\x1b[0m');
}

console.log('\n\x1b[2mCaveat: tickets are not equal. "Commit this file" and "build a detector');
console.log('with tests" both count as one. Treat the section table as more honest than');
console.log('any single total, and every projection as a floor rather than a forecast.\x1b[0m\n');

appendLog({
  at: new Date().toISOString(),
  project: PROJECT.id,
  done: done.length,
  total: tickets.length,
  // Absent rather than false on ordinary runs — every line already written
  // predates the flag, and an undefined `kind` is exactly what they mean.
  ...(RECONCILIATION ? { kind: 'reconciliation' } : {}),
});
