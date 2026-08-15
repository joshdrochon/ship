/**
 * PF-723 — the drill's first token pair comes from a REAL grant.
 *
 * *"A drill seeded with hand-made tokens measures the drill, not the platform."*
 * So there is no fixture pair anywhere in this package: every credential the
 * drill spends was minted by `/oauth/device/code` → `/oauth/device/verify` →
 * `/oauth/token`, driven by the SDK's own `runDeviceLogin`.
 *
 * The device grant rather than the auth-code grant because it is the cheapest
 * flow from a headless process: no browser, no redirect URI, no loopback
 * listener — just a code, an out-of-band approval, and a poll.
 *
 * ── The approval is somebody else's subprocess ─────────────────────────────
 * `scripts/l19-device-approve.ts` is the human-with-a-browser. It lives outside
 * `integrations/` because it needs `DATABASE_URL`, and p.11 says this tree
 * imports only `@ship/sdk`. Running it as a SUBPROCESS makes "the drill has no
 * privileged path" true by construction rather than true by an import list
 * nobody re-reads. Exactly the split L19's harness uses, reused rather than
 * re-invented.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeviceLogin, type StoredTokens } from '@ship/sdk';

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REPO_ROOT = dirname(dirname(dirname(PACKAGE_ROOT)));

/**
 * PF-608 — `tsx` is a devDependency of `api`, so pnpm links it into
 * `api/node_modules/.bin` and NOT into the workspace root. `npx tsx` from the
 * root therefore resolves nothing on a clean `pnpm install --frozen-lockfile`
 * checkout, and every test in this drill that logs in died with
 * `approval subprocess exited 127: sh: tsx: command not found`. Given a
 * reachable registry it is worse: `npx` downloads an unpinned tsx and the drill
 * measures a toolchain the lockfile does not name.
 *
 * Duplicated rather than imported — `integrations/` imports only `@ship/sdk`
 * (p.11) and the fence runs both ways. The long form lives in
 * `integrations/cli/tests/ttfe/tsx.ts`.
 */
function resolveTsx(): string {
  const candidates = [
    join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    join(REPO_ROOT, 'api', 'node_modules', '.bin', 'tsx'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      'no `tsx` binary found. Looked at:\n' +
        candidates.map((candidate) => `  \u00b7 ${candidate}`).join('\n') +
        '\n\nRun `pnpm install --frozen-lockfile` from the repo root.',
    );
  }
  return found;
}


function approve(userCode: string, baseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      resolveTsx(),
      [
        join(REPO_ROOT, 'scripts', 'l19-device-approve.ts'),
        '--user-code',
        userCode,
        '--base-url',
        baseUrl,
        '--decision',
        'allow',
      ],
      { env: { ...process.env }, cwd: REPO_ROOT },
    );
    let output = '';
    child.stdout.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (output += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`the approval subprocess exited ${code}:\n${output}`)),
    );
  });
}

/**
 * A real token pair.
 *
 * `runDeviceLogin` is started but NOT awaited before the approval runs: the
 * grant only becomes approvable once the server has issued the code, and the
 * SDK is polling for it in the meantime. Awaiting first would deadlock — the
 * poll would never see an approval that had not been made yet.
 */
export async function realTokenPair(baseUrl: string, clientId: string, scopes: string[]): Promise<StoredTokens> {
  let seen: { code: string } | null = null;
  let announce: (() => void) | null = null;
  const codeArrived = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const flow = runDeviceLogin({
    baseUrl,
    clientId,
    scopes,
    onUserCode: (code) => {
      seen = { code };
      announce?.();
    },
  });

  await codeArrived;
  const userCode = (seen as { code: string } | null)?.code;
  if (userCode === undefined) throw new Error('the SDK reported no user code');

  await approve(userCode, baseUrl);
  const result = await flow;
  return result.tokens;
}
