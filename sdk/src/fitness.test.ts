/**
 * Package-level fitness assertions — the properties no unit test can hold.
 *
 * PF-495 one `fetch(` site · PF-496 zero-polyfill runtime and no HTTP dependency
 * · PF-503 the contract is documented where a consumer will find it · PF-507 the
 * browser entry has no `node:` in its import graph · PF-513 no `setTimeout` in
 * any SDK test.
 *
 * These are greps and graph walks over the source, which is the only thing that
 * can fail when someone adds a second transport in six months.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = HERE;
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..');

/**
 * Source with comments removed.
 *
 * Every assertion in this file is about what the CODE does. Without this, the
 * file fails on its own prose — the header of `transport.ts` explains that
 * `http.ts` owns the only `fetch(` call, and a naive grep counts that sentence
 * as a second call site. A fitness test that cannot be described in a comment is
 * a fitness test nobody will document.
 *
 * The `//` rule skips `://` so a URL inside a string survives.
 */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, predicate: (p: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full, predicate));
    else if (predicate(full)) found.push(full);
  }
  return found;
}

const allSources = walk(SRC, (p) => p.endsWith('.ts'));
const productionSources = allSources.filter(
  (p) => !p.endsWith('.test.ts') && !p.endsWith('testSupport.ts'),
);
const testSources = allSources.filter((p) => p.endsWith('.test.ts'));

describe('PF-495 · exactly ONE module reaches the HTTP primitive', () => {
  it('and it is http.ts', () => {
    // Two transports means two auth behaviours, two retry policies, and two
    // places a token can leak — and the second one is always added by someone
    // who did not know the first existed.
    //
    // PRODUCTION sources only. A test file is allowed to say "fetch" in a
    // description; what must not happen is a second module in `dist` reaching
    // the global.
    const callers = productionSources.filter((path) => /\bfetch\b/.test(codeOf(path)));
    expect(callers.map((p) => relative(SRC, p))).toEqual(['http.ts']);
  });

  it('no resource client constructs a URL or a header of its own', () => {
    const resourceFiles = walk(join(SRC, 'resources'), (p) => p.endsWith('.ts'));
    expect(resourceFiles.length).toBeGreaterThan(0);
    for (const file of resourceFiles) {
      const source = codeOf(file);
      expect(source, `${file} builds its own URL`).not.toMatch(/new URL\(/);
      expect(source, `${file} sets its own auth header`).not.toMatch(/[Aa]uthorization/);
      expect(source, `${file} reaches fetch`).not.toMatch(/\bfetch\b/);
    }
  });

  it('no production source interpolates a credential into a string', () => {
    // The one legal interpolation is the Authorization header in transport.ts.
    // `${JSON.stringify(tokens…)}` is not a match — `tokens` is the pair, and
    // serialising it to write the store is the whole job of FileTokenStore.
    const offenders: string[] = [];
    for (const file of productionSources) {
      for (const line of codeOf(file).split('\n')) {
        if (!/\$\{[^}]*\b(accessToken|refreshToken|clientSecret|token|secret)\b[^}]*\}/.test(line)) {
          continue;
        }
        if (/Bearer \$\{accessToken\}/.test(line)) continue;
        offenders.push(`${relative(SRC, file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('PF-496 · zero-polyfill runtime, and no HTTP dependency', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    engines?: { node?: string };
    exports?: Record<string, unknown>;
  };

  it('declares engines.node at a version with a global fetch', () => {
    const engine = manifest.engines?.node ?? '';
    const major = Number(/(\d+)/.exec(engine)?.[1] ?? 0);
    expect(engine, 'engines.node is missing').not.toBe('');
    expect(major, `${engine} predates global fetch (Node 18)`).toBeGreaterThanOrEqual(18);
  });

  it('declares NO production dependencies at all', () => {
    // The p.9 budget is trivially met until the first `dependencies` entry
    // lands. This assertion is what makes that entry a deliberate act.
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('imports no HTTP client, in any module', () => {
    const banned = ['node-fetch', 'undici', 'axios', 'got', 'cross-fetch', 'superagent', 'request'];
    for (const file of allSources) {
      const source = readFileSync(file, 'utf8');
      for (const pkg of banned) {
        expect(source, `${relative(SRC, file)} imports ${pkg}`).not.toMatch(
          new RegExp(`from ['"]${pkg}`),
        );
      }
    }
  });

  it('imports nothing from this workspace — the fence, restated where it bites', () => {
    // ESLint fence 4 (L99 F24) owns this at lint time. Restated here because a
    // published package that reaches back into the monorepo compiles locally and
    // breaks on `npm install @ship/sdk`, which is the worst place to find out.
    for (const file of productionSources) {
      const source = codeOf(file);
      expect(source, `${relative(SRC, file)} imports @ship/*`).not.toMatch(/from ['"]@ship\//);
      expect(source, `${relative(SRC, file)} reaches out of sdk/`).not.toMatch(
        /from ['"]\.\.\/\.\.\/(?!\.)/,
      );
    }
  });
});

describe('PF-507 · the browser entry has no node: specifier in its import graph', () => {
  /** Follows relative imports from an entry and returns every module reached. */
  function importGraph(entry: string): { files: string[]; bareSpecifiers: string[] } {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);

      const source = codeOf(current);
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1] as string;
        if (!specifier.startsWith('.')) {
          bare.add(specifier);
          continue;
        }
        // Source is written with `.js` extensions (NodeNext); resolve to `.ts`.
        const resolved = resolve(dirname(current), specifier.replace(/\.js$/, '.ts'));
        if (existsSync(resolved)) queue.push(resolved);
      }
    }
    return { files: [...seen], bareSpecifiers: [...bare] };
  }

  it('reaches no `node:` module — this is the defect L99 F14 named', () => {
    const graph = importGraph(join(SRC, 'browser.ts'));
    const nodeBuiltins = graph.bareSpecifiers.filter((s) => s.startsWith('node:'));
    expect(
      nodeBuiltins,
      `browser.ts transitively imports ${nodeBuiltins.join(', ')} — a browser bundle of ` +
        `@ship/sdk cannot resolve it. Move the Node-only module behind the exports map.`,
    ).toEqual([]);
  });

  it('reaches NO bare specifier at all — nothing to resolve, nothing to polyfill', () => {
    expect(importGraph(join(SRC, 'browser.ts')).bareSpecifiers).toEqual([]);
  });

  it('and it really does reach the client and the localStorage store', () => {
    // A graph walk that found nothing would also pass the assertions above.
    const files = importGraph(join(SRC, 'browser.ts')).files.map((f) => relative(SRC, f));
    expect(files).toContain('client.ts');
    expect(files).toContain('transport.ts');
    expect(files).toContain('auth/localStorageTokenStore.ts');
    expect(files.length).toBeGreaterThan(8);
  });

  it('the NODE entry does reach node:crypto and node:fs — the split is real, not cosmetic', () => {
    const bare = importGraph(join(SRC, 'index.ts')).bareSpecifiers;
    expect(bare).toContain('node:crypto');
    expect(bare.some((s) => s.startsWith('node:fs'))).toBe(true);
  });

  it('package.json ships a conditional exports map with a browser condition', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, unknown>>;
    };
    const root = manifest.exports['.'];
    expect(root, 'no "." entry in exports').toBeTruthy();
    expect(Object.keys(root as object)[0], 'the browser condition must come FIRST — conditions are ordered').toBe(
      'browser',
    );
    expect(manifest.exports['./browser']).toBeTruthy();
    expect(manifest.exports['./node']).toBeTruthy();
  });
});

describe('PF-513 · no wall-clock sleeping in any SDK test', () => {
  it('`setTimeout` appears in no sdk/**/*.test.ts', () => {
    // p.11: timing-based tests "are flaky tests". The retry ladder is asserted
    // by reading what the client ASKED to wait, through the injected clock.
    //
    // This file is excluded because it is the scanner: it has to name the
    // identifier to look for it. Everything else is fair game.
    const offenders = testSources
      .filter((p) => p !== __filename && !p.endsWith('fitness.test.ts'))
      .filter((p) => /\bsetTimeout\b/.test(codeOf(p)));
    expect(offenders.map((p) => relative(SRC, p))).toEqual([]);
  });

  it('the ONE real setTimeout is `realClock.sleep`, and nowhere else', () => {
    const users = productionSources.filter((p) => /\bsetTimeout\b/.test(codeOf(p)));
    expect(users.map((p) => relative(SRC, p))).toEqual(['retry.ts']);
  });
});

describe('PF-503 · the ITokenStore contract lives somewhere a consumer will find it', () => {
  it('in the doc comment, naming all three methods', () => {
    const source = readFileSync(join(SRC, 'auth/tokenStore.ts'), 'utf8');
    for (const method of ['load()', 'save(tokens)', 'clear()']) {
      expect(source).toContain(method);
    }
  });

  it('and in docs/architecture.md’s SDK Surface section — Pre-Search 2.4 needs a LOCATION', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/architecture.md'), 'utf8');
    const sdkSection = doc.slice(doc.indexOf('## SDK Surface'), doc.indexOf('## Agent-as-Citizen'));
    expect(sdkSection).toContain('ITokenStore');
    // The two questions Pre-Search 2.4 actually asks.
    expect(sdkSection, 'does not answer "refresh tokens too, or only access?"').toMatch(
      /persists BOTH tokens|both access and refresh/i,
    );
    expect(sdkSection, 'does not answer "threading model under concurrent calls?"').toMatch(
      /single-flight/i,
    );
  });
});
