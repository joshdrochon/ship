/**
 * Source-scanning helpers for fitness tests.
 *
 * Several tickets in this repo are enforced by grepping source ("there is
 * exactly one issuance site", "nothing under `platform/oauth/` calls
 * `Math.random`"). A naive grep over raw file text answers the wrong question:
 * it fires on the COMMENT that explains the rule as readily as on a violation.
 * That is not hypothetical — the first version of L06's assertions failed on its
 * own documentation, which said "never from `Date.now()`" and "well-formed for
 * the UUID column".
 *
 * A fitness test that cannot tell code from prose has two failure modes and both
 * are bad: it blocks the comment that explains the rule, and it teaches whoever
 * hits it to delete the explanation rather than fix the code.
 *
 * `stripComments` is deliberately simple — it removes `//` and block comments
 * while respecting string and template literals. It is not a parser and does not
 * need to be: it is used to decide whether an identifier appears in executable
 * code, and both over- and under-stripping a pathological case would be caught
 * by the assertion it feeds.
 *
 * Lives in `src/test/` (excluded from `api/tsconfig.json`) so it is not itself
 * scanned by the assertions that use it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Removes line and block comments, leaving string and template literals intact. */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const ch = source[i]!;

    if (mode === 'code') {
      if (two === '//') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (two === '/*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") mode = 'single';
      else if (ch === '"') mode = 'double';
      else if (ch === '`') mode = 'template';
      out += ch;
      i += 1;
      continue;
    }

    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (two === '*/') {
        mode = 'code';
        i += 2;
        continue;
      }
      // Keep newlines so line-based reporting stays roughly aligned.
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }

    // Inside a string or template literal.
    if (ch === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }

  return out;
}

export interface ScannedFile {
  name: string;
  path: string;
  /** File text with comments removed. */
  code: string;
  /** Raw file text, comments included. */
  raw: string;
}

/** Every non-test `.ts` file directly inside `dir`, with comments stripped. */
export function scanDirectory(dir: string): ScannedFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const raw = readFileSync(path, 'utf8');
      return { name, path, raw, code: stripComments(raw) };
    });
}

/** Every non-test `.ts` file under `dir`, recursively. */
export function scanTree(dir: string, skip: string[] = ['node_modules', 'dist']): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (skip.includes(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const raw = readFileSync(full, 'utf8');
      out.push({ name: entry.name, path: full, raw, code: stripComments(raw) });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
