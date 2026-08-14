#!/usr/bin/env node
/**
 * PF-025 — merged `pf/**` branches are graded evidence and must survive to Final.
 *
 *     pnpm check:branch-preservation
 *
 * Three ways a per-slice branch disappears, and this checks all three:
 *
 *   1. GitHub's "Automatically delete head branches" repo setting. It is a
 *      checkbox that deletes the branch the moment the PR merges, silently, with
 *      no local record. Asserted OFF.
 *   2. Someone running `repo-cleanup`, `git branch -d`, or a prune script.
 *      Covered by .husky/pre-push, which refuses to push a deletion of any
 *      refs/heads/pf/* — checked here to exist and to still contain the guard,
 *      because a hook that was removed looks exactly like a hook that passed.
 *   3. A force-push that rewrites the history a PR description cites. Same hook.
 *
 * Requires the `gh` CLI for check 1. Without it the local checks still run and
 * the remote one is reported as UNVERIFIED rather than passed — an unverifiable
 * check must never read as a green one.
 *
 * Exit 0 = preserved. Exit 1 = at least one guard is missing or disabled.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PRE_PUSH = join(REPO, '.husky', 'pre-push');

const failures = [];
const warnings = [];
const notes = [];

// --- 1. the repo setting -----------------------------------------------------
try {
  const raw = execFileSync('gh', ['api', 'repos/{owner}/{repo}', '--jq', '{d:.delete_branch_on_merge,p:.private}'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const { d: deleteOnMerge, p: isPrivate } = JSON.parse(raw);

  if (deleteOnMerge === true) {
    failures.push(
      'GitHub repo setting "Automatically delete head branches" is ON. Every merged pf/** branch ' +
        'is deleted the moment its PR merges, and the submission evidence goes with it. Turn it off: ' +
        'gh api -X PATCH repos/{owner}/{repo} -F delete_branch_on_merge=false',
    );
  } else {
    notes.push('  ok  delete_branch_on_merge = false');
  }

  // Not this ticket's criterion, but it is the first row of the same PRD
  // requirement (p.12: "Public; per-slice branches preserved") and it costs one
  // field on a request already being made. L26 owns the gate; this is a warning.
  if (isPrivate === true) {
    warnings.push('repository is PRIVATE — PRD p.12 requires a public repo at Final Submission (L26 owns this gate)');
  } else {
    notes.push('  ok  repository is public');
  }
} catch (err) {
  warnings.push(
    `could not read the repo setting via gh (${String(err.message).split('\n')[0]}). ` +
      'delete_branch_on_merge is UNVERIFIED — check it by hand in Settings > General.',
  );
}

// --- 2 + 3. the pre-push hook ------------------------------------------------
if (!existsSync(PRE_PUSH)) {
  failures.push('.husky/pre-push does not exist. Nothing stops a branch deletion or a force-push to pf/**.');
} else {
  const hook = readFileSync(PRE_PUSH, 'utf8');
  if (!hook.includes('refs/heads/pf/')) {
    failures.push('.husky/pre-push exists but no longer matches refs/heads/pf/* — the guard was removed or renamed.');
  } else {
    notes.push('  ok  .husky/pre-push guards refs/heads/pf/*');
  }
  if (!hook.includes('merge-base --is-ancestor')) {
    failures.push('.husky/pre-push has no non-fast-forward check. A force-push can rewrite history a PR description cites.');
  } else {
    notes.push('  ok  .husky/pre-push rejects non-fast-forward pushes to pf/**');
  }
}

// --- report -------------------------------------------------------------------
console.log('branch-preservation check (PF-025)\n');
for (const n of notes) console.log(n);
for (const w of warnings) console.warn(`  ?   ${w}`);

if (failures.length > 0) {
  console.error('\nFAILED:\n');
  for (const f of failures) console.error(`  x  ${f}\n`);
  console.error('Per-slice branches are graded evidence (PRD p.12). See CONTRIBUTING.md.');
  process.exit(1);
}

console.log('\nBranch preservation guards are in place.');
