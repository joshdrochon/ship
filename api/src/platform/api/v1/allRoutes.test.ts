/**
 * The manifest in `allRoutes.ts` is checked against the filesystem.
 *
 * PRD p.11 (A4/B2): the spec is generated from route metadata. That only holds
 * if "every route module" is a fact someone can verify rather than a list
 * someone maintains. Registration happens at module load, so an import list is
 * the real definition of the public surface, and an import list that is SHORT
 * does not fail — it shrinks the surface every downstream check measures.
 *
 * `GET /api/v1/audit` is the case that proves it: it shipped with no SDK
 * binding, and `sdkSurfaceParity.test.ts` stayed green because its own import
 * list omitted the audit route. Spec side and SDK side agreed at 22 instead of
 * 23. The check that exists to catch drift was itself the thing that drifted.
 *
 * So this file does not trust the manifest. It reads the directory.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V1_ROUTE_MODULES } from './allRoutes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = join(HERE, 'allRoutes.ts');

/** Every `api/v1/<resource>/routes.ts` that exists on disk, by directory name. */
function routeModulesOnDisk(): string[] {
  return readdirSync(HERE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(HERE, name, 'routes.ts')))
    .sort();
}

/** The `import './<name>/routes.js'` lines actually present in the manifest. */
function importedInManifest(): string[] {
  const source = readFileSync(MANIFEST_FILE, 'utf8');
  const found = [...source.matchAll(/^import '\.\/([^/']+)\/routes\.js';$/gm)];
  return found.map((match) => match[1] as string).sort();
}

describe('the /api/v1 route manifest is complete', () => {
  it('the walk found route modules at all — it cannot pass by finding none', () => {
    // Without this, a rename of the directory layout turns every assertion
    // below into a comparison of two empty arrays, which is the same vacuous
    // pass this file exists to prevent.
    expect(
      routeModulesOnDisk().length,
      `no api/v1/<resource>/routes.ts was found under ${HERE}. Either the layout moved and ` +
        `this test needs to follow it, or the walk is broken — and a broken walk here makes ` +
        `every check below pass on an empty set.`,
    ).toBeGreaterThan(0);
  });

  it('every route module on disk is in V1_ROUTE_MODULES', () => {
    const missing = routeModulesOnDisk().filter(
      (name) => !(V1_ROUTE_MODULES as readonly string[]).includes(name),
    );

    expect(
      missing,
      `${missing.length} route module(s) exist on disk but are absent from the manifest in ` +
        `allRoutes.ts: ${missing.join(', ')}. Their operations are therefore missing from ` +
        `docs/openapi.json, from staticCopy.test.ts's comparison, and from ` +
        `sdkSurfaceParity.test.ts's spec walk — which means the SDK is not required to have ` +
        `a binding for them and the parity suite stays green at a smaller number. Add an ` +
        `import line AND a name in allRoutes.ts.`,
    ).toEqual([]);
  });

  it('every name in V1_ROUTE_MODULES exists on disk', () => {
    const onDisk = new Set(routeModulesOnDisk());
    const phantom = V1_ROUTE_MODULES.filter((name) => !onDisk.has(name));

    expect(
      phantom,
      `the manifest names ${phantom.join(', ')}, which has no routes.ts. A stale entry is a ` +
        `resource someone believes is published.`,
    ).toEqual([]);
  });

  it('every name in V1_ROUTE_MODULES has a real import line — the array alone loads nothing', () => {
    // The array is a claim; the `import` statements are what actually register
    // the operations. An entry with no import would make the manifest assert
    // coverage it does not provide, and the two lists sit ten lines apart where
    // that is easy to do.
    const imported = new Set(importedInManifest());
    const unimported = V1_ROUTE_MODULES.filter((name) => !imported.has(name));

    expect(
      unimported,
      `${unimported.join(', ')} appear(s) in V1_ROUTE_MODULES but has no ` +
        `\`import './<name>/routes.js';\` line in allRoutes.ts. Nothing loads the module, so ` +
        `nothing registers its operations — the manifest would be claiming a surface it does ` +
        `not deliver.`,
    ).toEqual([]);
  });

  it('and the import lines name nothing the array omits', () => {
    const listed = new Set<string>(V1_ROUTE_MODULES);
    const unlisted = importedInManifest().filter((name) => !listed.has(name));
    expect(unlisted, `imported but not listed in V1_ROUTE_MODULES: ${unlisted.join(', ')}`).toEqual(
      [],
    );
  });

  it('the audit route specifically is in the manifest — this is the regression', () => {
    // Named on purpose. A general assertion that passes today would also have
    // passed on the day the audit route was omitted, because at that point the
    // manifest did not exist. This pins the case that got through.
    expect(V1_ROUTE_MODULES).toContain('audit');
  });
});
