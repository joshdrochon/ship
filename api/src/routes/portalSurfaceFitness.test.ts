/**
 * PF-652's fitness test — the portal's privileged surface is EXACTLY one route.
 *
 * The lane's whole architectural claim (PF-651) is that the portal is a
 * `/api/v1` client except for one ownership-gated token mint. That claim decays
 * the first time someone adds "just one more" internal route because a public
 * one was inconvenient — and the second route is always the cheap one to add,
 * which is why the guard is mechanical rather than a review convention.
 *
 * Two assertions:
 *
 *   1. `routes/portal.ts` declares exactly one route, and it is the token mint.
 *   2. That module contains no route returning webhook, delivery or
 *      subscription data. Those three are what `/api/v1` already serves, so an
 *      internal copy would mean the portal was reading around the public API on
 *      the very data Testing Scenario 8 (p.5) grades it on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL_SOURCE = join(HERE, 'portal.ts');

/** Comments quote route paths; only executable text is scanned. */
function code(): string {
  return readFileSync(PORTAL_SOURCE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('PF-652 — the portal has exactly one privileged internal route', () => {
  it('declares one route, and it is the token mint', () => {
    const declarations = [...code().matchAll(/router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)];
    expect(declarations.map((m) => `${m[1]} ${m[2]}`)).toEqual(['post /:id/portal-token']);
  });

  it('serves no webhook, delivery or subscription data from the internal surface', () => {
    const text = code();
    for (const forbidden of ['webhook', 'delivery', 'deliveries', 'subscription']) {
      expect(
        text.toLowerCase().includes(forbidden),
        `routes/portal.ts mentions "${forbidden}" in executable code. That data is ` +
          `served by /api/v1 and the portal must read it through @ship/sdk — an ` +
          `internal copy would make PRD p.10's "reuses the public API like any ` +
          `other client" false, and would make Testing Scenario 8 prove nothing ` +
          `about the public contract.`
      ).toBe(false);
    }
  });

  it('the mint is session-only — it rejects bearer auth before authenticating', () => {
    expect(code()).toContain('rejectBearerAuth');
    expect(code()).toMatch(/router\.use\(rejectBearerAuth\)/);
  });
});
