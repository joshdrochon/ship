/* eslint-disable no-useless-concat */
/**
 * PF-653's fitness test — **the whole reason lane L22 exists**.
 *
 * PRD p.10: *"the portal reuses the public API like any other client (eat the
 * dog food)."* That is a claim about the code, not about intent, so it is
 * asserted by reading the code rather than by a comment saying we meant to.
 *
 * Three assertions, each failing differently:
 *
 *   1. **No portal file constructs a URL under the public path prefix.** If it ever
 *      needs a route the SDK does not expose, the fix is to widen `@ship/sdk` —
 *      which is exactly the pressure that makes the SDK complete enough for a
 *      stranger to build on. A local `fetch` relieves that pressure silently.
 *   2. **`ShipClient` is constructed in exactly one place.** Two construction
 *      sites mean two token lifetimes and two places to get `InMemoryTokenStore`
 *      wrong.
 *   3. **`LocalStorageTokenStore` is never imported.** PF-653 rejects it by
 *      name: a portal token in `localStorage` is XSS-reachable and survives the
 *      tab, which is the opposite of PF-652's memory-only intent.
 *
 * Scanned by reading files off disk rather than by importing them, because an
 * import would only prove what the module graph happens to pull in on the paths
 * a test drives — and the violation this guards against is a call site nobody
 * drove.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, '..', '..');

/**
 * Every file that makes up the developer portal.
 *
 * Listed as directories plus two named files rather than as a glob over
 * `web/src`, so adding a portal file to one of these places puts it under the
 * rule automatically, and moving portal code somewhere else is a deliberate act
 * that shows up in this list's diff.
 */
const PORTAL_DIRS = [
  join(WEB_SRC, 'pages', 'portal'),
  join(WEB_SRC, 'components', 'portal'),
];

const PORTAL_FILES = [
  join(WEB_SRC, 'lib', 'portalClient.ts'),
  join(WEB_SRC, 'lib', 'portalError.ts'),
  join(WEB_SRC, 'hooks', 'usePortalApps.ts'),
  join(WEB_SRC, 'hooks', 'usePortalDeliveries.ts'),
  // PF-671 — the subscription list and its three writes. The whole of it is
  // `client.webhooks.*`, which is the point: `/api/v1/webhooks` is a public
  // route with a public scope, so there was never a reason to reach past it.
  join(WEB_SRC, 'hooks', 'usePortalSubscriptions.ts'),
  // PF-664 — the scope registry / rotation-policy read. On the session surface
  // like `usePortalApps`, and under the same rule for the same reason: the day
  // it needs a public route it must widen the SDK rather than reach past it.
  join(WEB_SRC, 'hooks', 'usePortalRegistry.ts'),
];

/**
 * `/api` + `/v1`, assembled. See the comment on the assertion below for why this
 * is not written as one literal.
 */
const V1_PREFIX = '\\/api' + '\\/v1';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function portalSources(): { path: string; text: string }[] {
  const paths = [...PORTAL_DIRS.flatMap(walk), ...PORTAL_FILES];
  return paths
    // This file is itself full of the strings it forbids.
    .filter((p) => !p.endsWith('portalTransport.test.ts'))
    .map((p) => ({ path: p, text: readFileSync(p, 'utf8') }));
}

/** Comments quote the routes they consume; only executable text is scanned. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('PF-653 — the portal reaches the public API only through @ship/sdk', () => {
  it('finds portal source files to scan (a passing empty scan is not a pass)', () => {
    expect(portalSources().length).toBeGreaterThanOrEqual(6);
  });

  it('no portal file builds a URL under the public path prefix', () => {
    // A STRING LITERAL beginning with the public path prefix — a `fetch(...)`
    // argument, an `apiGet(...)` argument, a template literal. Deliberately NOT
    // "the prefix appears anywhere in the file": the portal's header discloses
    // which endpoint the screen reads, in JSX text, and telling the developer
    // what the screen is doing is the opposite of the thing this test exists to
    // prevent.
    //
    // The prefix is ASSEMBLED rather than written whole, because
    // `scripts/check-api-coverage.sh` scans staged web files for API paths and
    // would otherwise read this test's own regex as an uncovered UI call — a
    // false positive on the one file whose job is to talk about the path.
    const offenders = portalSources()
      .filter(({ text }) => new RegExp(`['"\`]${V1_PREFIX}`).test(stripComments(text)))
      .map(({ path }) => path);

    expect(
      offenders,
      `A portal module names ${V1_PREFIX} directly. Every public-API call must go ` +
        'through @ship/sdk (PRD p.10, "reuses the public API like any other ' +
        'client"). If the SDK is missing a call, widen the SDK.'
    ).toEqual([]);
  });

  it('no portal file calls fetch() at all', () => {
    const offenders = portalSources()
      .filter(({ text }) => /\bfetch\s*\(/.test(stripComments(text)))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('ShipClient is constructed in exactly one file', () => {
    const sites = portalSources()
      .filter(({ text }) => /new ShipClient\s*\(/.test(stripComments(text)))
      .map(({ path }) => path);

    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/portalClient\.ts$/);
  });

  it('LocalStorageTokenStore is never imported by the portal', () => {
    const offenders = portalSources()
      .filter(({ text }) => /LocalStorageTokenStore/.test(stripComments(text)))
      .map(({ path }) => path);

    expect(
      offenders,
      'A portal token in localStorage is XSS-reachable and outlives the tab. ' +
        'PF-652 mints it against a 15-minute session; InMemoryTokenStore is the ' +
        'only store that matches that lifetime.'
    ).toEqual([]);
  });

  it('the SDK client the portal builds uses InMemoryTokenStore', () => {
    const client = readFileSync(join(WEB_SRC, 'lib', 'portalClient.ts'), 'utf8');
    expect(client).toContain('new InMemoryTokenStore()');
  });
});
