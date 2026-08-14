/**
 * PF-609 — every threshold is read from `ttfe.thresholds.json`, and this is the
 * only reader inside the drill.
 *
 * p.6: *"Any regression past the configured threshold fails the build."* The
 * point of one file is that raising a budget is a reviewable diff with the
 * number visible in it. A `toBeLessThan(60_000)` typed into a test body is a
 * budget that can be relaxed by the person who broke it, in the same commit that
 * broke it, and nothing in review shows the number moved.
 *
 * Read with `readFileSync`, not `import … with { type: 'json' }`: a JSON import
 * is resolved by the bundler and would be inlined into the built artifact, which
 * is the same class of problem — the committed number and the running number
 * stop being the same number.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

export const THRESHOLDS_PATH = join(REPO_ROOT, 'ttfe.thresholds.json');

export interface TtfeThresholds {
  totalMs: number;
  stageMs: Record<string, number>;
  p95WindowRuns: number;
  p95TotalMs: number;
  p95EventToPostMs: number;
  verifyLatencyMs: number;
  reconcileToleranceMs: number;
  loadRatioVeto: number;
  cleanModeMinutes: number;
}

let cached: TtfeThresholds | null = null;

export function thresholds(): TtfeThresholds {
  if (cached !== null) return cached;
  const raw = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8')) as Record<string, unknown>;
  // Keys beginning `_` are the prose that explains each number and are dropped
  // here rather than in the file: an unexplained threshold is how a number
  // outlives the reason for it.
  const values = Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('_')));
  cached = values as unknown as TtfeThresholds;
  return cached;
}
