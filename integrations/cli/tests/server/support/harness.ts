/**
 * Driving the REAL `ship` binary against a REAL booted Ship.
 *
 * ── The one rule this file exists to keep ──────────────────────────────────
 * Everything here spawns `dist/index.js` as a CHILD PROCESS. Nothing imports a
 * command function, and nothing imports anything outside this package. That is
 * not ceremony: PF-556's claim is about a *binary*, and PF-566's is that "a NEW
 * process running `ship docs ls` with an empty environment succeeds". Both are
 * claims about `process.exitCode`, argv and a file on disk, and an in-process
 * call cannot observe any of them — it would pass with a broken shebang, a
 * broken `bin` entry and a `main()` that never assigns an exit code, which is
 * exactly the class of defect F120/F121 turned out to be.
 *
 * ── Approving the grant is somebody else's subprocess ──────────────────────
 * `scripts/l19-device-approve.ts` is the browser-with-a-human. It lives outside
 * `integrations/` because it needs `DATABASE_URL`, and PRD p.11 says this tree
 * imports only `@ship/sdk`. The ESLint fence is import-scoped, so a helper here
 * could technically have held a `pg` client without tripping it — running it as
 * a subprocess makes "the CLI has no privileged path" true by construction
 * instead of true by an import list nobody re-reads.
 *
 * ── HOME is redirected, deliberately ───────────────────────────────────────
 * The credential is `~/.ship/credentials.json` and that is not negotiable
 * (PF-506). So the suite gives each run its own `HOME` rather than its own path:
 * the code under test still resolves the real, documented location, and the
 * developer running the suite does not get logged out of their own instance.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
/** The monorepo root. PF-580's test copies its tracked files into a clean directory. */
export const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

/** The built binary. `dist`, not `src` — PF-556 is a claim about the artifact. */
export const SHIP_BIN = join(PACKAGE_ROOT, 'dist', 'index.js');

/** The app p.6's five-line story runs as (PF-057's D12 demo app). */
export const DEMO_CLIENT_ID = 'ship_app_grader_demo';

function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) {
    // Loud, and never a skip. CLAUDE.md: a test that skips itself when the
    // world is not set up reports green for a run that proved nothing.
    throw new Error(
      `${name} is required by the CLI's server-backed suite. ${why}\n` +
        'See integrations/cli/README.md → "Running the server-backed suite".',
    );
  }
  return value;
}

export function baseUrl(): string {
  return required(
    'SHIP_TEST_BASE_URL',
    'It must point at a booted Ship (e.g. http://localhost:3919).',
  ).replace(/\/+$/, '');
}

export function databaseUrl(): string {
  return required(
    'DATABASE_URL',
    'The approval subprocess opens a session in that database; this package never touches it.',
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, for PF-572's leak assertion. */
  all: string;
}

/** A throwaway `HOME`, so `~/.ship` is this run's and not the developer's. */
export function makeHome(): { home: string; dispose: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'l19-home-'));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * The environment a spawned `ship` sees.
 *
 * `SHIP_BASE_URL` and `SHIP_CLIENT_ID` are deliberately ABSENT: PF-562's second
 * clause is that a later invocation succeeds "with no flags and no env", and
 * leaving them set would make that assertion unfalsifiable.
 */
export function cliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SHIP_BASE_URL;
  delete env.SHIP_CLIENT_ID;
  delete env.DATABASE_URL;
  return env;
}

/**
 * Runs `ship <args>` to completion.
 *
 * `bin` defaults to this package's own `dist/index.js`. PF-580's test passes the
 * binary built by the README's setup command inside a clean checkout — same
 * driver, a different artifact, which is the point: nothing about the way these
 * tests spawn a CLI is specific to this working copy.
 */
export function runShip(args: string[], home: string, bin: string = SHIP_BIN): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: cliEnv(home),
      cwd: REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` }),
    );
  });
}

/** A long-running `ship` (login, tail) whose streams are read as they arrive. */
export class ShipProcess {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = '';
  stderr = '';
  private readonly waiters: (() => void)[] = [];
  private closed: { code: number } | null = null;

  constructor(args: string[], home: string, bin: string = SHIP_BIN) {
    this.child = spawn(process.execPath, [bin, ...args], {
      env: cliEnv(home),
      cwd: REPO_ROOT,
    });
    this.child.stdout.on('data', (c: Buffer) => {
      this.stdout += c.toString('utf8');
      this.wake();
    });
    this.child.stderr.on('data', (c: Buffer) => {
      this.stderr += c.toString('utf8');
      this.wake();
    });
    this.child.on('close', (code) => {
      this.closed = { code: code ?? -1 };
      this.wake();
    });
  }

  private wake(): void {
    while (this.waiters.length > 0) this.waiters.pop()?.();
  }

  get all(): string {
    return `${this.stdout}\n${this.stderr}`;
  }

  /**
   * Resolves once `predicate` sees the output it is waiting for.
   *
   * EVENT-DRIVEN, not polled: it wakes on a `data` event, never on a timer
   * (p.11). The only clock involved is vitest's own test timeout, which is what
   * a genuinely hung child should trip.
   */
  async waitFor(predicate: (all: string) => boolean, what: string): Promise<void> {
    for (;;) {
      if (predicate(this.all)) return;
      if (this.closed !== null) {
        throw new Error(
          `ship exited ${this.closed.code} before ${what}.\n--- stdout ---\n${this.stdout}\n--- stderr ---\n${this.stderr}`,
        );
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** SIGINT — the Ctrl-C path PF-574's cleanup hangs off. */
  interrupt(): void {
    this.child.kill('SIGINT');
  }

  exited(): Promise<number> {
    if (this.closed !== null) return Promise.resolve(this.closed.code);
    return new Promise((resolve) => {
      this.child.once('close', (code) => resolve(code ?? -1));
    });
  }
}

/** The stable, parseable line PF-563 requires. This is what a machine scrapes. */
export function userCodeFrom(output: string): string {
  const match = output.match(/ship: device-code-ready user_code=(\S+)/);
  if (!match?.[1]) {
    throw new Error(`no device-code-ready line in:\n${output}`);
  }
  return match[1];
}

/** The human-with-a-browser, as a subprocess. Resolves when the grant is decided. */
export function approveDeviceGrant(
  userCode: string,
  decision: 'allow' | 'deny' = 'allow',
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      [
        'tsx',
        join(REPO_ROOT, 'scripts', 'l19-device-approve.ts'),
        '--user-code',
        userCode,
        '--base-url',
        baseUrl(),
        '--decision',
        decision,
      ],
      { env: { ...process.env, DATABASE_URL: databaseUrl() }, cwd: REPO_ROOT },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: code ?? -1, stdout, stderr, all: `${stdout}\n${stderr}` }),
    );
  });
}

/** `ship login`, driven to completion with the grant approved out of band. */
export async function login(
  home: string,
  options: { clientId?: string; bin?: string } = {},
): Promise<ShipProcess> {
  const proc = new ShipProcess(
    ['login', '--base-url', baseUrl(), '--client-id', options.clientId ?? DEMO_CLIENT_ID],
    home,
    options.bin ?? SHIP_BIN,
  );
  await proc.waitFor((all) => all.includes('device-code-ready'), 'printing a user code');

  const approved = await approveDeviceGrant(userCodeFrom(proc.all));
  if (approved.code !== 0) {
    throw new Error(`approval subprocess failed (${approved.code}):\n${approved.all}`);
  }

  await proc.exited();
  return proc;
}
