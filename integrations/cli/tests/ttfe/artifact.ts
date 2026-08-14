/**
 * PF-592 — the timings are a machine-readable artifact, not a log line.
 *
 * `test-results/ttfe.json`, published as a CI artifact next to the existing
 * `junit.xml` and `playwright-report/` paths. A human-readable table still goes
 * to stdout, but the gate and the trend both read the JSON.
 *
 * FOUR consumers depend on this one file — PF-600's P95, PF-606's 20-run soak,
 * PF-604's CI-minute figure and PF-610's submission evidence. Four consumers
 * scraping four log formats is how a graded number quietly stops being
 * comparable between runs.
 *
 * The run also APPENDS to `test-results/ttfe-series.jsonl`, which is the rolling
 * series the P95 checks read (PF-600, PF-603). One line per run, so 20 runs is
 * 20 lines and a soak is countable rather than asserted.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TtfeArtifact } from './recorder.js';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function repoRoot(): string {
  return dirname(dirname(PACKAGE_ROOT));
}

export const ARTIFACT_PATH = join(repoRoot(), 'test-results', 'ttfe.json');
export const SERIES_PATH = join(repoRoot(), 'test-results', 'ttfe-series.jsonl');

export function writeArtifact(artifact: TtfeArtifact): void {
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
  writeFileSync(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  appendFileSync(SERIES_PATH, `${JSON.stringify(artifact)}\n`);
}

/**
 * L99's F80, applied.
 *
 * Three runs of `baseline:compare` on ONE commit spread 6.0x while query counts
 * stayed bit-identical, under a load ratio of 1.33–1.88 on this hardware. The
 * machine fingerprint (`platform`/`node`/`cpuCount`) matched exactly on all
 * three — it says *"same box"*, not *"the box was idle enough to time on"*.
 *
 * So every timing this drill records carries the ratio it was taken under, and
 * `loadCertified` says whether the number is inside the veto. A figure over the
 * veto is still recorded — suppressing it would lose the run — but nothing may
 * quote it as a measurement of the platform.
 */
export interface MachineLoad {
  loadAvg1: number;
  cpuCount: number;
  loadRatio: number;
}

export function machineLoad(): MachineLoad {
  const cpuCount = cpus().length;
  const loadAvg1 = loadavg()[0] ?? 0;
  return {
    loadAvg1: Math.round(loadAvg1 * 100) / 100,
    cpuCount,
    loadRatio: Math.round((loadAvg1 / Math.max(1, cpuCount)) * 1000) / 1000,
  };
}
