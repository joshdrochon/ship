/**
 * PF-018 — the internal `/api` middleware stack is unchanged by the PlugForge
 * composition-root refactor.
 *
 * This is a safety rail, not a unit test. `createApp(deps = productionDeps())`
 * (PF-014) rewrites the signature of the file that assembles the entire Part 1
 * application. If that refactor moves a middleware, drops one, or reorders the
 * session/CSRF pair, every downstream measurement this week is taken against a
 * different application than the one the baseline describes — and the +10%
 * regression budget (PRD p.2, p.6) measures nothing.
 *
 * Two independent assertions, because they fail differently:
 *
 *   1. The ordered app-level middleware stack matches a snapshot captured from
 *      the pre-refactor `createApp`. Order is the whole point: `helmet` before
 *      the routers, the rate limiter before the body parser, `session` before
 *      `conditionalCsrf`, and CSRF before every state-changing router. A diff
 *      here names the exact position that moved.
 *
 *   2. `api/src/middleware/auth.ts` is byte-for-byte what it was, pinned by
 *      SHA-256. The ticket says "diff on api/src/middleware/auth.ts is empty",
 *      and `git diff` cannot express that once the branch is merged — a content
 *      hash can, forever.
 *
 * The second assertion also pins the coupling F26 depends on (lane-99):
 * `app.ts:73` skips CSRF on any `Authorization: Bearer` header, which is safe
 * only because `auth.ts:135` does not fall back to session auth on an invalid
 * bearer. Nothing else in the repo holds those two files together. If a future
 * change adds that fallback, this hash breaks and someone has to look at why.
 *
 * When a change to the internal stack is genuinely intended, regenerate:
 *   pnpm --filter @ship/api exec vitest run internal-middleware-stack -u
 * and say in the PR body which layer moved and why. Regenerating without that
 * sentence is how a safety rail becomes a rubber stamp.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, 'internal-middleware-stack.snapshot.json');
const AUTH_PATH = join(HERE, '..', 'middleware', 'auth.ts');

/** Express mounts a path-less `app.use(fn)` with this regexp. */
const ROOT_MOUNT = '/^\\/?(?=\\/|$)/i';
/** Distinctive fragment of the SPA fallback route's regexp. */
const SPA_FALLBACK = '(?!api';

interface Layer {
  name: string;
  path: string | null;
  mount: string;
}

interface Snapshot {
  _comment: string;
  authMiddlewareSha256: string;
  layerCount: number;
  layers: Layer[];
}

/**
 * The ordered app-level stack, minus the two layers that exist only when a built
 * frontend happens to be on disk.
 *
 * `api/src/app.ts` mounts `express.static(webDist)` and the SPA fallback inside
 * `if (existsSync(webDist))`. Whether `web/dist` exists differs between a
 * developer who has run `pnpm build` and one who has not, and between CI jobs.
 * Including them would make this snapshot fail for a reason that has nothing to
 * do with the middleware stack. They are not part of the internal `/api`
 * surface, so they are excluded here rather than allowed to make the rail flaky.
 */
function captureStack(): Layer[] {
  const app = createApp();
  // Express 4 exposes the router stack here. Untyped by @types/express on purpose;
  // this test is deliberately reaching into an internal to observe assembly order.
  const stack = (app as unknown as { _router: { stack: RawLayer[] } })._router.stack;

  return stack
    .map((l) => ({ name: l.name, path: l.route?.path ?? null, mount: String(l.regexp) }))
    .filter((l) => !l.mount.includes(SPA_FALLBACK))
    .filter((l) => !(l.name === 'serveStatic' && l.mount === ROOT_MOUNT));
}

interface RawLayer {
  name: string;
  regexp: RegExp;
  route?: { path: string };
}

function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
}

describe('PF-018 · internal /api middleware stack is unchanged', () => {
  it('assembles the same ordered middleware stack as before the refactor', () => {
    const actual = captureStack();
    const expected = loadSnapshot();

    // Regenerate on `vitest -u`, so an intended change is one command and a
    // reviewable diff rather than a hand-edited JSON file.
    if (process.env.VITEST_UPDATE_SNAPSHOTS === 'true' || process.argv.includes('-u')) {
      writeFileSync(
        SNAPSHOT_PATH,
        JSON.stringify(
          {
            _comment: expected._comment,
            authMiddlewareSha256: createHash('sha256').update(readFileSync(AUTH_PATH)).digest('hex'),
            layerCount: actual.length,
            layers: actual,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    // Compare counts first: a length mismatch produces a readable message,
    // where a deep-equal on 76 objects produces a wall of JSON.
    expect(
      actual.length,
      `Layer count changed: ${expected.layerCount} -> ${actual.length}. ` +
        `A middleware or router was added to or removed from createApp(). The internal ` +
        `/api stack must stay byte-for-byte what Part 1 shipped (PRD p.3).`,
    ).toBe(expected.layerCount);

    for (let i = 0; i < expected.layers.length; i++) {
      const want = expected.layers[i]!;
      const got = actual[i]!;
      expect(
        `${got.name} @ ${got.path ?? got.mount}`,
        `Middleware position ${i} changed: expected "${want.name} @ ${want.path ?? want.mount}", ` +
          `got "${got.name} @ ${got.path ?? got.mount}". Order is the contract here — ` +
          `session before CSRF, CSRF before every state-changing router.`,
      ).toBe(`${want.name} @ ${want.path ?? want.mount}`);
    }
  });

  it('leaves api/src/middleware/auth.ts byte-for-byte unchanged', () => {
    const expected = loadSnapshot();
    const actual = createHash('sha256').update(readFileSync(AUTH_PATH)).digest('hex');

    expect(
      actual,
      `api/src/middleware/auth.ts changed (sha256 ${expected.authMiddlewareSha256} -> ${actual}).\n\n` +
        `The internal session/CSRF stack is out of scope for PlugForge (PRD p.3), and this ` +
        `file also holds a coupling nothing else pins: app.ts:73 skips CSRF for any Bearer ` +
        `header, which is only safe because this file does NOT fall back to session auth on ` +
        `an invalid bearer (lane-99 F26). If the change is intended, say so in the PR body and ` +
        `regenerate with \`vitest run internal-middleware-stack -u\`.`,
    ).toBe(expected.authMiddlewareSha256);
  });
});
