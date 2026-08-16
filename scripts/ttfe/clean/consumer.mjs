/**
 * PF-590 — the stage script that runs INSIDE the clean container.
 *
 *     pnpm drill ttfe --clean
 *
 * ── What makes this file "clean" ───────────────────────────────────────────
 * This file never sees the repository. It arrives in the container over HTTP
 * from the same one-file static server that serves the packed tarball, and the
 * container is started with **no bind mount**, so `/app` contains exactly what
 * this script fetches and installs. Its inputs are the two PF-590 names:
 *
 *   TTFE_TARBALL_URL      the packed @ship/sdk, over HTTP
 *   TTFE_SHIP_BASE_URL    the Ship instance, reached over the network like any
 *                         external consumer would reach it
 *
 * Everything else it needs it installs itself, from a **cold pnpm store** — the
 * container is fresh, so `~/.local/share/pnpm/store` is empty by construction
 * rather than by a flag somebody can forget to pass. That is the single
 * difference from fast mode that the ≤ 30 min budget is actually about: fast
 * mode installs a LOCAL tarball on a machine with a WARM store and borrows the
 * repository's own `tsc`. None of those three is available here.
 *
 * ── Why it is not the drill file ───────────────────────────────────────────
 * `integrations/cli/tests/ttfe.drill.ts` is a vitest spec that imports this
 * repository's test support and drives L19's exported CLI commands. Neither
 * exists in the container, and shipping them in would put the repository back
 * inside the thing whose whole claim is that the repository is absent. So the
 * six stages are re-stated here against `@ship/sdk` alone — and
 * `integrations/cli/tests/cleanConsumerParity.test.ts` asserts this file's stage
 * ids are `STAGE_IDS`, in order, so the two cannot drift into two different
 * six-stage drills.
 *
 * ── The one step a script cannot do the way a human does ───────────────────
 * The device grant is approved out of band, by the HOST, which has the database
 * this container deliberately does not. This file prints the user code on stdout
 * as a tagged line and waits; `scripts/ttfe/clean-runner.mjs` reads it and runs
 * L19's approval script. PF-595's audit note asks for that to be stated rather
 * than hidden, and this is where it is stated.
 *
 * Assertions are `node:assert/strict`, not vitest: vitest is not installed here
 * and installing it would be another warm-cache dependency in the one place that
 * exists to have none.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * p.6's six, in p.6's order. Kept in step with
 * `integrations/cli/tests/ttfe/stages.ts` by a unit test, for the same reason
 * `READY_PREFIX` is: two copies of a list that must agree, with nothing
 * asserting that they do, is a list that stops agreeing.
 */
export const STAGE_IDS = Object.freeze([
  'install',
  'login',
  'register_subscription',
  'create_document',
  'receive_webhook',
  'verify_signature',
]);

/** Read by the runner off the container's stdout. Asserted by the same test. */
export const USER_CODE_PREFIX = 'ttfe-clean-usercode ';
export const RESULT_PREFIX = 'ttfe-clean-result ';
export const APP_DIR = '/app/consumer';

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; the runner must pass it into the container.`);
  }
  return value;
};

// Read inside `main`, not at module scope, so
// `integrations/cli/tests/cleanConsumerParity.test.ts` can import this file to
// check its stage list without needing a container's environment to exist.
let TARBALL_URL;
let SHIP_BASE_URL;
let CLIENT_ID;
let LISTENER_PORT;
let PUBLIC_LISTENER_URL;

// ── stage recording ─────────────────────────────────────────────────────────
// The same shape `integrations/cli/tests/ttfe/recorder.ts` produces, because the
// artifact is read by four consumers (PF-592) and a second shape would make the
// clean figure un-comparable with everything else in `ttfe-series.jsonl`.
const records = [];
let firstStageStart = null;
let lastStageEnd = null;
/**
 * PF-593: the FAILING stage, named. Tracked explicitly rather than inferred
 * from `records.length`, because the `finally` below records a stage that threw
 * — so at the moment the rejection surfaces the count already includes it and
 * an inferred id names the stage AFTER the one that failed. Measured on the
 * first green-ish run of this script: a login assertion was reported as
 * `register_subscription`.
 */
let currentStage = null;

async function stage(id, body) {
  const startedAt = performance.now();
  if (firstStageStart === null) firstStageStart = startedAt;
  currentStage = id;
  try {
    const value = await body();
    currentStage = null;
    return value;
  } finally {
    const endedAt = performance.now();
    lastStageEnd = endedAt;
    records.push({ id, elapsedMs: endedAt - startedAt, startedAt, endedAt });
    process.stderr.write(`  ${id.padEnd(22)} ${Math.round(endedAt - startedAt)} ms\n`);
  }
}

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? APP_DIR,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let all = '';
    child.stdout.on('data', (c) => (all += c.toString('utf8')));
    child.stderr.on('data', (c) => (all += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, all }));
  });
}

/** p.8's Install row, third assertion — asserted on captured output. */
const PEER_DEPENDENCY_MARKERS = [
  'unmet peer dependency',
  'peer dep missing',
  'eresolve',
  'could not resolve dependency',
];

// ── the listener (PF-599), verbatim in behaviour ────────────────────────────
// A real socket, and the RAW bytes. A signature computed over
// JSON.stringify(JSON.parse(body)) is a signature over different bytes.
const deliveries = [];
const waiters = [];
const listener = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
    deliveries.push({
      receivedAt: performance.now(),
      method: request.method ?? '',
      headers,
      rawBody: Buffer.concat(chunks).toString('utf8'),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    while (waiters.length > 0) waiters.pop()?.();
  });
});

/** Resolves on a condition, never on a clock (PF-605). The timer is a deadline. */
async function waitForDelivery(predicate, { timeoutMs, what }) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const match = deliveries.find(predicate);
    if (match !== undefined) return match;
    if (performance.now() >= deadline) {
      throw new Error(
        `receive_webhook: no delivery satisfying "${what}" arrived at ${PUBLIC_LISTENER_URL} ` +
          `within ${timeoutMs} ms (${deliveries.length} request(s) seen). The stage timed out; ` +
          'this is not a generic runner timeout.',
      );
    }
    await Promise.race([
      new Promise((resolve) => waiters.push(resolve)),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadline - performance.now()));
        timer.unref?.();
      }),
    ]);
  }
}

async function main() {
  TARBALL_URL = env('TTFE_TARBALL_URL');
  SHIP_BASE_URL = env('TTFE_SHIP_BASE_URL');
  CLIENT_ID = env('TTFE_CLIENT_ID');
  LISTENER_PORT = Number(env('TTFE_LISTENER_PORT'));
  PUBLIC_LISTENER_URL = env('TTFE_PUBLIC_LISTENER_URL');

  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    // 0.0.0.0 inside the container: the host publishes this port, and Ship
    // reaches it at TTFE_PUBLIC_LISTENER_URL from the other side of that map.
    listener.listen(LISTENER_PORT, '0.0.0.0', resolve);
  });

  // ── Stage 1 · install ─────────────────────────────────────────────────────
  // p.8's Install row: "Workspace package resolves; types load in editor; no
  // peer-dependency errors." Three assertions, from a COLD store, over HTTP.
  const sdk = await stage('install', async () => {
    mkdirSync(APP_DIR, { recursive: true });
    writeFileSync(
      join(APP_DIR, 'package.json'),
      `${JSON.stringify({ name: 'ttfe-clean-consumer', version: '0.0.0', type: 'module', private: true }, null, 2)}\n`,
    );

    // `pnpm add <url>` — the tarball travels over HTTP, so registry-shaped
    // resolution and network variance are exercised here and only here. Fast
    // mode installs a local file path and says so.
    const installed = await exec('pnpm', ['add', TARBALL_URL, '--reporter=append-only']);
    assert.equal(installed.code, 0, `pnpm add ${TARBALL_URL} failed (${installed.code}):\n${installed.all}`);

    // (c) no peer-dependency complaint, on the installer's own output.
    const lower = installed.all.toLowerCase();
    assert.ok(
      !PEER_DEPENDENCY_MARKERS.some((marker) => lower.includes(marker)),
      `the installer complained about peer dependencies:\n${installed.all}`,
    );

    // (b) "types load in editor" — the declaration files resolve for a consumer
    // outside the workspace. The compiler is installed HERE, cold, rather than
    // borrowed from the repository's node_modules the way fast mode borrows it,
    // because there is no repository to borrow from.
    writeFileSync(
      join(APP_DIR, 'consumer.ts'),
      "import { ShipClient, verifyWebhook } from '@ship/sdk';\n" +
        'export const probe: [typeof ShipClient, typeof verifyWebhook] = [ShipClient, verifyWebhook];\n',
    );
    writeFileSync(
      join(APP_DIR, 'tsconfig.json'),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: [],
          },
          files: ['consumer.ts'],
        },
        null,
        2,
      )}\n`,
    );
    const addedTsc = await exec('pnpm', ['add', '-D', 'typescript', '--reporter=append-only']);
    assert.equal(addedTsc.code, 0, `pnpm add -D typescript failed:\n${addedTsc.all}`);
    const typeCheck = await exec('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']);
    assert.equal(typeCheck.code, 0, `tsc --noEmit over a two-line consumer failed:\n${typeCheck.all}`);

    // (a) RESOLUTION and EVALUATION are different failures, and the import must
    // go through the package's `exports` map — a path into dist/ bypasses it.
    writeFileSync(join(APP_DIR, 'probe.mjs'), "export * from '@ship/sdk';\n");
    const namespace = await import(`file://${join(APP_DIR, 'probe.mjs')}`);
    assert.equal(typeof namespace.ShipClient, 'function', 'the packed artifact must EVALUATE, not merely resolve');
    assert.equal(typeof namespace.verifyWebhook, 'function');
    assert.equal(typeof namespace.runDeviceLogin, 'function');
    return namespace;
  });

  const credentialsPath = join(APP_DIR, 'credentials.json');

  // ── Stage 2 · login ───────────────────────────────────────────────────────
  const tokens = await stage('login', async () => {
    const store = new sdk.FileTokenStore({ path: credentialsPath });
    let displayed = null;
    const result = await sdk.runDeviceLogin({
      baseUrl: SHIP_BASE_URL,
      clientId: CLIENT_ID,
      tokenStore: store,
      onUserCode: (code, verifyUrl) => {
        displayed = { code, verifyUrl };
        // The host approves. This container has no database and no privileged
        // path, which is the whole point of it.
        process.stdout.write(`${USER_CODE_PREFIX}${JSON.stringify({ code, verifyUrl })}\n`);
      },
    });

    assert.notEqual(displayed, null, 'onUserCode was never invoked');
    assert.ok(displayed.code.length > 0, 'the user code must be non-empty');
    // ── Same instance, different NAME, and that is not a defect ──────────────
    // The fast drill asserts `verifyUrl` starts with the instance's base URL.
    // That assertion is host-specific and it is false here for an honest
    // reason: the container reaches Ship at `host.docker.internal:PORT` while
    // Ship advertises itself at its own `APP_BASE_URL`, `127.0.0.1:PORT`. An
    // external consumer behind any NAT, proxy or container boundary sees
    // exactly this. So the check is on the parts that must hold for a human to
    // be able to finish the flow — an absolute http(s) URL, at the same port,
    // carrying the user code — rather than on a string the network rewrote.
    const verify = new URL(displayed.verifyUrl);
    assert.ok(['http:', 'https:'].includes(verify.protocol), 'the verification URL must be absolute');
    assert.equal(
      verify.port,
      new URL(SHIP_BASE_URL).port,
      `the verification URL must point at the same instance (${displayed.verifyUrl} vs ${SHIP_BASE_URL})`,
    );
    assert.ok(
      displayed.verifyUrl.includes(displayed.code),
      'the verification URL must carry the user code the developer was shown',
    );

    // "persists in configured store", proven by REUSE. Reading the file back
    // only proves something was written.
    const reused = new sdk.ShipClient({
      baseUrl: SHIP_BASE_URL,
      clientId: CLIENT_ID,
      tokenStore: new sdk.FileTokenStore({ path: credentialsPath }),
    });
    const me = await reused.me();
    assert.ok(
      me.scopes.includes('webhooks:manage'),
      'a client built from the store alone must be able to call .me()',
    );
    return result;
  });

  const client = new sdk.ShipClient({
    baseUrl: SHIP_BASE_URL,
    clientId: CLIENT_ID,
    tokenStore: tokens.tokenStore,
  });

  // ── Stage 3 · register subscription ───────────────────────────────────────
  const subscription = await stage('register_subscription', async () => {
    const created = await client.webhooks.create({
      event: 'document.created',
      target_url: PUBLIC_LISTENER_URL,
    });
    assert.equal(typeof created.signing_secret, 'string', 'create() must return the signing secret');
    assert.ok(created.signing_secret.length > 16);

    const fetched = await client.webhooks.get(created.id);
    assert.equal(fetched.id, created.id);
    assert.ok(!Object.keys(fetched).includes('signing_secret'), 'a later read must not carry the secret');

    const page = await client.webhooks.list();
    assert.ok(page.data.map((row) => row.id).includes(created.id));
    for (const row of page.data) {
      assert.ok(!Object.keys(row).includes('signing_secret'));
    }
    return created;
  });

  // ── Stage 4 · create document ─────────────────────────────────────────────
  let documentCreatedAt = 0;
  const document = await stage('create_document', async () => {
    const created = await client.documents.create({ title: 'hello' });
    documentCreatedAt = performance.now();
    const fetched = await client.documents.get(created.id);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.title, 'hello');
    return created;
  });

  // ── Stage 5 · receive webhook ─────────────────────────────────────────────
  const delivery = await stage('receive_webhook', async () => {
    const received = await waitForDelivery((candidate) => candidate.rawBody.includes(document.id), {
      // The clean container crosses a published port and a cold TLS-less HTTP
      // hop that fast mode does not; the stage budget is the clean-mode one.
      timeoutMs: 30_000,
      what: `a POST carrying document ${document.id}`,
    });
    assert.equal(received.method, 'POST');
    assert.ok(received.headers[sdk.SIGNATURE_HEADER.toLowerCase()], 'the delivery must carry Ship-Signature');
    assert.ok(received.headers['idempotency-key'], 'the delivery must carry Idempotency-Key');
    const forThisDocument = deliveries.filter((d) => d.rawBody.includes(document.id));
    assert.equal(forThisDocument.length, 1, 'one document.created write must produce exactly one delivery');
    return received;
  });

  // ── Stage 6 · verify signature ────────────────────────────────────────────
  const verifyMs = await stage('verify_signature', async () => {
    const headers = delivery.headers;
    const secret = subscription.signing_secret;

    const startedAt = performance.now();
    const valid = sdk.verifyWebhook(headers, delivery.rawBody, secret);
    const singleCallMs = performance.now() - startedAt;
    assert.equal(valid, true, 'the delivery that actually arrived must verify');

    const tampered = delivery.rawBody.replace('hello', 'hellp');
    assert.notEqual(tampered, delivery.rawBody, 'the tamper fixture must actually differ');
    assert.equal(sdk.verifyWebhook(headers, tampered, secret), false);

    const staleT = Math.floor(Date.now() / 1000) - 301;
    const staleSignature = createHmac('sha256', secret).update(`${staleT}.${delivery.rawBody}`).digest('hex');
    assert.equal(
      sdk.verifyWebhook(
        { ...headers, [sdk.SIGNATURE_HEADER.toLowerCase()]: `t=${staleT},v1=${staleSignature}` },
        delivery.rawBody,
        secret,
      ),
      false,
      `a signature 301 s old must fail at the ${sdk.DEFAULT_TOLERANCE_SECONDS}s default`,
    );
    return singleCallMs;
  });

  // PF-591: every stage reported, in order, and nothing hid between them.
  assert.deepEqual(
    records.map((r) => r.id),
    [...STAGE_IDS],
    "every one of p.6's six stages must report, in p.6's order",
  );
  for (const record of records) {
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0, `${record.id} elapsedMs must be finite`);
  }

  const totalMs = lastStageEnd - firstStageStart;
  const stageSumMs = records.reduce((sum, r) => sum + r.elapsedMs, 0);
  let gapMs = 0;
  for (let i = 1; i < records.length; i += 1) gapMs += records[i].startedAt - records[i - 1].endedAt;

  return {
    stages: records.map(({ id, elapsedMs }) => ({ id, elapsedMs: Math.round(elapsedMs * 1000) / 1000 })),
    totalMs: Math.round(totalMs * 1000) / 1000,
    metrics: {
      stageSumMs: Math.round(stageSumMs * 1000) / 1000,
      interStageGapMs: Math.round(gapMs * 1000) / 1000,
      reconciliationErrorMs: Math.round(Math.abs(totalMs - (stageSumMs + gapMs)) * 1000) / 1000,
      eventToPostMs: Math.round((delivery.receivedAt - documentCreatedAt) * 1000) / 1000,
      verifySingleCallMs: Math.round(verifyMs * 1000) / 1000,
      deliveriesSeen: deliveries.length,
    },
  };
}

// Executed only when this file IS the program. `cleanConsumerParity.test.ts`
// imports it for `STAGE_IDS` and the two prefixes, and an import that booted a
// listener and then called `process.exit(1)` would take the test runner down
// with it — measured, on the first run of that test.
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().then(
    (result) => {
      process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ pass: true, ...result })}\n`);
      listener.close();
      process.exit(0);
    },
    (error) => {
      // PF-593: a failing run still emits an artifact carrying the stages that
      // DID complete. A failure that produces no artifact produces no diagnosis.
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const failedStage = currentStage;
      process.stderr.write(`\nttfe --clean FAILED in stage ${failedStage ?? '(post-stage assertion)'}\n${message}\n`);
      process.stdout.write(
        `${RESULT_PREFIX}${JSON.stringify({
          pass: false,
          stages: records.map(({ id, elapsedMs }) => ({ id, elapsedMs: Math.round(elapsedMs * 1000) / 1000 })),
          totalMs: lastStageEnd === null ? 0 : Math.round((lastStageEnd - firstStageStart) * 1000) / 1000,
          metrics: { deliveriesSeen: deliveries.length },
          failure: { stage: failedStage, message: String(error instanceof Error ? error.message : error) },
        })}\n`,
      );
      listener.close();
      process.exit(1);
    },
  );
}
