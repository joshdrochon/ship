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
/**
 * The `/api/v1` mount, excluded from the internal snapshot for the same reason
 * the SPA fallback is: it is not part of the internal `/api` surface.
 *
 * This is NOT the rail being loosened. The public router is one opaque layer
 * whose insides are asserted by `platform/api/v1/router.test.ts` against
 * `V1_MIDDLEWARE_ORDER`, and its POSITION relative to the internal middleware —
 * the thing that actually matters, and the thing findings F1 and F2 were about —
 * is asserted below by `describe('PF-214/PF-215 …')`, which is a stronger check
 * than a layer count. Leaving it in the snapshot would instead mean regenerating
 * the snapshot every time a public lane mounts anything, which is exactly how a
 * safety rail becomes a rubber stamp.
 */
const V1_MOUNT = 'api\\/v1';
/**
 * The `/oauth` mount (L04 PF-107), excluded on exactly the same grounds as
 * `/api/v1` above: it is a SIBLING of the internal `/api` surface, not part of
 * it, and by construction it shares none of its middleware.
 *
 * Same argument against leaving it in, too. Its insides are asserted by
 * `platform/oauth/consent.test.ts` and `authCodeGrant.test.ts`, and its POSITION
 * relative to the internal middleware — which is the thing that matters, and the
 * thing PF-107 is actually about — is asserted by
 * `platform/oauth/oauthBoundary.test.ts`, which drives real requests through
 * `createApp()` and checks that the internal limiter, the 10 MB body parser, the
 * v1 bearer auth and the SPA fallback each fail to reach it. That is a stronger
 * check than a layer count, and it is the check that would actually catch a
 * regression.
 *
 * NOTE FOR THE AUDIT: nothing else about this rail moved. `cookieParser` and
 * `session` are now named locals rather than inline expressions in `createApp`
 * — the same instances, in the same positions, so that the consent screen shares
 * one session store with the portal instead of constructing a second one. Layer
 * names, order and count for every internal layer are unchanged, which is what
 * the assertions below still check.
 */
const OAUTH_MOUNT = '/^\\/oauth\\/?(?=\\/|$)/i';
/** How Express compiles `app.use('/api/', …)`. Identifies the internal limiter. */
const API_PREFIX_MOUNT = '/^\\/api\\/?(?=\\/|$)/i';

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
    .filter((l) => !l.mount.includes(V1_MOUNT))
    .filter((l) => l.mount !== OAUTH_MOUNT)
    .filter((l) => !(l.name === 'serveStatic' && l.mount === ROOT_MOUNT));
}

/** The full stack, v1 mount included — for the position assertions below. */
function captureStackWithV1(): Layer[] {
  const app = createApp();
  const stack = (app as unknown as { _router: { stack: RawLayer[] } })._router.stack;
  return stack.map((l) => ({ name: l.name, path: l.route?.path ?? null, mount: String(l.regexp) }));
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

describe('PF-214 / PF-215 — where the public router sits, structurally', () => {
  // The layer-count snapshot above cannot express this, and it is the assertion
  // that actually encodes findings F1 and F2. A future refactor that moves the
  // `/api/v1` mount one line down reintroduces BOTH defects at once and would
  // otherwise sail through a regenerated snapshot.
  const indexOf = (layers: Layer[], predicate: (l: Layer) => boolean, what: string): number => {
    const i = layers.findIndex(predicate);
    expect(i, `${what} is not in the app stack at all`).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('the /api/v1 mount is ABOVE the internal rate limiter (F1)', () => {
    const layers = captureStackWithV1();
    const v1 = indexOf(layers, (l) => l.mount.includes(V1_MOUNT), 'the /api/v1 mount');
    // `express-rate-limit@8` returns an anonymous function, so the layer reports
    // `<anonymous>`; the `/api` prefix mount is what identifies it. That the name
    // is useless is itself why `namedLayer` exists on the public side.
    const limiter = indexOf(
      layers,
      (l) => l.mount === API_PREFIX_MOUNT && l.name === '<anonymous>',
      'the internal apiLimiter',
    );
    expect(
      v1,
      'The public router must be mounted ABOVE `app.use("/api/", apiLimiter)`. Below it, the ' +
        "internal limiter prefix-matches /api/v1/* and answers with the internal body " +
        '`{ error: "Too many requests. Please slow down." }`, above the public router — so no ' +
        'request_id, no envelope, no audit row. That is finding F1 (PF-214).',
    ).toBeLessThan(limiter);
  });

  it('the /api/v1 mount is ABOVE the app-wide 10 MB body parser (F2)', () => {
    const layers = captureStackWithV1();
    const v1 = indexOf(layers, (l) => l.mount.includes(V1_MOUNT), 'the /api/v1 mount');
    const parser = indexOf(layers, (l) => l.name === 'jsonParser', 'the app-wide jsonParser');
    expect(
      v1,
      'The public router must be mounted ABOVE `app.use(express.json({limit:"10mb"}))`. Below ' +
        "it, the body is already parsed by the time the public router's own 1 MB parser runs, " +
        'so the public ceiling is dead code. That is finding F2 (PF-215).',
    ).toBeLessThan(parser);
  });

  it('the /api/v1 mount is BELOW helmet — public responses still get security headers', () => {
    const layers = captureStackWithV1();
    const v1 = indexOf(layers, (l) => l.mount.includes(V1_MOUNT), 'the /api/v1 mount');
    const helmet = indexOf(layers, (l) => l.name === 'helmetMiddleware', 'helmet');
    expect(v1).toBeGreaterThan(helmet);
  });

  it('the /api/v1 mount is ABOVE session, cookieParser and every CSRF-wrapped router', () => {
    // PRD p.11: the public router shares NO middleware with the internal API.
    // Mount position is the runtime half of that promise; the ESLint fence is the
    // import half. Neither alone is sufficient.
    const layers = captureStackWithV1();
    const v1 = indexOf(layers, (l) => l.mount.includes(V1_MOUNT), 'the /api/v1 mount');
    for (const name of ['session', 'cookieParser']) {
      const i = layers.findIndex((l) => l.name === name);
      if (i >= 0) {
        expect(v1, `${name} must not be able to run before the public router`).toBeLessThan(i);
      }
    }
  });

  it('exactly ONE /api/v1 mount exists (PF-234)', () => {
    const layers = captureStackWithV1();
    expect(layers.filter((l) => l.mount.includes(V1_MOUNT))).toHaveLength(1);
  });
});
