#!/usr/bin/env node
/**
 * PF-586 — `pnpm drill ttfe`, the invocation p.6 names literally.
 *
 *     "pnpm drill ttfe runs the full loop end-to-end against a containerized
 *      Ship instance from a clean working directory."
 *
 * ── Clean working directory is ASSERTED, not assumed ───────────────────────
 * The drill runs on a fresh checkout with no `pnpm dev` first, no
 * `api/.env.local`, no seeded database and nothing already listening. Two of
 * those are checked here, before a container is started, because discovering
 * them 40 seconds in produces a confusing failure:
 *
 *   - `DATABASE_URL` in the environment is refused (PF-587). The harness
 *     provisions and DROPS a database; adopting an inherited one risks running
 *     that teardown against a dev or deployed database.
 *   - `api/.env.local` is reported, because `api/src/index.ts` loads it and a
 *     value in it silently becomes part of the measurement.
 *
 * ── Modes (PF-589 / PF-590) ────────────────────────────────────────────────
 *   pnpm drill ttfe            fast mode  — packed tarball, warm store, < 60 s
 *   pnpm drill ttfe --clean    clean mode — cold container, no repo mount, <= 30 min
 *
 * The two figures land in the same artifact carrying a `mode` field, so they
 * can never be reported as each other.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const argv = process.argv.slice(2);
const target = argv[0];
const clean = argv.includes('--clean');
const controls = argv.includes('--controls');

if (target !== 'ttfe') {
  process.stderr.write(
    'usage: pnpm drill ttfe [--clean] [--controls]\n\n' +
      '  ttfe            the Time-to-First-Event drill (PRD p.6, the signature challenge)\n' +
      '  --clean         cold container, no repo mount, empty pnpm store (p.8, <= 30 min)\n' +
      '  --controls      the negative controls instead of the loop: PF-607 (the drill goes\n' +
      '                  red for the right reason) and PF-587 (refuses a foreign DATABASE_URL,\n' +
      '                  two concurrent runs do not collide, nothing survives teardown)\n',
  );
  process.exit(2);
}

const problems = [];
if (process.env.DATABASE_URL) {
  problems.push(
    'DATABASE_URL is set. The drill provisions its own throwaway database and drops it at ' +
      'teardown (PF-587); it will not adopt one it did not create. Unset it, or set ' +
      'TTFE_POSTGRES_ADMIN_URL to a server on which the harness may CREATE its own.',
  );
}
if (existsSync(join(REPO_ROOT, 'api', '.env.local'))) {
  problems.push(
    'api/.env.local exists. api/src/index.ts loads it, so values in it become part of the ' +
      'measurement and "clean working directory" (p.6) is no longer true. Move it aside.',
  );
}
if (problems.length > 0) {
  process.stderr.write(`\nttfe: refusing to start — the working directory is not clean.\n\n`);
  for (const problem of problems) process.stderr.write(`  · ${problem}\n\n`);
  process.exit(2);
}

// PF-590. `--clean` is a DIFFERENT PROGRAM, not a flag on the fast path, and
// that is deliberate: the fast drill is a vitest spec that imports this
// repository's test support and drives L19's exported CLI commands, and neither
// of those exists inside a container with no repo mounted. Sharing the entry
// point while sharing none of the mechanism is how `--clean` would quietly
// become the fast mode wearing a different name.
if (clean) {
  if (controls) {
    process.stderr.write('ttfe: --clean and --controls are separate runs; pass one.\n');
    process.exit(2);
  }
  const cleanRun = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'ttfe', 'clean-runner.mjs')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, TTFE_MODE: 'clean' },
  });
  process.exit(cleanRun.status ?? 1);
}

// The controls run as a SEPARATE invocation, never alongside the loop: they boot
// two extra Ship instances and run the SDK suite, and folding that into the same
// process would inflate the very number p.8 grades.
const specs = controls ? ['tests/ttfe.negative.drill.ts'] : ['tests/ttfe.drill.ts'];

const started = Date.now();
const result = spawnSync(
  'pnpm',
  ['--filter', '@ship/cli', 'exec', 'vitest', 'run', '--config', 'vitest.drill.config.ts', ...specs],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, TTFE_MODE: clean ? 'clean' : 'fast' },
  },
);

// PF-604: the JOB's own wall clock, distinct from the drill's graded total. The
// difference between them is what CI pays for and the developer does not wait
// for — the container, the migrations, the server boot.
process.stderr.write(`\nttfe: job wall clock ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
process.exit(result.status ?? 1);
