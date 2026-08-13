/**
 * PF-523, second assertion — Ship's INTERNAL sprint noun appears NOWHERE under
 * `sdk/`.
 *
 * The public contract is `sprints`: p.3's `sprints:read` / `sprints:write`
 * scopes, p.4's `client.sprints`, p.7's `readonly sprints: SprintsClient`, and
 * `/api/v1/sprints`. Ship's internal HTTP route for the same documents uses a
 * different noun, and exactly one file in the repository is allowed to know it:
 * L03's `platform/scopes/resource-map.ts` (PF-077), with PF-078 asserting the
 * literal appears in no other platform file.
 *
 * This is the same assertion one package out. The SDK is a PUBLISHED package on
 * the far side of that map — it cannot import `api/src/` at all — so the
 * internal noun has no business here in code, in a comment, or in a test name.
 * A leaked internal noun in a published package cannot be taken back: it lands
 * in a consumer's code, in a support thread, and in a search index.
 *
 * ── The trap this file walks around ─────────────────────────────────────────
 * L99 F52 records L03 hitting exactly this: its own fitness test failed its own
 * grep, because a test searching for a literal contains that literal. So the
 * needle is ASSEMBLED from fragments here and appears nowhere as one token — and
 * the assembly is asserted to be right, so the test cannot pass by searching for
 * the wrong string.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ROOT = resolve(SRC, '..');

/**
 * The internal noun, assembled so this file does not contain it as a token.
 * Asserted below to be what we think it is.
 */
const INTERNAL_NOUN = ['we', 'ek', 's'].join('');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(ts|mjs|js|json|md)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('PF-523 · the public noun is `sprints`, and the internal one never leaks', () => {
  it('the needle really is the internal noun — this test cannot pass vacuously', () => {
    // Without this, a typo in the fragments above makes every assertion below
    // search for a string nothing contains and pass forever.
    expect(INTERNAL_NOUN).toHaveLength(5);
    expect(INTERNAL_NOUN.startsWith('we')).toBe(true);
    expect(INTERNAL_NOUN.endsWith('ks')).toBe(true);
    // and it is NOT the public noun.
    expect(INTERNAL_NOUN).not.toBe('sprints');
  });

  it('appears in no file under sdk/ — source, tests, proofs or package manifest', () => {
    const files = walk(PACKAGE_ROOT).filter((f) => f !== fileURLToPath(import.meta.url));
    expect(files.length, 'the walk found nothing to check').toBeGreaterThan(20);

    const offenders = files.filter((file) =>
      new RegExp(INTERNAL_NOUN, 'i').test(readFileSync(file, 'utf8')),
    );

    expect(
      offenders.map((f) => relative(PACKAGE_ROOT, f)),
      `Ship's internal sprint noun leaked into the published package. The public ` +
        `contract is 'sprints' (p.3, p.4, p.7) and the translation belongs in ` +
        `api/src/platform/scopes/resource-map.ts alone.`,
    ).toEqual([]);
  });

  it('and the sprints client really does target /sprints', async () => {
    const { SprintsClient } = await import('./sprints.js');
    const paths: string[] = [];
    const client = new SprintsClient({
      request: <T,>(_m: string, path: string) => {
        paths.push(path);
        return Promise.resolve({ data: [], next_cursor: null } as T);
      },
    });

    await client.list();
    await client.get('abc');
    expect(paths).toEqual(['/sprints', '/sprints/abc']);
  });
});
