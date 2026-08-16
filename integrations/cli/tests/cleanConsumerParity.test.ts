/**
 * PF-590 — the clean container runs a SECOND copy of the six-stage loop, and
 * this is what stops the two copies becoming two different drills.
 *
 * `scripts/ttfe/clean/consumer.mjs` cannot import anything from this repository:
 * it executes inside a container started with no bind mount, and its whole claim
 * is that the repository is absent. So it restates `STAGE_IDS`, the pnpm
 * version and the two stdout protocol prefixes. Restating is fine; restating
 * with nothing asserting the copies agree is how a stage gets renamed on one
 * side and the clean figure silently stops measuring the same loop as the fast
 * one. `READY_PREFIX` in `shipInstance.ts` carries an identical note for an
 * identical reason.
 *
 * These are cheap string checks on purpose — the expensive proof is the drill
 * itself, and this exists so the drill is still measuring what it says.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STAGE_IDS } from './ttfe/stages.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const CONSUMER = join(REPO_ROOT, 'scripts', 'ttfe', 'clean', 'consumer.mjs');
const RUNNER = join(REPO_ROOT, 'scripts', 'ttfe', 'clean-runner.mjs');
const DRILL = join(REPO_ROOT, 'scripts', 'ttfe', 'drill.mjs');
const CI = join(REPO_ROOT, '.gitlab-ci.yml');

const read = (path: string): string => readFileSync(path, 'utf8');

describe('PF-590 — the clean-container consumer stays in step with the drill', () => {
  it('restates p.6\'s six stage ids, in p.6\'s order', async () => {
    const module = (await import(CONSUMER)) as { STAGE_IDS: readonly string[] };
    expect(
      [...module.STAGE_IDS],
      'scripts/ttfe/clean/consumer.mjs must run the same six stages, in the same order, as the fast drill',
    ).toEqual([...STAGE_IDS]);
  });

  it('is importable without a container environment', async () => {
    // If this file ever reads its `TTFE_*` variables at module scope again, the
    // import above starts throwing and the parity check silently stops running.
    const module = (await import(CONSUMER)) as { USER_CODE_PREFIX: string; RESULT_PREFIX: string };
    expect(module.USER_CODE_PREFIX).toBe('ttfe-clean-usercode ');
    expect(module.RESULT_PREFIX).toBe('ttfe-clean-result ');
  });

  it('agrees with the runner on the two stdout prefixes the runner parses', () => {
    const runner = read(RUNNER);
    expect(runner).toContain("USER_CODE_PREFIX = 'ttfe-clean-usercode '");
    expect(runner).toContain("RESULT_PREFIX = 'ttfe-clean-result '");
  });

  it('pins the same pnpm the lockfile and CI pin — an unpinned pnpm measures a different toolchain', () => {
    const runner = read(RUNNER);
    const runnerVersion = /PNPM_VERSION = '([^']+)'/.exec(runner)?.[1];
    const ciVersion = /PNPM_VERSION:\s*'([^']+)'/.exec(read(CI))?.[1];
    expect(runnerVersion, 'scripts/ttfe/clean-runner.mjs must pin a pnpm version').toBeDefined();
    expect(ciVersion, '.gitlab-ci.yml must pin PNPM_VERSION').toBeDefined();
    expect(runnerVersion).toBe(ciVersion);
  });

  it('mounts nothing from the repository into the container', () => {
    // The single claim that makes this mode different from the fast one. A `-v`
    // added for a quick debugging session and left behind would turn `--clean`
    // back into the fast path while every number kept saying `mode: clean`.
    const runner = read(RUNNER);
    const dockerArgs = /const dockerArgs = \[([\s\S]*?)\n\];/.exec(runner)?.[1] ?? '';
    expect(dockerArgs.length, 'the docker argument list must be findable for this check to mean anything').toBeGreaterThan(
      0,
    );
    expect(dockerArgs).not.toMatch(/'-v'|'--volume'|'--mount'|'--network'/);
    expect(dockerArgs, 'the tarball must reach the container over HTTP').toContain('TTFE_TARBALL_URL=http://');
  });

  it('no longer refuses --clean as unimplemented', () => {
    const drill = read(DRILL);
    expect(drill).not.toContain('is not wired to a container image');
    expect(drill).toContain('clean-runner.mjs');
  });

  it('reads its budget from the one thresholds file, not from a literal', () => {
    const runner = read(RUNNER);
    expect(runner).toContain('ttfe.thresholds.json');
    expect(runner).toContain('cleanModeMinutes');
    // PF-609: a budget that can be relaxed inside the script is not a budget.
    expect(runner).not.toMatch(/1_?800_?000/);
  });
});
