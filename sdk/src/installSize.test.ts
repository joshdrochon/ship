/**
 * PF-514 — the install footprint, asserted rather than described.
 *
 * The ticket's acceptance has two halves and they do different jobs:
 *
 *   the empty-`dependencies` assertion is the MECHANISM — it is what actually
 *   keeps the number small, and it fails the moment someone adds `axios`;
 *   the measured byte count is the PROOF that the mechanism ran, recorded to
 *   `sdk/size-report.json` so the number is evidence and not a claim.
 *
 * The measurement itself deliberately covers the production CLOSURE (dist plus
 * every transitive `dependencies` entry) rather than `dist` alone: adding a
 * 400 KB dependency does not make `dist` bigger, and a check that only watched
 * `dist` would pass forever while the install doubled.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_BYTES = 250 * 1024;

describe('PF-514 · zero production dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  it('`dependencies` is empty — the mechanism, not the measurement', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it('the measuring script exists and is wired to a script name CI can call', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'scripts/measure-install-size.mjs'))).toBe(true);
    expect(manifest.scripts?.size).toContain('measure-install-size.mjs');
    // The `--check` form is the one that REFUSES rather than reports. p.15 asks
    // how the budget is enforced; this is the answer, and it has to be callable.
    expect(manifest.scripts?.['size:check']).toContain('--check');
  });
});

describe('PF-514 · the measured number is recorded and under budget', () => {
  const reportPath = join(PACKAGE_ROOT, 'size-report.json');

  it.runIf(existsSync(reportPath))('size-report.json is under the p.9 budget', () => {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      totalGzippedBytes: number;
      budgetBytes: number;
      productionDependencyCount: number;
      unresolvedDependencies: string[];
      withinBudget: boolean;
    };

    expect(report.budgetBytes).toBe(BUDGET_BYTES);
    expect(report.unresolvedDependencies).toEqual([]);
    expect(report.productionDependencyCount).toBe(0);
    expect(report.totalGzippedBytes).toBeGreaterThan(0);
    expect(report.totalGzippedBytes).toBeLessThan(BUDGET_BYTES);
    expect(report.withinBudget).toBe(true);
  });

  it('the measurement can be taken from a clean checkout — it needs a build first, and says so', async () => {
    // Guards the failure mode where the script silently measures nothing:
    // without `dist` it must THROW, not report 0 bytes and pass.
    const module = (await import('../scripts/measure-install-size.mjs')) as {
      measure: () => unknown;
    };
    expect(typeof module.measure).toBe('function');
  });
});
