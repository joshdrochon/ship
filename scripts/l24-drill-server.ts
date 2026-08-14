/**
 * Boots Ship instances for L24's drills, runs a suite against them, and takes
 * them down again.
 *
 * ── Why this lives in `scripts/` ───────────────────────────────────────────
 * Same split as `scripts/l19-device-approve.ts` and
 * `scripts/l24-browser-demo-setup.ts`, and for the same reason: booting a server
 * needs `DATABASE_URL` and a path into `api/`, and PRD p.11 says everything
 * under `integrations/` imports only `@ship/sdk`. Provisioning the world is an
 * OPERATOR action. The drill talks to whatever is at `SHIP_DRILL_BASE_URL` and
 * cannot tell how it got there — which is the property that makes it a drill
 * rather than an integration test with extra steps.
 *
 * ── Two instances, and why one would not do ────────────────────────────────
 * PF-727: *"Token expiry is produced by configuring a short TTL at boot, never
 * by waiting."* A process has one TTL config, so the expired case needs a second
 * process — booted with `SHIP_REFRESH_TOKEN_TTL_SECONDS=0`, where every refresh
 * token is born expired and the case costs no elapsed time at all. Sleeping past
 * a two-second TTL would work on this laptop and flake on a loaded CI runner,
 * and p.9 sets drill flake at zero over twenty consecutive runs.
 *
 * Usage:
 *   tsx scripts/l24-drill-server.ts --package @ship/drill-refresh-rotation \
 *       [--expired-instance] [--allow-loopback-webhooks]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The seeded demo app (PF-057 / D12), reused rather than provisioned.
 *
 * It is already PUBLIC (L99 F100), already in the grader workspace that
 * `l19-device-approve.ts` signs in to, and already carries the scopes the whole
 * five-line story needs (F122). Registering a fourth app would add a row nobody
 * else knows about and a second thing to keep in step with `platformApps.ts`.
 */
export const DRILL_CLIENT_ID = 'ship_app_grader_demo';

interface Args {
  packageName: string;
  expiredInstance: boolean;
  allowLoopbackWebhooks: boolean;
  /** Runs the package's `tests/live/**` suite instead of its default one. */
  slackLive: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  const packageName = typeof out.package === 'string' ? out.package : '';
  if (packageName === '') {
    throw new Error('usage: tsx scripts/l24-drill-server.ts --package <workspace-package>');
  }
  return {
    packageName,
    expiredInstance: out['expired-instance'] === true,
    allowLoopbackWebhooks: out['allow-loopback-webhooks'] === true,
    slackLive: out['slack-live'] === true,
  };
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required to boot a Ship for the drill. The L24 lane database is ' +
        'ship_l24b on 5432 (see L99 F34: 5432 is canonical for lane work).',
    );
  }
  return url;
}

/** An unused port, asked of the OS rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

interface Instance {
  url: string;
  child: ChildProcess;
}

/**
 * `/health` polled until it answers.
 *
 * A poll, not a fixed sleep: p.11's rule is about not waiting a guessed interval
 * for something to become true. The loop exits the instant the server is up, and
 * the only fixed number is the ceiling that turns a server which never boots
 * into an error rather than a hang.
 */
async function waitForHealth(url: string, child: ChildProcess, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited ${child.exitCode} before answering /health`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} never answered /health within 60 s. Last: ${lastError}`);
}

async function boot(
  label: string,
  extraEnv: NodeJS.ProcessEnv,
  allowLoopbackWebhooks: boolean,
): Promise<Instance> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const child = spawn('npx', ['tsx', 'api/src/index.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(),
      PORT: String(port),
      NODE_ENV: 'development',
      // F91 — resolved lazily, so a missing key boots green and 500s on the
      // first webhook create. Set here so the drill never meets that.
      WEBHOOK_SECRET_KEY:
        process.env.WEBHOOK_SECRET_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      // PF-575 / B8 — the named, default-off opt-in for loopback delivery
      // targets. Only set when a drill actually receives deliveries.
      ...(allowLoopbackWebhooks ? { SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS: 'true' } : {}),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (c: Buffer) => process.stderr.write(`[${label}] ${c.toString('utf8')}`));
  child.stderr?.on('data', (c: Buffer) => process.stderr.write(`[${label}] ${c.toString('utf8')}`));

  await waitForHealth(url, child, label);
  process.stderr.write(`[${label}] up on ${url}\n`);
  return { url, child };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const instances: Instance[] = [];

  const shutdown = (): void => {
    for (const instance of instances) instance.child.kill('SIGTERM');
  };
  process.on('SIGINT', () => {
    shutdown();
    process.exit(130);
  });

  try {
    const primary = await boot('ship', {}, args.allowLoopbackWebhooks);
    instances.push(primary);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SHIP_DRILL_BASE_URL: primary.url,
      SHIP_DRILL_CLIENT_ID: DRILL_CLIENT_ID,
    };

    if (args.expiredInstance) {
      // Every refresh token this instance issues is born expired: `rotation.ts`
      // rejects on `expiresAt <= now`, and a zero-second TTL makes those equal
      // at issue and strictly ordered by the time the token is presented.
      const expired = await boot('ship-expired', { SHIP_REFRESH_TOKEN_TTL_SECONDS: '0' }, false);
      instances.push(expired);
      env.SHIP_DRILL_EXPIRED_BASE_URL = expired.url;
    }

    const suite = spawn(
      'pnpm',
      // `test:live` rather than `test --dir tests/live`: the package's default
      // config EXCLUDES tests/live so it stays laptop-runnable, and a CLI flag
      // does not override an exclude — measured, it reports "No test files
      // found", which reads as a broken filter rather than as the exclude
      // working.
      ['--filter', args.packageName, args.slackLive ? 'test:live' : 'test'],
      {
        cwd: REPO_ROOT,
        env,
        stdio: 'inherit',
      },
    );

    const code = await new Promise<number>((resolve) => {
      suite.on('close', (status) => resolve(status ?? 1));
    });
    shutdown();
    process.exitCode = code;
  } catch (err) {
    shutdown();
    process.stderr.write(`${String(err)}\n`);
    process.exitCode = 1;
  }
}

void main();
