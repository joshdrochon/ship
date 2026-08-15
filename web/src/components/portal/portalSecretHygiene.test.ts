/**
 * PF-667 / PF-669 — the two leakage paths that no behavioural test can see,
 * enforced by reading the portal's source off disk.
 *
 * A component test drives the paths it drives. These two failures happen on a
 * path nobody drove:
 *
 *   * a `console.log` added while debugging the create response, left in;
 *   * a `setQueryData` that puts the create response in TanStack state, which
 *     `web/src/lib/queryClient.ts` persists to **IndexedDB** — a store that
 *     survives reload AND logout. PRD p.15 names "log line" as a leakage path;
 *     a cache written to disk is a log line with extra steps.
 *
 * Neither is hypothetical in this repo. `queryClient.ts` logs freely at module
 * scope, so "we do not log secrets" is a rule this codebase does not already
 * follow by habit — which is exactly why it is a test rather than a convention.
 *
 * Scanned from disk rather than by importing, because the violation this guards
 * against is a line on a code path no test executes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, '..', '..');

/** The portal module, same definition `portalTransport.test.ts` uses. */
const PORTAL_DIRS = [join(WEB_SRC, 'pages', 'portal'), join(WEB_SRC, 'components', 'portal')];
const PORTAL_FILES = [
  join(WEB_SRC, 'lib', 'portalClient.ts'),
  join(WEB_SRC, 'lib', 'portalError.ts'),
  join(WEB_SRC, 'hooks', 'usePortalApps.ts'),
  join(WEB_SRC, 'hooks', 'usePortalDeliveries.ts'),
  // PF-672 — the hook that returns a raw `signing_secret` from `create()`. It is
  // under this rule for exactly that reason.
  join(WEB_SRC, 'hooks', 'usePortalSubscriptions.ts'),
  join(WEB_SRC, 'hooks', 'usePortalRegistry.ts'),
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Production sources only — a test file is allowed to say the words. */
function portalSources(): { path: string; text: string }[] {
  return [...PORTAL_DIRS.flatMap(walk), ...PORTAL_FILES]
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
}

/** Comments discuss `console.log` and `setQueryData`; only code is scanned. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function offenders(pattern: RegExp): string[] {
  return portalSources()
    .filter(({ text }) => pattern.test(stripComments(text)))
    .map(({ path }) => relative(WEB_SRC, path));
}

describe('PF-669 — no portal module logs', () => {
  it('finds portal sources to scan (a passing empty scan is not a pass)', () => {
    expect(portalSources().length).toBeGreaterThanOrEqual(8);
  });

  it('contains no console.* call anywhere in the portal', () => {
    // Deliberately the WHOLE module rather than "the create/rotate path": the
    // secret is a prop passed down a tree, and tracing which components can
    // receive it is exactly the judgement call this test exists to remove.
    const found = offenders(/\bconsole\s*\.\s*\w+\s*\(/);
    expect(
      found,
      `A portal module calls console.*. The create and rotate responses carry a raw ` +
        `client_secret (PRD p.2), and p.15 names a log line as a leakage path. If you ` +
        `need diagnostics here, render them — the portal already shows request_id on ` +
        `error states.`
    ).toEqual([]);
  });
});

describe('PF-667 — no portal module writes to persisted client state', () => {
  it('never calls setQueryData, so nothing it holds can reach IndexedDB', () => {
    const found = offenders(/\bsetQueryData\s*\(|\buseMutation\s*\(|\buseQuery\s*\(/);
    expect(
      found,
      `A portal module uses TanStack query state. web/src/lib/queryClient.ts persists ` +
        `that cache to IndexedDB (createStore('ship-query-cache','queries')), and that ` +
        `store survives reload and logout — so a client_secret reaching query state is ` +
        `a secret written to disk. Portal reads use plain component state.`
    ).toEqual([]);
  });

  it('never touches localStorage, sessionStorage or indexedDB directly', () => {
    const found = offenders(/\b(localStorage|sessionStorage|indexedDB)\b/);
    expect(found).toEqual([]);
  });

  it('the secret dialog takes its value as a prop and stores it nowhere', () => {
    const dialog = readFileSync(join(HERE, 'SecretOnceDialog.tsx'), 'utf8');
    const code = stripComments(dialog);
    // The component may hold the string in a closure for the clipboard write.
    // What it must not do is hand it to anything that outlives the component.
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|setQueryData/);
    // And it must not render it into a form control a password manager saves.
    expect(code).not.toMatch(/type="password"/);
  });
});
