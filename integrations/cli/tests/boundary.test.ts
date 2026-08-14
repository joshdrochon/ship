/**
 * PF-558 / PF-559 / PF-562 — the boundary, proven against THIS package.
 *
 * L01's PF-011 is the rule and PF-012 is one generic fixture. This file points
 * both at `integrations/cli`, and adds the two structural claims the SDK-front-
 * door argument actually rests on: the CLI computes no URL of its own, and it
 * contains no OAuth logic of its own.
 *
 * The lint half — two fixtures that must FAIL `pnpm lint` — lives under
 * `eslint-fixtures/integrations/cli/`, because a file that fails lint cannot
 * live inside a package whose own `pnpm lint` has to stay green. This file
 * asserts those fixtures exist and that `scripts/check-boundary-lint.mjs` knows
 * about them; the script is what actually runs ESLint over them, in CI, through
 * PF-013's blocking job.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT, readSources } from './support/source.js';

const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));
const sources = readSources();

describe('PF-558 — integrations/cli imports only @ship/sdk', () => {
  it('every import in src/ is @ship/sdk, a node: builtin, or a relative sibling', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const match of file.code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        const allowed =
          specifier === '@ship/sdk' ||
          specifier.startsWith('@ship/sdk/') ||
          specifier.startsWith('node:') ||
          specifier.startsWith('./') ||
          specifier.startsWith('../');
        if (!allowed) offenders.push(`${file.relative} → ${specifier}`);
      }
    }
    expect(offenders, 'PRD p.11: integrations/ imports ONLY @ship/sdk').toEqual([]);
  });

  it.each(['api/src', '@ship/api', '@ship/shared', '@ship/agent', '@ship/web'])(
    'no occurrence of %s in src/ (comments stripped)',
    (needle) => {
      const hits = sources.filter((f) => f.code.includes(needle)).map((f) => f.relative);
      expect(hits).toEqual([]);
    },
  );

  it('does not reach for a database driver', () => {
    const hits = sources
      .filter((f) => /from\s+['"]pg['"]|require\(['"]pg['"]\)/.test(f.code))
      .map((f) => f.relative);
    expect(hits, 'the CLI has no database — that is the point of it').toEqual([]);
  });

  it('declares exactly one runtime dependency, and it is @ship/sdk (PF-557)', () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    // PF-557 leaned `commander`; the decision recorded in README.md and in
    // `src/argv.ts` went the other way, and this assertion is the reason it can:
    // one entry makes "the SDK is the front door" a mechanically checkable
    // claim, and `scripts/check-boundary-lint.mjs` enforces the same set.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@ship/sdk']);
  });

  it('ships the two negative lint fixtures L01 runs in CI', () => {
    const fixtures = [
      'eslint-fixtures/integrations/cli/imports-api-route.ts',
      'eslint-fixtures/integrations/cli/imports-shared-package.ts',
    ];
    for (const fixture of fixtures) {
      expect(existsSync(join(REPO_ROOT, fixture)), `${fixture} must exist`).toBe(true);
    }
    const checker = readFileSync(join(REPO_ROOT, 'scripts/check-boundary-lint.mjs'), 'utf8');
    for (const fixture of fixtures) {
      expect(checker, `${fixture} must be wired into PF-012's fitness test`).toContain(fixture);
    }
  });
});

describe('PF-559 — the CLI computes no URL of its own', () => {
  it('contains no /api/v1 literal', () => {
    const hits = sources.filter((f) => f.code.includes('/api/v1')).map((f) => f.relative);
    expect(
      hits,
      'the API prefix belongs to the SDK: a copy here silently discards a base-URL path prefix (PF-494)',
    ).toEqual([]);
  });
});

describe('PF-562 — ship login is nothing but a call into the SDK', () => {
  it.each(['fetch(', '/oauth/', 'code_verifier', 'code_challenge'])(
    'src/ contains no %s',
    (needle) => {
      const hits = sources.filter((f) => f.code.includes(needle)).map((f) => f.relative);
      expect(
        hits,
        'auth logic in the CLI is an SDK gap that got worked around (L18 PF-537)',
      ).toEqual([]);
    },
  );

  it('handles no device_code of its own', () => {
    // `USER_CODE_LINE_PREFIX` is this CLI's own output marker and is spelled
    // with hyphens precisely so this assertion stays a real one.
    const hits = sources.filter((f) => f.code.includes('device_code')).map((f) => f.relative);
    expect(hits).toEqual([]);
  });
});

describe('PF-560 — no stack trace reaches the terminal', () => {
  it('src/ never reads Error.stack', () => {
    const hits = sources.filter((f) => /\.stack\b/.test(f.code)).map((f) => f.relative);
    expect(hits).toEqual([]);
  });
});
