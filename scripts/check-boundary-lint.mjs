#!/usr/bin/env node
/**
 * PF-012 — prove the PlugForge boundary rules actually fire.
 *
 *     pnpm lint:boundary
 *
 * `pnpm lint` proves the tree has no violations. It cannot prove the rules that
 * would catch one are still wired up: a mis-globbed `files` entry, a later
 * config object silently overriding `no-restricted-imports`, or someone deleting
 * the block during a merge all leave `pnpm lint` green. A rule that never fires
 * is indistinguishable from a rule that is gone.
 *
 * So this runs ESLint over four deliberate violations under eslint-fixtures/ and
 * fails unless each one is rejected *by the fence that owns it* — matched on the
 * rule id and on the fence's `BOUNDARY (...)` marker, not merely on a non-zero
 * exit code. A fixture with a typo in it would otherwise "pass" this check by
 * failing to parse.
 *
 * Two controls keep the check honest in the other direction:
 *
 *   - a POSITIVE control asserts a real platform source file reports zero
 *     `no-restricted-imports` errors, so a config that rejected everything
 *     could not pass;
 *   - the workspace-dependency check (PF-011, second mechanism) reads
 *     integrations/<pkg>/package.json directly. PRD p.11 asks for the
 *     integrations fence to be "enforced by a workspace dependency rule", which
 *     is a different mechanism from an import-path lint: ESLint sees import
 *     specifiers, so it cannot see a dependency added to package.json and
 *     reached through `require()` or a dynamic import.
 *
 * Exit 0 = every fence fires and the controls hold. Exit 1 = at least one does not.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** Each fence, the fixture that violates it, and the marker that identifies it. */
const FENCES = [
  {
    ticket: 'PF-009',
    name: 'platform → routes',
    fixture: 'eslint-fixtures/platform/api/v1/imports-internal-route.ts',
    marker: 'BOUNDARY (platform → routes)',
  },
  {
    ticket: 'PF-010',
    name: 'platform → middleware',
    fixture: 'eslint-fixtures/platform/audit/imports-internal-middleware.ts',
    marker: 'BOUNDARY (platform → middleware)',
  },
  {
    ticket: 'PF-011',
    name: 'integrations → server',
    fixture: 'eslint-fixtures/integrations/imports-api-source.ts',
    marker: 'BOUNDARY (integrations → server)',
  },
  {
    ticket: 'F24',
    name: 'sdk → workspace',
    fixture: 'eslint-fixtures/sdk/imports-workspace-package.ts',
    marker: 'BOUNDARY (sdk → workspace)',
  },
];

/** A real file that must stay clean — the positive control. */
const POSITIVE_CONTROL = 'api/src/platform/webhooks/bus.ts';

/** The only runtime dependency an integration may declare. */
const ALLOWED_INTEGRATION_DEPS = new Set(['@ship/sdk']);

const failures = [];
const notes = [];

/** Run ESLint over one file and return its parsed messages. Never throws on lint errors. */
function lint(relPath) {
  let stdout;
  try {
    stdout = execFileSync(
      'npx',
      ['eslint', '--no-ignore', '--format', 'json', relPath],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    // Non-zero exit is the expected outcome for a fixture; the JSON is still on stdout.
    stdout = err.stdout ?? '';
    if (!stdout.trim()) {
      return { ok: false, messages: [], crashed: String(err.stderr ?? err.message).slice(0, 500) };
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, messages: [], crashed: `unparseable eslint output: ${stdout.slice(0, 300)}` };
  }
  const messages = parsed.flatMap((r) => r.messages ?? []);
  return { ok: true, messages, crashed: null };
}

// --- 1. every fence fires on its own fixture ---------------------------------
for (const fence of FENCES) {
  if (!existsSync(join(REPO, fence.fixture))) {
    failures.push(`${fence.ticket} (${fence.name}): fixture missing — ${fence.fixture}`);
    continue;
  }

  const { messages, crashed } = lint(fence.fixture);
  if (crashed) {
    failures.push(`${fence.ticket} (${fence.name}): eslint could not run — ${crashed}`);
    continue;
  }

  const errors = messages.filter((m) => m.severity === 2);
  if (errors.length === 0) {
    failures.push(
      `${fence.ticket} (${fence.name}): lint PASSED on ${fence.fixture}. ` +
        `The fence did not fire. Check the \`files\` glob in eslint.config.js covers the fixture path, ` +
        `and that no later config object overrides no-restricted-imports.`,
    );
    continue;
  }

  const matched = errors.filter(
    (m) => m.ruleId === 'no-restricted-imports' && (m.message ?? '').includes(fence.marker),
  );
  if (matched.length === 0) {
    failures.push(
      `${fence.ticket} (${fence.name}): ${fence.fixture} failed lint, but not for the right reason. ` +
        `Expected no-restricted-imports carrying "${fence.marker}". Got: ` +
        errors.map((m) => `${m.ruleId ?? 'parse-error'}: ${(m.message ?? '').slice(0, 80)}`).join(' | '),
    );
    continue;
  }

  notes.push(`  ok  ${fence.ticket.padEnd(7)} ${fence.name.padEnd(24)} ${matched.length} violation(s) caught`);
}

// --- 2. positive control: a real platform file stays clean --------------------
{
  const { messages, crashed } = lint(POSITIVE_CONTROL);
  if (crashed) {
    failures.push(`positive control: eslint could not run on ${POSITIVE_CONTROL} — ${crashed}`);
  } else {
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    if (restricted.length > 0) {
      failures.push(
        `positive control: ${POSITIVE_CONTROL} is a legitimate platform module and must not trip a fence. ` +
          `The fences are over-broad. Got: ${restricted.map((m) => m.message).join(' | ')}`,
      );
    } else {
      notes.push(`  ok  control ${POSITIVE_CONTROL} — clean, so the fences are not rejecting everything`);
    }
  }
}

// --- 3. workspace dependency rule (PF-011, second mechanism) -----------------
{
  const integrationsDir = join(REPO, 'integrations');
  if (!existsSync(integrationsDir)) {
    failures.push('workspace dependency rule: integrations/ does not exist');
  } else {
    const pkgs = readdirSync(integrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (pkgs.length === 0) failures.push('workspace dependency rule: no packages under integrations/');

    for (const pkg of pkgs) {
      const manifest = join(integrationsDir, pkg, 'package.json');
      if (!existsSync(manifest)) {
        failures.push(`workspace dependency rule: integrations/${pkg} has no package.json`);
        continue;
      }
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      const deps = Object.keys(json.dependencies ?? {});
      const disallowed = deps.filter((d) => !ALLOWED_INTEGRATION_DEPS.has(d));
      if (disallowed.length > 0) {
        failures.push(
          `workspace dependency rule: integrations/${pkg} declares ${disallowed.join(', ')}. ` +
            `An integration may depend on @ship/sdk and nothing else in this workspace — that is the ` +
            `whole claim being made about the front door (PRD p.11).`,
        );
      } else {
        notes.push(`  ok  PF-011  workspace deps           integrations/${pkg} → ${deps.join(', ') || '(none)'}`);
      }
    }
  }
}

// --- report -------------------------------------------------------------------
console.log('boundary-lint fitness test (PF-012)\n');
for (const n of notes) console.log(n);

if (failures.length > 0) {
  console.error('\nFAILED:\n');
  for (const f of failures) console.error(`  x  ${f}\n`);
  console.error(
    `${failures.length} boundary check(s) failed. See api/src/platform/README.md ` +
      `for the contract and eslint-fixtures/README.md for how this test works.`,
  );
  process.exit(1);
}

console.log(`\n${FENCES.length} fences verified, positive control clean, workspace deps clean.`);
