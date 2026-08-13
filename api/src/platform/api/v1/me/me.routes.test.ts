/**
 * `GET /api/v1/me` — PF-271 through PF-275.
 *
 * Everything here runs against the REAL bearer middleware over a REAL database,
 * through `createBearerTestApp`. L07's `createTestPublicApp` stubs bearer auth,
 * which is right for testing the envelope and cannot test PF-273 at all: the
 * claim "`me` resolves from the token and never from a session" is a claim about
 * which middleware answered, and a stub answers it by fiat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { pool } from '../../../../db/client.js';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { createIdentityService } from '../../../../services/identity.js';
import { mountMe } from './routes.js';
import { meSchema, REJECTED_INTERNAL_ME_FIELDS } from './me.schema.js';

const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

let harness: BearerTestApp;
let workspaceId: string;
let userId: string;
let otherUserId: string;
let userEmail: string;

beforeAll(async () => {
  const workspace = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ($1) RETURNING id`,
    [`L10 me ${runId}`],
  );
  workspaceId = workspace.rows[0]!.id;

  userEmail = `l10-me-${runId}@ship.local`;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name, is_super_admin)
     VALUES ($1, 'test-hash', 'Me Route User', true) RETURNING id`,
    [userEmail],
  );
  userId = user.rows[0]!.id;

  // A second user in the same workspace, for PF-273's "user A never returns
  // user B" case. `is_super_admin` is set on the FIRST user deliberately: if the
  // public projection ever leaked the flag, the leak would be visible rather
  // than silently `false`.
  const other = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, 'test-hash', 'Other User') RETURNING id`,
    [`l10-me-other-${runId}@ship.local`],
  );
  otherUserId = other.rows[0]!.id;

  await pool.query(
    `INSERT INTO workspace_memberships (workspace_id, user_id, role)
     VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
    [workspaceId, userId, otherUserId],
  );

  harness = await createBearerTestApp({
    workspaceId,
    userId,
    mountResources: (router) =>
      mountMe(router, {
        db: pool,
        service: createIdentityService(),
        appsRepo: harnessAppsRepo(),
      }),
  });
});

/**
 * The apps repository the route reads the app NAME from.
 *
 * `createBearerTestApp` builds its own `InMemoryOAuthAppRepo` and registers the
 * app in it before calling `mountResources`, so this closure resolves to the
 * same instance the bearer middleware authenticated against. Passing a fresh
 * repository would make `findById` miss and turn every request into the 500 the
 * route raises for a vanished app.
 */
function harnessAppsRepo() {
  return {
    findById: (id: string) => harness.appsRepo.findById(id),
  } as unknown as Parameters<typeof mountMe>[1]['appsRepo'];
}

afterAll(async () => {
  await pool.query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [workspaceId]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userId, otherUserId]]);
  await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
});

describe('PF-272 · the body is a public schema, not /api/auth/me’s', () => {
  it('deep-equals the declared schema, with no extra keys', async () => {
    const token = (await harness.mint(['documents:read'])).access_token;

    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);

    // `.strict()` throughout, so a parse that succeeds IS the deep-equality
    // claim: an extra key anywhere in the tree fails it.
    const parsed = meSchema.safeParse(res.body);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error?.issues),
    ).toBe(true);

    expect(res.body.user).toEqual({
      id: userId,
      email: userEmail,
      name: 'Me Route User',
      workspace_id: workspaceId,
    });
  });

  it('the string `success` appears nowhere in the serialized body', async () => {
    // The internal endpoint's envelope is `{success: true, data: {...}}`
    // (`api/src/routes/auth.ts:296`). Asserted over the RAW TEXT rather than by
    // key lookup, because a nested wrapper at any depth is the same defect and a
    // top-level `toHaveProperty` check would miss it.
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.text).not.toContain('success');
  });

  it('carries none of the internal fields, by name', async () => {
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    for (const field of REJECTED_INTERNAL_ME_FIELDS) {
      expect(res.text, `the public body contains "${field}"`).not.toContain(field);
    }
  });

  it('does not leak is_super_admin even though the fixture user has it set', async () => {
    // Belt to the braces above: the flag is TRUE on this user, so a projection
    // that passed the column through would show `true` here rather than a
    // harmless default.
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    const stored = await pool.query<{ is_super_admin: boolean }>(
      `SELECT is_super_admin FROM users WHERE id = $1`,
      [userId],
    );
    expect(stored.rows[0]!.is_super_admin, 'fixture precondition').toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('true');
  });
});

describe('PF-273 · identity comes from the token, never from a session', () => {
  it('a valid session cookie with NO bearer token is 401', async () => {
    // The session stack is not in this router at all (PF-211), so this is a
    // property of the composition. The cookie below is a REAL row — an
    // implementation that fell back to sessions would authenticate it.
    const sessionId = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO sessions (id, user_id, workspace_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [sessionId, userId, workspaceId],
    );

    try {
      const res = await request(harness.app)
        .get('/api/v1/me')
        .set('Cookie', `session_id=${sessionId}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.details.reason).toBe('missing');
    } finally {
      await pool.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
    }
  });

  it('a bearer token returns the user the token was issued for', async () => {
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(userId);
  });

  it('a token issued for user A never returns user B, whatever the query says', async () => {
    // `?user_id=` is a 422 before it can be read (PF-275's allowlist), which is
    // the stronger outcome: the parameter cannot be honoured because it cannot
    // reach the handler.
    const token = (await harness.mint()).access_token;

    const res = await request(harness.app)
      .get(`/api/v1/me?user_id=${otherUserId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('user_id');

    // And with the parameter removed, still user A.
    const clean = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);
    expect(clean.body.user.id).toBe(userId);
    expect(clean.body.user.id).not.toBe(otherUserId);
  });

  it('a token for the OTHER user returns the other user — the route reads the token', async () => {
    // The assertion that catches a handler hard-coding the workspace owner: a
    // second harness whose tokens carry a different `userId`, against the same
    // route module.
    const otherHarness = await createBearerTestApp({
      workspaceId,
      userId: otherUserId,
      mountResources: (router) =>
        mountMe(router, {
          db: pool,
          service: createIdentityService(),
          appsRepo: {
            findById: (id: string) => otherHarness.appsRepo.findById(id),
          } as unknown as Parameters<typeof mountMe>[1]['appsRepo'],
        }),
    });

    const token = (await otherHarness.mint()).access_token;
    const res = await request(otherHarness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(otherUserId);
    expect(res.body.user.name).toBe('Other User');
  });
});

describe('PF-271 · no scope required, and no eighth scope invented', () => {
  it('a token with an EMPTY scope array reaches me and gets 200', async () => {
    // The case an eighth scope would have broken, and the case
    // `requireScope('documents:read')` would have broken differently. A
    // webhooks-only app — or one mid-consent with nothing granted yet — can
    // still discover who it is.
    const token = (await harness.mint([])).access_token;

    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.scopes).toEqual([]);
  });

  it('a token with an unrelated scope also gets 200', async () => {
    const token = (await harness.mint(['issues:read'])).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.scopes).toEqual(['issues:read']);
  });
});

describe('PF-274 · the acting app and the granted scopes', () => {
  it('scopes deep-equal the TOKEN’s grant, not the app’s requested set', async () => {
    const granted = ['documents:read', 'documents:write'] as const;
    const token = (await harness.mint([...granted])).access_token;

    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.body.scopes).toEqual([...granted]);
    // The app requested three; this token carries two. If the route reported the
    // app's requested set, a CLI would print a permission the token does not
    // have and the user would see a 403 for something they were told they could
    // do.
    expect(harness.oauthApp.requestedScopes).toHaveLength(3);
    expect(res.body.scopes).not.toEqual([...harness.oauthApp.requestedScopes]);
  });

  it('every reported scope is one the registry knows', async () => {
    const { scopeRegistry } = await import('../../../scopes/scopes.js');
    const token = (await harness.mint(['documents:read', 'issues:read'])).access_token;

    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    // `Set<string>`, not `Set<Scope>`: the whole point is to check an untrusted
    // wire value against the registry, and a set typed as the union would make
    // the lookup a compile error instead of the runtime check it needs to be.
    const registered = new Set<string>(scopeRegistry.list().map((s) => s.scope));
    for (const scope of res.body.scopes as string[]) {
      expect(registered.has(scope), `${scope} is not registered`).toBe(true);
    }
  });

  it('the app object is client_id and name, and carries no secret', async () => {
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(Object.keys(res.body.app).sort()).toEqual(['client_id', 'name']);
    expect(res.body.app.client_id).toBe(harness.oauthApp.clientId);
    expect(res.body.app.name).toBe(harness.oauthApp.name);

    // By name, and by value. The stored hash is a real string on the fixture
    // app, so a spread of the app row would put it in the body verbatim.
    expect(res.text).not.toContain('client_secret');
    expect(harness.oauthApp.clientSecretHash, 'fixture precondition').toBeTruthy();
    expect(res.text).not.toContain(harness.oauthApp.clientSecretHash);
  });
});

describe('PF-275 · not a collection, and no query parameters', () => {
  it('the body has no next_cursor key at all — not a null one', async () => {
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect('next_cursor' in res.body).toBe(false);
  });

  it('?limit=1 is REJECTED, not silently ignored', async () => {
    // The heart of the ticket. `assertAllowedQueryParams` in `page.ts` allows
    // `limit` unconditionally because every route it was written for is a list;
    // on a route that returns one object, accepting-and-ignoring it is the
    // silent success PF-226's decision exists to prevent.
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me?limit=1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields).toEqual([
      { field: 'limit', message: expect.stringContaining('no query parameters') },
    ]);
  });

  it('?cursor= is rejected too — a cursor from another collection means nothing here', async () => {
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me?cursor=abc')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('cursor');
  });

  it('every unknown parameter is named, not just the first', async () => {
    const token = (await harness.mint()).access_token;
    const res = await request(harness.app)
      .get('/api/v1/me?offset=1&fields=id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
    expect((res.body.details.fields as { field: string }[]).map((f) => f.field).sort()).toEqual([
      'fields',
      'offset',
    ]);
  });
});

describe('the failure envelope is L07’s, on every path', () => {
  it('no Authorization header → 401 ApiError with a request id', async () => {
    const res = await request(harness.app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['www-authenticate']).toBeTruthy();
  });

  it('an expired token → 401 with reason `expired`, which tells an SDK to refresh', async () => {
    // Its OWN harness, so advancing the clock cannot reach back into the shared
    // one and expire tokens for the cases above. A `FakeClock`, not a wall-clock
    // wait (p.11).
    const expiring = await createBearerTestApp({
      workspaceId,
      userId,
      mountResources: (router) =>
        mountMe(router, {
          db: pool,
          service: createIdentityService(),
          appsRepo: {
            findById: (id: string) => expiring.appsRepo.findById(id),
          } as unknown as Parameters<typeof mountMe>[1]['appsRepo'],
        }),
    });

    const token = (await expiring.mint()).access_token;
    expiring.clock.advance((expiring.ttl.accessSeconds + 60) * 1000);

    const res = await request(expiring.app)
      .get('/api/v1/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.details.reason).toBe('expired');
  });
});
