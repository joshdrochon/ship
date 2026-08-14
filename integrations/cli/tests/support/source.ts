/**
 * Reads this package's own sources, with comments stripped.
 *
 * Every grep-shaped acceptance criterion in this lane (PF-558's `api/src`,
 * PF-559's `/api/v1`, PF-562's `fetch(` and `/oauth/`) is a claim about CODE.
 * A doc comment that NAMES the forbidden string — which several of these files
 * deliberately do, because explaining the rule is how it survives a refactor —
 * is not a violation, and a test that could not tell the two apart would push
 * every author to stop documenting the constraint. So comments come out first,
 * and the test says so rather than quietly matching on a weaker pattern.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const SRC_ROOT = join(PACKAGE_ROOT, 'src');

export function listSourceFiles(root: string = SRC_ROOT): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found.sort();
}

/**
 * Removes block and line comments. Not a parser — a lexer good enough for this
 * package, which contains no regex literal holding `//` and no template string
 * holding `/*`.
 */
export function stripComments(source: string): string {
  let out = '';
  let index = 0;
  let inString: string | null = null;

  while (index < source.length) {
    const two = source.slice(index, index + 2);
    const char = source[index] as string;

    if (inString !== null) {
      out += char;
      if (char === '\\') {
        out += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === inString) inString = null;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      out += char;
      index += 1;
      continue;
    }

    if (two === '//') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }

    if (two === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

export interface SourceFile {
  path: string;
  /** Path relative to the package root, for readable failure messages. */
  relative: string;
  /** The file with comments removed. */
  code: string;
  /** The file as written. */
  raw: string;
}

export function readSources(root: string = SRC_ROOT): SourceFile[] {
  return listSourceFiles(root).map((path) => {
    const raw = readFileSync(path, 'utf8');
    return {
      path,
      relative: path.slice(PACKAGE_ROOT.length + 1),
      code: stripComments(raw),
      raw,
    };
  });
}
