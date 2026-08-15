/**
 * The drill's half of PF-588's split: `scripts/ttfe/harness.ts` as a CHILD
 * PROCESS, spoken to over HTTP.
 *
 * Nothing in this file imports server code, and nothing in it can. The harness
 * has `DATABASE_URL`, `pg` and `api/src`; this side has a URL and a client id.
 * That is the same shape L19 used for `scripts/l19-device-approve.ts`, and for
 * the same reason: a subprocess with its own module graph makes "the drill has
 * no privileged path" true by construction rather than true by an import list
 * nobody re-reads.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTsx } from './tsx.js';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

/** Kept in step with `READY_PREFIX` in the harness — asserted by a unit test. */
export const READY_PREFIX = 'ttfe-harness-ready ';

export interface ShipInstanceInfo {
  baseUrl: string;
  databaseUrl: string;
  clientId: string;
  mode: string;
}

export class ShipInstance {
  private constructor(
    readonly info: ShipInstanceInfo,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly log: () => string,
  ) {}

  static async start(): Promise<ShipInstance> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // PF-587: the harness refuses an inherited DATABASE_URL by design. The drill
    // does not smuggle one in — it removes it, so the refusal is real rather
    // than something the caller can defeat by accident.
    delete env.DATABASE_URL;

    // `detached` for the same reason the harness detaches the server: the binary
    // below is a shell wrapper that execs node, so the pid we hold is not the pid
    // that matters, and a SIGTERM to the wrapper leaves the harness — and
    // therefore a container and a database — alive. Measured, not theorised:
    // PF-587's teardown assertion caught it.
    //
    // `resolveTsx` rather than `npx tsx`: see tsx.ts. On a clean checkout `npx`
    // finds nothing at the root and the harness dies 127 before its ready line.
    const child = spawn(resolveTsx(REPO_ROOT), [join('scripts', 'ttfe', 'harness.ts')], {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    const waiters: (() => void)[] = [];
    const wake = (): void => {
      while (waiters.length > 0) waiters.pop()?.();
    };
    let closed: number | null = null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      wake();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      wake();
    });
    child.on('close', (code) => {
      closed = code ?? -1;
      wake();
    });

    const log = (): string => `--- harness stdout ---\n${stdout}\n--- harness stderr ---\n${stderr}`;

    // Event-driven, like L19's `ShipProcess.waitFor` — wakes on a `data` event,
    // never on a timer. A harness that hangs trips the caller's test timeout,
    // which is what a genuinely hung child should do.
    for (;;) {
      const line = stdout.split('\n').find((candidate) => candidate.startsWith(READY_PREFIX));
      if (line !== undefined) {
        const info = JSON.parse(line.slice(READY_PREFIX.length)) as ShipInstanceInfo;
        return new ShipInstance(info, child, log);
      }
      if (closed !== null) {
        throw new Error(`ttfe harness exited ${closed} before printing its ready line.\n${log()}`);
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  /** Everything the harness and the server it booted printed. Failure diagnosis. */
  output(): string {
    return this.log();
  }

  /**
   * PF-587's third assertion, from this side: nothing survives teardown. The
   * harness drops the database (or stops the container) before it exits, so
   * this resolves only once that has happened.
   */
  async stop(): Promise<number> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    const exited = new Promise<number>((resolve) =>
      this.child.once('close', (code) => resolve(code ?? -1)),
    );
    // Closing stdin is the leash the harness listens on. SIGTERM to the GROUP is
    // the backstop — the pid we hold belongs to tsx's shell wrapper, not to the
    // harness.
    this.child.stdin.end();
    if (this.child.pid !== undefined) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch {
        this.child.kill('SIGTERM');
      }
    }
    return exited;
  }
}

/**
 * The human-with-a-browser, as a subprocess — L19's `scripts/l19-device-approve.ts`,
 * reused verbatim.
 *
 * PF-595's audit note: authorizing the device code out of band is the single
 * step a scripted drill cannot perform the way a human does. It is called out
 * here rather than hidden because a reader is entitled to know which part of
 * "from nothing to a verified webhook" was not typed by a person.
 */
export function approveDeviceGrant(
  userCode: string,
  databaseUrl: string,
  baseUrl: string,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveTsx(REPO_ROOT),
      [
        join(REPO_ROOT, 'scripts', 'l19-device-approve.ts'),
        '--user-code',
        userCode,
        '--base-url',
        baseUrl,
        '--decision',
        'allow',
      ],
      { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl } },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}
