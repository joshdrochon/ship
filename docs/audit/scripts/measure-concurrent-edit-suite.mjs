#!/usr/bin/env node
/**
 * Category 6 / W6-9 before-after harness.
 *
 * Implementation Rule 1 wants one named script run under identical conditions
 * before and after the fix. `measure-concurrent-edit.mjs` produces a single run,
 * and W6-9's headline number is a ratio over runs ("13 of 13"), so this wrapper
 * invokes that script N times unmodified and aggregates only the verdict fields.
 *
 * It deliberately shells out rather than importing, so each run gets a fresh
 * browser, fresh contexts and fresh Yjs client ids — importing and looping in one
 * process would reuse them and stop exercising the two-writer merge path.
 *
 *   RUNS=5 BASE=http://localhost:5174 API=http://localhost:3001 \
 *   DOC_ID=<wiki uuid> node docs/audit/scripts/measure-concurrent-edit-suite.mjs \
 *     --out docs/audit/raw/cat6-w6-9-before.json --label before
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS = Number(process.env.RUNS ?? 5);
const arg = (name, fallback) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const OUT = arg('--out', '/tmp/cat6-concurrent-suite.json');
const LABEL = arg('--label', 'run');

const scratch = mkdtempSync(join(tmpdir(), 'cat6-suite-'));
const runs = [];

for (let i = 1; i <= RUNS; i++) {
  const raw = join(scratch, `run-${i}.json`);
  const started = Date.now();
  const proc = spawnSync(
    process.execPath,
    [join(HERE, 'measure-concurrent-edit.mjs'), '--out', raw],
    { env: process.env, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
  );

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(raw, 'utf8'));
  } catch {
    runs.push({ run: i, error: 'no output', stderr: (proc.stderr ?? '').slice(-400) });
    continue;
  }

  const title = parsed.tests?.find((t) => t.field === 'title') ?? {};
  const body = parsed.tests?.find((t) => t.field === 'body') ?? {};
  runs.push({
    run: i,
    ms: Date.now() - started,
    doc: parsed.doc,
    resetHeld: parsed.resetHeld,
    title: {
      typedA: title.typedA,
      typedB: title.typedB,
      server: title.server,
      A_chars_gained_on_server: title.A_chars_gained_on_server,
      B_chars_gained_on_server: title.B_chars_gained_on_server,
      server_has_A: title.server_has_A,
      server_has_B: title.server_has_B,
      both_survived: title.both_survived,
      lost_edit_of: title.lost_edit_of,
      clients_converged: title.clients_converged,
      interleaved: title.interleaved,
      baseline_text_intact: title.baseline_text_intact,
      conflict_indicator_shown: title.conflict_indicator_shown,
    },
    body: {
      A_chars_gained_on_server: body.A_chars_gained_on_server,
      B_chars_gained_on_server: body.B_chars_gained_on_server,
      no_data_loss: body.no_data_loss,
      clients_converged: body.clients_converged,
    },
    afterReload_title: parsed.afterReload?.server?.title,
  });
}

// Only runs whose pre-test reset verifiably held can be cited (see resetDoc()).
const valid = runs.filter((r) => r.resetHeld);
const summary = {
  label: LABEL,
  runs_attempted: RUNS,
  runs_with_reset_held: valid.length,
  title_both_survived: valid.filter((r) => r.title.both_survived).length,
  title_one_edit_destroyed: valid.filter((r) => r.title.lost_edit_of?.length > 0).length,
  title_clients_converged: valid.filter((r) => r.title.clients_converged).length,
  title_baseline_text_intact: valid.filter((r) => r.title.baseline_text_intact).length,
  body_no_data_loss: valid.filter((r) => r.body.no_data_loss).length,
};

writeFileSync(OUT, JSON.stringify({ summary, runs }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${OUT}`);
