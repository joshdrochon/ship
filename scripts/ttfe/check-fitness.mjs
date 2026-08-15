#!/usr/bin/env node
/**
 * PF-605 / PF-609 / PF-586 — the drill's own fitness test.
 *
 *     node scripts/ttfe/check-fitness.mjs
 *
 * Four claims, each of which would otherwise be true only until someone
 * convenient made it false:
 *
 *   1. NO FIXED-DURATION SLEEP anywhere in the drill or its harness. p.11 is
 *      categorical, and p.9's 0% flake target depends on it: a sleep is how a
 *      race becomes "usually green". Every wait must be on a condition with a
 *      named timeout (PF-599). One deadline timer is allowed, by name, in
 *      `listener.ts` — a deadline REJECTS, it does not let a run continue.
 *
 *   2. `retry: 0` in the drill's runner config, and no retry wrapper in CI.
 *      `playwright.config.ts:60` is `retries: process.env.CI ? 2 : 1`, so a
 *      drill moved into that suite for convenience inherits two CI retries and
 *      forfeits p.9's target with nothing failing to say so. The lane file names
 *      this as the guard that was missing; here it is.
 *
 *   3. The drill is NOT a Playwright spec. Same reason.
 *
 *   4. Every threshold is read from `ttfe.thresholds.json` — no second literal
 *      `60_000` / `60000` in any file this lane owns. p.8's budget is graded, and
 *      a budget that can be relaxed inside a test body is not a budget. Scoped to
 *      this lane's files deliberately: `api/src/index.ts` sets
 *      `server.timeout = 60000` for entirely unrelated reasons and a repo-wide
 *      grep would either fail forever or be softened until it caught nothing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Every file this lane owns. Nothing else is in scope, and that is stated. */
const OWNED = [
  'integrations/cli/tests/ttfe.drill.ts',
  'integrations/cli/tests/ttfe.negative.drill.ts',
  'integrations/cli/tests/ttfeRecorder.test.ts',
  'integrations/cli/vitest.drill.config.ts',
  'scripts/ttfe/harness.ts',
  'scripts/ttfe/drill.mjs',
  'scripts/ttfe/check-series.mjs',
  'scripts/ttfe/check-fitness.mjs',
  ...listDir('integrations/cli/tests/ttfe'),
];

/**
 * The one allowed timer, named rather than pattern-matched.
 *
 * `listener.ts`'s `deadlineElapsed` is a REJECTION deadline raced against a
 * condition — the opposite of a sleep. Naming the file and the function means
 * adding a second one is a diff to this list, which is the point.
 */
const SLEEP_ALLOWLIST = new Map([
  ['integrations/cli/tests/ttfe/listener.ts', ['deadlineElapsed']],
]);

const SLEEP_PATTERNS = [
  { name: 'awaited setTimeout', re: /await\s+new\s+Promise\s*\([^)]*setTimeout/ },
  { name: 'sleep(', re: /\bsleep\s*\(\s*\d/ },
  { name: 'delay(', re: /\bdelay\s*\(\s*\d/ },
  { name: 'setTimeout with a literal duration', re: /setTimeout\s*\([^,]+,\s*\d+\s*\)/ },
];

const problems = [];

// ── 1. no fixed-duration sleeps ─────────────────────────────────────────────
for (const file of OWNED) {
  const source = read(file);
  if (source === null) continue;
  const allowed = SLEEP_ALLOWLIST.get(file) ?? [];
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
    for (const pattern of SLEEP_PATTERNS) {
      if (!pattern.re.test(line)) continue;
      if (allowed.some((name) => source.includes(`function ${name}`))) {
        // The file has a named exception; check the hit is inside it rather than
        // trusting the file wholesale.
        const before = source.slice(0, source.indexOf(line));
        const lastFunction = /function\s+(\w+)/g;
        let match;
        let enclosing = '';
        while ((match = lastFunction.exec(before)) !== null) enclosing = match[1];
        if (allowed.includes(enclosing)) continue;
      }
      problems.push(
        `${file}:${index + 1} — ${pattern.name}. p.11 forbids fixed-duration waits and p.9's 0% ` +
          'flake target depends on it. Wait on a condition with a named timeout (PF-599).',
      );
    }
  });
}

// ── 2. retry: 0 in the drill's runner ───────────────────────────────────────
const drillConfig = read('integrations/cli/vitest.drill.config.ts');
if (drillConfig === null) {
  problems.push('integrations/cli/vitest.drill.config.ts is missing — the drill has no runner config to police.');
} else if (!/retry:\s*0\b/.test(drillConfig)) {
  problems.push(
    'integrations/cli/vitest.drill.config.ts does not set `retry: 0`. p.9\'s target is ' +
      '"0% (any flake = bug in the drill or the platform)", and a retry is precisely the ' +
      'mechanism that converts a flake into a pass.',
  );
}

// ── 3. the drill is not a Playwright spec ───────────────────────────────────
for (const file of OWNED) {
  const source = read(file);
  if (source === null) continue;
  if (/from\s+['"]@playwright\/test['"]/.test(source)) {
    problems.push(
      `${file} imports @playwright/test. playwright.config.ts:60 is ` +
        '`retries: process.env.CI ? 2 : 1`, so the drill would inherit two CI retries and ' +
        'forfeit p.9\'s flake target on a line it never reads (PF-586).',
    );
  }
}

// ── 4. one home for every threshold ─────────────────────────────────────────
for (const file of OWNED) {
  if (file === 'scripts/ttfe/check-fitness.mjs') continue; // this file names them to forbid them
  const source = read(file);
  if (source === null) continue;
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
    if (/\b60[_]?000\b/.test(line) || /\b2[_]?000\s*(?:\/\/|$)/.test(line)) {
      problems.push(
        `${file}:${index + 1} — a threshold literal outside ttfe.thresholds.json. ` +
          'Every budget lives in that one file so raising it is a reviewable diff (PF-609).',
      );
    }
  });
}

// ── 5. no `npx`, and the two tsx resolvers agree ────────────────────────────
//
// PF-608. The drill spawns four child processes and every one of them used to be
// `npx tsx <script>`. On a clean `pnpm install --frozen-lockfile` checkout that
// resolves to nothing — `tsx` is a devDependency of `api`, so pnpm links it into
// `api/node_modules/.bin` and not into the root — and the harness died 127 before
// printing its ready line on every CI run the drill has ever had. Worse is the
// version that "works": given a reachable registry, `npx` DOWNLOADS an unpinned
// tsx and the graded drill then measures a toolchain the lockfile does not name.
//
// The resolver is deliberately duplicated — `scripts/ttfe/harness.ts` may not
// import from `integrations/` and vice versa (p.11, PF-588) — so the two copies
// are held in step here rather than by hoping.
for (const file of OWNED) {
  if (file === 'scripts/ttfe/check-fitness.mjs') continue; // this file names it to forbid it
  const source = read(file);
  if (source === null) continue;
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return;
    if (/['"]npx['"]/.test(line)) {
      problems.push(
        `${file}:${index + 1} — spawns \`npx\`. On a clean checkout it resolves nothing and the ` +
          'harness exits 127 before its ready line; with a registry it silently downloads an ' +
          'unpinned tsx and the graded drill measures a toolchain the lockfile does not name. ' +
          'Use resolveTsx() (PF-608).',
      );
    }
  });
}

const RESOLVER_COPIES = ['integrations/cli/tests/ttfe/tsx.ts', 'scripts/ttfe/harness.ts'];
const candidateLists = RESOLVER_COPIES.map((file) => {
  const source = read(file);
  if (source === null) return null;
  // The candidate list, as the `join(...)` calls that build it.
  const matches = [...source.matchAll(/join\(\s*repoRoot|join\(\s*REPO_ROOT/gi)];
  const paths = [...source.matchAll(/'node_modules',\s*'\.bin',\s*'tsx'|'api',\s*'node_modules',\s*'\.bin',\s*'tsx'/g)].map(
    (match) => match[0],
  );
  return matches.length === 0 ? null : paths.join(' | ');
});
if (candidateLists.some((list) => list === null)) {
  problems.push(
    `the tsx resolver is missing from one of ${RESOLVER_COPIES.join(' / ')}. Both need it: ` +
      'the harness is outside `integrations/` and may not import across that fence (PF-588).',
  );
} else if (new Set(candidateLists).size !== 1) {
  problems.push(
    'the two tsx resolvers look for different paths:\n' +
      RESOLVER_COPIES.map((file, i) => `      ${file}: ${candidateLists[i]}`).join('\n') +
      '\n    They are duplicated only because the boundary forbids sharing; they must stay identical.',
  );
}

// The thresholds file must exist and parse — three consumers read it.
try {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, 'ttfe.thresholds.json'), 'utf8'));
  if (parsed.totalMs !== 60000) {
    problems.push(`ttfe.thresholds.json totalMs is ${parsed.totalMs}; p.8 budgets the loop at 60000 ms.`);
  }
} catch (error) {
  problems.push(`ttfe.thresholds.json is missing or unparseable: ${String(error)}`);
}

if (problems.length > 0) {
  process.stderr.write('\nttfe fitness FAILED:\n\n');
  for (const problem of problems) process.stderr.write(`  · ${problem}\n\n`);
  process.exit(1);
}

process.stdout.write(`ttfe fitness OK — ${OWNED.length} file(s): no sleeps, retry: 0, no Playwright, one thresholds file\n`);

function read(relativePath) {
  try {
    return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
  } catch {
    return null;
  }
}

function listDir(relativeDir) {
  const absolute = join(REPO_ROOT, relativeDir);
  try {
    return readdirSync(absolute)
      .map((name) => join(absolute, name))
      .filter((path) => statSync(path).isFile())
      .map((path) => relative(REPO_ROOT, path));
  } catch {
    return [];
  }
}
