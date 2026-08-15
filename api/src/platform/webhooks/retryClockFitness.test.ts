/**
 * PF-451 · PF-456 — the two fitness greps this lane rests on.
 *
 * Both are mechanical rather than cultural, which is the whole ticket: PRD p.11
 * names timing-based webhook tests as *"flaky tests"* by construction, and a
 * rule enforced by code review is a rule that holds until the reviewer is busy.
 *
 * The failure messages name the file and the line, because the point of a
 * fitness test is that the person who broke it does not have to go looking.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { architectureText } from '../../test/architectureDoc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(HERE, '..', '..');
const REPO_ROOT = join(API_SRC, '..', '..');

interface Hit {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

function grep(files: string[], pattern: RegExp, skipLine?: (line: string) => boolean): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (skipLine?.(text)) return;
      if (pattern.test(text)) {
        hits.push({ file: relative(REPO_ROOT, file), line: index + 1, text: text.trim() });
      }
    });
  }
  return hits;
}

const report = (hits: Hit[]): string =>
  hits.map((h) => `  ${h.file}:${h.line}  ${h.text.slice(0, 120)}`).join('\n');

/**
 * A comment line, by the crude-but-sufficient test: this whole lane documents
 * its decisions in prose that quotes the very identifiers being banned, and a
 * grep that flagged its own explanation would be unusable.
 */
const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

const webhookSources = () =>
  walk(join(API_SRC, 'platform', 'webhooks'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));

const webhookTests = () =>
  walk(join(API_SRC, 'platform', 'webhooks'), (p) => p.endsWith('.test.ts'));

/**
 * Finding **F60** — the two wall-clock reads under `platform/webhooks/**` that
 * this lane found and deliberately did NOT fix.
 *
 * Both are in modules L14 and L15 own, and both need a `Clock` threaded through
 * a call site those lanes control — `publish()` for `payloads.ts`, the bus
 * constructor for `bus.ts`. Fixing them from here would be a unilateral change
 * to another lane's contract in the middle of a parallel build, which is exactly
 * what produced findings F39 and F55.
 *
 * They are listed EXACTLY rather than excluded by directory, so the grep still
 * fails on a new violation anywhere — including a new one in these two files —
 * and so the debt is visible in the test rather than absent from it. When the
 * owning lane fixes one, this list shrinks and the test says so.
 */
const KNOWN_CLOCK_VIOLATIONS: readonly string[] = [
  // L14 — the envelope's `occurred_at` comes from the wall clock, so an event's
  // own timestamp is non-deterministic in every test that publishes one.
  'api/src/platform/webhooks/payloads.ts:74',
  // L15 — `this.clock?.nowMs() ?? Date.now()`, three times. An OPTIONAL clock
  // with a wall-clock fallback: a bus constructed without one silently opts out
  // of injection, and nothing fails.
  'api/src/platform/webhooks/bus.ts:194',
  'api/src/platform/webhooks/bus.ts:204',
  'api/src/platform/webhooks/bus.ts:231',
];

describe('PF-456 — time is read only through the injected Clock', () => {
  it('no bare setTimeout/setInterval/Date.now/new Date() under platform/webhooks/**', () => {
    // `SystemClock` is the ONE implementation allowed to touch the real clock,
    // and it lives in platform/clock.ts, outside this tree. Nothing under
    // webhooks/ has an exemption except the four lines in F60 above, which are
    // other lanes' to fix.
    const banned = /(?<![.\w])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(|Date\.now\s*\(|new Date\s*\(\s*\)/;
    const hits = grep(webhookSources(), banned, isComment);
    const unexpected = hits.filter(
      (h) => !KNOWN_CLOCK_VIOLATIONS.includes(`${h.file}:${h.line}`),
    );

    expect(
      unexpected.length,
      `Time must be read through the injected Clock (platform/clock.ts), not directly.\n` +
        `PRD p.11: "tested with deterministic clock injection — never with setTimeout waits\n` +
        `in tests. Timing-based webhook tests are flaky tests."\n\n` +
        `Offending lines:\n${report(unexpected)}\n\n` +
        `Use \`clock.nowMs()\` and \`clock.setTimeout()\`. \`new Date(clock.nowMs())\` is fine —\n` +
        `it formats a value the clock produced; \`new Date()\` reads the wall clock.`,
    ).toBe(0);
  });

  it('the F60 exemption list is exact — a fixed violation must be delisted', () => {
    const banned = /(?<![.\w])(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(|Date\.now\s*\(|new Date\s*\(\s*\)/;
    const found = new Set(
      grep(webhookSources(), banned, isComment).map((h) => `${h.file}:${h.line}`),
    );
    const stale = KNOWN_CLOCK_VIOLATIONS.filter((entry) => !found.has(entry));
    expect(
      stale,
      `These F60 entries no longer match a violation. Either the owning lane fixed them —\n` +
        `in which case delete the entry, because an exemption for a line that is now clean\n` +
        `is an exemption that will silently cover the NEXT violation on that line — or the\n` +
        `line numbers drifted and the list needs re-anchoring.`,
    ).toEqual([]);
  });

  it('Math.random appears only as delayBeforeAttemptMs\'s default parameter', () => {
    const hits = grep(webhookSources(), /Math\.random/, isComment);
    // One hit, and it is the default of the injected jitter source (PF-453). A
    // second one is a module that decided its own randomness, which no test can
    // pin.
    expect(
      hits.length,
      `Randomness is injected (PF-453). Offending lines:\n${report(hits)}`,
    ).toBe(1);
    expect(hits[0]!.file).toMatch(/retry\.ts$/);
    expect(hits[0]!.text).toContain('DEFAULT_JITTER');
  });

  it('no test file in this lane waits on a real timer', () => {
    const banned = /(?<![.\w])(setTimeout|setInterval)\s*\(|vi\.(useFakeTimers|advanceTimersBy)/;
    const hits = grep(webhookTests(), banned, isComment);

    expect(
      hits.length,
      `A webhook test that waits is a flaky test with a longer feedback loop (p.11).\n` +
        `Advance the FakeClock instead: \`clock.advance(16_000); await scheduler.settled();\`\n\n` +
        `Offending lines:\n${report(hits)}`,
    ).toBe(0);
  });

  it('the grep is not vacuous — it finds a planted violation', () => {
    // A fitness test that scans an empty file list passes forever. This proves
    // the pattern and the walker both work by running them against a string that
    // definitely violates.
    // Assembled from fragments rather than written as literals: this file is
    // itself inside the scanned set, and a test that plants a real violation in
    // its own source would fail the very grep it is proving.
    const planted = [`const t = set${'Timeout'}(fn, 10);`, `const n = Date${'.'}now();`];
    const banned = /(?<![.\w])(setTimeout|setInterval)\s*\(|Date\.now\s*\(/;
    expect(planted.every((line) => banned.test(line))).toBe(true);
    // And that there is something to scan at all.
    expect(webhookSources().length).toBeGreaterThan(10);
    expect(webhookTests().length).toBeGreaterThan(5);
  });
});

describe('PF-451 — exactly one retry ladder in the repository', () => {
  const ladderSources = () => [
    ...walk(API_SRC, (p) => p.endsWith('.ts') && !p.endsWith('.test.ts')),
    ...walk(join(REPO_ROOT, 'sdk', 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts')),
    ...walk(join(REPO_ROOT, 'shared', 'src'), (p) => p.endsWith('.ts') && !p.endsWith('.test.ts')),
  ];

  it('the literal `1800` appears in exactly one source file — retry.ts', () => {
    // 1800 is the distinctive rung: 1, 4, 16, 60 and 300 all appear innocently
    // as page sizes, timeouts and TTLs, and grepping for them would be noise.
    // A second `1800` in a retry context is a second ladder.
    const hits = grep(ladderSources(), /\b1800\b/, isComment);
    const files = [...new Set(hits.map((h) => h.file))];
    expect(
      files,
      `The p.4 ladder is ONE constant (RETRY_SCHEDULE_SECONDS). A second copy is a\n` +
        `second answer to "how long do we wait", and the wrong one is always the one in\n` +
        `production.\n\n${report(hits)}`,
    ).toEqual(['api/src/platform/webhooks/retry.ts']);
  });

  it('no source file contains a second `[1, 4, 16` array literal', () => {
    const hits = grep(ladderSources(), /\[\s*1\s*,\s*4\s*,\s*16\s*,/, isComment);
    const files = [...new Set(hits.map((h) => h.file))];
    expect(files, report(hits)).toEqual(['api/src/platform/webhooks/retry.ts']);
  });

  it('docs/architecture.md imports the constant rather than inlining the array', () => {
    const doc = architectureText();
    expect(
      doc.includes('new RetryScheduler(clock, [1, 4, 16, 60, 300, 1800])'),
      'docs/architecture.md passed the ladder as an inline array literal into ' +
        'RetryScheduler. That is a second copy in a graded document — the one place a ' +
        'reader would trust. It must reference RETRY_SCHEDULE_SECONDS.',
    ).toBe(false);
    expect(doc).toContain('RETRY_SCHEDULE_SECONDS');
  });
});
