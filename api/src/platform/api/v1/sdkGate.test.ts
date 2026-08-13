/**
 * PF-492 — MVP GATE ITEM 8, against a GENUINELY RUNNING SERVER.
 *
 * PRD p.2: *"SDK skeleton exists in a pnpm workspace package;
 * `new ShipClient({ token }).me()` against a running server returns the typed
 * authenticated user."*
 *
 * ── Why this file lives in `api/` and not in `sdk/` ─────────────────────────
 * ESLint fence 4 (L99 F24) forbids `sdk/**` from importing ANYTHING in this
 * repository, so an SDK test cannot boot the server. The dependency runs the
 * only direction that is allowed: `@ship/api` takes `@ship/sdk` as a
 * devDependency and exercises it exactly as an external consumer would —
 * through the published entry point, over a real socket. That is also a
 * stronger test than the alternative, because nothing here is mocked: real
 * Express, real `createPublicRouter`, real `bearerTokenMiddleware`, real
 * tokens, real HTTP.
 *
 * ── ⚑ `/api/v1/me` DOES NOT EXIST, AND THAT IS NOT AN SDK DEFECT ────────────
 * The route is **L10's** ("Resources: Issues, Sprints, Me") and L10 has not
 * landed. It is not merely missing — its absence is PINNED by two tests already
 * on the integration branch:
 *
 *   - `documents/documents.regression.test.ts` asserts the mounted v1 route set
 *     is exactly the three `documents` routes (L13's PF-363, from the
 *     generator's side);
 *   - `__tests__/scope-fitness.test.ts` asserts no path starting `/me`,
 *     `/issues` or `/sprints` is mounted.
 *
 * So adding the route to close this gate item would break two other lanes'
 * shipped assertions. It is a two-lane change and a spine edit
 * (`Blocks on: L13, L10`), not a local one — L17's lane file says the same. It
 * is therefore reported, not stubbed.
 *
 * What this file proves instead, and what it does not:
 *
 *   §1  The production surface, honestly: `.me()` against the app as it stands
 *       today reaches the server, authenticates, and comes back as a TYPED
 *       `ShipError` — `kind: 'not_found'`. Everything L17 owns works; the route
 *       is absent. This test will start failing the day L10 lands, which is the
 *       correct signal.
 *   §2  The typed round-trip, against a `/me` mounted into the SAME
 *       `createPublicRouter` behind the SAME real bearer middleware. Every
 *       clause of gate item 8 except "the route ships in the composition root"
 *       is demonstrated: a real token, a real socket, and a resolved value whose
 *       `app.client_id`, `user` and `scopes` are populated and typed.
 *   §3  PF-494 live — the same call through a path-prefixed mount.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ShipClient, ShipError, type Me } from '@ship/sdk';
import { createBearerTestApp, type BearerTestApp } from '../../oauth/bearerTestSupport.js';
import { enumerateV1Routes } from './routeFitness.js';
import type { PlatformAuthContext } from '../../scopes/auth-context.js';

/** Boots an Express app on an ephemeral port and returns its base URL. */
async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('§1 · MVP gate item 8 against the PRODUCTION public surface', () => {
  let harness: BearerTestApp;
  let server: Server;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    harness = await createBearerTestApp();
    ({ server, baseUrl } = await listen(harness.app));
    token = (await harness.mint()).access_token;
  });

  afterAll(async () => {
    await close(server);
  });

  it('the gate expression constructs and reaches the server over a real socket', async () => {
    const client = new ShipClient({ token, baseUrl });
    expect(client.baseUrl).toBe(baseUrl);

    const error = (await client.me().catch((e: unknown) => e)) as ShipError;

    // A typed error, not a crash, not a hang, not an HTML page.
    expect(error).toBeInstanceOf(ShipError);
    expect(error.status).toBe(404);
    expect(error.kind).toBe('not_found');
    expect(error.code).toBe('not_found');
    // L07's envelope arrived intact, with the request id PF-191 guarantees.
    expect(error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('…and the reason is that GET /api/v1/me is not mounted — L10, not L17', () => {
    // Walks the LIVE Express stack rather than trusting a list, using the same
    // enumerator the route-fitness harness uses. Stated as an assertion so this
    // file fails loudly the day L10 lands, at which point §1 should be replaced
    // by the real gate assertion.
    const mounted = enumerateV1Routes(harness.app).map((r) => `${r.method} ${r.path}`);
    expect(mounted).not.toContain('GET /api/v1/me');
  });

  it('a bad token is a typed auth error carrying B14’s reason — the SDK can tell refresh from re-auth', async () => {
    const client = new ShipClient({ token: 'not-a-real-token', baseUrl });
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;

    expect(error.kind).toBe('auth');
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
    expect(error.reason).toBe('invalid');
    // Never retried: a 401 with a static token is not a transient failure.
  });

  it('no credential at all never leaves the process', async () => {
    const client = new ShipClient({ baseUrl });
    const error = (await client.me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(0);
  });
});

describe('§2 · the typed round-trip, through the real router and real bearer auth', () => {
  let harness: BearerTestApp;
  let server: Server;
  let baseUrl: string;

  /**
   * The `/me` handler, standing in for L10's route.
   *
   * It reads `res.locals.platformAuth` — the context L06's real middleware
   * populated from a real token — and shapes it exactly as the SDK's `Me`
   * declares. Nothing here is a mock: the request went through
   * `createPublicRouter`'s full stack (request id, audit, body parser, bearer
   * auth, rate limiter) before reaching it.
   */
  const mountMe = (router: Router): void => {
    router.get('/me', (_req, res) => {
      const auth = res.locals.platformAuth as PlatformAuthContext;
      res.json({
        app: { client_id: auth.clientId, name: 'L17 bearer test app' },
        user: auth.userId === null ? null : { id: auth.userId, name: 'Test User' },
        scopes: auth.scopes,
      });
    });
  };

  beforeAll(async () => {
    harness = await createBearerTestApp({ mountResources: mountMe });
    ({ server, baseUrl } = await listen(harness.app));
  });

  afterAll(async () => {
    await close(server);
  });

  it('`new ShipClient({ token, baseUrl }).me()` resolves to the typed authenticated user', async () => {
    const token = (await harness.mint(['documents:read', 'documents:write'])).access_token;

    const me: Me = await new ShipClient({ token, baseUrl }).me();

    // The three things the ticket names, all populated.
    expect(me.app.client_id).toBe(harness.oauthApp.clientId);
    expect(me.app.client_id).toMatch(/\S/);
    expect(me.user).not.toBeNull();
    expect(me.user?.id).toBe('user-1');
    expect(me.scopes).toEqual(['documents:read', 'documents:write']);

    // Typed, not `any`: these compile because `Me` says so, and
    // `sdk/typeProofs/gateItem8.ts` proves `me.app.nonexistent` does not.
    const clientId: string = me.app.client_id;
    const scopes: string[] = me.scopes;
    expect(typeof clientId).toBe('string');
    expect(Array.isArray(scopes)).toBe(true);
  });

  it('the scopes the SDK reports are the token’s, not the app’s requested set', async () => {
    const token = (await harness.mint(['issues:read'])).access_token;
    const me = await new ShipClient({ token, baseUrl }).me();
    expect(me.scopes).toEqual(['issues:read']);
    // The app asked for three; this token carries one.
    expect(harness.oauthApp.requestedScopes.length).toBeGreaterThan(1);
  });

  it('an expired token gives reason `expired` — what tells a client to REFRESH rather than re-auth', async () => {
    const token = (await harness.mint()).access_token;
    // FakeClock, not a wall-clock wait (p.11).
    harness.clock.advance((harness.ttl.accessSeconds + 60) * 1000);

    const error = (await new ShipClient({ token, baseUrl }).me().catch((e: unknown) => e)) as ShipError;
    expect(error.kind).toBe('auth');
    expect(error.code).toBe('unauthorized');
    expect(error.reason).toBe('expired');
  });
});

describe('§3 · PF-494 live — the same call behind a path prefix', () => {
  let harness: BearerTestApp;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    harness = await createBearerTestApp({
      mountResources: (router: Router) => {
        router.get('/me', (_req, res) => {
          const auth = res.locals.platformAuth as PlatformAuthContext;
          res.json({ app: { client_id: auth.clientId, name: 'n' }, user: null, scopes: auth.scopes });
        });
      },
    });

    // The deployment shape the old `new URL('/api/v1' + path, baseUrl)` 404'd
    // on: Ship mounted under a prefix behind a reverse proxy.
    const outer = express();
    outer.use('/ship', harness.app);
    ({ server, baseUrl } = await listen(outer));
  });

  afterAll(async () => {
    await close(server);
  });

  it('resolves against `http://host/ship`, which the old join silently discarded', async () => {
    const token = (await harness.mint()).access_token;
    const me = await new ShipClient({ token, baseUrl: `${baseUrl}/ship` }).me();
    expect(me.app.client_id).toBe(harness.oauthApp.clientId);
  });

  it('and the old join would have gone to the wrong place — the regression, demonstrated', async () => {
    const token = (await harness.mint()).access_token;
    // Dropping the prefix is exactly what the defect did.
    const error = (await new ShipClient({ token, baseUrl })
      .me()
      .catch((e: unknown) => e)) as ShipError;
    expect(error).toBeInstanceOf(ShipError);
    expect(error.status).toBe(404);
  });
});
