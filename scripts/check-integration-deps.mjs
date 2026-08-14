#!/usr/bin/env node
/**
 * PF-717 — the workspace dependency rule as a BLOCKING CHECK OF ITS OWN.
 *
 *     pnpm check:integration-deps
 *
 * Runs before `pnpm lint` in CI, deliberately. PRD p.11 names a *workspace
 * dependency rule* and p.18 names the *lint rule*; the two catch different
 * things and neither subsumes the other. A dependency can be declared,
 * installed and hoisted — and reached through `require()` or a computed dynamic
 * import — before a single static `import` statement exists for ESLint to see.
 *
 * The predicate itself lives in `scripts/lib/integration-packages.mjs`, so
 * `pnpm lint:boundary` (PF-012) and this job cannot drift into two slightly
 * different rules.
 *
 * ── Section 2 is why this file is not just a loop ───────────────────────────
 * A checker that never rejects anything is indistinguishable from a checker
 * that is broken, and the tree is green by construction on the day it ships. So
 * the run also applies the same predicate to fixture manifests under
 * `eslint-fixtures/integration-manifests/`, each of which violates the rule in a
 * different way, and FAILS if any of them is accepted.
 *
 * Those fixtures are real `package.json` files that pnpm must never install:
 * they live outside `integrations/` for exactly that reason, and
 * `pnpm-workspace.yaml`'s globs do not reach them.
 *
 * Exit 0 = every integration manifest is clean AND every fixture is rejected.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_INTEGRATION_DEPS,
  ALLOWED_INTEGRATION_DEV_DEPS,
  checkIntegrationsTree,
  checkManifest,
} from './lib/integration-packages.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_ROOT = join(REPO, 'eslint-fixtures', 'integration-manifests');

const failures = [];
const notes = [];

// --- 1. every real integration manifest obeys the rule ------------------------
{
  const { violations, checked } = checkIntegrationsTree(REPO);
  failures.push(...violations);
  for (const pkg of checked) {
    notes.push(`  ok  integrations/${pkg.name}`);
  }
  if (checked.length > 0) {
    notes.push(`      ${checked.length} integration package(s) checked`);
  }
}

// --- 2. anti-vacuity: each fixture manifest must be REJECTED ------------------
{
  if (!existsSync(FIXTURE_ROOT)) {
    failures.push(
      `anti-vacuity: ${FIXTURE_ROOT} does not exist. Without the fixtures this check ` +
        `cannot demonstrate that it rejects anything.`,
    );
  } else {
    const fixtures = readdirSync(FIXTURE_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    if (fixtures.length === 0) {
      failures.push(`anti-vacuity: no fixture manifests under ${FIXTURE_ROOT}.`);
    }

    // A fixture named `ok-*` is a POSITIVE control and must be ACCEPTED. Without
    // one, "reject everything" would pass every assertion in this section — and
    // an over-broad rule is worse than a missing one here, because the next
    // integration that legitimately needs `express` would route around it.
    let negatives = 0;
    for (const name of fixtures) {
      const manifest = join(FIXTURE_ROOT, name, 'package.json');
      if (!existsSync(manifest)) {
        failures.push(`anti-vacuity: fixture ${name} has no package.json`);
        continue;
      }
      const { violations } = checkManifest(manifest, `fixture:${name}`);
      const shouldPass = name.startsWith('ok-');

      if (shouldPass && violations.length > 0) {
        failures.push(
          `positive control: fixture ${name} was REJECTED and must not be. The rule is ` +
            `over-broad. Got: ${violations.join(' | ')}`,
        );
      } else if (shouldPass) {
        notes.push(`  ok  control ${name} accepted — third-party runtime deps are not violations`);
      } else if (violations.length === 0) {
        failures.push(
          `anti-vacuity: fixture ${name} was ACCEPTED. It exists to be rejected — the rule ` +
            `no longer catches the violation it encodes. See ${manifest}.`,
        );
      } else {
        negatives += 1;
        notes.push(`  ok  fixture ${name} rejected`);
      }
    }
    if (negatives === 0) {
      failures.push(
        'anti-vacuity: not a single negative fixture was rejected. A check that rejects nothing ' +
          'is indistinguishable from a check that is gone.',
      );
    }
  }
}

// --- report -------------------------------------------------------------------
console.log('workspace dependency rule (PF-716 / PF-717)\n');
console.log(
  `  runtime allowlist: ${[...ALLOWED_INTEGRATION_DEPS].join(', ')}\n` +
    `  dev allowlist:     ${[...ALLOWED_INTEGRATION_DEV_DEPS].join(', ')}\n`,
);
for (const n of notes) console.log(n);

if (failures.length > 0) {
  console.error('\nFAILED:\n');
  for (const f of failures) console.error(`  x  ${f}\n`);
  console.error(
    `${failures.length} workspace-dependency violation(s). PRD p.11: integrations/ imports only ` +
      `@ship/sdk. See integrations/README.md.`,
  );
  process.exit(1);
}

console.log('\nAll integration manifests clean; every fixture manifest rejected.');
