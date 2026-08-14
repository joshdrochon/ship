/**
 * PF-716 / PF-717 — the WORKSPACE DEPENDENCY RULE, as one definition.
 *
 * PRD p.11, Critical Guidance: *"External integrations live in integrations/ and
 * import only @ship/sdk — never api/src/. Enforced by a workspace dependency
 * rule."* p.18 separately names the lint rule. They are two mechanisms and they
 * catch different things:
 *
 *   ESLint          sees import SPECIFIERS. It cannot see a dependency that has
 *                   been declared, installed and hoisted but not yet imported,
 *                   and it cannot see one reached through `require()` or a
 *                   computed dynamic import.
 *   this module     reads the MANIFESTS. It cannot see an import at all.
 *
 * Neither subsumes the other, which is why PF-717 runs this as its own blocking
 * job BEFORE lint rather than folding it into `pnpm lint`.
 *
 * ── What the rule actually forbids, and what it deliberately does not ───────
 * PF-716's criterion is about SHIP-INTERNAL packages, not about third-party
 * ones: *"Third-party runtime deps are fine (`@slack/bolt`, `express`);
 * Ship-internal packages are not."* An integration is a stranger, and strangers
 * install npm packages. What makes the front-door claim true is that the only
 * door into THIS repository is `@ship/sdk`.
 *
 * So a violation is any dependency that is either
 *
 *   - named `@ship/…` and is not `@ship/sdk`, or
 *   - versioned `workspace:…` and is not `@ship/sdk`
 *
 * The second clause is the one that matters in practice: `"@ship/api": "*"` is
 * caught by the first, and `"some-local-pkg": "workspace:*"` — a package in this
 * repo that has not adopted the `@ship/` prefix — is caught only by the second.
 *
 * ── The one devDependency exception, stated rather than smuggled ────────────
 * PF-721 requires *exactly one* signed-delivery listener implementation across
 * `integrations/**`, imported by every webhook-receiving integration. One
 * implementation shared by two packages is a workspace dependency by
 * construction, so the rule has to say something about it rather than be quietly
 * bent.
 *
 * It is allowed in `devDependencies` and nowhere else. The runtime claim — "this
 * process reaches Ship only through the front door" — is a claim about
 * `dependencies`; a test fixture is not on that path and never ships. And the
 * testkit is itself an integration package under this same rule, so it cannot
 * launder an `api/src` import through the exception: its own manifest is checked
 * with the same predicate, with no exception of its own.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The only Ship-internal RUNTIME dependency an integration may declare. */
export const ALLOWED_INTEGRATION_DEPS = new Set(['@ship/sdk']);

/**
 * The only Ship-internal DEV dependencies an integration may declare.
 *
 * `@ship/integration-testkit` is PF-721's single shared listener. Adding a name
 * here is a deliberate act with a ticket behind it, which is the point of the
 * list being a list.
 */
export const ALLOWED_INTEGRATION_DEV_DEPS = new Set([
  '@ship/sdk',
  '@ship/integration-testkit',
]);

/** Marks a dependency as belonging to this repository rather than to npm. */
export function isShipInternal(name, version) {
  return name.startsWith('@ship/') || String(version ?? '').startsWith('workspace:');
}

/**
 * Every integration package, found by walking for `package.json` rather than by
 * listing one level.
 *
 * `integrations/drills/refresh-rotation` is two levels deep — the drills are a
 * group, not a package — and a scanner that reads only `integrations/*` would
 * silently skip both drills. Silently skipping is the failure mode this whole
 * file exists to prevent, so the walk is recursive and bounded by `node_modules`
 * / `dist` rather than by depth.
 */
export function findIntegrationPackages(repoRoot) {
  const root = join(repoRoot, 'integrations');
  if (!existsSync(root)) return [];

  const found = [];
  const walk = (dir) => {
    if (existsSync(join(dir, 'package.json'))) {
      found.push({
        dir,
        name: relative(join(repoRoot, 'integrations'), dir).split(/[\\/]/).join('/'),
        manifestPath: join(dir, 'package.json'),
      });
      // A package does not contain another package in this tree. Stop here so a
      // vendored copy under a package cannot register itself as an integration.
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(join(dir, entry.name));
    }
  };
  walk(root);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Applies the rule to one manifest.
 *
 * Returns `{ violations: string[], deps: string[] }` — never throws on a
 * violation, so a caller can report every offending package in one pass instead
 * of one per run.
 */
export function checkManifest(manifestPath, label = manifestPath) {
  const violations = [];
  let json;
  try {
    json = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { violations: [`${label}: package.json is unreadable — ${String(err)}`], deps: [] };
  }

  const runtime = Object.entries(json.dependencies ?? {});
  const dev = Object.entries(json.devDependencies ?? {});

  for (const [name, version] of runtime) {
    if (!isShipInternal(name, version)) continue; // third-party is fine (PF-716)
    if (!ALLOWED_INTEGRATION_DEPS.has(name)) {
      violations.push(
        `${label}: declares "${name}": "${version}" in dependencies. An integration's only ` +
          `Ship-internal runtime dependency may be @ship/sdk — that is the front-door claim ` +
          `PRD p.11 makes, and a declared dependency is reachable through require() and ` +
          `dynamic import without ESLint ever seeing a specifier.`,
      );
    }
  }

  for (const [name, version] of dev) {
    if (!isShipInternal(name, version)) continue;
    if (!ALLOWED_INTEGRATION_DEV_DEPS.has(name)) {
      violations.push(
        `${label}: declares "${name}": "${version}" in devDependencies. The only Ship-internal ` +
          `dev dependencies permitted are ${[...ALLOWED_INTEGRATION_DEV_DEPS].join(', ')} ` +
          `(PF-721's shared listener). See scripts/lib/integration-packages.mjs.`,
      );
    }
  }

  const sdk = (json.dependencies ?? {})['@ship/sdk'];
  if (sdk === undefined) {
    violations.push(
      `${label}: does not declare "@ship/sdk": "workspace:*" in dependencies. Every integration ` +
        `is a consumer of the public SDK; one that declares no dependency on it is either not an ` +
        `integration or is reaching Ship some other way.`,
    );
  } else if (!String(sdk).startsWith('workspace:')) {
    violations.push(
      `${label}: declares "@ship/sdk": "${sdk}". Inside this monorepo it must be "workspace:*", ` +
        `or the package resolves to a published copy and the boundary proves nothing about this tree.`,
    );
  }

  return { violations, deps: runtime.map(([n]) => n) };
}

/** The whole tree. `{ ok, violations, checked }`. */
export function checkIntegrationsTree(repoRoot) {
  const packages = findIntegrationPackages(repoRoot);
  const violations = [];
  if (packages.length === 0) {
    violations.push('integrations/: no packages found. The tree should hold at least the CLI.');
  }
  for (const pkg of packages) {
    violations.push(...checkManifest(pkg.manifestPath, `integrations/${pkg.name}`).violations);
  }
  return { ok: violations.length === 0, violations, checked: packages };
}

/** Directory sizes vary; this keeps the report aligned without a formatter dep. */
export function pad(text, width) {
  return String(text).padEnd(width);
}

/** Only used by the self-test below; exported so the checker can reuse it. */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
