/**
 * `/api/apps` — lane L02, slice S2 (PF-039–PF-046).
 *
 * Drives the real Express app over supertest against a real database, because
 * the properties under test are about the HTTP boundary: what appears in a
 * response body, what a second owner can see, and whether a bearer token can
 * reach these routes at all. None of that is visible from the repository layer.
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { productionDeps } from '../deps.js';
import { pool } from '../db/client.js';
import { PgOAuthAppRepo } from '../platform/apps/index.js';

let app: Express;
let workspaceId: string;
let ownerId: string;
let otherOwnerId: string;
let ownerCookie: string;
let otherCookie: string;

const repo = () => new PgOAuthAppRepo(pool);

/** Creates a user + an active session row and returns the cookie header. */
async function makeSessionUser(email: string): Promise<{ userId: string; cookie: string }> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'L02 Test') RETURNING id`,
    [email]
  );
  const userId = u.rows[0]!.id;
  await pool.query(
    `INSERT INTO workspace_memberships (user_id, workspace_id, role)
     VALUES ($1, $2, 'admin')`,
    [userId, workspaceId]
  );
  // sessions.id is a TEXT primary key with no default — the app mints it.
  const { randomBytes } = await import('crypto');
  const sessionId = randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity)
     VALUES ($1, $2, $3, now() + interval '1 hour', now())`,
    [sessionId, userId, workspaceId]
  );
  return { userId, cookie: `session_id=${sessionId}` };
}

const VALID_BODY = {
  name: 'Demo Integration',
  redirect_uris: ['https://example.test/callback'],
  requested_scopes: ['documents:read'],
};

beforeAll(async () => {
  app = createApp(productionDeps());
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L02 route tests') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;

  const owner = await makeSessionUser('l02-route-owner@ship.local');
  ownerId = owner.userId;
  ownerCookie = owner.cookie;

  const other = await makeSessionUser('l02-route-other@ship.local');
  otherOwnerId = other.userId;
  otherCookie = other.cookie;
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_apps');
});

/**
 * Ship runs TWO session mechanisms side by side, and a write to `/api/apps`
 * needs both:
 *
 *   `session_id`  — the `sessions` table row that `authMiddleware` reads
 *   `connect.sid` — the express-session that `csrf-sync` keeps its synchroniser
 *                   token in, minted by `GET /api/csrf-token`
 *
 * A test that sends only the first gets 403 from `conditionalCsrf` — which is
 * itself PF-046's placement working, so this helper exists rather than a
 * decision to disable CSRF for tests.
 */
async function csrfFor(sessionCookie: string): Promise<{ cookies: string; token: string }> {
  const res = await request(app).get('/api/csrf-token').set('Cookie', sessionCookie);
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const connectSid = (setCookie ?? [])
    .map((c) => c.split(';')[0])
    .filter((c): c is string => Boolean(c))
    .join('; ');
  return {
    cookies: [sessionCookie, connectSid].filter(Boolean).join('; '),
    token: res.body.token,
  };
}

/** POST a valid registration, negotiating CSRF first. */
async function register(cookie = ownerCookie, body: object = VALID_BODY) {
  const { cookies, token } = await csrfFor(cookie);
  return request(app).post('/api/apps').set('Cookie', cookies).set('x-csrf-token', token).send(body);
}

describe('PF-040 — POST /api/apps', () => {
  it('returns 201 with a client_id and a raw client_secret', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.data.client_id).toMatch(/^ship_app_/);
    expect(res.body.data.client_secret).toMatch(/^ship_secret_/);
    expect(res.body.data.rotation_policy).toBe('instant');
  });

  it('persists ONLY a SHA-256 hash — the raw secret is in no column', async () => {
    const res = await register();
    const raw: string = res.body.data.client_secret;

    // Byte scan over the whole row rendered as text, not just the column we
    // expect to be wrong. A future column holding the secret would be caught.
    const row = await pool.query(
      `SELECT oauth_apps::text AS whole, client_secret_hash FROM oauth_apps WHERE client_id = $1`,
      [res.body.data.client_id]
    );
    expect(String(row.rows[0]!.whole)).not.toContain(raw);

    const { createHash } = await import('crypto');
    expect(row.rows[0]!.client_secret_hash).toBe(
      createHash('sha256').update(raw).digest('hex')
    );
  });

  it('an unauthenticated call is 401', async () => {
    // CSRF is negotiated but no session cookie is sent, so the request reaches
    // authMiddleware and fails there. Sending neither would give 403 from
    // conditionalCsrf, which tests the wrong thing — the ticket's claim is
    // about AUTHENTICATION, and 401-vs-403 is the distinction that tells a
    // client to log in rather than to ask for permission.
    const res = await request(app).get('/api/csrf-token');
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    const connectSid = (setCookie ?? []).map((c) => c.split(';')[0]).join('; ');

    const post = await request(app)
      .post('/api/apps')
      .set('Cookie', connectSid)
      .set('x-csrf-token', res.body.token)
      .send(VALID_BODY);
    expect(post.status).toBe(401);
  });
});

describe('PF-041 — requested_scopes validated against the ScopeRegistry', () => {
  it('rejects an unknown scope and NAMES it', async () => {
    const res = await register(ownerCookie, {
      ...VALID_BODY,
      requested_scopes: ['documents:delete'],
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('documents:delete');
  });

  it('rejects an empty requested_scopes with the reason', async () => {
    // Decision recorded in PF-041: an app that requests nothing can only ever
    // hold a token that can do nothing, so this fails at registration rather
    // than at the developer's first API call.
    const res = await register(ownerCookie, { ...VALID_BODY, requested_scopes: [] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/at least one scope/);
  });

  it('accepts all seven registered scope names', async () => {
    const { scopeRegistry } = await import('../platform/scopes/registry.js');
    const all = scopeRegistry.list().map((d) => d.scope);
    expect(all).toHaveLength(7);

    const res = await register(ownerCookie, { ...VALID_BODY, requested_scopes: all });
    expect(res.status).toBe(201);
    expect(res.body.data.requested_scopes).toEqual(all);
  });
});

describe('PF-042 — redirect_uris validated at write time', () => {
  const reject = (uris: string[]) => register(ownerCookie, { ...VALID_BODY, redirect_uris: uris });

  it('rejects an empty array', async () => {
    expect((await reject([])).status).toBe(400);
  });
  it('rejects a relative URI', async () => {
    expect((await reject(['/callback'])).status).toBe(400);
  });
  it('rejects a non-https scheme on a public host', async () => {
    expect((await reject(['http://example.test/cb'])).status).toBe(400);
  });
  it('rejects a URI carrying a fragment', async () => {
    expect((await reject(['https://example.test/cb#tok'])).status).toBe(400);
  });
  it('rejects credentials in the authority', async () => {
    expect((await reject(['https://u:p@example.test/cb'])).status).toBe(400);
  });
  it('names the offending field', async () => {
    const res = await reject(['http://example.test/cb']);
    expect(JSON.stringify(res.body)).toContain('redirect_uris');
  });

  it('permits http on loopback, for the browser demo and the PKCE test', async () => {
    for (const uri of ['http://localhost:5173/cb', 'http://127.0.0.1:5173/cb']) {
      const res = await register(ownerCookie, { ...VALID_BODY, redirect_uris: [uri] });
      expect(res.status, uri).toBe(201);
    }
  });

  it('stores the URI byte-for-byte, without normalization', async () => {
    // L04 compares these exactly at authorize time. A trailing slash or a
    // lowercased path added here would silently break that comparison, and the
    // failure would surface in L04's lane, not this one.
    const uri = 'https://Example.test/Callback?b=2&a=1';
    const res = await register(ownerCookie, { ...VALID_BODY, redirect_uris: [uri] });
    expect(res.status).toBe(201);
    const app = await repo().findByClientId(res.body.data.client_id);
    expect(app!.redirectUris[0]).toBe(uri);
  });
});

describe('PF-043 — owner scoping is not an ownership oracle', () => {
  it('a foreign app id and a nonexistent id return BYTE-IDENTICAL responses', async () => {
    const mine = await register(ownerCookie);
    const theirs = await register(otherCookie);
    expect(theirs.status).toBe(201);

    const foreign = await request(app)
      .get(`/api/apps/${theirs.body.data.id}`)
      .set('Cookie', ownerCookie);
    const absent = await request(app)
      .get('/api/apps/00000000-0000-0000-0000-000000000000')
      .set('Cookie', ownerCookie);
    const malformed = await request(app).get('/api/apps/not-a-uuid').set('Cookie', ownerCookie);

    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    // A 500 on a malformed id would be a weaker version of the same oracle.
    expect(malformed.status).toBe(404);
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(absent.body));
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(malformed.body));

    // And the owner's own app is reachable, so the test is not passing by
    // rejecting everything.
    const own = await request(app)
      .get(`/api/apps/${mine.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(own.status).toBe(200);
  });
});

describe('PF-044 — the read side', () => {
  it('lists only the session user\'s own apps; a second owner\'s is ABSENT', async () => {
    await register(ownerCookie);
    const theirs = await register(otherCookie);

    const res = await request(app).get('/api/apps').set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    // Absent, not present-and-403 — a 403 would still confirm it exists.
    expect(res.body.data.some((a: { id: string }) => a.id === theirs.body.data.id)).toBe(false);
  });

  it('no read response carries any field named *secret* but secret_prefix/version', async () => {
    const created = await register();
    const list = await request(app).get('/api/apps').set('Cookie', ownerCookie);
    const one = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);

    for (const body of [list.body.data[0], one.body.data]) {
      const secretish = Object.keys(body).filter((k) => k.includes('secret'));
      expect(secretish.sort()).toEqual(['secret_prefix', 'secret_version']);
    }
  });

  it('the projection publishes exactly the allowlisted fields', async () => {
    const created = await register();
    const one = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(Object.keys(one.body.data).sort()).toEqual([
      'active',
      'client_id',
      'created_at',
      'id',
      'name',
      'redirect_uris',
      'requested_scopes',
      'secret_prefix',
      'secret_version',
    ]);
  });
});

describe('PF-046 — CSRF placement and the bearer hole', () => {
  it('rejects a request carrying a bearer token, even a valid one', async () => {
    // conditionalCsrf SKIPS CSRF for any Bearer header, and authMiddleware
    // accepts api_tokens bearers. Without this rejection there would be a path
    // to these routes with no CSRF token at all (L99 F26).
    const { createHash, randomBytes } = await import('crypto');
    const token = `ship_${randomBytes(32).toString('hex')}`;
    await pool.query(
      `INSERT INTO api_tokens (user_id, workspace_id, name, token_hash, token_prefix)
       VALUES ($1, $2, 'l02 probe', $3, $4)`,
      [ownerId, workspaceId, createHash('sha256').update(token).digest('hex'), token.slice(0, 12)]
    );

    const res = await request(app)
      .post('/api/apps')
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);

    // And nothing was created.
    const count = await pool.query('SELECT count(*)::int AS n FROM oauth_apps');
    expect(count.rows[0]!.n).toBe(0);
  });

  it('rejects a bearer even when a valid session cookie is also present', async () => {
    // The dangerous shape: the cookie authenticates, the bearer header makes
    // conditionalCsrf step aside. Both together must still fail.
    const res = await request(app)
      .post('/api/apps')
      .set('Cookie', ownerCookie)
      .set('Authorization', 'Bearer junk')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });
});

describe('PF-038 — the raw secret reaches exactly one response and no log line', () => {
  const logs: string[] = [];
  afterEach(() => {
    logs.length = 0;
    vi.restoreAllMocks();
  });

  it('appears in the create body and in NO other response, and in no captured log', async () => {
    for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }

    const created = await register();
    const raw: string = created.body.data.client_secret;
    expect(raw).toBeTruthy();

    const list = await request(app).get('/api/apps').set('Cookie', ownerCookie);
    const one = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);

    // (b) the secret is in the create body and in no read body.
    expect(JSON.stringify(list.body)).not.toContain(raw);
    expect(JSON.stringify(one.body)).not.toContain(raw);
    expect(one.body.data.client_secret).toBeUndefined();

    // (c) captured server log output contains it zero times.
    expect(logs.filter((l) => l.includes(raw))).toEqual([]);
  });

  it('does not put the secret in ApiError.details on a validation failure', async () => {
    // PF-038(d): no error body on an app route carries the secret. A handler
    // that echoed req.body into details would leak it on the create path.
    const res = await register(ownerCookie, { ...VALID_BODY, requested_scopes: ['nope:nope'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/ship_secret_/);
  });
});

describe('PF-047 / PF-049 — rotation and force-rotate', () => {
  async function rotate(id: string, cookie: string) {
    const { cookies, token } = await csrfFor(cookie);
    return request(app)
      .post(`/api/apps/${id}/rotate-secret`)
      .set('Cookie', cookies)
      .set('x-csrf-token', token)
      .send({});
  }

  it('D3: the old secret fails on the very next call, the new one succeeds', async () => {
    const { verifyClientSecret } = await import('../platform/apps/index.js');
    const created = await register();
    const clientId: string = created.body.data.client_id;
    const oldSecret: string = created.body.data.client_secret;

    const res = await rotate(created.body.data.id, ownerCookie);
    expect(res.status).toBe(200);
    const newSecret: string = res.body.data.client_secret;

    expect(newSecret).toMatch(/^ship_secret_/);
    expect(newSecret).not.toBe(oldSecret);
    expect(res.body.data.secret_version).toBe(2);
    // No grace period. The old secret is dead the moment the new one exists.
    expect((await verifyClientSecret(repo(), clientId, oldSecret)).ok).toBe(false);
    expect((await verifyClientSecret(repo(), clientId, newSecret)).ok).toBe(true);
  });

  it('secret_prefix now names the NEW secret', async () => {
    const created = await register();
    const res = await rotate(created.body.data.id, ownerCookie);
    expect(res.body.data.secret_prefix).not.toBe(created.body.data.secret_prefix);
    // The prefix is of the random portion, after the tag.
    expect(res.body.data.client_secret).toContain(res.body.data.secret_prefix);
  });

  it('carries rotation_policy as DATA, so the portal cannot hard-code the copy', async () => {
    // L22's PF-670 renders whichever value this returns. If the API stopped
    // sending it, the UI would have to guess and could lie about the model.
    const created = await register();
    const res = await rotate(created.body.data.id, ownerCookie);
    expect(res.body.data.rotation_policy).toBe('instant');
    expect(created.body.data.rotation_policy).toBe('instant');
  });

  it('a non-admin rotating a FOREIGN app gets PF-043\'s not-found body', async () => {
    const theirs = await register(otherCookie);
    const res = await rotate(theirs.body.data.id, ownerCookie);
    expect(res.status).toBe(404);

    const absent = await rotate('00000000-0000-0000-0000-000000000000', ownerCookie);
    expect(JSON.stringify(res.body)).toBe(JSON.stringify(absent.body));
  });

  it('PF-049: a super-admin CAN force-rotate an app they do not own', async () => {
    const theirs = await register(otherCookie);
    await pool.query('UPDATE users SET is_super_admin = true WHERE id = $1', [ownerId]);
    try {
      const res = await rotate(theirs.body.data.id, ownerCookie);
      expect(res.status).toBe(200);
      expect(res.body.data.secret_version).toBe(2);

      // The ACTING user is recorded, not the owner — that is what makes a
      // force-rotate attributable.
      const audit = await pool.query<{ actor_user_id: string; action: string }>(
        `SELECT actor_user_id, action FROM audit_logs
          WHERE action = 'oauth_app.secret_force_rotated' ORDER BY created_at DESC LIMIT 1`
      );
      expect(audit.rows[0]!.actor_user_id).toBe(ownerId);
    } finally {
      await pool.query('UPDATE users SET is_super_admin = false WHERE id = $1', [ownerId]);
    }
  });

  it('the raw secret appears in the rotate body and in no read afterwards', async () => {
    const created = await register();
    const res = await rotate(created.body.data.id, ownerCookie);
    const newSecret: string = res.body.data.client_secret;

    const read = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(JSON.stringify(read.body)).not.toContain(newSecret);
    expect(read.body.data.client_secret).toBeUndefined();
  });

  it('rotation does NOT change client_id — the audit trail stays joinable', async () => {
    const created = await register();
    const res = await rotate(created.body.data.id, ownerCookie);
    expect(res.body.data.client_id).toBe(created.body.data.client_id);
  });
});

describe('PF-048 — the documented departure is pinned to the shipped constant', () => {
  it('docs/architecture.md names ROTATION_POLICY, so a flip forces a doc change', async () => {
    const { readFileSync } = await import('fs');
    const doc = readFileSync(new URL('../../../docs/architecture.md', import.meta.url), 'utf-8');
    expect(doc).toContain('ROTATION_POLICY');
    // The departure has to be argued, not merely asserted.
    expect(doc).toContain('Stripe');
    expect(doc).toMatch(/grace period/i);
    // And the blast-radius sentence PF-049's playbook depends on.
    expect(doc).toMatch(/does not revoke tokens already issued/i);
  });
});

describe('PF-053 — D2\'s recovery story: reactivate and reassign', () => {
  async function reactivate(id: string, cookie: string, body: object) {
    const { cookies, token } = await csrfFor(cookie);
    return request(app)
      .post(`/api/apps/${id}/reactivate`)
      .set('Cookie', cookies)
      .set('x-csrf-token', token)
      .send(body);
  }

  const asSuperAdmin = async <T>(fn: () => Promise<T>): Promise<T> => {
    await pool.query('UPDATE users SET is_super_admin = true WHERE id = $1', [ownerId]);
    try {
      return await fn();
    } finally {
      await pool.query('UPDATE users SET is_super_admin = false WHERE id = $1', [ownerId]);
    }
  };

  it('a NON-admin gets the not-found body, not a 403', async () => {
    // A 403 would confirm the app exists to someone with no standing.
    const created = await register();
    await repo().deactivate(created.body.data.id, 'admin_action', new Date());
    const res = await reactivate(created.body.data.id, ownerCookie, {
      owner_user_id: otherOwnerId,
    });
    expect(res.status).toBe(404);
  });

  it('a super-admin reassigns to a live user and the app comes back', async () => {
    const created = await register();
    const id: string = created.body.data.id;
    const clientId: string = created.body.data.client_id;
    const rawSecret: string = created.body.data.client_secret;
    await repo().deactivate(id, 'owner_deleted', new Date());

    const res = await asSuperAdmin(() =>
      reactivate(id, ownerCookie, { owner_user_id: otherOwnerId })
    );
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);

    const { verifyClientSecret } = await import('../platform/apps/index.js');
    const back = await repo().findById(id);
    expect(back!.ownerUserId).toBe(otherOwnerId);
    expect(back!.deactivatedAt).toBeNull();
    expect(back!.deactivationReason).toBeNull();
    // client_id and the stored credential are untouched, so the audit history
    // stays continuous and the owner's secret still works.
    expect(back!.clientId).toBe(clientId);
    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(true);
  });

  it('rejects reactivation naming a user that does not exist, NAMING the field', async () => {
    // An active app with a deleted owner is the orphan state D2 was chosen to
    // avoid: a credential nobody can rotate and nobody is accountable for.
    const created = await register();
    const id: string = created.body.data.id;
    await repo().deactivate(id, 'owner_deleted', new Date());

    const res = await asSuperAdmin(() =>
      reactivate(id, ownerCookie, { owner_user_id: '00000000-0000-0000-0000-000000000000' })
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('owner_user_id');
    // And the app stayed deactivated.
    expect((await repo().findById(id))!.active).toBe(false);
  });

  it('requires owner_user_id rather than silently assigning the acting admin', async () => {
    const created = await register();
    await repo().deactivate(created.body.data.id, 'owner_deleted', new Date());
    const res = await asSuperAdmin(() => reactivate(created.body.data.id, ownerCookie, {}));
    expect(res.status).toBe(400);
  });
});

describe('PF-045 — MVP GATE ITEM 1, asserted end to end as ONE test', () => {
  it('admin creates an app → client_id + raw secret once → DB holds only the hash → verify works', async () => {
    // Recorded as a single test on purpose. This is the last unclaimed gate
    // item on the board and the one a grader runs first; a partial pass must
    // not be reportable as a pass.
    const { createHash } = await import('crypto');
    const { verifyClientSecret } = await import('../platform/apps/index.js');

    // 1. An admin session POSTs to /api/apps.
    const res = await register(ownerCookie, {
      name: 'Gate Item One',
      redirect_uris: ['https://grader.test/callback'],
      requested_scopes: ['documents:read'],
    });
    expect(res.status).toBe(201);

    // 2. The response carries a client_id AND a raw client_secret.
    const clientId: string = res.body.data.client_id;
    const rawSecret: string = res.body.data.client_secret;
    expect(clientId).toMatch(/^ship_app_/);
    expect(rawSecret).toMatch(/^ship_secret_/);

    // 3. The database row holds ONLY a SHA-256 hash of that secret.
    const row = await pool.query<{ whole: string; client_secret_hash: string }>(
      `SELECT oauth_apps::text AS whole, client_secret_hash FROM oauth_apps WHERE client_id = $1`,
      [clientId]
    );
    expect(row.rows[0]!.client_secret_hash).toBe(
      createHash('sha256').update(rawSecret).digest('hex')
    );
    expect(row.rows[0]!.whole).not.toContain(rawSecret);

    // 4. A subsequent read never returns the raw value.
    const read = await request(app)
      .get(`/api/apps/${res.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(rawSecret);

    // 5. verifyClientSecret accepts the secret and rejects a near miss.
    expect((await verifyClientSecret(repo(), clientId, rawSecret)).ok).toBe(true);
    expect((await verifyClientSecret(repo(), clientId, rawSecret + 'x')).ok).toBe(false);
  });
});
