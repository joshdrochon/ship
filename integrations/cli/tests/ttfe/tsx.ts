/**
 * PF-608 — where the `tsx` binary actually is, resolved rather than guessed.
 *
 * ── What `npx tsx` does, and why the drill must not do it ──────────────────
 * Every spawn in this lane used to be `npx tsx <script>`. On a clean checkout —
 * which is what `pnpm install --frozen-lockfile` produces, and therefore what
 * every CI job gets — that fails:
 *
 *     sh: tsx: command not found
 *     Error: ttfe harness exited 127 before printing its ready line.
 *
 * `tsx` is a devDependency of `api`, not of the workspace root (`api/package.json`
 * "tsx": "4.21.0"). pnpm links a package's bins into ITS OWN `node_modules/.bin`,
 * so `api/node_modules/.bin/tsx` exists and `<root>/node_modules/.bin/tsx` does
 * not. `npx`, run from the repo root, finds nothing there.
 *
 * It went unnoticed for the same reason PF-608's `docker pull` did: on the
 * machine this lane was written on, `<root>/node_modules/.bin/tsx` exists as a
 * leftover from an earlier install in which tsx WAS a root dependency. A stale
 * symlink is not a dependency, and CI does not have one.
 *
 * ── Why not just let `npx` fetch it ────────────────────────────────────────
 * Because it would work, and that is the problem. Given a registry, `npx tsx`
 * silently downloads the LATEST tsx and runs the drill on it — an unpinned
 * dependency inside the one test the PRD grades, on a repo whose CI installs
 * `--frozen-lockfile` precisely so that cannot happen. A drill that measures a
 * different toolchain than the one the lockfile names is measuring something
 * nobody shipped.
 *
 * ── Why a path and not `pnpm --filter @ship/api exec tsx` ──────────────────
 * That spelling is used elsewhere in the repo (`baseline:measure`, and the
 * `regression-budget` job) and does resolve. It also sets cwd to `api/`, and
 * both callers here depend on cwd being the REPO ROOT: `scripts/ttfe/harness.ts`
 * spawns `api/src/index.ts` with `cwd: REPO_ROOT`, and PF-586's clean-directory
 * check is written against root-relative paths. Resolving the binary keeps cwd
 * under the caller's control and adds no extra process to the group the teardown
 * has to kill.
 *
 * The failure is loud on purpose. A missing binary previously surfaced as
 * "harness exited 127", which names neither the binary nor the reason — the
 * exact shape of diagnosis PF-593 exists to forbid.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where pnpm puts it, in the order worth trying. */
export function tsxCandidates(repoRoot: string): string[] {
  return [
    join(repoRoot, 'node_modules', '.bin', 'tsx'),
    join(repoRoot, 'api', 'node_modules', '.bin', 'tsx'),
  ];
}

export function resolveTsx(repoRoot: string): string {
  const candidates = tsxCandidates(repoRoot);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      'ttfe: no `tsx` binary found. Looked at:\n' +
        candidates.map((candidate) => `  · ${candidate}`).join('\n') +
        '\n\n`tsx` is a devDependency of `api`, so pnpm links it into ' +
        '`api/node_modules/.bin` and not into the workspace root. Run ' +
        '`pnpm install --frozen-lockfile` from the repo root. Do NOT fall back to ' +
        '`npx tsx`: with a registry reachable that downloads an unpinned tsx and the ' +
        'drill then measures a toolchain the lockfile does not name (PF-608).',
    );
  }
  return found;
}
