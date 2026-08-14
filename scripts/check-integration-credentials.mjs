#!/usr/bin/env node
/**
 * PF-722 — no integration holds a credential an external developer could not hold.
 *
 *     pnpm check:integration-credentials
 *
 * The import fence stops COMPILE-TIME cheating: an integration cannot `import`
 * its way into `api/src`. This stops RUNTIME cheating, which the fence cannot
 * see at all — a `pg.Client` built from a connection string, a `SESSION_SECRET`
 * read out of the environment, a `fetch` at the internal `/api/` surface with a
 * session cookie. Every one of those compiles cleanly under fence 3 and every
 * one of them means the integration is not a stranger.
 *
 * It is the half that makes *platform citizen* checkable rather than asserted,
 * and PRD p.11's claim is precisely the conjunction of the two.
 *
 * ── The word `pg`, and why this is not a bare grep ──────────────────────────
 * PF-722's criterion says "returns zero matches for `pg`". Run literally that
 * matches `pgrep`, `--pg`, the letters inside `postgres`, and any identifier a
 * future author happens to spell with those two characters, so the check would
 * be abandoned within a week of its first false positive — which is L99 F113's
 * lesson (a grep-shaped fitness test that fires on honest prose gets "fixed" by
 * deleting the prose).
 *
 * So each forbidden thing is matched in the SHAPE that would actually be a
 * violation:
 *
 *   pg / postgres      an import or require of the driver, by module specifier
 *   DATABASE_URL       the identifier, anywhere — there is no innocent use of it
 *   SESSION_SECRET     likewise
 *   api/src            a path into the server tree, in any quoting
 *
 * Comments are STRIPPED before matching, for the same reason L99 F72 records:
 * a source comment explaining *why this package does not hold a database
 * credential* would otherwise be the thing that fails the check.
 *
 * ── TWO TIERS, and the ticket's literal criterion is wrong (L99 F150) ───────
 * PF-722 asks for zero matches across `integrations/**`. Run literally against
 * the tree as it stands, that fails SEVEN times and not one of them is a
 * violation:
 *
 *   integrations/cli/tests/boundary.test.ts        asserts no source file names
 *                                                  `api/src` — the honest test
 *                                                  fails for naming the thing it
 *                                                  forbids (L99 F113 exactly)
 *   integrations/cli/tests/server/support/harness.ts
 *                                                  DELETES `DATABASE_URL` from
 *                                                  the CLI's environment and
 *                                                  hands it to the operator's
 *                                                  approval subprocess
 *   integrations/browser-demo/playwright.config.ts forwards it to `globalSetup`,
 *                                                  which lives in `scripts/`
 *                                                  precisely so the integration
 *                                                  does not hold it
 *
 * So the scan is split by ROLE, and the split is drawn where the claim actually
 * lives:
 *
 *   THE INTEGRATION  every file that is not a test or a runner config. All four
 *                    patterns, zero matches, no exceptions. This is the process
 *                    that talks to Ship, and it is what "platform citizen" is a
 *                    claim about.
 *   THE HARNESS      tests and `*.config.ts`. `pg` and `SESSION_SECRET` stay
 *                    absolutely forbidden; `DATABASE_URL` and `api/src` are
 *                    permitted, because a harness legitimately hands an
 *                    operator's credential to an operator's subprocess and
 *                    legitimately names the path it is asserting nobody imports.
 *
 * The load-bearing half survives the split intact: **a package that never
 * imports `pg` cannot open a database connection**, whatever strings it holds,
 * and that pattern is enforced in both tiers. The relaxation is on strings, not
 * on capability.
 *
 * ── The anti-vacuity half ──────────────────────────────────────────────────
 * A fixture file under `eslint-fixtures/integration-credentials/` violates each
 * pattern. The run fails if any of them is NOT caught, so "zero matches across
 * integrations/" cannot come from a regex that matches nothing. A second fixture
 * exercises the harness tier, so the relaxation cannot silently widen into `pg`.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_DIR = join(REPO, 'eslint-fixtures', 'integration-credentials');

/** Extensions worth reading. A `.json` manifest is covered by the deps check. */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', 'playwright-report', '.vite']);

/**
 * The forbidden things, as data.
 *
 * `label` is what the failure message names, so a reader learns which of the
 * four rules they tripped rather than being handed a regex.
 */
export const CREDENTIAL_PATTERNS = [
  {
    label: 'pg (the Postgres driver)',
    // `bothTiers` is the capability half: a package that never imports the
    // driver cannot open a connection, so this one holds everywhere.
    bothTiers: true,
    // `from 'pg'`, `require("pg")`, `import('pg/lib/...')`, and the same for
    // `postgres`. Anchored on the quote so `pgrep` and `postgresql://` in a URL
    // literal are not matches — the URL case is caught by DATABASE_URL below.
    regex: /(?:from|require\s*\(|import\s*\()\s*['"](pg|postgres)(?:\/[^'"]*)?['"]/g,
    why: 'An integration that opens a database connection is not using the front door.',
  },
  {
    label: 'DATABASE_URL',
    regex: /\bDATABASE_URL\b/g,
    why: 'Provisioning is an operator action. See scripts/l24-browser-demo-setup.ts for where it belongs.',
  },
  {
    label: 'SESSION_SECRET',
    // No honest use anywhere, harness included: the internal session surface is
    // not something a test for an external integration has any business signing.
    bothTiers: true,
    regex: /\bSESSION_SECRET\b/g,
    why: 'Sessions are the INTERNAL surface. An integration authenticates with OAuth, never a session.',
  },
  {
    label: 'api/src',
    regex: /api\/src/g,
    why: 'A path into the server tree. Fence 3 catches the import; this catches the string.',
  },
];

/** Strips `//` and block comments so honest prose cannot fail the check (F72). */
export function stripComments(source) {
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = '';
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i += 1; continue;
    }
    // string
    if (c === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    out += c;
    if (c === quote) state = 'code';
    i += 1;
  }
  return out;
}

/**
 * Which tier a file belongs to. See the header — the split is by ROLE, and a
 * harness is anything that only ever runs under a test runner.
 */
export function tierOf(relPath) {
  const parts = relPath.split('/');
  const base = parts[parts.length - 1];
  const isHarness =
    parts.includes('tests') ||
    parts.includes('test') ||
    parts.includes('__tests__') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /\.config\.[cm]?[jt]s$/.test(base);
  return isHarness ? 'harness' : 'integration';
}

/** Every match of every pattern in one file, filtered by tier. */
export function scanSource(source, tier = 'integration') {
  const code = stripComments(source);
  const hits = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (tier === 'harness' && pattern.bothTiers !== true) continue;
    const regex = new RegExp(pattern.regex.source, 'g');
    let match;
    while ((match = regex.exec(code)) !== null) {
      const line = code.slice(0, match.index).split('\n').length;
      hits.push({ label: pattern.label, why: pattern.why, line, text: match[0] });
    }
  }
  return hits;
}

function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
        out.push(full);
      }
    }
  };
  if (existsSync(root) && statSync(root).isDirectory()) walk(root);
  return out.sort();
}

const failures = [];
const notes = [];

// --- 1. integrations/ holds none of the four ---------------------------------
{
  const files = sourceFiles(join(REPO, 'integrations'));
  if (files.length === 0) failures.push('integrations/: no source files found — the scan proved nothing.');
  const counts = { integration: 0, harness: 0 };
  for (const file of files) {
    const rel = relative(REPO, file).split(/[\\/]/).join('/');
    const tier = tierOf(rel);
    counts[tier] += 1;
    for (const hit of scanSource(readFileSync(file, 'utf8'), tier)) {
      failures.push(`${rel}:${hit.line} [${tier}] matches ${hit.label} (\`${hit.text.trim()}\`). ${hit.why}`);
    }
  }
  notes.push(
    `  ok  ${counts.integration} integration file(s) — all four patterns, zero matches\n` +
      `  ok  ${counts.harness} harness file(s) — pg and SESSION_SECRET, zero matches`,
  );
}

// --- 2. anti-vacuity: the fixtures must be caught -----------------------------
{
  if (!existsSync(FIXTURE_DIR)) {
    failures.push(`anti-vacuity: ${FIXTURE_DIR} does not exist; the patterns are unproven.`);
  } else {
    const uncaught = new Set(CREDENTIAL_PATTERNS.map((p) => p.label));
    const fixtures = readdirSync(FIXTURE_DIR).filter((f) => SOURCE_EXTENSIONS.has(extname(f)));
    if (fixtures.length === 0) failures.push(`anti-vacuity: no fixtures in ${FIXTURE_DIR}.`);
    let harnessTierExercised = false;
    for (const name of fixtures) {
      // Scanned in the tier its own filename puts it in — so the fixture named
      // `*.test.ts` proves the RELAXED tier still catches `pg`, which is the
      // half of the split that could rot into permitting everything.
      const tier = tierOf(name);
      const hits = scanSource(readFileSync(join(FIXTURE_DIR, name), 'utf8'), tier);
      if (hits.length === 0) {
        failures.push(
          `anti-vacuity: fixture ${name} (${tier} tier) was NOT caught. It exists to be caught — ` +
            `a pattern has stopped matching the violation it encodes.`,
        );
      }
      if (tier === 'harness' && hits.length > 0) harnessTierExercised = true;
      for (const hit of hits) uncaught.delete(hit.label);
    }
    if (uncaught.size > 0) {
      failures.push(
        `anti-vacuity: no fixture exercises ${[...uncaught].join(', ')}. Every pattern needs one, ` +
          `or an unexercised pattern can rot into matching nothing without anyone noticing.`,
      );
    } else {
      notes.push(`  ok  all ${CREDENTIAL_PATTERNS.length} patterns caught their fixture`);
    }
    if (!harnessTierExercised) {
      failures.push(
        'anti-vacuity: no fixture is scanned in the HARNESS tier. The tier split is where this ' +
          'check could quietly become permissive, so it needs its own fixture — one named ' +
          '`*.test.ts` that still gets caught.',
      );
    } else {
      notes.push('  ok  the relaxed harness tier still catches the pg driver');
    }
  }
}

console.log('integration credential rule (PF-722)\n');
for (const n of notes) console.log(n);

if (failures.length > 0) {
  console.error('\nFAILED:\n');
  for (const f of failures) console.error(`  x  ${f}\n`);
  console.error(
    `${failures.length} violation(s). An integration authenticates with an OAuth client_id/` +
      `client_secret or a token loaded through ITokenStore, and holds nothing else (PRD p.11, p.3).`,
  );
  process.exit(1);
}

console.log('\nNo integration holds a credential an external developer could not hold.');
