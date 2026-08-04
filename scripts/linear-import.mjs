#!/usr/bin/env node
/**
 * Keep TICKETS.md and Linear in agreement, in one direction each.
 *
 * The authority is split deliberately:
 *
 *   TICKETS.md  owns what tickets EXIST      → pushed to Linear by `import`
 *   Linear      owns what state they are IN  → pulled back by `--sync`
 *
 * Nothing is maintained by hand in both places. Hand-maintaining 268 checkboxes
 * across two systems is how the board and the file start disagreeing, and then
 * the one you happen to be looking at is not the real one. This script is the
 * reason that cannot happen rather than a promise to be careful.
 *
 *   node scripts/linear-import.mjs --dry-run     parse and report, create nothing
 *   node scripts/linear-import.mjs               create the missing issues
 *   node scripts/linear-import.mjs --sync        pull status from Linear into TICKETS.md
 *   node scripts/linear-import.mjs --sync --dry-run   show what sync would change
 *
 * Needs LINEAR_API_KEY in .env (Linear → Settings → Security & access →
 * Personal API keys). The key is sent in the Authorization header verbatim —
 * Linear personal keys carry no "Bearer" prefix.
 *
 * Why a script rather than the Linear MCP server: MCP creates one issue per
 * tool call. 265 issues is 265 round trips, each returning ~800 tokens of JSON.
 * MCP stays connected and is the right tool for moving issues through states as
 * work happens; it is the wrong tool for a bulk write.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.linear.app/graphql';

const TEAM_ID = 'f888e2fa-dd09-412b-91a2-35c4d5a7da27';
const PROJECTS = {
  M: '63ef77d1-f218-4140-b6c2-6e69f874a44b', // FleetGraph MVP
  E: '5351cf45-aa84-4f8a-9c57-0e0116f8005b', // FleetGraph Early Submission
  F: '1666f4bb-3dcb-4a48-97a9-86a866bdf0f0', // FleetGraph Final
};
// 1=Urgent 2=High 3=Medium 4=Low
const BUCKET_PRIORITY = { M: 2, E: 3, F: 4 };
const PRIORITY_OVERRIDE = {
  'FG-015': 1, // the checkpointer spike — everything in M6 depends on it
  'FG-021': 1, // suppression uniqueness — the cost cliff from PRESEARCH Q32
  'FG-029': 1, // data-access boundary — what keeps one-database reversible
  'FG-204': 1, // destroy-and-redeploy, run early not at the deadline
};

const DRY_RUN = process.argv.includes('--dry-run');
const SYNC = process.argv.includes('--sync');

/**
 * `--set <State> FG-005,FG-008-FG-014` — bulk state change in Linear.
 *
 * Exists because completing work happens in batches (M0 finished ten tickets at
 * once) and Linear's MCP server writes one issue per call. Single-ticket moves
 * during normal work are fine over MCP; this is for the batch case.
 *
 * Ranges are inclusive and expand numerically: FG-008-FG-014 is seven ids.
 */
function parseSetArgs(argv) {
  const i = argv.indexOf('--set');
  if (i === -1) return null;
  const state = argv[i + 1];
  const spec = argv[i + 2];
  if (!state || !spec || state.startsWith('--') || spec.startsWith('--')) {
    console.error('usage: --set <State> <FG-005,FG-008-FG-014>');
    process.exit(1);
  }
  const ids = [];
  for (const part of spec.split(',')) {
    const range = part.trim().match(/^(FG-\d{3})-(FG-\d{3})$/);
    if (range) {
      const a = Number(range[1].slice(3));
      const b = Number(range[2].slice(3));
      if (b < a) {
        console.error(`range runs backwards: ${part}`);
        process.exit(1);
      }
      for (let n = a; n <= b; n++) ids.push(`FG-${String(n).padStart(3, '0')}`);
    } else if (/^FG-\d{3}$/.test(part.trim())) {
      ids.push(part.trim());
    } else {
      console.error(`unrecognised id or range: ${part}`);
      process.exit(1);
    }
  }
  return { state, ids };
}

const SET = parseSetArgs(process.argv);
const LABEL = process.argv.includes('--label');

/**
 * Section colours, deliberately a progression rather than a random assignment —
 * cool at the foundations, warming through the build, so the board reads in
 * dependency order at a glance. Red is reserved: nothing here uses it, so the
 * `risk` label is the only red on the board and cannot be mistaken for a phase.
 */
const SECTION_COLORS = {
  M0: '#6E79D6', M1: '#4E8FDA', M2: '#35A3C4', M3: '#2FA98C',
  M4: '#46A85C', M5: '#7EA83F', M6: '#A89F35', M7: '#C79038',
  M8: '#D0783F', M9: '#C9634E', M10: '#B5566B', M11: '#9C5285',
  E1: '#7C8B99', E2: '#6F8296', E3: '#647A93',
  E4: '#5A7290', E5: '#506A8D', E6: '#46628A',
  F: '#8A6FB0',
};

const RISK_LABEL = 'risk';
const RISK_COLOR = '#E5484D';

/**
 * The four tickets that can sink the week — not the four most urgent chores.
 * Each one, if wrong, invalidates work already done rather than merely delaying
 * it. FG-015 is included even though it passed, because the label documents
 * where the risk lived.
 */
const RISK_IDS = new Set(['FG-015', 'FG-021', 'FG-029', 'FG-204']);

/** "M2 · Detectors" -> "M2".  Tickets directly under §F carry no ## heading. */
function sectionCode(t) {
  const m = t.section.match(/^([MEF]\d*)\b/);
  return m ? m[1] : t.bucket;
}

// ---------------------------------------------------------------- env

function loadEnv() {
  let raw = '';
  try {
    raw = readFileSync(join(REPO, '.env'), 'utf8');
  } catch {
    /* fall through to process.env */
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const key = process.env.LINEAR_API_KEY;
  if (!key && !DRY_RUN) {
    console.error(
      'LINEAR_API_KEY not set.\n' +
        '  Linear → Settings → Security & access → Personal API keys\n' +
        '  Then add to .env:  LINEAR_API_KEY=lin_api_...\n' +
        '  .env is gitignored — never commit the value.\n' +
        '\n' +
        '  `--dry-run` works without a key and validates the parse.'
    );
    process.exit(1);
  }
  return key ?? null;
}

// ---------------------------------------------------------------- parse

/**
 * Walk TICKETS.md and pull out every checkbox, tagging it with the bucket
 * (M/E/F) and section heading it sits under.
 *
 * The risk table at the bottom references ticket ids too, so match only lines
 * that are actual checkboxes — `- [ ] **FG-NNN** …` at the start of a line.
 */
function parseTickets() {
  const text = readFileSync(join(REPO, 'TICKETS.md'), 'utf8');
  const tickets = [];
  let bucket = null;
  let section = null;

  for (const line of text.split('\n')) {
    const b = line.match(/^#\s+§([MEF])\s+·\s+(.+)$/);
    if (b) {
      bucket = b[1];
      section = null;
      continue;
    }
    const s = line.match(/^##\s+(.+)$/);
    if (s && bucket) {
      section = s[1].trim();
      continue;
    }
    const t = line.match(/^- \[( |x)\] \*\*(FG-\d{3})\*\*\s+(.+)$/);
    if (t && bucket) {
      tickets.push({
        done: t[1] === 'x',
        id: t[2],
        title: t[3].trim(),
        bucket,
        section: section ?? '(unsectioned)',
      });
    }
  }
  return tickets;
}

/** Strip markdown emphasis so Linear titles read cleanly in a list. */
function plainTitle(id, title) {
  const clean = title
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return `${id} ${clean}`;
}

function describe(t) {
  return [
    `Section ${t.section}`,
    '',
    'Source of truth: `TICKETS.md` at the repo root.',
    'Architecture rationale: `PRESEARCH.md`.',
    '',
    `Bucket: ${{ M: 'MVP — Tuesday 11:59 PM', E: 'Early Submission — Thursday 11:59 PM', F: 'Final — Sunday noon' }[t.bucket]}`,
  ].join('\n');
}

// ---------------------------------------------------------------- api

async function gql(key, query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 5);
    console.log(`  rate limited, waiting ${retry}s`);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return gql(key, query, variables);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

/**
 * Every FG-id in the team, with its state. Used two ways: `import` only needs
 * the keys (so a re-run is safe), `--sync` needs the states.
 */
async function fetchLinearState(key) {
  const byId = new Map();
  let cursor = null;
  for (;;) {
    const data = await gql(
      key,
      `query($teamId: ID!, $after: String) {
         issues(filter: { team: { id: { eq: $teamId } } }, first: 250, after: $after) {
           nodes { identifier title state { name type } labels { nodes { name } } }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { teamId: TEAM_ID, after: cursor }
    );
    for (const n of data.issues.nodes) {
      const m = n.title.match(/^(FG-\d{3})\b/);
      if (m) {
        byId.set(m[1], {
          identifier: n.identifier,
          state: n.state?.name ?? 'Unknown',
          // Linear's state *type* is the stable thing to branch on; the display
          // name is user-editable and would silently break this if renamed.
          done: n.state?.type === 'completed',
          started: n.state?.type === 'started',
          labels: (n.labels?.nodes ?? []).map((l) => l.name).sort(),
        });
      }
    }
    if (!data.issues.pageInfo.hasNextPage) break;
    cursor = data.issues.pageInfo.endCursor;
  }
  return byId;
}

/**
 * Rewrite TICKETS.md checkboxes from Linear state.
 *
 * Only the `[ ]` / `[x]` marker is touched — never the ticket text, which
 * TICKETS.md owns. A ticket Linear has never heard of is left exactly as it is,
 * so a newly written ticket does not get silently unchecked before its first
 * import.
 */
function syncCheckboxes(linear) {
  const path = join(REPO, 'TICKETS.md');
  const before = readFileSync(path, 'utf8');
  const changes = [];

  const after = before
    .split('\n')
    .map((line) => {
      const m = line.match(/^- \[( |x)\] \*\*(FG-\d{3})\*\*/);
      if (!m) return line;
      const [, mark, id] = m;
      const state = linear.get(id);
      if (!state) return line; // not in Linear yet — leave alone
      const want = state.done ? 'x' : ' ';
      if (want === mark) return line;
      changes.push({ id, from: mark === 'x' ? 'done' : 'open', to: state.done ? 'done' : 'open', state: state.state });
      return line.replace(`- [${mark}] **${id}**`, `- [${want}] **${id}**`);
    })
    .join('\n');

  return { path, before, after, changes };
}

async function createIssue(key, t) {
  const data = await gql(
    key,
    `mutation($input: IssueCreateInput!) {
       issueCreate(input: $input) { success issue { identifier title } }
     }`,
    {
      input: {
        teamId: TEAM_ID,
        projectId: PROJECTS[t.bucket],
        title: plainTitle(t.id, t.title),
        description: describe(t),
        priority: PRIORITY_OVERRIDE[t.id] ?? BUCKET_PRIORITY[t.bucket],
      },
    }
  );
  if (!data.issueCreate.success) throw new Error(`create failed for ${t.id}`);
  return data.issueCreate.issue;
}

/** Bounded concurrency — Linear allows plenty, but a stampede earns a 429. */
async function pool(items, limit, worker) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    })
  );
  return results;
}

// ---------------------------------------------------------------- main

const key = loadEnv();
const tickets = parseTickets();

const byBucket = tickets.reduce((a, t) => ((a[t.bucket] = (a[t.bucket] ?? 0) + 1), a), {});
console.log(`Parsed ${tickets.length} tickets from TICKETS.md`);
for (const [b, n] of Object.entries(byBucket)) console.log(`  §${b}  ${n}`);

const seen = new Set(tickets.map((t) => t.id));
if (seen.size !== tickets.length) {
  console.error(`Duplicate FG ids: ${tickets.length - seen.size}. Fix TICKETS.md first.`);
  process.exit(1);
}

// Without a key we can still prove the parse; the readback needs the API.
let linear = new Map();
if (key) {
  console.log('\nReading Linear…');
  linear = await fetchLinearState(key);
  console.log(`  ${linear.size} FG ids found`);
} else {
  console.log('\nNo LINEAR_API_KEY — skipping readback, assuming Linear is empty.');
}

// ---------------------------------------------------------------- label mode

if (LABEL) {
  if (!key) {
    console.error('--label needs LINEAR_API_KEY.');
    process.exit(1);
  }

  // Existing labels first — creating a duplicate name is an error, and this has
  // to be re-runnable.
  const existing = await gql(
    key,
    `query($teamId: ID!) {
       issueLabels(filter: { team: { id: { eq: $teamId } } }, first: 250) {
         nodes { id name color }
       }
     }`,
    { teamId: TEAM_ID }
  );
  const labelId = new Map(existing.issueLabels.nodes.map((l) => [l.name, l.id]));

  const wanted = [
    ...Object.entries(SECTION_COLORS).map(([name, color]) => ({ name, color })),
    { name: RISK_LABEL, color: RISK_COLOR },
  ];
  const toCreate = wanted.filter((w) => !labelId.has(w.name));

  console.log(`\nLabels: ${labelId.size} exist, ${toCreate.length} to create`);
  if (!DRY_RUN) {
    for (const w of toCreate) {
      const r = await gql(
        key,
        `mutation($input: IssueLabelCreateInput!) {
           issueLabelCreate(input: $input) { success issueLabel { id name } }
         }`,
        { input: { name: w.name, color: w.color, teamId: TEAM_ID } }
      );
      labelId.set(w.name, r.issueLabelCreate.issueLabel.id);
      console.log(`  created ${w.name} ${w.color}`);
    }
  } else {
    for (const w of toCreate) console.log(`  would create ${w.name} ${w.color}`);
  }

  // Apply. labelIds REPLACES the set, so section + risk go on together or the
  // second write silently drops the first.
  const plan = tickets
    .filter((t) => linear.has(t.id))
    .map((t) => {
      const names = [sectionCode(t)];
      if (RISK_IDS.has(t.id)) names.push(RISK_LABEL);
      return { t, names };
    });

  const bySection = plan.reduce((a, p) => ((a[p.names[0]] = (a[p.names[0]] ?? 0) + 1), a), {});
  console.log(`\nTarget labelling for ${plan.length} issues:`);
  for (const [s, n] of Object.entries(bySection)) console.log(`  ${s.padEnd(4)} ${n}`);
  console.log(`  ${RISK_LABEL} → ${plan.filter((p) => p.names.includes(RISK_LABEL)).map((p) => p.t.id).join(', ')}`);

  // Only write where the label set actually differs. Without this, every re-run
  // is 268 pointless mutations — and a re-run is exactly what you do after a
  // transient 500 from Linear.
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const changed = plan.filter((p) => !same([...p.names].sort(), linear.get(p.t.id).labels));
  console.log(`\n  ${plan.length - changed.length} already correct, ${changed.length} to write`);

  if (DRY_RUN) {
    for (const p of changed.slice(0, 10)) {
      console.log(`    ${p.t.id}: [${linear.get(p.t.id).labels.join(',')}] → [${p.names.join(',')}]`);
    }
    if (changed.length > 10) console.log(`    … and ${changed.length - 10} more`);
    console.log('\nDry run — nothing applied.');
    process.exit(0);
  }

  if (changed.length === 0) {
    console.log('\nLabels already match. Nothing to do.');
    process.exit(0);
  }

  let ok = 0;
  let bad = 0;
  await pool(changed, 5, async ({ t, names }) => {
    try {
      const ids = names.map((n) => labelId.get(n)).filter(Boolean);
      const r = await gql(
        key,
        `mutation($id: String!, $labelIds: [String!]) {
           issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
         }`,
        { id: linear.get(t.id).identifier, labelIds: ids }
      );
      if (!r.issueUpdate.success) throw new Error('issueUpdate returned success=false');
      ok++;
      if (ok % 50 === 0) console.log(`  ${ok}/${plan.length}…`);
    } catch (err) {
      bad++;
      console.error(`  FAILED ${t.id}: ${err.message}`);
    }
  });

  console.log(`\nLabelled ${ok}, failed ${bad}.`);
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- set mode

if (SET) {
  if (!key) {
    console.error('--set needs LINEAR_API_KEY.');
    process.exit(1);
  }

  const states = await gql(
    key,
    `query($teamId: ID!) {
       workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 50) {
         nodes { id name type }
       }
     }`,
    { teamId: TEAM_ID }
  );
  const target = states.workflowStates.nodes.find(
    (s) => s.name.toLowerCase() === SET.state.toLowerCase()
  );
  if (!target) {
    console.error(
      `No state named "${SET.state}". Available: ` +
        states.workflowStates.nodes.map((s) => s.name).join(', ')
    );
    process.exit(1);
  }

  const found = SET.ids.filter((id) => linear.has(id));
  const unknown = SET.ids.filter((id) => !linear.has(id));
  const alreadyThere = found.filter((id) => linear.get(id).state === target.name);
  const todo = found.filter((id) => linear.get(id).state !== target.name);

  console.log(`\n--set ${target.name}: ${SET.ids.length} requested`);
  if (unknown.length) console.log(`  ${unknown.length} not in Linear: ${unknown.join(', ')}`);
  if (alreadyThere.length) console.log(`  ${alreadyThere.length} already ${target.name}`);
  console.log(`  ${todo.length} to change`);

  if (DRY_RUN) {
    for (const id of todo) console.log(`    would set ${id} (${linear.get(id).identifier}) → ${target.name}`);
    console.log('\nDry run — nothing changed.');
    process.exit(0);
  }

  let ok = 0;
  let bad = 0;
  await pool(todo, 5, async (id) => {
    try {
      const r = await gql(
        key,
        `mutation($id: String!, $stateId: String!) {
           issueUpdate(id: $id, input: { stateId: $stateId }) { success }
         }`,
        { id: linear.get(id).identifier, stateId: target.id }
      );
      if (!r.issueUpdate.success) throw new Error('issueUpdate returned success=false');
      ok++;
    } catch (err) {
      bad++;
      console.error(`  FAILED ${id}: ${err.message}`);
    }
  });

  console.log(`\nSet ${ok} to ${target.name}, ${bad} failed.`);
  console.log('Run with --sync to reflect this in TICKETS.md.');
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- sync mode

if (SYNC) {
  if (!key) {
    console.error('--sync needs LINEAR_API_KEY; there is nothing to sync from.');
    process.exit(1);
  }

  const done = [...linear.values()].filter((v) => v.done).length;
  const started = [...linear.values()].filter((v) => v.started).length;
  const missing = tickets.filter((t) => !linear.has(t.id));

  console.log(`\nLinear state: ${done} done · ${started} in progress · ${linear.size - done - started} not started`);
  if (missing.length) {
    console.log(`  ${missing.length} ticket(s) in TICKETS.md not yet in Linear — run without --sync to create them`);
  }

  const { path, before, after, changes } = syncCheckboxes(linear);

  if (!changes.length) {
    console.log('\nTICKETS.md already matches Linear. Nothing to write.');
    process.exit(0);
  }

  console.log(`\n${changes.length} checkbox(es) to update:`);
  for (const c of changes) console.log(`  ${c.id}  ${c.from} → ${c.to}  (${c.state})`);

  if (DRY_RUN) {
    console.log('\nDry run — TICKETS.md not written.');
    process.exit(0);
  }

  writeFileSync(path, after, 'utf8');
  console.log(`\nTICKETS.md updated (${before.length} → ${after.length} bytes).`);
  process.exit(0);
}

const already = new Set(linear.keys());

const todo = tickets.filter((t) => !already.has(t.id));
console.log(`  ${todo.length} to create\n`);

if (todo.length === 0) {
  console.log('Nothing to do — Linear matches TICKETS.md.');
  process.exit(0);
}

if (DRY_RUN) {
  for (const t of todo.slice(0, 10)) console.log(`  would create  ${plainTitle(t.id, t.title)}`);
  if (todo.length > 10) console.log(`  … and ${todo.length - 10} more`);
  console.log('\nDry run — nothing created.');
  process.exit(0);
}

let done = 0;
let failed = 0;
await pool(todo, 5, async (t) => {
  try {
    const issue = await createIssue(key, t);
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${todo.length}…`);
    return issue;
  } catch (err) {
    failed++;
    console.error(`  FAILED ${t.id}: ${err.message}`);
    return null;
  }
});

console.log(`\nCreated ${done}, failed ${failed}, skipped ${already.size}.`);
if (failed) {
  console.log('Re-run to retry the failures — the script skips what already exists.');
  process.exit(1);
}
