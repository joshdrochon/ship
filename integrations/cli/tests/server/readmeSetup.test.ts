/**
 * PF-580 — one-command setup from a clean clone, in the README where a grader
 * will look.
 *
 * p.18's Pre-Search 3.4 asks it directly: *"If a grader wants to install the CLI
 * from your repo and run it against your deployed instance, what is the
 * one-command setup, and where does it live in the README?"* A README answer
 * that nobody executes is a guess, so this test reads the command **out of the
 * README** and runs it — if someone edits that block, this fails.
 *
 * ── What is proven here, and what is NOT ───────────────────────────────────
 * PF-580 asks for three things and this test delivers two:
 *
 *   ✓ ONE command, taken verbatim from `integrations/cli/README.md`;
 *   ✓ executed in a CLEAN CHECKOUT — an empty directory holding only this
 *     repository's tracked files: no `node_modules`, no `dist`, nothing built;
 *   ✗ …in a CONTAINER, against the DEPLOYED instance.
 *
 * The third is open and is reported open. A test that ran the container against
 * localhost while the ticket says "deployed" would be a green tick a grader
 * could falsify in one curl. So this runs on the host against
 * `SHIP_TEST_BASE_URL`, and the ticket stays ◐.
 *
 * The reason it was open has changed. It used to be that no reachable deployed
 * PlugForge instance existed to point at — the SDK's `DEFAULT_BASE_URL` was
 * `https://ship.awsdev.treasury.gov`, Part 1's host, which answers 403. That
 * default now points at the live deployment, so what remains open is only the
 * containerized half.
 *
 * The grader's app is read-only (p.13, p.2), so the documented smoke command is
 * `docs ls` and not `docs create` — and that claim is asserted too, because a
 * README that hands a grader credentials which cannot run the headline command
 * had better say so.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT, REPO_ROOT, login, makeHome, runShip } from './support/harness.js';
import { EXIT_CODES } from '../../src/exitCodes.js';

/** The app p.13 promises graders: read-only scopes, pre-registered. */
const GRADER_CLIENT_ID = 'ship_app_grader_readonly';

let checkout: string;
let scratchHome: { home: string; dispose: () => void };

/**
 * The one command, read out of the README's "One-command setup" section.
 *
 * Verbatim, and asserted to be a single line: "one command" is the whole point
 * of the ticket, and a block that grew a second line would otherwise pass this
 * test while failing the acceptance criterion.
 */
function documentedSetupCommand(): string {
  const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
  const section = readme.split('## One-command setup')[1];
  expect(section, 'the README must have a "One-command setup" section').toBeDefined();

  const fenced = (section as string).match(/```bash\n([\s\S]*?)```/);
  expect(fenced?.[1], 'that section must open with a bash block').toBeDefined();

  const lines = (fenced?.[1] as string)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  expect(lines, 'PF-580: ONE command, not a recipe').toHaveLength(1);
  return lines[0] as string;
}

/** An empty directory holding this repo's TRACKED files and nothing else. */
function cleanCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), 'l19-clean-'));

  // `git init` first: the repository's own `postinstall` sets a git config
  // value and `prepare` runs husky, so an un-versioned directory would fail the
  // install for a reason that has nothing to do with the CLI.
  execFileSync('git', ['init', '--quiet'], { cwd: root });

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT })
    .toString('utf8')
    .split('\0')
    .filter((path) => path !== '');

  for (const relative of tracked) {
    const source = join(REPO_ROOT, relative);
    if (!existsSync(source)) continue; // a deleted-but-tracked file
    const destination = join(root, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  // The two things a "clean" checkout must not already have.
  expect(existsSync(join(root, 'node_modules'))).toBe(false);
  expect(existsSync(join(root, 'integrations', 'cli', 'dist'))).toBe(false);
  return root;
}

/** Runs a shell command the way a grader would: pasted, in the checkout root. */
function runInCheckout(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env } });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

beforeAll(() => {
  checkout = cleanCheckout();
  scratchHome = makeHome();
});

afterAll(() => {
  scratchHome?.dispose();
  if (checkout !== undefined) rmSync(checkout, { recursive: true, force: true });
});

describe('PF-580 — the README command, executed from a clean checkout', () => {
  it('builds a runnable `ship` binary and reaches an authenticated `docs ls`', async () => {
    const command = documentedSetupCommand();
    const setup = await runInCheckout(command, checkout);
    expect(setup.code, `${command}\n${setup.output}`).toBe(0);

    // PF-556's claim, re-asserted about the artifact this command produced —
    // not the one this working copy happens to have lying around.
    const bin = join(checkout, 'integrations', 'cli', 'dist', 'index.js');
    expect(existsSync(bin), setup.output).toBe(true);
    expect(statSync(bin).mode & 0o111, 'the executable bit must survive the build').not.toBe(0);
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);

    const help = await runShip(['--help'], scratchHome.home, bin);
    expect(help.code, help.all).toBe(EXIT_CODES.success);
    for (const name of ['login', 'docs ls', 'docs get', 'docs create', 'webhooks tail']) {
      expect(help.stdout).toContain(name);
    }

    // The documented authenticate-then-smoke-test pair, with the grader's app.
    const session = await login(scratchHome.home, { clientId: GRADER_CLIENT_ID, bin });
    expect(await session.exited(), session.all).toBe(EXIT_CODES.success);

    // …and `docs ls` with NO flags and NO environment, which is what the README
    // promises: the instance and the app were persisted by `login`.
    const ls = await runShip(['docs', 'ls', '--json'], scratchHome.home, bin);
    expect(ls.code, ls.all).toBe(EXIT_CODES.success);
    expect(Array.isArray(JSON.parse(ls.stdout))).toBe(true);
  }, 300_000);

  it('the grader app is genuinely read-only, exactly as the README warns', async () => {
    // p.13 and p.2 both say the pre-registered grader app carries read-only
    // scopes, which is WHY the documented smoke command is `docs ls`. If this
    // ever succeeds, the README's warning is wrong and so is the app.
    const bin = join(checkout, 'integrations', 'cli', 'dist', 'index.js');
    const created = await runShip(
      ['docs', 'create', '--title', 'grader-should-not-be-able-to-write'],
      scratchHome.home,
      bin,
    );

    expect(created.code, created.all).not.toBe(EXIT_CODES.success);
    expect(created.stdout).toBe('');
    // The missing scope is NAMED — p.2's gate item 6, surfaced through the
    // SDK's `required_scope` (PF-500). "Forbidden" alone sends a developer
    // reading their own code.
    expect(created.stderr).toContain('documents:write');
    expect(created.stderr).not.toContain('    at ');

    // The README says this, in as many words. If the sentence goes, so does the
    // only warning a grader gets before pasting the headline command.
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('The documented smoke command is `docs ls`');
  }, 120_000);
});
