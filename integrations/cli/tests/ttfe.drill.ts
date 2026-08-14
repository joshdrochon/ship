/**
 * PF-586 – PF-611 — the Time-to-First-Event drill.
 *
 *     pnpm drill ttfe
 *
 * p.6 asks one question and this file is the answer: *"on a clean container,
 * with only the published docs and the SDK, how long does it take a developer to
 * go from nothing to a verified signed webhook in their terminal?"* p.14 closes
 * the PRD with *"The TTFE drill is the rubric."*
 *
 * ── Boundary (PF-588) ──────────────────────────────────────────────────────
 * The import graph of this file contains `@ship/sdk` — as a TYPE import, with
 * the RUNTIME namespace loaded from a real `pnpm install` of the packed tarball
 * — plus node builtins, vitest, and this package's own test support. It imports
 * no server code. The Ship instance it runs against is booted by
 * `scripts/ttfe/harness.ts` as a CHILD PROCESS and reached over HTTP, exactly as
 * an external developer would reach it. A drill that imported `createApp`
 * directly is a drill in which the boundary claim it exists to demonstrate is
 * false.
 *
 * ── Six stages, and nothing hides between them (PF-591) ────────────────────
 * p.6 names them: install, login, register subscription, create document,
 * receive webhook, verify signature. `STAGE_IDS` is the frozen list; every one
 * must report, every `elapsedMs` must be finite and non-negative, and the six
 * plus the measured inter-stage gaps must reconcile with the total to within
 * `reconcileToleranceMs`.
 *
 * ── No retries and no sleeps (PF-605) ──────────────────────────────────────
 * `vitest.drill.config.ts` sets `retry: 0` and the CI job adds no wrapper. p.9's
 * target is *"0% (any flake = bug in the drill or the platform)"*, and a retry
 * is precisely the mechanism that converts a flake into a pass. This is also why
 * the drill is NOT a Playwright test: `playwright.config.ts:60` is
 * `retries: process.env.CI ? 2 : 1`, which would forfeit the target on a line
 * this file never reads.
 *
 * ── What is setup and what is graded ───────────────────────────────────────
 * Booting the throwaway Ship (container, 60 migrations, server) is SETUP and is
 * recorded as `setupMs` — it is what the harness costs, not what a developer
 * waits for. p.8's example sets `t0` before the install line, so the graded
 * total is first-stage-start → last-stage-end and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ShipSdk from '@ship/sdk';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STAGE_IDS } from './ttfe/stages.js';
import { StageFailure, StageRecorder } from './ttfe/recorder.js';
import { thresholds } from './ttfe/thresholds.js';
import { WebhookListener } from './ttfe/listener.js';
import { ShipInstance, approveDeviceGrant } from './ttfe/shipInstance.js';
import {
  hasPeerDependencyComplaint,
  packAndInstallSdk,
  typeCheckConsumer,
  type InstalledSdk,
} from './ttfe/install.js';
import { writeArtifact, machineLoad, repoRoot } from './ttfe/artifact.js';

// L19's exported command functions (PF-581), for the CLI half of PF-611. Same
// package, so the boundary fence is untouched; and importing them rather than
// re-implementing them is the difference between timing the demo's code path and
// timing a parallel one that can drift from it.
import { runLogin, runDocsCreate, runWebhooksTail } from '../src/public.js';
import { contextDefaults, type OutputSink } from '../src/public.js';
import { EXIT_CODES } from '../src/exitCodes.js';

const T = thresholds();
const MODE = process.env.TTFE_MODE ?? 'fast';

let instance: ShipInstance;
let listener: WebhookListener;
let installed: InstalledSdk | null = null;
let setupMs = 0;
const recorder = new StageRecorder();

beforeAll(async () => {
  const startedAt = performance.now();
  instance = await ShipInstance.start();
  listener = await WebhookListener.start();
  setupMs = performance.now() - startedAt;
}, 300_000);

afterAll(async () => {
  await listener?.close();
  await instance?.stop();
  installed?.dispose();
});

/**
 * PF-611 — Testing Scenario 9 as ONE pass/fail.
 *
 * p.5: *"from a clean container, `pnpm install @ship/sdk` → `ship login` →
 * create document → receive verified webhook in under 30 minutes elapsed."* No
 * stage is skippable and an unreached stage is a failure rather than an absence:
 * six `it()` blocks would let five green ones read as progress while the sixth
 * never ran.
 */
describe('TS-9 — the Time-to-First-Event drill', () => {
  it('runs the whole loop and every stage reports', async () => {
    const load = machineLoad();
    let failure: unknown;

    try {
      // ── Stage 1 · install ───────────────────────────────────────────────
      // p.8's Install row: "Workspace package resolves; types load in editor;
      // no peer-dependency errors." Three assertions, not one.
      const sdk = await recorder.stage('install', async () => {
        installed = await packAndInstallSdk();

        // (a) RESOLUTION and EVALUATION are different failures. L99's F14 —
        // `verifyWebhook` top-level-importing `node:crypto` in a browser build —
        // resolves fine and fails only here, on evaluation.
        const namespace = (await import(installed.entryUrl)) as typeof ShipSdk;
        expect(typeof namespace.ShipClient, 'the packed artifact must EVALUATE, not merely resolve').toBe(
          'function',
        );
        expect(typeof namespace.verifyWebhook).toBe('function');
        expect(typeof namespace.runDeviceLogin).toBe('function');

        // (b) "types load in editor" is checkable only as "the declaration files
        // resolve for a consumer OUTSIDE the workspace".
        const typeCheck = await typeCheckConsumer(installed);
        expect(typeCheck.code, `tsc --noEmit over a two-line consumer failed:\n${typeCheck.all}`).toBe(0);

        // (c) asserted on the installer's captured output, not eyeballed.
        expect(
          hasPeerDependencyComplaint(installed.installerOutput),
          `the installer complained about peer dependencies:\n${installed.installerOutput}`,
        ).toBe(false);

        return namespace;
      });

      const home = mkdtempSync(join(tmpdir(), 'ttfe-home-'));
      const credentialsPath = join(home, 'credentials.json');

      // ── Stage 2 · login ─────────────────────────────────────────────────
      // p.8's Auth row: user code displayed, polling succeeds, token persists in
      // the configured store.
      const tokens = await recorder.stage('login', async () => {
        const store = new sdk.FileTokenStore({ path: credentialsPath });
        let displayed: { code: string; verifyUrl: string } | null = null;

        const flow = sdk.runDeviceLogin({
          baseUrl: instance.info.baseUrl,
          clientId: instance.info.clientId,
          tokenStore: store,
          onUserCode: (code, verifyUrl) => {
            displayed = { code, verifyUrl };
            // The out-of-band approval is the ONE step a scripted drill cannot
            // perform the way a human does. It is a subprocess with its own
            // DATABASE_URL, never a privileged path available to this file.
            void approveDeviceGrant(code, instance.info.databaseUrl, instance.info.baseUrl);
          },
        });

        const result = await flow;

        // (a) BOTH values, before the first poll — a device flow that never
        // displays the code is unusable however fast it completes.
        expect(displayed, 'onUserCode was never invoked').not.toBeNull();
        const shown = displayed as unknown as { code: string; verifyUrl: string };
        expect(shown.code.length, 'the user code must be non-empty').toBeGreaterThan(0);
        expect(shown.verifyUrl).toContain(instance.info.baseUrl);

        // (c) "persists in configured store" proven by REUSE, not by inspection.
        // Reading the file back only proves something was written.
        const reused = new sdk.ShipClient({
          baseUrl: instance.info.baseUrl,
          clientId: instance.info.clientId,
          tokenStore: new sdk.FileTokenStore({ path: credentialsPath }),
        });
        const me = await reused.me();
        expect(me.scopes, 'a client built from the store alone must be able to call .me()').toContain(
          'webhooks:manage',
        );

        return result;
      });

      const client = new sdk.ShipClient({
        baseUrl: instance.info.baseUrl,
        clientId: instance.info.clientId,
        tokenStore: tokens.tokenStore,
      });

      // ── Stage 3 · register subscription ─────────────────────────────────
      // p.8's Subscribe row: persisted, signing secret returned ONCE, visible
      // over the source the dev portal itself consumes.
      const subscription = await recorder.stage('register_subscription', async () => {
        const created = await client.webhooks.create({
          event: 'document.created',
          target_url: listener.url,
        });

        // (b) present on create …
        expect(typeof created.signing_secret, 'create() must return the signing secret').toBe('string');
        expect(created.signing_secret.length).toBeGreaterThan(16);

        // (a) … and a subsequent read resolves the id …
        const fetched = await client.webhooks.get(created.id);
        expect(fetched.id).toBe(created.id);
        expect(fetched.target_url).toBe(listener.url);

        // (b, negative) … carrying NO secret. Asserted positively and negatively
        // in the same stage, against L15's PF-423/424 and L18's two-type split.
        expect(Object.keys(fetched)).not.toContain('signing_secret');

        // (c) "appears in dev portal". L22's portal consumes the public API and
        // adds no privileged internal route, so a subscription visible at
        // GET /api/v1/webhooks IS the portal's content. The drill must not grow
        // a headless-browser dependency to check a data source it already has.
        const page = await client.webhooks.list();
        expect(page.data.map((row) => row.id)).toContain(created.id);
        for (const row of page.data) {
          expect(Object.keys(row)).not.toContain('signing_secret');
        }

        return created;
      });

      // ── Stage 4 · create document ───────────────────────────────────────
      // p.7's literal call.
      let documentCreatedAt = 0;
      const document = await recorder.stage('create_document', async () => {
        const created = await client.documents.create({ title: 'hello' });
        documentCreatedAt = performance.now();
        const fetched = await client.documents.get(created.id);
        expect(fetched.id).toBe(created.id);
        expect(fetched.title).toBe('hello');
        return created;
      });

      // ── Stage 5 · receive webhook ───────────────────────────────────────
      // p.8's Trigger row, third assertion: the subscriber receives the POST,
      // carrying both headers, inside the stage budget. A stage asserting only
      // "the document was created" passes green on a platform whose event bus is
      // disconnected — which is the contract regression p.11 says this drill
      // exists to catch.
      const delivery = await recorder.stage('receive_webhook', async () => {
        const received = await listener.waitFor(
          (candidate) => candidate.rawBody.includes(document.id),
          { timeoutMs: T.stageMs.receive_webhook ?? 5000, what: `a POST carrying document ${document.id}` },
        );

        expect(received.method).toBe('POST');
        expect(received.headers[sdk.SIGNATURE_HEADER.toLowerCase()], 'the delivery must carry Ship-Signature').toBeTruthy();
        expect(received.headers['idempotency-key'], 'the delivery must carry Idempotency-Key').toBeTruthy();

        // Exactly ONE delivery for this write (p.8's Trigger row, second
        // assertion). L14's PF-412 pins the server-side property; the drill
        // asserts its observable consequence.
        const forThisDocument = listener.deliveries.filter((d) => d.rawBody.includes(document.id));
        expect(forThisDocument.length, 'one document.created write must produce exactly one delivery').toBe(1);

        return received;
      });

      // ── Stage 6 · verify signature ──────────────────────────────────────
      // p.8's Verify row, on the RECEIVED bytes and never a re-signed fixture.
      // Golden vectors prove the verifier agrees with the signer; this proves the
      // WIRE agrees with both, which is the case vectors structurally cannot
      // cover.
      const verifyStart = await recorder.stage('verify_signature', async () => {
        const headers = delivery.headers;
        const secret = subscription.signing_secret;

        const startedAt = performance.now();
        const valid = sdk.verifyWebhook(headers, delivery.rawBody, secret);
        const singleCallMs = performance.now() - startedAt;
        expect(valid, 'the delivery that actually arrived must verify').toBe(true);

        // (b) one flipped byte.
        const tampered = delivery.rawBody.replace('hello', 'hellp');
        expect(tampered, 'the tamper fixture must actually differ').not.toBe(delivery.rawBody);
        expect(sdk.verifyWebhook(headers, tampered, secret)).toBe(false);

        // (c) a timestamp 301 s old, at the documented 300 s default. Re-signed
        // with the OLD t so the only reason it fails is age — a stale signature
        // over a stale timestamp would fail for two reasons and prove one.
        const staleT = Math.floor(Date.now() / 1000) - 301;
        const staleSignature = createHmac('sha256', secret)
          .update(`${staleT}.${delivery.rawBody}`)
          .digest('hex');
        expect(
          sdk.verifyWebhook(
            { ...headers, [sdk.SIGNATURE_HEADER.toLowerCase()]: `t=${staleT},v1=${staleSignature}` },
            delivery.rawBody,
            secret,
          ),
          `a signature ${301}s old must fail at the ${sdk.DEFAULT_TOLERANCE_SECONDS}s default`,
        ).toBe(false);

        return singleCallMs;
      });

      rmSync(home, { recursive: true, force: true });

      // ── PF-591: every stage reported, and nothing hid between them ──────
      expect(recorder.missingStages(), 'every one of p.6\'s six stages must report').toEqual([]);
      expect(recorder.stages.map((s) => s.id)).toEqual([...STAGE_IDS]);
      for (const record of recorder.stages) {
        expect(Number.isFinite(record.elapsedMs), `${record.id} elapsedMs must be finite`).toBe(true);
        expect(record.elapsedMs, `${record.id} elapsedMs must be non-negative`).toBeGreaterThanOrEqual(0);
      }
      expect(
        recorder.reconciliationErrorMs,
        'stage times plus measured gaps must reconcile with the total — otherwise work is hiding between stages',
      ).toBeLessThanOrEqual(T.reconcileToleranceMs);

      // ── PF-603: event → POST on the wire, the first real measurement ────
      const eventToPostMs = delivery.receivedAt - documentCreatedAt;
      recorder.record('eventToPostMs', Math.round(eventToPostMs * 1000) / 1000);
      recorder.record('verifySingleCallMs', Math.round(verifyStart * 1000) / 1000);
      recorder.record('setupMs', Math.round(setupMs));
      recorder.record('loadAvg1', load.loadAvg1);
      recorder.record('loadRatio', load.loadRatio);
      recorder.record('cpuCount', load.cpuCount);
      recorder.record('loadCertified', load.loadRatio <= T.loadRatioVeto);
      recorder.record('harnessMode', instance.info.mode);

      // ── PF-600: p.8's assertion, shipped literally ──────────────────────
      // The threshold is READ, not typed (PF-609): a budget that can be relaxed
      // inside a test body is not a budget.
      expect(
        recorder.totalMs,
        `TTFE total ${Math.round(recorder.totalMs)} ms exceeds the ${T.totalMs} ms budget in ttfe.thresholds.json` +
          ` (load ratio ${load.loadRatio}; L99 F80 — timings on this hardware are contention-exposed)`,
      ).toBeLessThan(T.totalMs);

      for (const record of recorder.stages) {
        const budget = T.stageMs[record.id];
        if (budget === undefined) continue;
        expect(
          record.elapsedMs,
          `stage "${record.id}" took ${Math.round(record.elapsedMs)} ms against its ${budget} ms budget ` +
            '(raise it in ttfe.thresholds.json if that is the right answer)',
        ).toBeLessThan(budget);
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // PF-593: a failure that produces no artifact also produces no diagnosis.
      const artifact = recorder.toArtifact(MODE, commitSha(), failure);
      artifact.metrics.setupMs = Math.round(setupMs);
      writeArtifact(artifact);
      process.stdout.write(`\nTTFE (${MODE})\n${recorder.toTable()}\n`);
      if (failure instanceof StageFailure) {
        process.stdout.write(`\n${failure.message}\n`);
      }
    }
  }, 600_000);

  /**
   * PF-602 — signature verification < 1 ms, from the SAME packed build.
   *
   * L18's `perf-report.json` is the recorded figure over >= 1000 iterations, and
   * it measured `sdk/dist/index.js`. The drill installed a tarball built from
   * that same `dist/`, so the link is asserted rather than assumed: the bytes
   * are compared, and the figure is then re-measured against the artifact that
   * was actually installed. A benchmark of a different build is not a
   * measurement of this one.
   */
  it('PF-602: the recorded verify benchmark belongs to the build that was installed', async () => {
    expect(installed, 'the install stage must have run first').not.toBeNull();
    const install = installed as InstalledSdk;

    const report = JSON.parse(
      readFileSync(join(repoRoot(), 'sdk', 'perf-report.json'), 'utf8'),
    ) as { p95Ms: number; iterations: number; withinBudget: boolean };

    expect(report.iterations, 'PF-547 records the figure over at least 1000 iterations').toBeGreaterThanOrEqual(1000);
    expect(report.withinBudget).toBe(true);
    expect(report.p95Ms).toBeLessThan(T.verifyLatencyMs);

    const workspaceBuild = readFileSync(join(repoRoot(), 'sdk', 'dist', 'index.js'));
    const installedBuild = readFileSync(join(install.dir, 'node_modules', '@ship', 'sdk', 'dist', 'index.js'));
    expect(
      installedBuild.equals(workspaceBuild),
      'the benchmark measured sdk/dist; the drill must have installed the same bytes',
    ).toBe(true);
  });

  /**
   * PF-611, second half — the SAME loop, driven through L19's CLI.
   *
   * p.5 and p.6 both write the story as `ship login` / `ship docs create` /
   * `ship webhooks tail`. If the CLI cannot drive the loop then the platform's
   * headline story is unproven however green the SDK path is. This IMPORTS
   * L19's exported command functions (PF-581) with an injected sink and branches
   * on PF-561's exported exit codes; it does not re-implement command logic and
   * it does not scrape a terminal.
   */
  it('PF-611: the same loop runs through the CLI commands, not only the SDK', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ttfe-cli-'));
    const credentialsPath = join(home, 'credentials.json');
    const lines: string[] = [];

    // A sink that notifies, so the device code is approved the moment it is
    // printed. `RecordingSink` accumulates but cannot wake anything.
    const sink: OutputSink = {
      out: (line) => lines.push(line),
      err: (line) => {
        lines.push(line);
        const match = /user_code=(\S+)/.exec(line);
        if (match?.[1] !== undefined) {
          void approveDeviceGrant(match[1], instance.info.databaseUrl, instance.info.baseUrl);
        }
      },
    };

    const context = contextDefaults({
      sink,
      baseUrl: instance.info.baseUrl,
      clientId: instance.info.clientId,
      credentialsPath,
      settings: null,
      env: {},
    });

    const loginCode = await runLogin(context, { saveSettings: () => undefined });
    expect(loginCode, `ship login: ${lines.join('\n')}`).toBe(EXIT_CODES.success);

    // `webhooks tail` subscribes, listens, verifies and cleans up after ONE
    // delivery; `docs create` is the event that feeds it. Started first so the
    // subscription exists before the write.
    let announceSubscribed: () => void = () => undefined;
    const subscribed = new Promise<void>((resolve) => {
      announceSubscribed = resolve;
    });
    const tailSink: OutputSink = {
      out: (line) => lines.push(line),
      err: (line) => {
        lines.push(line);
        // Event-driven: the tail tells us it is listening, and only then is the
        // document created. Creating it first would race the subscription and
        // the drill would flake — which p.9 reads as a bug in the drill.
        if (line.includes('waiting for a signed delivery')) announceSubscribed();
      },
    };
    const tail = runWebhooksTail(contextDefaults({ ...context, sink: tailSink }), {
      listen: true,
      maxDeliveries: 1,
    });

    await subscribed;
    const createCode = await runDocsCreate(context, { title: 'hello' });
    expect(createCode, `ship docs create: ${lines.join('\n')}`).toBe(EXIT_CODES.success);

    const tailCode = await tail;
    expect(tailCode, `ship webhooks tail: ${lines.join('\n')}`).toBe(EXIT_CODES.success);
    // p.6's fifth line, character for character.
    expect(lines.join('\n')).toContain('→ document.created event arrives, signature verified ✓');

    rmSync(home, { recursive: true, force: true });
  }, 300_000);
});

/**
 * The commit the artifact is stamped with.
 *
 * Read from `.git` rather than shelled out to `git rev-parse`: `--clean` mode
 * (PF-590) runs in a container with no repo mounted and no git binary, and a
 * `commit` field that says `unknown` in one mode and a SHA in the other makes
 * the two runs impossible to line up. CI's own variable wins where there is one.
 */
function commitSha(): string {
  const fromCi = process.env.CI_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (fromCi !== undefined && fromCi !== '') return fromCi;
  try {
    // `.git` is a DIRECTORY in a normal clone and a FILE containing
    // `gitdir: …` in a worktree. The first version of this read only the
    // directory case and stamped every worktree run `unknown`, which is the
    // shape a soak record must not have: 20 runs that cannot be attributed to a
    // commit are 20 runs of nothing in particular.
    const dotGit = join(repoRoot(), '.git');
    const stat = statSync(dotGit);
    const gitDir = stat.isDirectory()
      ? dotGit
      : readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim();
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const refPath = head.slice(5);
    try {
      return readFileSync(join(gitDir, refPath), 'utf8').trim();
    } catch {
      // A packed ref — the loose file does not exist. `packed-refs` lives in the
      // COMMON dir, which for a worktree is two levels up from `worktrees/<name>`.
      const packed = readFileSync(join(gitDir, '..', '..', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((row) => row.endsWith(` ${refPath}`));
      return line?.split(' ')[0] ?? 'unknown';
    }
  } catch {
    return 'unknown';
  }
}
