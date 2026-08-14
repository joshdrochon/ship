/**
 * PF-589 / PF-594 — a REAL install of the PACKED artifact, into an empty
 * directory outside the workspace.
 *
 * ── The decision, and why it is not the trade the PRD frames it as ─────────
 * Pre-Search 3.2 (p.17) asks: full `pnpm install` in a fresh container, or a
 * workspace symlink with the install step mocked? Which proves more, and which
 * is fast enough for CI? Those are only a trade if there is ONE mode. There are
 * two (PF-590), so the answer is a real install in both.
 *
 * A workspace symlink resolves `sdk/src` through tsconfig `paths` and therefore
 * never executes the published artifact. The `exports` map, the `files`
 * allowlist, the built `dist/` and peer-dependency resolution all go untested,
 * and each is a live way `pnpm install @ship/sdk` fails for a stranger while CI
 * is green. L99's F14 is exactly that class of bug — `verifyWebhook`
 * top-level-imports `node:crypto`, found independently by two lanes, invisible
 * to every test that imported source.
 *
 * The residual honesty gap, stated rather than hidden: this installs from a
 * LOCAL TARBALL, so registry resolution and network variance are exercised only
 * by `--clean` (PF-590). A local Verdaccio would close that and costs a
 * container; it buys coverage of npm's availability, not of ours.
 *
 * ── Three assertions, not one (p.8's Install row) ──────────────────────────
 *   (a) resolves AND evaluates — different failures; F14 fails only the second.
 *   (b) `tsc --noEmit` over a two-line consumer resolves the package's `types`
 *       entry: *"types load in editor"* is checkable only as "the declaration
 *       files resolve for a consumer outside the workspace".
 *   (c) the installer's own captured output carries no peer-dependency warning.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  all: string;
}

export function exec(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: REPO_ROOT },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env ?? process.env, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // `execFile` puts the exit code in `error.code` as a NUMBER for a
        // process that ran and failed, and a STRING (`ENOENT`, `EACCES`) when
        // the process could not be spawned at all. Those are different events:
        // "tsc reported errors" is a result the caller asserts on, "there is no
        // tsc" is a broken environment and must not be reported as an exit code.
        const raw: unknown = error === null ? 0 : (error as NodeJS.ErrnoException).code;
        if (typeof raw === 'string') {
          reject(error ?? new Error(`${command} could not be spawned: ${raw}`));
          return;
        }
        const code = typeof raw === 'number' ? raw : 1;
        resolve({ code, stdout, stderr, all: `${stdout}\n${stderr}` });
      },
    );
  });
}

export interface InstalledSdk {
  /** The directory the tarball was installed into. Outside the workspace. */
  dir: string;
  /**
   * A one-line ESM shim inside the install directory that does
   * `export * from '@ship/sdk'`.
   *
   * The drill imports THIS, never `node_modules/@ship/sdk/dist/index.js`
   * directly, and the difference is the whole point of PF-589. Importing the
   * built file by path bypasses the `exports` map completely: the first version
   * of this did exactly that, and PF-607's negative control — an `exports` map
   * pointed at the wrong build — stayed green through it. A bare specifier
   * resolved from a file inside the install directory is the only import that
   * makes Node consult the manifest the way a stranger's `import` does.
   */
  entryUrl: string;
  tarball: string;
  /** Everything the packer and the installer printed — PF-594(c) reads this. */
  installerOutput: string;
  dispose: () => void;
}

/**
 * The words pnpm/npm use when a peer dependency is unmet. p.8 asks for *"no
 * peer-dependency errors"*, asserted on captured output rather than eyeballed.
 */
export const PEER_DEPENDENCY_MARKERS = [
  'unmet peer dependency',
  'peer dep missing',
  'ERESOLVE',
  'could not resolve dependency',
] as const;

export function hasPeerDependencyComplaint(output: string): boolean {
  const lower = output.toLowerCase();
  return PEER_DEPENDENCY_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}

/**
 * `pnpm pack` the SDK and install the tarball into an empty directory in the OS
 * temp dir.
 *
 * The temp dir matters: anywhere under the repo and pnpm finds
 * `pnpm-workspace.yaml`, links `@ship/sdk` from `sdk/` and quietly turns this
 * back into the symlink mode the decision above rejects.
 *
 * `patchTarball` exists for PF-607's negative control — a fixture that breaks
 * exactly one thing in the packed artifact — and is unused by the drill proper.
 */
export async function packAndInstallSdk(options?: {
  patchPackageJson?: (manifest: Record<string, unknown>) => void;
}): Promise<InstalledSdk> {
  const dir = mkdtempSync(join(tmpdir(), 'ttfe-install-'));
  const packDir = join(dir, 'artifact');
  mkdirSync(packDir);

  const packed = await exec('pnpm', ['pack', '--pack-destination', packDir], {
    cwd: join(REPO_ROOT, 'sdk'),
  });
  if (packed.code !== 0) {
    throw new Error(`pnpm pack failed (${packed.code}):\n${packed.all}`);
  }
  const tarballName = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  if (tarballName === undefined) {
    throw new Error(`pnpm pack produced no tarball in ${packDir}:\n${packed.all}`);
  }
  let tarball = join(packDir, tarballName);

  if (options?.patchPackageJson !== undefined) {
    tarball = await repackWithPatchedManifest(tarball, packDir, options.patchPackageJson);
  }

  const consumer = join(dir, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'ttfe-consumer', version: '0.0.0', type: 'module', private: true }, null, 2),
  );

  const installed = await exec(
    'pnpm',
    ['add', tarball, '--ignore-workspace', '--reporter=append-only', '--config.confirmModulesPurge=false'],
    { cwd: consumer },
  );
  if (installed.code !== 0) {
    throw new Error(`pnpm add ${tarballName} failed (${installed.code}):\n${installed.all}`);
  }

  // The bare specifier, resolved from inside the install directory — see the
  // note on `entryUrl`. `.mjs` so it is ESM regardless of the consumer manifest.
  writeFileSync(join(consumer, 'probe.mjs'), "export * from '@ship/sdk';\n");

  return {
    dir: consumer,
    entryUrl: new URL('./probe.mjs', `file://${consumer}/`).href,
    tarball,
    installerOutput: `${packed.all}\n${installed.all}`,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * PF-594(b) — `tsc --noEmit` over a two-line consumer file in the install
 * directory.
 *
 * The compiler comes from the repo's own `node_modules/.bin`; the TYPES come
 * from the install directory, because that is what `moduleResolution: bundler`
 * plus a cwd of `consumer` resolves. Installing TypeScript into the throwaway
 * directory would cost ~10 s of the 60 s budget to prove something about npm
 * rather than about `@ship/sdk`.
 */
export async function typeCheckConsumer(installed: InstalledSdk): Promise<CommandResult> {
  writeFileSync(
    join(installed.dir, 'consumer.ts'),
    [
      "import { ShipClient, verifyWebhook } from '@ship/sdk';",
      'export const probe: [typeof ShipClient, typeof verifyWebhook] = [ShipClient, verifyWebhook];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(installed.dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    ),
  );

  return exec(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: installed.dir,
  });
}

/** PF-607's fixture: repack the artifact with exactly one thing broken. */
async function repackWithPatchedManifest(
  tarball: string,
  packDir: string,
  patch: (manifest: Record<string, unknown>) => void,
): Promise<string> {
  const extracted = join(packDir, 'unpacked');
  mkdirSync(extracted, { recursive: true });
  const untarred = await exec('tar', ['-xzf', tarball, '-C', extracted], { cwd: packDir });
  if (untarred.code !== 0) throw new Error(`tar -x failed:\n${untarred.all}`);

  const manifestPath = join(extracted, 'package', 'package.json');
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  patch(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const patchedName = 'ship-sdk-patched.tgz';
  const repacked = await exec('tar', ['-czf', join(packDir, patchedName), 'package'], {
    cwd: extracted,
  });
  if (repacked.code !== 0) throw new Error(`tar -c failed:\n${repacked.all}`);
  return join(packDir, patchedName);
}
