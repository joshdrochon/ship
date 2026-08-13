/**
 * PF-498 (c) and PF-499 — the SDK's code list is key-equal to the SERVER's, and
 * the comment that used to lie about the mapping is gone.
 *
 * ── Why this reads a file instead of importing one ──────────────────────────
 * L07's PF-189 says *"L17 imports this, does not restate it."* The SDK cannot.
 * ESLint fence 4 (L99 F24) forbids `sdk/**` from importing anything in this
 * repository, because a workspace import compiles here and breaks on
 * `npm install @ship/sdk`; and an `@ship/api` dependency would blow the p.9
 * < 250 KB budget besides.
 *
 * What the SDK CAN do is what this file does: a test — which ships in neither
 * package's `dist` and imports nothing across the fence — reads L07's source as
 * TEXT and asserts the two key sets are string-equal. `readFileSync` is not an
 * import, so the fence does not fire and the guarantee is still real.
 *
 * If the audit prefers a genuinely shared source of truth, the only clean home
 * is `shared/` — today a types package that `api` and `web` depend on. Adding
 * `sdk` to that list is a bigger call than this lane should make alone, so it is
 * FLAGGED rather than quietly done. What is not acceptable is the SDK importing
 * the API, and that is the option this file exists to avoid.
 *
 * Adding a seventh server code fails this suite BY NAME.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KIND_BY_CODE, SHIP_API_ERROR_CODES, SHIP_UNAUTHORIZED_REASONS } from './errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ERRORS = resolve(HERE, '../../api/src/platform/api/v1/errors.ts');
const SDK_ERRORS = resolve(HERE, './errors.ts');

function readServerSource(): string {
  try {
    return readFileSync(SERVER_ERRORS, 'utf8');
  } catch {
    throw new Error(
      `Could not read L07's error module at ${SERVER_ERRORS}. This test asserts the SDK's ` +
        `code list matches the server's; if the file moved, re-point the path — do NOT delete ` +
        `the assertion, because the drift it catches is a published-contract break.`,
    );
  }
}

/** Pulls the members out of a `export const NAME = [ 'a', 'b' ] as const;` declaration. */
function readStringArray(source: string, name: string): string[] {
  const match = new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`, 's').exec(source);
  if (!match?.[1]) {
    throw new Error(
      `${name} is no longer declared as an inline array literal in ${SERVER_ERRORS}. ` +
        `Update this parser rather than dropping the parity assertion.`,
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('PF-498 (c) · the SDK key set string-equals L07’s API_ERROR_CODES', () => {
  it('same members, same order', () => {
    const server = readStringArray(readServerSource(), 'API_ERROR_CODES');
    expect(server).toHaveLength(6);
    expect([...SHIP_API_ERROR_CODES]).toEqual(server);
  });

  it('the SDK’s map is keyed by exactly those six codes — a seventh fails by name', () => {
    const server = readStringArray(readServerSource(), 'API_ERROR_CODES');
    const sdkKeys = Object.keys(KIND_BY_CODE).sort();
    expect(sdkKeys).toEqual([...server].sort());
  });

  it('the server’s own published SDK_KIND_BY_CODE agrees with ours, entry for entry', () => {
    const source = readServerSource();
    // L07 publishes its view of the mapping. Two independent statements of the
    // same 6→5 relation; this asserts they have not drifted.
    const block = /export const SDK_KIND_BY_CODE[^=]*=\s*\{([^}]*)\}/s.exec(source)?.[1];
    expect(block, 'SDK_KIND_BY_CODE not found in L07’s errors.ts').toBeTruthy();
    const serverMap = Object.fromEntries(
      [...(block as string).matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
    );
    expect(serverMap).toEqual(KIND_BY_CODE);
  });

  it('B14’s UNAUTHORIZED_REASONS enum matches too — it is what splits refresh from re-auth', () => {
    const server = readStringArray(readServerSource(), 'UNAUTHORIZED_REASONS');
    expect([...SHIP_UNAUTHORIZED_REASONS]).toEqual(server);
  });
});

describe('PF-499 · the false 1:1 claim is gone, and the collapse is stated', () => {
  const sdkSource = readFileSync(SDK_ERRORS, 'utf8');
  // Comments wrap. Normalising whitespace (and the leading ` * ` of each JSDoc
  // line) is what lets the assertion be about the SENTENCE rather than about
  // where the author's editor happened to break the line.
  const prose = sdkSource.replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ');

  it('the false claim is not in the file', () => {
    expect(prose).not.toMatch(/Maps 1:1/i);
    expect(prose).not.toMatch(/1:1 from the server/i);
  });

  it('the header names the collapse and BOTH codes involved', () => {
    // The acceptance criterion is not "some comment exists" — it is that a
    // reader learns which two codes collapse, because believing `kind` can be
    // used where `code` is meant is the exact mistake PF-500 prevents.
    expect(prose).toMatch(/6\s*→\s*5|6→5/);
    expect(prose).toMatch(/`unauthorized` and `forbidden` both collapse to `kind: 'auth'`/);
  });
});
