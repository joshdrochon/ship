#!/usr/bin/env node
/**
 * PF-784 companion — the per-slice inventory PRD p.12 asks for, rebuilt from git.
 *
 *     node scripts/slice-ledger.mjs            # regenerate docs/slice-ledger.md
 *     node scripts/slice-ledger.mjs --check    # exit 1 if the committed file is stale
 *
 * ── What this measures ─────────────────────────────────────────────────────
 * p.12: *"each PR description lists which acceptance criterion that slice
 * advances and confirms the fitness test passed."* One row per `pf/*` branch on
 * `origin`, carrying four things a reader would otherwise have to reconstruct by
 * hand: the acceptance criterion the slice advances, where that criterion was
 * read from, the fitness test the lane file planned for it, and whatever named
 * fitness artifact the slice's own commit bodies actually contain.
 *
 * ── What this does NOT measure, and must not be read as ────────────────────
 * **It is not a PR audit and it does not create one.** Seven merge requests on
 * GitLab have a `pf/LNN-*` branch as their source. The other ~180 slices never
 * had a PR description, and no retroactive MR was opened to manufacture one —
 * the timestamps would show it. So this file reports the *information* the
 * clause asks for, recovered from artifacts contemporaneous with the work
 * (branch, merge commit, commit body, lane file), and it does not claim the
 * clause is met as written.
 *
 * **It is an inventory, not an audit.** It counts whether a fitness artifact is
 * *named*; it never opens the file, runs the test, or judges whether the named
 * artifact supports the claim. `docs/pr-compliance-sweep.md` is the quality
 * measurement over the same commit bodies. A row here saying `2913/2913` means
 * a commit body contains that string — nothing more.
 *
 * **The `Advances` cell is planning text, not proof.** It comes from the lane
 * file's own Slices table, or failing that from the `Advances` column of the
 * ticket rows the commit bodies name. Both were written before or alongside the
 * work. That the slice *claims* a criterion is what is measured.
 *
 * ── The unit ───────────────────────────────────────────────────────────────
 * `docs/pr-compliance-sweep.md` records that getting to the right unit took
 * three attempts, and this script uses the third: for a merge with parents
 * `P1 P2`, the slice's own commits are exactly `P1..P2`. Reading merge subjects
 * alone reads one-liners; reading `merge-base..branch` on a fully merged branch
 * reads an empty range and then, on the older fallback, unrelated ancestors
 * belonging to a different slice.
 *
 * Two branches cannot be resolved that way and are labelled as such rather than
 * guessed at:
 *   - **fast-forward / squashed** — the tip is an ancestor of `origin/main` but
 *     is nobody's second parent, so no merge commit exists to bracket. The
 *     documented fallback range `merge-base(origin/main, tip)..tip` is empty for
 *     these, so the tip commit alone is read: in a squash that IS the slice's
 *     commit body, and reading exactly one commit cannot drift into a
 *     neighbour's history the way attempt 2 did.
 *   - **unmerged** — not an ancestor of `origin/main` at all. Range is
 *     `merge-base(origin/main, tip)..tip`, which for a divergent branch is that
 *     branch's own commits.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * Stable sort, no clock in the body. The one volatile line is the `Generated …`
 * line, which `--check` normalizes away before comparing — otherwise the check
 * would report the file stale every day for a reason that is not staleness.
 *
 * No network. Reads local refs and files under `tickets/plugforge/` only, and
 * writes exactly one path: `docs/slice-ledger.md`.
 *
 * Exit 0 = written (or, with --check, up to date).
 * Exit 1 = --check found the committed file stale.
 * Exit 2 = the refs this reads from are not present locally.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LANES_DIR = join(REPO, 'tickets', 'plugforge');
const OUT = join(REPO, 'docs', 'slice-ledger.md');

const CHECK = process.argv.includes('--check');

/** A slice with more commits than this is truncated rather than read whole. */
const MAX_COMMITS_PER_SLICE = 200;
/** Long planning prose is truncated for table legibility, never for the counts. */
const CELL_MAX = 220;

// ─── git ─────────────────────────────────────────────────────────────────────

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function refExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) !== null;
}

function isAncestor(a, b) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ─── markdown table parsing ──────────────────────────────────────────────────

/** Split a markdown table row on unescaped pipes. `\|` is a literal pipe. */
function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((s) => s.trim());
}

const isDivider = (line) => /^\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

/**
 * Pull the first markdown table out of the `## <heading>` section of a file.
 * Returns { header: string[], rows: string[][] } or null.
 */
function tableInSection(lines, heading) {
  let i = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (i === -1) return null;
  i += 1;

  let header = null;
  const rows = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^## /.test(line)) break;
    if (!line.startsWith('|')) {
      if (header && rows.length) break; // table ended
      continue;
    }
    if (isDivider(line)) continue;
    const cells = splitRow(line);
    if (!header) header = cells;
    else rows.push(cells);
  }
  return header ? { header, rows } : null;
}

/** Index of the first header cell matching `pred`, or -1. */
function colIndex(header, pred) {
  return header.findIndex((h) => pred(h.replace(/\*\*/g, '').trim().toLowerCase()));
}

// ─── lane files ──────────────────────────────────────────────────────────────

/**
 * laneTitles:   Map<laneNumber, H1 text>
 * sliceRows:    Map<branchName, { advances, fitness, tickets }>   (from ## Slices)
 * ticketAdvances: Map<'PF-123', advances string>                  (from ## Tickets)
 */
function readLanes() {
  const laneTitles = new Map();
  const sliceRows = new Map();
  const ticketAdvances = new Map();

  if (!existsSync(LANES_DIR)) return { laneTitles, sliceRows, ticketAdvances };

  const files = readdirSync(LANES_DIR)
    .filter((f) => /^lane-\d+-.*\.md$/.test(f))
    .sort();

  for (const file of files) {
    const laneNum = Number(file.match(/^lane-(\d+)-/)[1]);
    const lines = readFileSync(join(LANES_DIR, file), 'utf8').split('\n');

    const h1 = lines.find((l) => l.startsWith('# '));
    if (h1) laneTitles.set(laneNum, h1.replace(/^#\s+/, '').trim());

    const slices = tableInSection(lines, 'Slices');
    if (slices) {
      const bi = colIndex(slices.header, (h) => h === 'branch');
      const ti = colIndex(slices.header, (h) => h === 'tickets');
      const ai = colIndex(slices.header, (h) => h === 'advances');
      // Three header shapes exist across the 26 lane files: `Fitness test`,
      // `Fitness test / artifact`, and L05's `| Slice | Branch | Tests |
      // Evidence |` — which carries the same content under a different name and
      // no `Advances` column at all.
      const fi = colIndex(slices.header, (h) => h.startsWith('fitness') || h === 'evidence');
      if (bi !== -1) {
        for (const row of slices.rows) {
          const branchCell = row[bi] ?? '';
          for (const m of branchCell.matchAll(/`(pf\/[^`]+)`/g)) {
            const branch = m[1];
            if (sliceRows.has(branch)) continue; // first lane file wins; stable by filename sort
            sliceRows.set(branch, {
              advances: ai === -1 ? '' : (row[ai] ?? ''),
              fitness: fi === -1 ? '' : (row[fi] ?? ''),
              tickets: ti === -1 ? '' : (row[ti] ?? ''),
            });
          }
        }
      }
    }

    const tickets = tableInSection(lines, 'Tickets');
    if (tickets) {
      const ii = colIndex(tickets.header, (h) => h === 'id');
      const ai = colIndex(tickets.header, (h) => h === 'advances');
      if (ii !== -1 && ai !== -1) {
        for (const row of tickets.rows) {
          const id = (row[ii] ?? '').match(/PF-\d{3}/);
          if (!id) continue;
          const advances = (row[ai] ?? '').trim();
          if (!advances || advances === '—' || advances === '-') continue;
          if (!ticketAdvances.has(id[0])) ticketAdvances.set(id[0], advances);
        }
      }
    }
  }

  return { laneTitles, sliceRows, ticketAdvances };
}

// ─── ticket ids ──────────────────────────────────────────────────────────────

/**
 * Every `PF-\d{3}` in `text`, plus ranges expanded. Lane Slices tables write
 * a slice's ticket block as `PF-586–590` with an EN DASH; an unexpanded range
 * resolves to one ticket instead of five.
 */
function ticketsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/PF-(\d{3})\s*[–—-]\s*(?:PF-)?(\d{3})\b/g)) {
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (hi >= lo && hi - lo <= 60) {
      for (let n = lo; n <= hi; n += 1) found.add(`PF-${String(n).padStart(3, '0')}`);
    }
  }
  for (const m of text.matchAll(/PF-(\d{3})\b/g)) found.add(`PF-${m[1]}`);
  return found;
}

// ─── fitness artifacts named in commit bodies ────────────────────────────────

const ARTIFACT_PATTERNS = [
  /[\w./-]+\.(?:test|spec|drill)\.[jt]sx?/gi,
  /\b\d+\s*\/\s*\d+\b/g,
  /type-check clean/gi,
  /tsc clean/gi,
  /exit 0/gi,
  /no leaks found/gi,
  /0 errors/gi,
];

/** First 3 distinct named artifacts, ordered by position in the text. */
function artifactsIn(text) {
  const hits = [];
  for (const re of ARTIFACT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push({ at: m.index, value: m[0].trim() });
  }
  hits.sort((a, b) => a.at - b.at || a.value.localeCompare(b.value));
  const out = [];
  const seen = new Set();
  for (const { value } of hits) {
    const key = value.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length === 3) break;
  }
  return out;
}

// ─── cell formatting ─────────────────────────────────────────────────────────

/** Escape a value so it survives inside a markdown table cell. */
function cell(value) {
  const flat = String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
  return flat === '' ? '—' : flat;
}

/** Truncate on a word boundary at ~CELL_MAX chars. */
function clip(text, max = CELL_MAX) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;.]+$/, '')}…`;
}

const clipCell = (value) => clip(cell(value));

// ─── gather ──────────────────────────────────────────────────────────────────

function main() {
  if (!refExists('origin/main')) {
    console.error('slice-ledger: no `origin/main` locally. Run `git fetch origin` and try again.');
    process.exit(2);
  }

  const branchLines = (git(['branch', '-r', '--list', 'origin/pf/*', '--format=%(refname:short) %(objectname)']) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (branchLines.length === 0) {
    console.error(
      'slice-ledger: no `origin/pf/*` refs are present locally, so there is nothing to inventory.\n' +
        '              Run `git fetch origin` (the slice branches are the evidence this reads).',
    );
    process.exit(2);
  }

  // second-parent SHA -> the merge that brought it in, and that merge's first parent.
  const mergeOf = new Map();
  for (const ref of ['origin/main', 'origin/pf/integration']) {
    if (!refExists(ref)) continue;
    const out = git(['rev-list', '--merges', '--parents', ref]) ?? '';
    for (const line of out.split('\n')) {
      const shas = line.trim().split(/\s+/).filter(Boolean);
      if (shas.length < 3) continue;
      const [merge, p1, ...rest] = shas;
      for (const parent of rest) {
        if (!mergeOf.has(parent)) mergeOf.set(parent, { merge, p1 });
      }
    }
  }

  const { laneTitles, sliceRows, ticketAdvances } = readLanes();

  const rows = [];
  for (const line of branchLines) {
    const [ref, tip] = line.split(/\s+/);
    const branch = ref.replace(/^origin\//, '');
    const laneMatch = branch.match(/^pf\/L(\d+)-/);
    const lane = laneMatch ? Number(laneMatch[1]) : null;
    const kind = laneMatch ? 'slice' : 'batch';

    // --- how it landed, and which commits are its own
    let mergeLabel;
    let status;
    let range;
    const hit = mergeOf.get(tip);
    if (hit) {
      status = 'merged';
      const subject = (git(['log', '-1', '--format=%s', hit.merge]) ?? '').trim();
      mergeLabel = `\`${hit.merge.slice(0, 8)}\` ${subject}`;
      range = `${hit.p1}..${tip}`;
    } else if (isAncestor(tip, 'origin/main')) {
      status = 'ff';
      mergeLabel = 'fast-forward / squashed';
      const base = (git(['merge-base', 'origin/main', tip]) ?? '').trim();
      range = `${base}..${tip}`;
    } else {
      status = 'unmerged';
      mergeLabel = 'unmerged';
      const base = (git(['merge-base', 'origin/main', tip]) ?? '').trim();
      range = `${base}..${tip}`;
    }

    let bodies = (git(['log', `--max-count=${MAX_COMMITS_PER_SLICE}`, '--format=%B', range], { allowFail: true }) ?? '').trim();
    // A fast-forwarded branch has an empty range by construction (its merge-base
    // with main IS its tip). The tip commit alone is then the slice's own body —
    // one commit, so this cannot wander into a neighbouring slice's history.
    if (bodies === '') bodies = (git(['log', '-1', '--format=%B', tip], { allowFail: true }) ?? '').trim();

    // --- tickets: commit bodies ∪ the lane file's own Slices row
    const planned = sliceRows.get(branch) ?? null;
    const tickets = new Set([...ticketsIn(bodies)]);
    if (planned) for (const t of ticketsIn(planned.tickets)) tickets.add(t);
    const ticketList = [...tickets].sort();

    // --- criterion, and which source produced it
    let advances = '';
    let source = 'commit-body';
    if (planned && planned.advances && planned.advances !== '—') {
      advances = planned.advances;
      source = 'slices-table';
    } else {
      const fromTickets = [];
      const seen = new Set();
      for (const t of ticketList) {
        const a = ticketAdvances.get(t);
        if (!a || seen.has(a)) continue;
        seen.add(a);
        fromTickets.push(a);
      }
      if (fromTickets.length) {
        advances = fromTickets.sort().join('; ');
        source = 'ticket-advances';
      }
    }

    const artifacts = artifactsIn(bodies);

    rows.push({
      branch,
      lane,
      kind,
      status,
      mergeLabel,
      advances,
      source,
      fitnessPlanned: planned?.fitness ?? '',
      artifacts,
      tickets: ticketList,
    });
  }

  rows.sort((a, b) => {
    const la = a.lane === null ? Number.POSITIVE_INFINITY : a.lane;
    const lb = b.lane === null ? Number.POSITIVE_INFINITY : b.lane;
    return la - lb || a.branch.localeCompare(b.branch);
  });

  return { rows, markdown: render(rows, laneTitles) };
}

// ─── render ──────────────────────────────────────────────────────────────────

const GENERATED_LINE_RE = /^Generated .*$/m;

function render(rows, laneTitles) {
  const mainSha = (git(['rev-parse', 'origin/main']) ?? '').trim().slice(0, 8);
  const today = new Date().toISOString().slice(0, 10);

  const count = (pred) => rows.filter(pred).length;
  const totals = {
    total: rows.length,
    slices: count((r) => r.kind === 'slice'),
    batch: count((r) => r.kind === 'batch'),
    merged: count((r) => r.status === 'merged'),
    ff: count((r) => r.status === 'ff'),
    unmerged: count((r) => r.status === 'unmerged'),
    fromSlices: count((r) => r.source === 'slices-table'),
    fromTickets: count((r) => r.source === 'ticket-advances'),
    noCriterion: count((r) => r.source === 'commit-body'),
    named: count((r) => r.artifacts.length > 0),
    unnamed: count((r) => r.artifacts.length === 0),
  };

  const out = [];
  const w = (line = '') => out.push(line);

  w('# Slice ledger — one row per `pf/*` branch');
  w();
  w('**Generated.** Regenerate with `node scripts/slice-ledger.mjs`. Do not hand-edit.');
  w();
  w(`Generated ${today} against \`origin/main\` at \`${mainSha}\`.`);
  w();

  w('## What this is, and what it is not');
  w();
  w('PRD p.12 requires that *"each PR description lists which acceptance criterion that slice');
  w('advances and confirms the fitness test passed."*');
  w();
  w('**The per-slice review trail for this project lives in commit bodies and in this ledger, not');
  w(`in per-slice merge requests.** ${totals.total} \`pf/*\` branches exist on \`origin\` (${totals.slices} slices plus`);
  w(`${totals.batch} integration branch${totals.batch === 1 ? '' : 'es'}). **7** merge requests have a \`pf/L<NN>-*\` branch as their`);
  w('source — !21–!27 — of which **5** carry both required sections. A further 4 batch merge');
  w('requests, !17–!20, cover whole integration batches rather than single slices.');
  w();
  w('**No retroactive merge requests were opened.** Opening an MR for an already-merged branch');
  w('fabricates a review trail that never existed, and the timestamps would show it. The clause');
  w('*"each PR description"* is therefore **not met as written**, and this document does not claim');
  w('it is. What is on offer is the information the clause asks for, recovered from artifacts that');
  w("are contemporaneous with the work: the branch, the merge commit, the commit body, and the lane");
  w("file's own Slices table.");
  w();
  w('**This ledger is the inventory; `docs/pr-compliance-sweep.md` is the audit.** The sweep');
  w('measures the *quality* of those commit bodies — whether each one names its tickets and names a');
  w('test, a pass ratio or an exit code a reader can go and re-run. This file makes no quality');
  w('judgement at all: a `Fitness artifact in commit body` cell means the string appears in a commit');
  w('message, not that the artifact exists, ran, or passed.');
  w();
  w('Two further limits, stated rather than left to be discovered:');
  w();
  w('- **The `Advances` column is a claim, not proof.** It is read from the lane file\'s Slices table');
  w('  where one exists, and otherwise from the `Advances` column of the ticket rows the commit');
  w('  bodies name. Both were written alongside the work, not after grading it. `Source` describes');
  w('  **only** where the criterion came from — `slices-table` is the slice\'s own planned criterion,');
  w('  `ticket-advances` is inferred from the tickets the commits cite, and `commit-body` means');
  w('  neither source resolved anything and the cell is `—`. It says nothing about the two fitness');
  w('  columns, which are filled independently wherever the data exists.');
  w('- **`fast-forward / squashed` rows carry less evidence than merged rows.** With no merge commit');
  w('  to bracket, the slice\'s own commits cannot be recovered as `P1..P2`; the tip commit alone is');
  w('  read instead. For a squashed branch that is the whole slice. For a fast-forwarded one it is');
  w('  the last commit only, so those rows can under-report tickets and artifacts.');
  w();

  w('## Coverage');
  w();
  w('| | Count |');
  w('|---|---:|');
  w(`| \`pf/*\` branches on \`origin\` | **${totals.total}** |`);
  w(`| …of those, slice branches (\`pf/L<NN>-*\`) | ${totals.slices} |`);
  w(`| …of those, batch branches (not a slice) | ${totals.batch} |`);
  w(`| Landed through a merge commit (slice commits recovered as \`P1..P2\`) | ${totals.merged} |`);
  w(`| Landed fast-forward / squashed (no merge commit to bracket) | ${totals.ff} |`);
  w(`| Unmerged — not an ancestor of \`origin/main\` | ${totals.unmerged} |`);
  w(`| Criterion resolved from the lane file's **Slices table** | ${totals.fromSlices} |`);
  w(`| Criterion resolved from the tickets' **\`Advances\`** column | ${totals.fromTickets} |`);
  w(`| **No criterion resolvable** from either source | ${totals.noCriterion} |`);
  w(`| Names a fitness artifact in its commit bodies | ${totals.named} |`);
  w(`| Names **none** | ${totals.unnamed} |`);
  w();

  w('## Ledger');
  w();

  const header =
    '| Branch | Advances (acceptance criterion) | Source | Fitness test (planned) | Fitness artifact in commit body | Tickets | Merge |';
  const divider = '|---|---|---|---|---|---|---|';

  let currentLane;
  let first = true;
  for (const row of rows) {
    if (first || row.lane !== currentLane) {
      if (!first) w();
      currentLane = row.lane;
      first = false;
      w(`### ${laneHeading(row.lane, laneTitles)}`);
      w();
      w(header);
      w(divider);
    }
    const cells = [
      `\`${row.branch}\``,
      clipCell(row.advances),
      row.source,
      clipCell(row.fitnessPlanned),
      row.artifacts.length ? row.artifacts.map((a) => `\`${cell(a)}\``).join(', ') : 'none named',
      row.tickets.length ? clipCell(row.tickets.join(', ')) : '—',
      cell(row.mergeLabel),
    ];
    w(`| ${cells.join(' | ')} |`);
  }
  w();

  return `${out.join('\n')}\n`;
}

function laneHeading(lane, laneTitles) {
  if (lane === null) return 'Unlaned — batch branches';
  const label = `L${String(lane).padStart(2, '0')}`;
  const title = laneTitles.get(lane);
  return title ?? `${label} · (no lane file)`;
}

// ─── entry ───────────────────────────────────────────────────────────────────

/** Everything but the volatile `Generated …` line, which is not staleness. */
const normalize = (text) => text.replace(GENERATED_LINE_RE, 'Generated <date> against `origin/main` at <sha>.');

const { rows, markdown } = main();

if (CHECK) {
  // --check never writes. A check that repairs the thing it checks hides the
  // fact that the committed file was wrong.
  if (!existsSync(OUT)) {
    console.error('slice-ledger: docs/slice-ledger.md does not exist. Run `node scripts/slice-ledger.mjs`.');
    process.exit(1);
  }
  const committed = readFileSync(OUT, 'utf8');
  if (normalize(committed) !== normalize(markdown)) {
    console.error(
      'slice-ledger: docs/slice-ledger.md is STALE — the branches, merges or lane files have moved\n' +
        '              since it was generated. Run `node scripts/slice-ledger.mjs` and commit the result.',
    );
    process.exit(1);
  }
  console.log(`slice-ledger: up to date (${rows.length} rows).`);
} else {
  writeFileSync(OUT, markdown, 'utf8');
  console.log(`slice-ledger: wrote docs/slice-ledger.md — ${rows.length} rows.`);
}
