/**
 * PF-587 / PF-588 — the throwaway Ship instance the TTFE drill runs against.
 *
 * ── Why this file is not in `integrations/` ────────────────────────────────
 * PRD p.11 is categorical: *"External integrations live in integrations/ and
 * import only @ship/sdk — never api/src/."* PF-587 needs a booted Ship, which
 * needs server code. Those two facts collide, and PF-588 resolves the collision
 * structurally rather than by waiving it: the harness lives HERE, and the drill
 * spawns it as a child process and speaks to it over HTTP, exactly like an
 * external developer. The tempting fix — one `eslint-disable` on a `createApp`
 * import inside the drill — would make the drill the single place in the
 * repository where the boundary claim it exists to demonstrate is false.
 *
 * Same split, and the same reason, as `scripts/l19-device-approve.ts`.
 *
 * ── What it provisions ─────────────────────────────────────────────────────
 *   1. A Postgres it created itself — a testcontainer by default, or a freshly
 *      CREATEd database on `TTFE_POSTGRES_ADMIN_URL` when one is supplied.
 *   2. 60 migrations + the three first-party app seeds (`db:migrate` does both).
 *   3. `api/src/index.ts` as a child process on a free port — the PRODUCTION
 *      entrypoint, so `createApp(productionDeps())` and the real `HttpDeliverer`
 *      over a real socket. `testDeps()` would prove nothing p.11's unit suites
 *      do not already prove.
 *
 * ── The protocol ───────────────────────────────────────────────────────────
 * One line on stdout when everything is up:
 *
 *     ttfe-harness-ready {"baseUrl":"http://127.0.0.1:PORT","databaseUrl":"…"}
 *
 * then it stays alive until stdin closes or it is signalled. Teardown drops the
 * database (or stops the container) and kills the server. `stdin` is the leash:
 * if the drill dies without signalling, the pipe closes and this exits anyway.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *     npx tsx scripts/ttfe/harness.ts
 *
 * Environment: `TTFE_POSTGRES_ADMIN_URL` (optional). `DATABASE_URL` must NOT be
 * set — see `assertDatabaseIsOurs`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The line a caller waits for. Spelled once; the drill imports nothing from here. */
export const READY_PREFIX = 'ttfe-harness-ready ';

/** The app p.6's five-line story runs as (PF-057's D12 demo app). */
export const DEMO_CLIENT_ID = 'ship_app_grader_demo';

/**
 * PF-587's first assertion: *"the drill refuses to start, with a named error, if
 * `DATABASE_URL` points at anything it did not create."*
 *
 * The check is on PRESENCE, not on the value, and that is the strict reading on
 * purpose. A harness that inspected the URL and decided `ship_dev` looks like a
 * dev database would be one hostname away from dropping the wrong one. A
 * database this process did not create is a database it must not adopt, and the
 * only URL it did create is the one it is about to build.
 *
 * Exported as a pure function so a unit test can prove it fires without booting
 * anything.
 */
export class TtfeForeignDatabaseError extends Error {
  constructor(readonly offendingUrl: string) {
    super(
      'TTFE harness refuses to start: DATABASE_URL is already set in this environment ' +
        `(${redact(offendingUrl)}). The drill provisions its own throwaway database and drops it ` +
        'at teardown (PF-587); adopting an inherited one risks running migrations, seeds and a ' +
        'teardown DROP against a dev or deployed database. Unset DATABASE_URL, or point ' +
        'TTFE_POSTGRES_ADMIN_URL at a server on which this harness may CREATE its own.',
    );
    this.name = 'TtfeForeignDatabaseError';
  }
}

export function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

export function assertDatabaseIsOurs(env: NodeJS.ProcessEnv): void {
  const inherited = env.DATABASE_URL;
  if (inherited !== undefined && inherited !== '') {
    throw new TtfeForeignDatabaseError(inherited);
  }
}

/**
 * PF-587's second assertion: two concurrent drill runs collide on neither ports
 * nor schema. The database name carries 8 bytes of entropy and the port is
 * whatever the kernel hands out for `listen(0)` — neither is derived from a
 * worker index, a fixed base, or the clock.
 */
export function freshDatabaseName(): string {
  return `ship_ttfe_${randomBytes(8).toString('hex')}`;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not resolve an ephemeral port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

export function withDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

interface Provisioned {
  databaseUrl: string;
  dispose: () => Promise<void>;
}

/** A fresh database on a server we were handed. Dropped at teardown. */
async function provisionOnAdminServer(adminUrl: string): Promise<Provisioned> {
  const name = freshDatabaseName();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  // Identifier, not a value — parameters are not allowed in CREATE DATABASE.
  // `name` is our own hex, never user input.
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();

  return {
    databaseUrl: withDatabase(adminUrl, name),
    dispose: async () => {
      const dropper = new Client({ connectionString: adminUrl });
      await dropper.connect();
      await dropper.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      await dropper.query(`DROP DATABASE IF EXISTS "${name}"`);
      // PF-587's third assertion — "nothing survives teardown" — verified HERE
      // rather than asserted by the caller. The drill may not hold a database
      // client (p.11), so the only place this can be checked is the side that
      // created the thing. A non-zero exit is then the drill's proof.
      const survivors = await dropper.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      await dropper.end();
      if (survivors.rowCount !== 0) {
        throw new Error(`teardown failed: database ${name} still exists after DROP`);
      }
    },
  };
}

/** The default: a container this process started and this process destroys. */
async function provisionContainer(): Promise<Provisioned> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:16').start();
  return {
    databaseUrl: container.getConnectionUri(),
    dispose: () => container.stop(),
  };
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`)),
    );
  });
}

/**
 * Wait for the server to answer `/health`.
 *
 * EVENT-DRIVEN on the child's own output, then a request loop with NO fixed
 * sleep between attempts (PF-605): each attempt is awaited to completion and the
 * next starts immediately. The only clock is the caller's timeout.
 */
async function waitForHealth(baseUrl: string, child: ChildProcess, deadline: number): Promise<void> {
  let lastError = 'no attempt made';
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`api exited ${child.exitCode} before /health answered`);
    }
    if (Date.now() > deadline) {
      throw new Error(`api did not answer ${baseUrl}/health before the harness deadline: ${lastError}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

async function main(): Promise<void> {
  assertDatabaseIsOurs(process.env);

  const adminUrl = process.env.TTFE_POSTGRES_ADMIN_URL;
  const provisioned =
    adminUrl !== undefined && adminUrl !== ''
      ? await provisionOnAdminServer(adminUrl)
      : await provisionContainer();

  // Base64 of 32 random bytes — the shape `secretCipher.ts` expects. Generated
  // per run and never written to disk: L99 F91 is that a MISSING one makes
  // `webhooks.create` 500 with a message the consumer never sees, which is
  // precisely the drill's Subscribe stage.
  const webhookSecretKey = randomBytes(32).toString('base64');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: provisioned.databaseUrl,
    WEBHOOK_SECRET_KEY: webhookSecretKey,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    AGENT_CLIENT_SECRET: 'ttfe-drill',
    GRADER_CLIENT_SECRET: 'ttfe-drill',
    DEMO_CLIENT_SECRET: 'ttfe-drill',
    PORT: String(port),
    APP_BASE_URL: baseUrl,
    CORS_ORIGIN: baseUrl,
    // PF-599: the drill's listener is `http://127.0.0.1:PORT`, which
    // `checkTargetUrl` rejects unless this opt-in is set. Default-off; the
    // deployed instance does not set it (PF-575).
    SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS: 'true',
    NODE_ENV: 'development',
  };

  let server: ChildProcess | null = null;
  const dispose = async (): Promise<void> => {
    if (server !== null && server.exitCode === null && server.pid !== undefined) {
      // The GROUP, not the pid — see the `detached` note below. The database
      // DROP that follows needs every connection gone, and a leaked server holds
      // one open.
      try {
        process.kill(-server.pid, 'SIGKILL');
      } catch {
        server.kill('SIGKILL');
      }
      await new Promise<void>((resolve) => {
        if (server === null || server.exitCode !== null) return resolve();
        server.once('close', () => resolve());
      });
    }
    await provisioned.dispose();
  };

  try {
    await run('npx', ['tsx', join('api', 'src', 'db', 'migrate.ts')], serverEnv);

    // ── `detached: true` is load-bearing, not tidiness ──────────────────────
    // `npx` execs a SHELL WRAPPER which execs node. Killing the pid we hold
    // kills the wrapper and leaves the server running as an orphan — measured:
    // the first version of PF-587's teardown assertion found `/health` still
    // answering 200 after the harness had exited 0. A leaked server holds the
    // database open, so the DROP that follows blocks or fails, and "nothing
    // survives teardown" is false while every assertion around it is green.
    //
    // `detached` puts the child in its own process GROUP, and `kill(-pid)`
    // takes the whole group. This is the only spelling that reaches a
    // grandchild.
    server = spawn('npx', ['tsx', join('api', 'src', 'index.ts')], {
      cwd: REPO_ROOT,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    // The API's own logs go to OUR stderr, so a drill failure shows the server's
    // side of it. stdout is reserved for the ready line and nothing else.
    server.stdout?.on('data', (c: Buffer) => process.stderr.write(c));
    server.stderr?.on('data', (c: Buffer) => process.stderr.write(c));

    await waitForHealth(baseUrl, server, Date.now() + 120_000);
  } catch (error) {
    await dispose();
    throw error;
  }

  process.stdout.write(
    READY_PREFIX +
      JSON.stringify({
        baseUrl,
        databaseUrl: provisioned.databaseUrl,
        clientId: DEMO_CLIENT_ID,
        mode: adminUrl ? 'admin-server' : 'testcontainer',
      }) +
      '\n',
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void dispose().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  // The leash: the drill holds the write end of this pipe. If it dies without
  // signalling, the pipe closes here and the container goes with it.
  process.stdin.resume();
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// `import.meta.url` guard: the unit test imports the pure helpers above and must
// not boot a container by doing so.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`ttfe-harness failed: ${String(error)}\n`);
    process.exit(1);
  });
}
