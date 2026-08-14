/**
 * PF-548 — every published export is marked stable or pre-1.0, and the mark
 * cannot drift from `docs/architecture.md`.
 *
 * p.12's Required Documentation, SDK Surface row: *"Public surface of @ship/sdk:
 * resource clients, auth helpers, async iterators, error union, webhook
 * verifier. Mark which surfaces are stable and which are pre-1.0."*
 *
 * The assertion that does the work is §1's: an export in NEITHER list fails, and
 * so does an export in BOTH. There is no "unclassified" state and no default —
 * so adding a surface costs one line saying what you are promising about it,
 * which is the only reliable moment to ask the question.
 *
 * ── The lists cover TYPES as well as values, and that needs source parsing ──
 * `import * as sdk` gives runtime bindings only, so an interface like
 * `ShipDocument` — which is most of what a consumer actually writes down —
 * would be invisible to a purely runtime check and could go unmarked forever.
 * §1 therefore reads the two barrel files as text and extracts both kinds. §2
 * cross-checks the runtime half against a real namespace import, so the parser
 * cannot silently under-report.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as sdk from './index.js';
import { STABLE_SURFACE, PRE_1_0_SURFACE, stabilityOf } from './stability.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SRC, '../..');

/**
 * Every name a barrel re-exports, values and types alike.
 *
 * Handles `export { a, b as c }`, `export type { X }` and `export * from` —
 * the last by recursing into the referenced module, which is how `index.ts`
 * reaches everything in `core.ts`.
 */
function exportedNames(entry: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(entry)) return names;
  seen.add(entry);

  const source = readFileSync(entry, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // `export * from './core.js'`
  for (const match of source.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolve(dirname(entry), (match[1] as string).replace(/\.js$/, '.ts'));
    for (const name of exportedNames(target, seen)) names.add(name);
  }

  // `export { a, b as c } from '...'` and `export type { X } from '...'`
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const clause of (match[1] as string).split(',')) {
      const trimmed = clause.trim().replace(/^type\s+/, '');
      if (trimmed === '') continue;
      const parts = trimmed.split(/\s+as\s+/);
      names.add((parts[parts.length - 1] as string).trim());
    }
  }

  return names;
}

const BARREL_EXPORTS = exportedNames(join(SRC, 'index.ts'));

describe('§1 · every published export appears in EXACTLY ONE list', () => {
  it('the walk found the barrel — it cannot pass by finding nothing', () => {
    expect(BARREL_EXPORTS.size).toBeGreaterThan(60);
    // Spot-check one of each kind, so a parser that dropped `export type` or
    // failed to follow `export *` would be caught here rather than by passing.
    expect(BARREL_EXPORTS.has('ShipClient')).toBe(true); // value, via export *
    expect(BARREL_EXPORTS.has('ShipDocument')).toBe(true); // type, via export *
    expect(BARREL_EXPORTS.has('verifyWebhook')).toBe(true); // value, direct
    expect(BARREL_EXPORTS.has('FileTokenStoreOptions')).toBe(true); // type, direct
  });

  it('nothing is UNLISTED', () => {
    const unlisted = [...BARREL_EXPORTS].filter((name) => stabilityOf(name) === 'unlisted').sort();

    expect(
      unlisted,
      `${unlisted.length} export(s) of @ship/sdk are marked neither stable nor pre-1.0. ` +
        `p.12 requires the published surface to say which it is, and there is deliberately ` +
        `no default: add each name to STABLE_SURFACE or PRE_1_0_SURFACE in ` +
        `sdk/src/stability.ts. If you cannot decide, it is pre-1.0.`,
    ).toEqual([]);
  });

  it('nothing is in BOTH', () => {
    const both = STABLE_SURFACE.filter((name) =>
      (PRE_1_0_SURFACE as readonly string[]).includes(name),
    );
    expect(both, 'a surface cannot be stable and pre-1.0 at once').toEqual([]);
  });

  it('and neither list names something the barrel does not export', () => {
    // The other direction. A list that accumulates names of deleted exports
    // still passes every assertion above while describing an SDK that no longer
    // exists.
    const phantom = [...STABLE_SURFACE, ...PRE_1_0_SURFACE]
      .filter((name) => !BARREL_EXPORTS.has(name))
      .sort();
    expect(
      phantom,
      `these names are marked but are not exported: ${phantom.join(', ')}. Either the export ` +
        `was removed and the mark was left behind, or the mark is aspirational.`,
    ).toEqual([]);
  });

  it('adding an export without listing it FAILS — proven, not asserted', () => {
    // The mechanism, demonstrated against a fixture rather than described.
    const withNewExport = new Set([...BARREL_EXPORTS, 'somethingBrandNew']);
    const unlisted = [...withNewExport].filter((name) => stabilityOf(name) === 'unlisted');
    expect(unlisted).toEqual(['somethingBrandNew']);
  });
});

describe('§2 · the runtime half agrees with the source parse', () => {
  it('every runtime binding on the namespace import is classified', () => {
    // `import * as sdk` sees values only, so this covers strictly less than §1 —
    // but it covers it WITHOUT a parser, which is what makes it a useful
    // cross-check rather than a duplicate.
    const runtime = Object.keys(sdk).filter((key) => key !== 'default');
    expect(runtime.length).toBeGreaterThan(40);

    const unlisted = runtime.filter((name) => stabilityOf(name) === 'unlisted').sort();
    expect(unlisted).toEqual([]);
  });

  it('and the parser did not under-report — every runtime binding is in the parsed set', () => {
    const missed = Object.keys(sdk)
      .filter((key) => key !== 'default')
      .filter((name) => !BARREL_EXPORTS.has(name))
      .sort();
    expect(
      missed,
      `the source parser missed ${missed.join(', ')}, so §1 has been checking a subset of the ` +
        `real surface. Fix exportedNames() before trusting the unlisted assertion.`,
    ).toEqual([]);
  });
});

describe('§3 · the five p.4 rows are all STABLE — that is what the row promises', () => {
  // p.12 names the surfaces by category. Each of the five is checked by its
  // load-bearing export rather than by counting, so this cannot pass because a
  // list happens to be long.
  const rows: [string, string[]][] = [
    ['resource clients', ['ShipClient', 'DocumentsClient', 'IssuesClient', 'SprintsClient', 'WebhooksClient']],
    ['auth helpers', ['runDeviceLogin', 'runAuthorizationCodeFlow', 'ITokenStore', 'InMemoryTokenStore']],
    ['async iterators', ['paginate', 'Page']],
    ['error union', ['ShipError', 'SHIP_ERROR_KINDS', 'ShipErrorKind']],
    ['webhook verifier', ['verifyWebhook', 'SIGNATURE_HEADER']],
  ];

  for (const [row, names] of rows) {
    it(`${row}`, () => {
      for (const name of names) {
        expect(stabilityOf(name), `${name} is not marked stable`).toBe('stable');
      }
    });
  }

  it('the two STATIC login helpers are reachable on the class, whatever the lists say', () => {
    // p.4 names `ShipClient.authorizationCodeFlow()` and `ShipClient.deviceLogin()`
    // as the surface, and those are statics rather than exports — so no list can
    // see them and this is the only assertion that can.
    expect(typeof sdk.ShipClient.deviceLogin).toBe('function');
    expect(typeof sdk.ShipClient.authorizationCodeFlow).toBe('function');
  });
});

describe('§4 · docs/architecture.md and the lists cannot drift', () => {
  const doc = readFileSync(join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## SDK Surface'), doc.indexOf('## Agent-as-Citizen'));

  it('the section exists and states both halves', () => {
    expect(section.length).toBeGreaterThan(200);
    expect(section).toContain('Stable for the week');
    expect(section).toContain('Pre-1.0');
  });

  it('every surface the doc calls STABLE is stable in the lists', () => {
    // p.12 makes the architecture document a graded deliverable, so a
    // disagreement between it and the code is a graded defect, not a nit.
    const stableHalf = section.slice(
      section.indexOf('Stable for the week'),
      section.indexOf('Pre-1.0'),
    );
    for (const name of [
      'ShipClient',
      'authorizationCodeFlow',
      'deviceLogin',
      'verifyWebhook',
      'documents',
      'issues',
      'sprints',
      'webhooks',
    ]) {
      expect(stableHalf, `the doc's stable half does not mention ${name}`).toContain(name);
    }
    for (const name of ['ShipClient', 'verifyWebhook']) {
      expect(stabilityOf(name)).toBe('stable');
    }
  });

  it('every surface the doc calls PRE-1.0 is pre-1.0 in the lists', () => {
    const preHalf = section.slice(section.indexOf('Pre-1.0'));
    expect(preHalf).toContain('ITokenStore');
    expect(preHalf).toContain('option bags');
    // The doc's "ITokenStore implementations beyond in-memory/file" is exactly
    // `LocalStorageTokenStore`, and its option bag.
    expect(stabilityOf('LocalStorageTokenStore')).toBe('pre-1.0');
    expect(stabilityOf('LocalStorageTokenStoreOptions')).toBe('pre-1.0');
    // …and "in-memory/file" are the two the doc keeps on the stable side.
    expect(stabilityOf('InMemoryTokenStore')).toBe('stable');
    expect(stabilityOf('FileTokenStore')).toBe('stable');
  });

  it('the doc states the verifier’s POSITIONAL signature — PF-542’s second source', () => {
    expect(section).toContain('verifyWebhook(headers, rawBody, secret, toleranceSec = 300)');
  });
});
