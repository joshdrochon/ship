/**
 * PF-652 — `POST /api/apps/:id/portal-token`, the developer portal's only
 * privileged route. Lane L22, slice S1.
 *
 * Driven over supertest against the real app and a real database for the same
 * reason `apps.test.ts` is: every property here is about the HTTP boundary —
 * what a second owner can see, what a bearer header does, and what is and is not
 * in a response body. None of it is visible from the repository layer.
 *
 * The token that comes out is then USED against `/api/v1` in the last describe
 * block, because a token that mints and does not authenticate is a token that
 * fails on the demo rather than in CI.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { productionDeps } from '../deps.js';
import { pool } from '../db/client.js';
import { PORTAL_TOKEN_TTL_SECONDS, portalTokenScopes, assertNoScopeEscalation } from './portal.js';
import type { OAuthApp } from '../platform/apps/index.js';

let app: Express;
let workspaceId: string;
let ownerCookie: string;
let otherCookie: string;

async function makeSessionUser(email: string): Promise<{ userId: string; cookie: string }> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'L22 Test') RETURNING id`,
    [email]
  );
  const userId = u.rows[0]!.id;
  await pool.query(
    `INSERT INTO workspace_memberships (user_id, workspace_id, role) VALUES ($1, $2, 'admin')`,
    [userId, workspaceId]
  );
  const { randomBytes } = await import('crypto');
  const sessionId = randomBytes(24).toString('hex');
  await pool.query(
    `INSERT INTO sessions (id, user_id, workspace_id, expires_at, last_activity)
     VALUES ($1, $2, $3, now() + interval '1 hour', now())`,
    [sessionId, userId, workspaceId]
  );
  return { userId, cookie: `session_id=${sessionId}` };
}

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

/** Register an app through the shipped route, so the fixture is a real row. */
async function registerApp(
  cookie: string,
  scopes: string[] = ['webhooks:manage', 'documents:read']
): Promise<{ id: string; clientId: string }> {
  const { cookies, token } = await csrfFor(cookie);
  const res = await request(app)
    .post('/api/apps')
    .set('Cookie', cookies)
    .set('x-csrf-token', token)
    .send({
      name: 'L22 Portal Fixture',
      redirect_uris: ['https://example.test/callback'],
      requested_scopes: scopes,
    });
  expect(res.status).toBe(201);
  return { id: res.body.data.id, clientId: res.body.data.client_id };
}

async function mintToken(cookie: string, appId: string) {
  const { cookies, token } = await csrfFor(cookie);
  return request(app)
    .post(`/api/apps/${appId}/portal-token`)
    .set('Cookie', cookies)
    .set('x-csrf-token', token)
    .send({});
}

beforeAll(async () => {
  app = createApp(productionDeps());
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L22 portal token tests') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;
  ownerCookie = (await makeSessionUser('l22-portal-owner@ship.local')).cookie;
  otherCookie = (await makeSessionUser('l22-portal-other@ship.local')).cookie;
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_tokens');
  await pool.query('DELETE FROM oauth_apps');
});

describe('PF-652 — the mint succeeds for the owner', () => {
  it('returns a bearer access token scoped to the app', async () => {
    const { id, clientId } = await registerApp(ownerCookie);
    const res = await mintToken(ownerCookie, id);

    expect(res.status).toBe(200);
    expect(res.body.data.token_type).toBe('Bearer');
    expect(typeof res.body.data.access_token).toBe('string');
    expect(res.body.data.access_token.length).toBeGreaterThan(20);
    expect(res.body.data.client_id).toBe(clientId);
    expect(res.body.data.scope.split(' ').sort()).toEqual(
      ['documents:read', 'webhooks:manage'].sort()
    );
  });

  it('TTL is at most 15 minutes, so the token cannot outlive its session', async () => {
    const { id } = await registerApp(ownerCookie);
    const res = await mintToken(ownerCookie, id);
    expect(res.body.data.expires_in).toBe(PORTAL_TOKEN_TTL_SECONDS);
    expect(res.body.data.expires_in).toBeLessThanOrEqual(15 * 60);
  });

  it('the response carries NO refresh token — not null, no key at all', async () => {
    const { id } = await registerApp(ownerCookie);
    const res = await mintToken(ownerCookie, id);
    expect(Object.keys(res.body.data)).not.toContain('refresh_token');
    expect(JSON.stringify(res.body)).not.toContain('refresh');
  });

  it('the refresh half is revoked in the database before the handler returns', async () => {
    const { id } = await registerApp(ownerCookie);
    await mintToken(ownerCookie, id);
    const rows = await pool.query<{ token_type: string; revoked_at: Date | null }>(
      `SELECT token_type, revoked_at FROM oauth_tokens ORDER BY token_type`
    );
    const byType = Object.fromEntries(rows.rows.map((r) => [r.token_type, r.revoked_at]));
    expect(byType.access).toBeNull();
    expect(byType.refresh).not.toBeNull();
  });
});

describe('PF-652 — the endpoint is not an ownership oracle', () => {
  it("another owner's app id and a nonexistent id return byte-identical bodies", async () => {
    const { id } = await registerApp(ownerCookie);

    const foreign = await mintToken(otherCookie, id);
    const missing = await mintToken(otherCookie, '00000000-0000-0000-0000-000000000000');

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(foreign.body)).toBe(JSON.stringify(missing.body));
  });

  it('a malformed id is the same 404 and never a 500', async () => {
    const { id } = await registerApp(ownerCookie);
    const good = await mintToken(otherCookie, id);
    const garbage = await mintToken(otherCookie, 'not-a-uuid');
    expect(garbage.status).toBe(404);
    expect(JSON.stringify(garbage.body)).toBe(JSON.stringify(good.body));
  });
});

describe('PF-652 — authentication', () => {
  it('an unauthenticated call 401s', async () => {
    const { id } = await registerApp(ownerCookie);
    // No session cookie at all. CSRF is negotiated against a fresh session, so
    // the request reaches `authMiddleware` and fails there rather than at CSRF.
    const res = await request(app).post(`/api/apps/${id}/portal-token`).send({});
    expect([401, 403]).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });

  it('a bearer token cannot reach the mint — the CSRF skip cannot be ridden', async () => {
    const { id } = await registerApp(ownerCookie);
    const res = await request(app)
      .post(`/api/apps/${id}/portal-token`)
      .set('Cookie', ownerCookie)
      .set('Authorization', 'Bearer anything-at-all')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/interactive session/i);
  });

  it('a state-changing call with no CSRF token is rejected', async () => {
    const { id } = await registerApp(ownerCookie);
    const res = await request(app)
      .post(`/api/apps/${id}/portal-token`)
      .set('Cookie', ownerCookie)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('PF-652 — scopes are the app\'s own, never a superset', () => {
  it('the minted scope set equals the app\'s requested scopes', async () => {
    const { id } = await registerApp(ownerCookie, ['documents:read']);
    const res = await mintToken(ownerCookie, id);
    expect(res.body.data.scope).toBe('documents:read');
  });

  it('assertNoScopeEscalation throws on anything outside the app\'s ceiling', () => {
    const fake = { requestedScopes: ['documents:read'] } as unknown as OAuthApp;
    expect(() => assertNoScopeEscalation(fake, ['documents:read'])).not.toThrow();
    expect(() => assertNoScopeEscalation(fake, ['documents:read', 'webhooks:manage'])).toThrow(
      /escalate/
    );
  });

  it('portalTokenScopes returns a copy, so a caller cannot mutate the app row', () => {
    const fake = { requestedScopes: ['documents:read'] } as unknown as OAuthApp;
    const scopes = portalTokenScopes(fake);
    scopes.push('webhooks:manage');
    expect(fake.requestedScopes).toEqual(['documents:read']);
  });
});

describe('PF-653 — the minted token actually works against /api/v1', () => {
  it('authenticates the delivery-log endpoint the portal reads', async () => {
    const { id } = await registerApp(ownerCookie, ['webhooks:manage']);
    const minted = await mintToken(ownerCookie, id);
    const token: string = minted.body.data.access_token;

    const res = await request(app)
      .get('/api/v1/webhooks/deliveries')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('next_cursor');
  });

  it('a token minted without webhooks:manage is refused with the scope named', async () => {
    const { id } = await registerApp(ownerCookie, ['documents:read']);
    const minted = await mintToken(ownerCookie, id);
    const token: string = minted.body.data.access_token;

    const res = await request(app)
      .get('/api/v1/webhooks/deliveries')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('webhooks:manage');
  });
});

describe('PF-652 — a deactivated app cannot mint', () => {
  it('names the state rather than pretending the app is gone', async () => {
    const { id } = await registerApp(ownerCookie);
    await pool.query(
      `UPDATE oauth_apps SET active = false, deactivated_at = now(), deactivation_reason = 'admin_action' WHERE id = $1`,
      [id]
    );
    const res = await mintToken(ownerCookie, id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/deactivated/i);
  });
});
