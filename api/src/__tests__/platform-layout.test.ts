/**
 * PF-022 — `docs/architecture.md`'s Module Layout matches the shipped tree.
 *
 * The architecture doc is a graded Final deliverable (PRD p.12), and the usual
 * fate of an architecture doc is to describe the system as it was intended two
 * weeks ago. This walks `api/src/platform/` and the doc's Module Layout block and
 * asserts they agree in both directions:
 *
 *   - every module the doc names exists on disk, and
 *   - every module on disk is named in the doc.
 *
 * The second direction is the one that catches real drift. A module that quietly
 * appears under `platform/` — because it seemed easier than deciding where the
 * code belonged — is exactly the kind of thing nobody updates the doc for, and
 * exactly the kind of thing a reviewer reading only the doc would never see.
 *
 * "Module" here means a directory under `platform/` that contains TypeScript.
 * `platform/api/` contains no `.ts` of its own, only `v1/`, so it is a namespace
 * and the module is `api/v1/` — which is what the doc says. Files that sit beside
 * the modules (`index.ts`, `clock.ts`, `README.md`) are not modules and are not
 * expected to appear in the layout block.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = join(HERE, '..', 'platform');
const ARCHITECTURE_DOC = join(HERE, '..', '..', '..', 'docs', 'architecture.md');

/**
 * Directories under `platform/` that hold TypeScript, as slash-suffixed paths
 * relative to `platform/`. A directory with no `.ts` of its own is treated as a
 * namespace and descended into, which is what makes `api/v1/` one module rather
 * than two.
 */
function discoverModules(dir: string, prefix = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const hasOwnTypeScript = entries.some((e) => e.isFile() && e.name.endsWith('.ts'));
  const childDirs = entries.filter((e) => e.isDirectory());

  if (prefix !== '' && hasOwnTypeScript) return [prefix];

  return childDirs.flatMap((d) => discoverModules(join(dir, d.name), `${prefix}${d.name}/`));
}

/**
 * Module names from the Module Layout fenced block in docs/architecture.md — the
 * indented lines under `api/src/platform/`, up to the first line that returns to
 * column 0 (`sdk/`, which is a sibling of platform/, not a module in it).
 */
function documentedModules(): string[] {
  const doc = readFileSync(ARCHITECTURE_DOC, 'utf8');
  const fenceStart = doc.indexOf('```', doc.indexOf('## Module Layout'));
  const fenceEnd = doc.indexOf('```', fenceStart + 3);
  expect(fenceStart, 'docs/architecture.md has no fenced block under "## Module Layout"').toBeGreaterThan(0);

  const lines = doc.slice(fenceStart + 3, fenceEnd).split('\n');
  const platformIndex = lines.findIndex((l) => l.startsWith('api/src/platform/'));
  expect(platformIndex, 'the Module Layout block does not start with api/src/platform/').toBeGreaterThanOrEqual(0);

  const modules: string[] = [];
  for (const line of lines.slice(platformIndex + 1)) {
    if (line.trim() === '') continue;
    // Column 0 means we have left the platform/ subtree (sdk/, integrations/cli/, ...).
    if (!line.startsWith('  ')) break;
    // Continuation lines are indented past the name column and carry no path.
    const match = /^ {2}(\S+\/)\s/.exec(line);
    if (match) modules.push(match[1]!);
  }
  return modules;
}

describe('PF-022 · platform/ matches docs/architecture.md Module Layout', () => {
  const onDisk = discoverModules(PLATFORM_DIR).sort();
  const documented = documentedModules().sort();

  it('documents every module that exists', () => {
    const undocumented = onDisk.filter((m) => !documented.includes(m));
    expect(
      undocumented,
      `platform/ modules missing from docs/architecture.md's Module Layout: ${undocumented.join(', ')}. ` +
        `The doc is a graded deliverable (PRD p.12) — add a one-line entry, or move the code somewhere ` +
        `it belongs.`,
    ).toEqual([]);
  });

  it('ships every module it documents', () => {
    const missing = documented.filter((m) => !onDisk.includes(m));
    expect(
      missing,
      `docs/architecture.md names platform modules that do not exist: ${missing.join(', ')}. ` +
        `Either the module was never created, or it was renamed and the doc was not.`,
    ).toEqual([]);
  });

  it('ships exactly the eight modules the layout declares', () => {
    // Named explicitly rather than derived, so a change to BOTH the doc and the
    // tree — which the two assertions above would happily agree on — still has to
    // pass a human-readable list. PF-001's acceptance criterion, restated as code.
    expect(onDisk).toEqual(
      ['api/v1/', 'apps/', 'audit/', 'oauth/', 'openapi/', 'ratelimit/', 'scopes/', 'webhooks/'].sort(),
    );
  });

  it('gives every module a barrel index.ts', () => {
    const withoutBarrel = onDisk.filter((m) => !existsSync(join(PLATFORM_DIR, m, 'index.ts')));
    expect(
      withoutBarrel,
      `platform modules with no index.ts: ${withoutBarrel.join(', ')}. The composition root imports ` +
        `module barrels, not files behind them.`,
    ).toEqual([]);
  });
});
