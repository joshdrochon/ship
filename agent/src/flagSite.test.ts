/**
 * PF-704 — one flag, one name, one read site, default off.
 *
 * The parse is trivial. The grep is not: it is the assertion that makes the CI
 * matrix in PF-706 mean something. A flag read in five places is five places to
 * be inconsistent, and the matrix would then be exercising a combination no
 * deployment ever has — reader on, actions off, or the reverse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentViaSdk, AGENT_VIA_SDK_ENV_VAR } from './composition.js';

const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comments stripped before the grep — L99 F113's lesson, applied.
 *
 * `entrypoints/cron.ts` explains in a comment that `agentViaSdk()` is the only
 * function touching `process.env.SHIP_AGENT_VIA_SDK`. That comment exists to
 * tell the next reader where the flag lives, and the first version of this test
 * failed on it. The "fix" a hurried author reaches for is deleting the honest
 * comment; the correct one is to grep CODE.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const sources = walk(SRC).map((path) => ({
  name: relative(SRC, path),
  code: stripComments(readFileSync(path, 'utf8')),
}));

describe('PF-704 — the flag', () => {
  it('is named SHIP_AGENT_VIA_SDK', () => {
    expect(AGENT_VIA_SDK_ENV_VAR).toBe('SHIP_AGENT_VIA_SDK');
  });

  /**
   * DEFAULT OFF. An environment that has never heard of this variable keeps the
   * shipped Part 2 behaviour, and turning the rewire on is a deliberate act.
   *
   * The reverse default would make every existing deployment silently adopt
   * D5b's behavioural change at the next deploy, which is the one thing a flag
   * exists to prevent.
   */
  it('defaults OFF — an empty environment is the Part 2 agent', () => {
    expect(agentViaSdk({})).toBe(false);
    expect(agentViaSdk({ SHIP_AGENT_VIA_SDK: '' })).toBe(false);
  });

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    [' true ', true],
    ['0', false],
    ['false', false],
    // Strict on purpose: a typo behaves like the default, which is the safe
    // direction. A permissive parser turns `yes` into a silent no-op in the
    // direction of the OLD behaviour, diagnosed three days later as "the
    // rewire does nothing".
    ['yes', false],
    ['on', false],
  ])('parses %s as %s', (raw, expected) => {
    expect(agentViaSdk({ SHIP_AGENT_VIA_SDK: raw })).toBe(expected);
  });

  /**
   * THE grep. Exactly one non-test module names the variable.
   *
   * `composition.ts` names it twice by construction — once as the exported
   * constant, once in the lookup — so the assertion is over FILES, not over
   * occurrences.
   */
  it('is read in exactly one non-test module', () => {
    const readers = sources
      .filter((f) => !f.name.endsWith('.test.ts'))
      .filter((f) => f.code.includes('SHIP_AGENT_VIA_SDK'))
      .map((f) => f.name);
    expect(readers).toEqual(['composition.ts']);
  });

  /**
   * And nothing else reaches for `process.env` to decide which path it is on.
   *
   * A second module reading its own environment variable to reach the same
   * decision would satisfy the grep above and defeat its purpose.
   */
  it('no other module branches on an env var to pick a path', () => {
    const offenders = sources
      .filter((f) => !f.name.endsWith('.test.ts') && f.name !== 'composition.ts')
      .filter((f) => /process\.env\.[A-Z_]*(SDK|CITIZEN|REWIRE)/.test(f.code))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});
