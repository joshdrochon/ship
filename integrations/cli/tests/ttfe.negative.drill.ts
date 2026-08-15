/**
 * PF-587 / PF-607 — the drill's own negative controls.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * p.11 claims the drill *"will catch contract regressions faster than any unit
 * test"* and p.14 asks the interviewee to *"Walk through a bug the TTFE drill
 * caught that your unit tests missed."* Both are assertions about a test that,
 * until it has been SEEN failing for the right reason, nobody has evidence for.
 * A drill that has only ever been green is a drill whose red path is untested.
 *
 * ── The defect chosen, and why ─────────────────────────────────────────────
 * The packed `exports` map resolves `.` to the BROWSER build for every
 * condition. That is the single most common way an `exports` map goes wrong —
 * a condition reordered, a `default` edited, a copy-paste between the two
 * entries — and its symptom is that a Node consumer silently receives a bundle
 * with no `verifyWebhook`, which is L99 F14's exact shape from the other side.
 *
 * Why no unit suite can see it: every test in `sdk/` imports TypeScript SOURCE
 * through the workspace. The `exports` map is consulted only by a resolver
 * OUTSIDE the workspace — which exists exactly once in this repository, in the
 * drill's install stage. That is the whole of PF-589's argument for a real
 * install, demonstrated rather than asserted.
 *
 * ── The defect that was NOT a defect, recorded because it is worth knowing ──
 * The first candidate here was "the packed `exports` map loses its types entry"
 * (one of PF-607's three suggestions). It was tried and it did NOT turn the
 * drill red: with `moduleResolution: NodeNext`, TypeScript resolves the JS
 * target of the matching condition and then picks up an ADJACENT `index.d.ts`,
 * so a missing `types` condition is invisible whenever the declaration sits
 * next to the JavaScript — which it does here. Deleting `types` from this
 * package's `exports` map is therefore not a breaking change, and a ticket that
 * assumed it was would have shipped a negative control that proved nothing.
 *
 * This file is a `*.drill.ts` so it runs under `vitest.drill.config.ts` with
 * `retry: 0` and never inside `pnpm test`.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StageFailure, StageRecorder } from './ttfe/recorder.js';
import { packAndInstallSdk, exec, type InstalledSdk } from './ttfe/install.js';
import { READY_PREFIX } from './ttfe/shipInstance.js';
import { resolveTsx } from './ttfe/tsx.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

describe('PF-607 — the drill goes red for the right reason', () => {
  it('a packed exports map pointed at the wrong build fails the INSTALL stage, by name', async () => {
    const recorder = new StageRecorder();
    let broken: InstalledSdk | null = null;

    const thrown = await recorder
      .stage('install', async () => {
        broken = await packAndInstallSdk({
          patchPackageJson: (manifest) => {
            // ONE contract break, and nothing else: `.` now resolves to the
            // browser build under every condition. Every file in the tarball is
            // untouched and still correct; only the map that chooses between
            // them is wrong.
            const exportsMap = manifest.exports as Record<string, Record<string, unknown>>;
            exportsMap['.'] = {
              types: './dist/browser.d.ts',
              import: './dist/browser.js',
              require: './dist/browser.js',
              default: './dist/browser.js',
            };
          },
        });

        // The install stage's assertion (a), verbatim from `ttfe.drill.ts`:
        // resolution and EVALUATION are different failures, and this defect
        // passes the first.
        const namespace = (await import(broken.entryUrl)) as Record<string, unknown>;
        expect(typeof namespace.ShipClient, 'resolution still succeeds — that is the trap').toBe(
          'function',
        );
        expect(typeof namespace.verifyWebhook, 'the Node consumer must get verifyWebhook').toBe(
          'function',
        );
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    try {
      expect(thrown, 'the drill must go RED on a broken packed artifact').toBeInstanceOf(StageFailure);
      const failure = thrown as StageFailure;
      // PF-593: the first line names the stage and its elapsed ms.
      expect(failure.stage).toBe('install');
      expect(failure.message.split('\n')[0]).toContain('install');
      expect(failure.message).toMatch(/FAILED after \d+ ms/);

      // And the artifact still exists, with pass:false — a failure that produces
      // no artifact produces no diagnosis.
      const artifact = recorder.toArtifact('fast', 'negative-control', failure);
      expect(artifact.pass).toBe(false);
      expect(artifact.failure?.stage).toBe('install');
    } finally {
      (broken as InstalledSdk | null)?.dispose();
    }
  }, 300_000);

  it('the same defect leaves the SDK unit suite green — which is the point', async () => {
    // The defect lives in the PACKED manifest and in nothing this suite imports,
    // so a green run here is the second half of p.14's answer: the drill caught
    // something no unit test could have.
    const result = await exec('pnpm', ['--filter', '@ship/sdk', 'test'], { cwd: REPO_ROOT });
    expect(result.code, `pnpm --filter @ship/sdk test:\n${result.all}`).toBe(0);
  }, 300_000);
});

describe('PF-587 — the drill provisions what it tests, and destroys it', () => {
  it('refuses to start, by name, on a DATABASE_URL it did not create', async () => {
    const result = await runHarness({
      DATABASE_URL: 'postgresql://ship:ship_dev_password@localhost:5432/ship_dev',
    });

    expect(result.code, `the harness must REFUSE an inherited DATABASE_URL:\n${result.all}`).not.toBe(0);
    expect(result.all).toContain('TtfeForeignDatabaseError');
    // The error names the risk rather than merely refusing: the harness runs
    // migrations, seeds and a teardown DROP.
    expect(result.all).toContain('drops it');
    // And it does not leak the credential in the message.
    expect(result.all).not.toContain('ship_dev_password');
    expect(result.all).toContain('***@');
    // Nothing was provisioned: it refused before touching a container.
    expect(result.all).not.toContain(READY_PREFIX);
  }, 120_000);

  it('two concurrent runs collide on neither port nor schema, and neither survives teardown', async () => {
    const [first, second] = await Promise.all([startHarness(), startHarness()]);

    try {
      expect(first.info.baseUrl).not.toBe(second.info.baseUrl);
      expect(first.info.databaseUrl).not.toBe(second.info.databaseUrl);

      // Both are actually up — two distinct Ships, not one answering twice.
      for (const instance of [first, second]) {
        const health = await fetch(`${instance.info.baseUrl}/health`);
        expect(health.ok).toBe(true);
      }
    } finally {
      const codes = await Promise.all([first.stop(), second.stop()]);
      // Exit 0 is the teardown proof. `dispose()` drops the database and then
      // re-queries `pg_database` to confirm it is gone; a survivor throws, and
      // the harness exits 1. The drill may not hold a database client itself
      // (p.11), so this is the only honest place that check can live.
      expect(codes, 'both harnesses must exit 0, which is only reachable after teardown verified').toEqual([
        0, 0,
      ]);

      for (const instance of [first, second]) {
        await expect(fetch(`${instance.info.baseUrl}/health`)).rejects.toThrow();
      }
    }
  }, 600_000);
});

/** Runs the harness to completion with stdin already closed. */
function runHarness(extraEnv: NodeJS.ProcessEnv): Promise<{ code: number; all: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
    // `resolveTsx`, not `npx tsx` (PF-608, see ttfe/tsx.ts). It matters most
    // HERE: this control asserts a non-zero exit, and `npx` failing to find tsx
    // is also a non-zero exit. The following assertions on the error's text are
    // what kept that from reading as a pass, and resolving the binary removes
    // the ambiguity rather than relying on them to catch it.
    const child = spawn(resolveTsx(REPO_ROOT), [join('scripts', 'ttfe', 'harness.ts')], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let all = '';
    child.stdout.on('data', (chunk: Buffer) => (all += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (all += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, all }));
  });
}

/** A second copy of `ShipInstance.start`'s protocol, kept local to the control. */
async function startHarness(): Promise<{
  info: { baseUrl: string; databaseUrl: string };
  stop: () => Promise<number>;
}> {
  const { ShipInstance } = await import('./ttfe/shipInstance.js');
  const instance = await ShipInstance.start();
  return { info: instance.info, stop: () => instance.stop() };
}
