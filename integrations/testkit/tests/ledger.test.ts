/**
 * PF-719 — `integrations/README.md` is the 5-of-7 ledger, and it is MACHINE-CHECKED.
 *
 * PRD p.8 requires at least five of seven. Without this test, "at least 5" is a
 * sentence in a PR description that nobody can falsify — and the failure mode is
 * not somebody lying, it is somebody deleting a package and forgetting the table
 * two directories away.
 *
 * ── This file was deliberately NOT written until the directories existed ──
 * The ledger asserts five `shipped` rows naming real directories. Written on the
 * day the lane started, `integrations/` held two, and the table would have been
 * a claim that was false at the moment it was committed. It landed with the
 * fifth integration.
 *
 * Three assertions, and each catches a different way the claim goes stale:
 *
 *   1. every `shipped` row names a directory that EXISTS
 *   2. every one of those directories contains at least one TEST FILE — a
 *      directory with no tests is a claim nobody is checking
 *   3. there are at least FIVE of them
 *
 * Plus the reverse direction, which the ticket does not ask for and which is the
 * one that catches a lie of omission: every one of p.8's seven options appears
 * exactly once, so an option cannot be quietly dropped from the table to make
 * the arithmetic work.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INTEGRATIONS_ROOT = dirname(PACKAGE_ROOT);
const LEDGER = join(INTEGRATIONS_ROOT, 'README.md');

/** The seven options, in p.8's order. Restated so a dropped row is visible. */
const P8_OPTIONS = [
  'CLI tool with device flow',
  'Slack integration',
  'Browser SDK demo',
  'GitHub integration',
  'Refresh-token rotation drill',
  'Idempotency-Key end-to-end',
  'In-process plugin runtime',
];

interface Row {
  number: string;
  option: string;
  status: string;
  directory: string | null;
}

/** Parses the ledger table. Rows only — the `|---|` separator is skipped. */
function readLedger(): Row[] {
  const text = readFileSync(LEDGER, 'utf8');
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---')) continue;
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    const [number, option, status, directory] = cells as [string, string, string, string];
    if (!/^\d+$/.test(number)) continue;
    rows.push({
      number,
      option,
      status: status.replace(/\*/g, '').trim(),
      directory: directory === '—' || directory === '' ? null : directory.replace(/`/g, '').trim(),
    });
  }
  return rows;
}

function hasTestFile(dir: string): boolean {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', 'coverage', 'test-results'].includes(entry.name)) continue;
        stack.push(join(current, entry.name));
      } else if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

describe('PF-719 — the 5-of-7 ledger is checkable', () => {
  const rows = readLedger();

  it('parses seven rows, so the parser is not silently reading nothing', () => {
    expect(rows).toHaveLength(7);
  });

  it('every one of p.8s seven options appears exactly once', () => {
    // The lie-of-omission check. Dropping a row would otherwise let the table
    // claim "five of five" while the PRD asked for five of seven.
    const listed = rows.map((r) => r.option);
    for (const option of P8_OPTIONS) {
      expect(listed.filter((l) => l === option), `p.8 option "${option}"`).toHaveLength(1);
    }
  });

  it('every status is exactly `shipped` or `cut` — no third word', () => {
    for (const row of rows) expect(['shipped', 'cut']).toContain(row.status);
  });

  it('at least FIVE rows are shipped — the p.8 requirement', () => {
    const shipped = rows.filter((r) => r.status === 'shipped');
    expect(
      shipped.length,
      `PRD p.8 requires at least 5 of 7. The ledger claims ${shipped.length}: ` +
        shipped.map((r) => r.option).join(', '),
    ).toBeGreaterThanOrEqual(5);
  });

  it('every shipped row names a directory that EXISTS under integrations/', () => {
    for (const row of rows.filter((r) => r.status === 'shipped')) {
      expect(row.directory, `row ${row.number} (${row.option}) names no directory`).not.toBeNull();
      const path = join(INTEGRATIONS_ROOT, row.directory as string);
      expect(
        existsSync(path) && statSync(path).isDirectory(),
        `integrations/${row.directory} does not exist, but the ledger says ${row.option} shipped`,
      ).toBe(true);
    }
  });

  it('every shipped directory contains at least one TEST FILE', () => {
    for (const row of rows.filter((r) => r.status === 'shipped')) {
      const path = join(INTEGRATIONS_ROOT, row.directory as string);
      expect(
        hasTestFile(path),
        `integrations/${row.directory} has no test file. A shipped integration nobody tests is a ` +
          `claim nobody is checking — which is exactly what this ledger exists to prevent.`,
      ).toBe(true);
    }
  });

  it('every cut row gives a reason, and it is not one word', () => {
    for (const row of rows.filter((r) => r.status === 'cut')) {
      const reason = readFileSync(LEDGER, 'utf8')
        .split('\n')
        .find((l) => l.includes(row.option) && l.includes('cut'));
      expect((reason ?? '').length, `row ${row.number} (${row.option}) has a thin reason`).toBeGreaterThan(200);
    }
  });

  it('every directory under integrations/ is either a ledger row or the testkit', () => {
    // The other direction: a package can appear here without ever reaching the
    // table, and the table is what a grader reads.
    const claimed = new Set(rows.map((r) => r.directory).filter((d): d is string => d !== null));
    const present: string[] = [];
    for (const entry of readdirSync(INTEGRATIONS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      if (existsSync(join(INTEGRATIONS_ROOT, entry.name, 'package.json'))) {
        present.push(entry.name);
        continue;
      }
      // A grouping directory (`drills/`), so the packages are one level deeper.
      for (const nested of readdirSync(join(INTEGRATIONS_ROOT, entry.name), { withFileTypes: true })) {
        if (nested.isDirectory()) present.push(`${entry.name}/${nested.name}`);
      }
    }

    // `testkit` is PF-721's shared fixture, not one of p.8's seven. It is named
    // here rather than pattern-matched so a SECOND unlisted package fails.
    const unlisted = present.filter((p) => p !== 'testkit' && !claimed.has(p));
    expect(
      unlisted,
      'packages under integrations/ that no ledger row mentions. Add a row, or explain the ' +
        'exception here the way testkit is explained.',
    ).toEqual([]);
  });
});
