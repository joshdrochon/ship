#!/usr/bin/env node
/**
 * PF-590 — `pnpm drill ttfe --clean`, the only mode allowed to claim p.8's
 * *"≤ 30 min real elapsed"* on a clean machine.
 *
 * ── What "clean" is made to mean here, and what it is not ──────────────────
 * PF-590 names four things, and this runner does all four rather than aliasing
 * the fast path:
 *
 *   1. **A cold container, `node:22-bookworm`, with NO bind mount of the repo.**
 *      `docker run` below passes no `-v` and no `--mount`. The container's
 *      filesystem is the image plus what the stage script downloads.
 *   2. **An empty pnpm store.** Not a flag — a consequence. A fresh container
 *      has no `~/.local/share/pnpm/store`, and pnpm itself is fetched by
 *      corepack at the pinned version, so nothing about the host's warm store
 *      reaches the measurement.
 *   3. **The packed tarball served over HTTP.** `pnpm add http://…/ship-sdk.tgz`
 *      exercises fetch-then-extract resolution. Fast mode installs a local file
 *      path and `install.ts` says so in as many words.
 *   4. **No prebuilt `dist`.** `sdk/dist` is REMOVED and the SDK rebuilt from
 *      source before packing, so the artifact under test is built by this run.
 *      A tarball packed around a `dist/` some earlier command left behind is not
 *      a measurement of a clean machine, and it is the easiest way to make this
 *      mode quietly become the fast one.
 *
 * The Ship instance is booted by `scripts/ttfe/harness.ts` on the HOST and
 * reached over the network — PF-590's own words, *"It reaches the Ship instance
 * over the network like any external consumer."* Booting it is SETUP and is
 * recorded as `setupMs`, never inside the graded total, exactly as fast mode
 * treats it.
 *
 * ── What this does NOT close, stated here rather than discovered later ─────
 * p.8's clause is an AND: *"≤ 30 min on a clean machine **following only the
 * published docs**"*. This runner is the first conjunct. It is not the second
 * and cannot be: the commands below were written by someone who already knows
 * them, so the run cannot fail on a step that is missing from the README. That
 * half is PF-601, it needs a person and a stopwatch, and `docs/ttfe-drill.md`
 * says so.
 *
 * ── The one step a script cannot do the way a human does ───────────────────
 * The device grant is approved out of band by this process, which holds the
 * database URL the container deliberately does not have. The container prints
 * the user code; this reads it and shells out to L19's approval script. PF-595's
 * audit note asks for that to be named rather than hidden.
 *
 * Exit 0 = the loop completed inside the budget. Exit 1 = it did not, and the
 * artifact records which stage. Exit 2 = the environment could not be prepared
 * (no docker, no image, harness would not boot) — a broken environment is not a
 * measurement and must not be reported as one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CONSUMER_PATH = join(REPO_ROOT, 'scripts', 'ttfe', 'clean', 'consumer.mjs');
const HARNESS_READY_PREFIX = 'ttfe-harness-ready ';
const USER_CODE_PREFIX = 'ttfe-clean-usercode ';
const RESULT_PREFIX = 'ttfe-clean-result ';

/** The image PF-590 names. Not `-slim`: the stage script needs `curl`. */
const IMAGE = 'node:22-bookworm';
/** Kept in step with `.gitlab-ci.yml`'s `PNPM_VERSION`, asserted by a unit test. */
export const PNPM_VERSION = '10.27.0';
/** The container-side listen port. The host publishes it on a free port. */
const CONTAINER_LISTENER_PORT = 9099;

const thresholds = JSON.parse(readFileSync(join(REPO_ROOT, 'ttfe.thresholds.json'), 'utf8'));
const BUDGET_MS = thresholds.cleanModeMinutes * 60_000;

const log = (line) => process.stderr.write(`ttfe --clean: ${line}\n`);

function fatal(code, message) {
  process.stderr.write(`\nttfe --clean: ${message}\n`);
  process.exit(code);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return { code: result.status ?? -1, all: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createSocketServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * PF-608's lesson, restated: `tsx` is a devDependency of `api`, so pnpm links it
 * into `api/node_modules/.bin` and NOT into the workspace root. `npx tsx` from
 * the root finds nothing on a clean checkout — and with a registry reachable it
 * silently downloads an unpinned tsx, which makes the drill measure a toolchain
 * the lockfile does not name. Same candidate list as
 * `integrations/cli/tests/ttfe/tsx.ts` and `scripts/ttfe/harness.ts`.
 */
function resolveTsx() {
  const candidates = [
    join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    join(REPO_ROOT, 'api', 'node_modules', '.bin', 'tsx'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    fatal(
      2,
      'no `tsx` binary found. Looked at:\n' +
        candidates.map((candidate) => `  · ${candidate}`).join('\n') +
        '\n\nRun `pnpm install --frozen-lockfile` from the repo root. Do NOT fall back to `npx tsx`.',
    );
  }
  return found;
}

// ── 0. the environment, checked before anything is measured ─────────────────
if (run('docker', ['version', '--format', '{{.Server.Version}}']).code !== 0) {
  fatal(2, 'docker is not available. --clean runs the stage script inside a container by definition; there is no host fallback, because a host fallback would be the fast mode wearing this flag\'s name.');
}

const setupStart = Date.now();
const timings = {};

// ── 1. the image ────────────────────────────────────────────────────────────
// Pulled if absent, and TIMED SEPARATELY. Obtaining a base image is not part of
// the developer's loop — it is part of owning a computer — but it is also not
// free, so it is recorded rather than folded into either number.
{
  const started = Date.now();
  const present = run('docker', ['image', 'inspect', IMAGE]).code === 0;
  if (!present) {
    log(`pulling ${IMAGE} (not present locally)`);
    const pulled = run('docker', ['pull', IMAGE]);
    if (pulled.code !== 0) fatal(2, `docker pull ${IMAGE} failed:\n${pulled.all}`);
  }
  timings.imagePullMs = Date.now() - started;
  timings.imageWasCached = present;
}

// ── 2. no prebuilt dist ─────────────────────────────────────────────────────
{
  const started = Date.now();
  rmSync(join(REPO_ROOT, 'sdk', 'dist'), { recursive: true, force: true });
  // ── The `.tsbuildinfo` is not a cache you may leave behind ────────────────
  // MEASURED, on the first run of this script: deleting `dist` alone leaves
  // `sdk/tsconfig.tsbuildinfo`, tsc concludes the project is up to date, emits
  // NOTHING for the ESM half, and the build exits 0. `sdk/dist` then contains
  // only `cjs/` — so `pnpm pack` produces a tarball whose `exports.import` and
  // `types` entries both point at files that are not in it, and the drill fails
  // in the install stage for a reason that has nothing to do with the platform.
  // A "rebuild from source" that consults an incremental cache is not one.
  for (const stale of ['tsconfig.tsbuildinfo', 'tsconfig.cjs.tsbuildinfo']) {
    rmSync(join(REPO_ROOT, 'sdk', stale), { force: true });
  }
  log('removed sdk/dist and its .tsbuildinfo; rebuilding the SDK from source');
  const built = run('pnpm', ['--filter', '@ship/sdk', 'build']);
  if (built.code !== 0) fatal(2, `pnpm --filter @ship/sdk build failed:\n${built.all}`);
  // Assert the ENTRIES the manifest names, not merely that a directory appeared.
  for (const required of ['index.js', 'index.d.ts', join('cjs', 'index.js')]) {
    if (!existsSync(join(REPO_ROOT, 'sdk', 'dist', required))) {
      fatal(2, `the SDK build produced no sdk/dist/${required}, which package.json's exports map names.\n${built.all}`);
    }
  }
  timings.sdkRebuildMs = Date.now() - started;
}

// ── 3. pack ─────────────────────────────────────────────────────────────────
const packDir = join(REPO_ROOT, 'test-results', 'ttfe-clean-artifact');
rmSync(packDir, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
let tarballPath;
{
  const started = Date.now();
  const packed = run('pnpm', ['pack', '--pack-destination', packDir], { cwd: join(REPO_ROOT, 'sdk') });
  if (packed.code !== 0) fatal(2, `pnpm pack failed:\n${packed.all}`);
  const name = readdirSync(packDir).find((entry) => entry.endsWith('.tgz'));
  if (name === undefined) fatal(2, `pnpm pack produced no tarball in ${packDir}:\n${packed.all}`);
  tarballPath = join(packDir, name);
  timings.packMs = Date.now() - started;
  timings.tarballBytes = statSync(tarballPath).size;
}

// ── 4. the one-file static server — the container's only two inputs ─────────
const fileServer = createServer((request, response) => {
  const send = (path, type) => {
    response.writeHead(200, { 'content-type': type, 'content-length': statSync(path).size });
    createReadStream(path).pipe(response);
  };
  if (request.url === '/ship-sdk.tgz') return send(tarballPath, 'application/gzip');
  if (request.url === '/consumer.mjs') return send(CONSUMER_PATH, 'text/javascript');
  response.writeHead(404).end('not found');
});
const filePort = await freePort();
await new Promise((resolve, reject) => {
  fileServer.once('error', reject);
  // 0.0.0.0: the container reaches this through `host.docker.internal`.
  fileServer.listen(filePort, '0.0.0.0', resolve);
});

// ── 5. the Ship instance — SETUP, on the host, reached over the network ─────
const listenerHostPort = await freePort();
let harness = null;
let container = null;
let containerName = null;

const teardown = () => {
  try {
    if (containerName !== null) run('docker', ['rm', '-f', containerName]);
  } catch {
    /* the container is already gone; that is the desired end state */
  }
  try {
    fileServer.close();
  } catch {
    /* already closed */
  }
  if (harness !== null && harness.pid !== undefined && harness.exitCode === null) {
    harness.stdin.end();
    try {
      process.kill(-harness.pid, 'SIGTERM');
    } catch {
      harness.kill('SIGTERM');
    }
  }
};
process.on('exit', teardown);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

const harnessInfo = await (async () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  harness = spawn(resolveTsx(), [join('scripts', 'ttfe', 'harness.ts')], {
    cwd: REPO_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let stdout = '';
  let stderr = '';
  let closed = null;
  const waiters = [];
  const wake = () => {
    while (waiters.length > 0) waiters.pop()?.();
  };
  harness.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
    wake();
  });
  harness.stderr.on('data', (c) => {
    stderr += c.toString('utf8');
    wake();
  });
  harness.on('close', (code) => {
    closed = code ?? -1;
    wake();
  });
  log('booting the Ship instance (container, migrations, server) — this is setup, not the graded loop');
  for (;;) {
    const line = stdout.split('\n').find((candidate) => candidate.startsWith(HARNESS_READY_PREFIX));
    if (line !== undefined) return JSON.parse(line.slice(HARNESS_READY_PREFIX.length));
    if (closed !== null) {
      fatal(2, `the ttfe harness exited ${closed} before printing its ready line.\n${stdout}\n${stderr}`);
    }
    await new Promise((resolve) => waiters.push(resolve));
  }
})();

const apiPort = new URL(harnessInfo.baseUrl).port;
timings.setupMs = Date.now() - setupStart;
log(`instance up at ${harnessInfo.baseUrl} (setup ${(timings.setupMs / 1000).toFixed(1)} s)`);

// ── 6. the container ────────────────────────────────────────────────────────
// No `-v`, no `--mount`, no `--network host`. `--add-host` is what makes
// `host.docker.internal` resolve on a Linux runner; on Docker Desktop it is
// already there and passing it again is harmless.
containerName = `ttfe-clean-${process.pid}-${Date.now()}`;
const containerScript = [
  'set -e',
  'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
  'corepack enable',
  `corepack prepare pnpm@${PNPM_VERSION} --activate`,
  'mkdir -p /app',
  'curl -sSfL "$TTFE_CONSUMER_URL" -o /app/consumer.mjs',
  'exec node /app/consumer.mjs',
].join('\n');

const dockerArgs = [
  'run',
  '--rm',
  '--name',
  containerName,
  '--add-host=host.docker.internal:host-gateway',
  '-p',
  `127.0.0.1:${listenerHostPort}:${CONTAINER_LISTENER_PORT}`,
  '-e',
  `TTFE_TARBALL_URL=http://host.docker.internal:${filePort}/ship-sdk.tgz`,
  '-e',
  `TTFE_CONSUMER_URL=http://host.docker.internal:${filePort}/consumer.mjs`,
  '-e',
  `TTFE_SHIP_BASE_URL=http://host.docker.internal:${apiPort}`,
  '-e',
  `TTFE_CLIENT_ID=${harnessInfo.clientId}`,
  '-e',
  `TTFE_LISTENER_PORT=${CONTAINER_LISTENER_PORT}`,
  '-e',
  `TTFE_PUBLIC_LISTENER_URL=http://127.0.0.1:${listenerHostPort}/ttfe-drill`,
  IMAGE,
  'bash',
  '-lc',
  containerScript,
];

log(`starting ${IMAGE} with no repo mount, cold pnpm store, tarball over HTTP`);
const graded = await new Promise((resolve) => {
  container = spawn('docker', dockerArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const startedAt = Date.now();
  let stdout = '';
  let approved = false;
  let result = null;

  const budgetTimer = setTimeout(() => {
    process.stderr.write(
      `\nttfe --clean: the run exceeded the ${thresholds.cleanModeMinutes} min budget ` +
        `(ttfe.thresholds.json -> cleanModeMinutes) and was stopped.\n`,
    );
    run('docker', ['rm', '-f', containerName]);
  }, BUDGET_MS);
  budgetTimer.unref?.();

  container.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
    process.stderr.write(chunk);
    for (const line of stdout.split('\n')) {
      if (!approved && line.startsWith(USER_CODE_PREFIX)) {
        approved = true;
        const { code } = JSON.parse(line.slice(USER_CODE_PREFIX.length));
        // The out-of-band approval. This process has the database URL; the
        // container does not, and must not.
        log(`approving device code ${code} out of band (PF-595's named exception)`);
        const approvedResult = run(
          resolveTsx(),
          [
            join(REPO_ROOT, 'scripts', 'l19-device-approve.ts'),
            '--user-code',
            code,
            '--base-url',
            harnessInfo.baseUrl,
            '--decision',
            'allow',
          ],
          { env: { ...process.env, DATABASE_URL: harnessInfo.databaseUrl } },
        );
        if (approvedResult.code !== 0) {
          process.stderr.write(
            `ttfe --clean: the device grant was never approved — scripts/l19-device-approve.ts ` +
              `exited ${approvedResult.code}\n${approvedResult.all}\n`,
          );
        }
      }
      if (result === null && line.startsWith(RESULT_PREFIX)) {
        result = JSON.parse(line.slice(RESULT_PREFIX.length));
      }
    }
  });
  container.stderr.on('data', (chunk) => process.stderr.write(chunk));
  container.on('close', (code) => {
    clearTimeout(budgetTimer);
    resolve({ exitCode: code ?? -1, containerWallMs: Date.now() - startedAt, result });
  });
});

// ── 7. the artifact — the SAME file the fast mode writes, with `mode: clean` ─
// PF-592: four consumers read one file. `mode` is what keeps the two figures
// from ever being reported as each other, and `check-series.mjs` filters the
// 60 s P95 window to `mode === 'fast'` for exactly this reason.
const commit = (() => {
  const head = run('git', ['rev-parse', 'HEAD']);
  return head.code === 0 ? head.all.trim().split('\n')[0] : 'unknown';
})();

const cpuCount = cpus().length;
const loadAvg1 = Math.round((loadavg()[0] ?? 0) * 100) / 100;
const result = graded.result;
const pass = graded.exitCode === 0 && result !== null && result.pass === true && result.totalMs <= BUDGET_MS;

const artifact = {
  mode: 'clean',
  commit,
  startedAtIso: new Date(setupStart).toISOString(),
  stages: result?.stages ?? [],
  totalMs: result?.totalMs ?? 0,
  pass,
  ...(pass ? {} : {
    failure: {
      stage: result?.failure?.stage ?? null,
      elapsedMs: result?.totalMs ?? null,
      message:
        result === null
          ? `the container exited ${graded.exitCode} without emitting a result line`
          : (result.failure?.message ??
             (result.totalMs > BUDGET_MS
               ? `the loop took ${(result.totalMs / 60_000).toFixed(2)} min, over the ${thresholds.cleanModeMinutes} min budget`
               : 'the container reported a failure')),
    },
  }),
  metrics: {
    ...(result?.metrics ?? {}),
    setupMs: timings.setupMs,
    containerWallMs: graded.containerWallMs,
    imagePullMs: timings.imagePullMs,
    imageWasCached: timings.imageWasCached,
    sdkRebuildMs: timings.sdkRebuildMs,
    packMs: timings.packMs,
    tarballBytes: timings.tarballBytes,
    budgetMs: BUDGET_MS,
    // The four claims that make this mode different from the fast one, recorded
    // in the artifact so a reader does not have to take the flag's word for it.
    repoBindMounted: false,
    pnpmStoreWarm: false,
    tarballOverHttp: true,
    sdkRebuiltFromSource: true,
    image: IMAGE,
    pnpmVersion: PNPM_VERSION,
    loadAvg1,
    cpuCount,
    loadRatio: Math.round((loadAvg1 / Math.max(1, cpuCount)) * 1000) / 1000,
    loadCertified: loadAvg1 / Math.max(1, cpuCount) <= thresholds.loadRatioVeto,
  },
};

const artifactPath = join(REPO_ROOT, 'test-results', 'ttfe.json');
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
appendFileSync(join(REPO_ROOT, 'test-results', 'ttfe-series.jsonl'), `${JSON.stringify(artifact)}\n`);

process.stderr.write('\n');
process.stderr.write(`  mode                 clean\n`);
for (const record of artifact.stages) {
  process.stderr.write(`  ${record.id.padEnd(22)}${String(Math.round(record.elapsedMs)).padStart(9)} ms\n`);
}
process.stderr.write(`  ${'graded total'.padEnd(22)}${String(Math.round(artifact.totalMs)).padStart(9)} ms  (${(artifact.totalMs / 60_000).toFixed(2)} min of a ${thresholds.cleanModeMinutes} min budget)\n`);
process.stderr.write(`  ${'setup (not graded)'.padEnd(22)}${String(Math.round(timings.setupMs)).padStart(9)} ms\n`);
process.stderr.write(`  ${'container wall clock'.padEnd(22)}${String(Math.round(graded.containerWallMs)).padStart(9)} ms\n`);
process.stderr.write(`  ${'artifact'.padEnd(22)} ${artifactPath}\n\n`);

if (!pass) {
  process.stderr.write(`ttfe --clean: FAILED — ${artifact.failure?.message ?? 'see above'}\n`);
  process.exit(1);
}
log('PASS');
process.exit(0);
