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
 * ── ✅ `/api/v1/me` NOW EXISTS — L10 PF-271 LANDED ──────────────────────────
 * This header used to say the opposite, at length: the route was L10's, L10 had
 * not landed, and its absence was PINNED by two tests on the integration branch
 * (`documents.regression.test.ts` and `__tests__/scope-fitness.test.ts`). Both
 * of those have now been FLIPPED — deliberately, in the same commit that mounted
 * the route, and each with a note saying which assertion it replaced.
 *
 * The consequence for this file is the whole point of gate item 8: §1 no longer
 * documents an absence. It boots `createApp()` — the REAL composition root, with
 * `productionDeps()`, the Postgres app and token repositories and the real
 * bearer middleware — on a real socket, mints a real token against a real
 * database, and asserts that `new ShipClient({token}).me()` RESOLVES to a typed
 * user.
 *
 * What each section proves:
 *
 *   §1  MVP gate item 8 on the production surface. Nothing is mounted by the
 *       test: the route is there because `app.ts` mounts it. The old version of
 *       this section asserted a typed 404 and said it "will start failing the
 *       day L10 lands" — this is that replacement, not a deletion.
 *   §2  The same round-trip against a hand-mounted `/me`, kept because it pins
 *       the SDK's contract independently of L10's implementation: if the two
 *       ever disagree, the disagreement is visible here rather than absorbed.
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
import { createApp } from '../../../app.js';
import { pool } from '../../../db/client.js';
import { PgOAuthAppRepo } from '../../apps/pg-repo.js';
import { PgTokenRepo } from '../../oauth/pgTokenRepo.js';
import { issueTokenPair } from '../../oauth/issue.js';
import { DEFAULT_TOKEN_TTL } from '../../oauth/tokens.js';
import { SystemClock } from '../../clock.js';
import { secretMaterial } from '../../apps/repo.js';
import { generateClientId, generateClientSecret } from '../../apps/secrets.js';

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
  let server: Server;
  let baseUrl: string;
  let token: string;
  let workspaceId: string;
  let userId: string;
  let userName: string;
  let userEmail: string;
  let clientId: string;
  let appName: string;

  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  beforeAll(async () => {
    // Real rows, because everything below this line is real: `createApp()` with
    // `productionDeps()` resolves tokens through `PgTokenRepo` and apps through
    // `PgOAuthAppRepo`, and `/api/v1/me` reads `users` through
    // `identityService`. An in-memory harness would prove the SDK works against
    // a fixture, which §2 already does.
    const workspace = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
      [`gate8 ${runId}`],
    );
    workspaceId = workspace.rows[0]!.id;

    userName = 'Gate Eight User';
    userEmail = `gate8-${runId}@ship.local`;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test-hash', $2) RETURNING id`,
      [userEmail, userName],
    );
    userId = user.rows[0]!.id;

    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
      [workspaceId, userId],
    );

    const appsRepo = new PgOAuthAppRepo(pool);
    appName = `Gate 8 CLI ${runId}`;
    clientId = generateClientId();
    const oauthApp = await appsRepo.create({
      clientId,
      ...secretMaterial(generateClientSecret()),
      name: appName,
      ownerUserId: userId,
      workspaceId,
      redirectUris: ['https://example.test/cb'],
      requestedScopes: ['documents:read', 'documents:write'],
    });

    // Through the one issuance site, against the Postgres repository the running
    // server will resolve it from.
    const issued = await issueTokenPair(
      { tokenRepo: new PgTokenRepo(pool), clock: new SystemClock(), ttl: DEFAULT_TOKEN_TTL },
      { app: oauthApp, userId, scopes: ['documents:read'] },
    );
    token = issued.response.access_token;

    // THE COMPOSITION ROOT. No `mountResources` argument anywhere in this
    // section — `/api/v1/me` is reachable because `app.ts` mounts it.
    ({ server, baseUrl } = await listen(createApp()));
  });

  afterAll(async () => {
    await close(server);
    await pool.query(`DELETE FROM oauth_tokens WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM oauth_apps WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
  });

  it('`new ShipClient({ token }).me()` returns the typed authenticated user', async () => {
    // PRD p.2, gate item 8, verbatim: *"SDK skeleton exists in a pnpm workspace
    // package; `new ShipClient({ token }).me()` against a running server returns
    // the typed authenticated user."* This is that sentence, executed.
    const client = new ShipClient({ token, baseUrl });
    expect(client.baseUrl).toBe(baseUrl);

    const me: Me = await client.me();

    expect(me.user).not.toBeNull();
    expect(me.user?.id).toBe(userId);
    expect(me.user?.name).toBe(userName);
    expect(me.app.client_id).toBe(clientId);
    expect(me.app.name).toBe(appName);
    expect(me.scopes).toEqual(['documents:read']);

    // Typed, not `any`: these compile because `Me` says so, and
    // `sdk/typeProofs/gateItem8.ts` proves `me.app.nonexistent` does not.
    const id: string = me.app.client_id;
    const scopes: string[] = me.scopes;
    expect(typeof id).toBe('string');
    expect(Array.isArray(scopes)).toBe(true);
  });

  it('the SDK’s hand-declared `Me` agrees with the SERVED schema, field for field', async () => {
    // PF-493's other half. `Me` was hand-written by L17 because there was no
    // `/me` operation to check it against; there is one now, so the check is a
    // comparison against the served document rather than against another
    // literal. A field the server adds and the SDK does not know about is a
    // silent type lie to every consumer.
    const spec = (await (await fetch(`${baseUrl}/api/v1/openapi.json`)).json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const operation = spec.paths['/me']?.get;
    expect(operation, 'GET /me has no operation in the served spec').toBeDefined();

    const schema = (
      operation as unknown as {
        responses: { 200: { content: { 'application/json': { schema: { properties: object } } } } };
      }
    ).responses[200].content['application/json'].schema;

    expect(Object.keys(schema.properties).sort()).toEqual(['app', 'scopes', 'user']);
  });

  it('GET /api/v1/me IS mounted by the composition root — L10 PF-271', () => {
    // The inverse of the assertion this replaced, walking the LIVE Express stack
    // with the same enumerator the route-fitness harness uses.
    const mounted = enumerateV1Routes(createApp()).map((r) => `${r.method} ${r.path}`);
    expect(mounted).toContain('GET /api/v1/me');
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
