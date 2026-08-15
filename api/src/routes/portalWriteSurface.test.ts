/**
 * L22 slice S2 — the developer portal's WRITE surface, asserted at the HTTP
 * boundary the React form actually talks to.
 *
 * PF-663 (full app record), PF-664 (register form driven by the scope
 * registry), PF-665 (CSRF on the app-form and rotate-secret endpoints) and
 * PF-670 (rotation copy driven by `rotation_policy`) all rest on properties of
 * the RESPONSE, not of the component: which fields exist, which are refused,
 * and what a validation failure looks like when it is rendered under a field.
 * A component test cannot see any of that — it sees whatever the mock returns.
 *
 * Deliberately a separate file from L02's `apps.test.ts` rather than more
 * `describe` blocks inside it. That file is L02's contract for its own routes;
 * this one is L22 recording what the portal DEPENDS on, so if a future change
 * breaks the form the failure names the portal rather than looking like an
 * unrelated regression in app registration.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { productionDeps } from '../deps.js';
import { pool } from '../db/client.js';
import { ROTATION_POLICY } from './apps.js';
import { scopeRegistry } from '../platform/scopes/scopes.js';

let app: Express;
let workspaceId: string;
let ownerCookie: string;

async function makeSessionUser(email: string): Promise<{ userId: string; cookie: string }> {
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name) VALUES ($1, 'L22 Portal Test') RETURNING id`,
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

/**
 * Ship runs two session mechanisms side by side and a write needs both: the
 * `sessions` row `authMiddleware` reads, and the express-session `csrf-sync`
 * keeps its synchroniser token in. See `apps.test.ts` for the full note.
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

/** Exactly the body `RegisterAppDialog` submits. https, never loopback — see below. */
const FORM_BODY = {
  name: 'Portal Form App',
  redirect_uris: ['https://portal-form.example/callback'],
  requested_scopes: ['documents:read', 'webhooks:manage'],
};

async function registerThroughTheForm(body: object = FORM_BODY) {
  const { cookies, token } = await csrfFor(ownerCookie);
  return request(app).post('/api/apps').set('Cookie', cookies).set('x-csrf-token', token).send(body);
}

beforeAll(async () => {
  app = createApp(productionDeps());
  const ws = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (name) VALUES ('L22 portal write surface') RETURNING id`
  );
  workspaceId = ws.rows[0]!.id;
  ownerCookie = (await makeSessionUser('l22-portal-owner@ship.local')).cookie;
});

beforeEach(async () => {
  await pool.query('DELETE FROM oauth_apps');
});

describe('PF-664 — GET /api/apps/registry drives the register form', () => {
  it('returns the ScopeRegistry itself, not a copy — same names, same descriptions', async () => {
    const res = await request(app).get('/api/apps/registry').set('Cookie', ownerCookie);
    expect(res.status).toBe(200);

    const returned = (res.body.data.scopes as { scope: string; description: string }[]).map(
      (s) => s.scope
    );
    // Compared against the live registry rather than a literal list of seven:
    // a literal here would be the same hard-coding the ticket forbids in the UI,
    // just moved into the test. Adding a scope to `scopes.ts` must make this
    // pass, not fail.
    expect(returned).toEqual(scopeRegistry.names());

    for (const def of scopeRegistry.list()) {
      const served = (res.body.data.scopes as { scope: string; description: string }[]).find(
        (s) => s.scope === def.scope
      );
      expect(served?.description).toBe(def.description);
    }
  });

  it('every scope the form can offer is one registration ACCEPTS', async () => {
    // This is PF-664's real claim: the checkbox set and the validator read one
    // table. If they ever diverged, the form would render a scope that fails at
    // submit — the failure the user cannot act on, because they picked it from
    // a list we drew.
    const res = await request(app).get('/api/apps/registry').set('Cookie', ownerCookie);
    const offered = (res.body.data.scopes as { scope: string }[]).map((s) => s.scope);

    const created = await registerThroughTheForm({ ...FORM_BODY, requested_scopes: offered });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.requested_scopes).toEqual(offered);
  });

  it('is not swallowed by GET /:id — declaration order is load-bearing', async () => {
    // Below `/:id` this path parses as an app id, fails the UUID cast inside
    // findOwnedApp, and returns PF-043's not-found body: a 404 on a route that
    // exists. Asserted because the bug is invisible until someone opens the form.
    const res = await request(app).get('/api/apps/registry').set('Cookie', ownerCookie);
    expect(res.status).not.toBe(404);
    expect(res.body.success).toBe(true);
  });

  it('401s without a session, and refuses a bearer like every other /api/apps route', async () => {
    expect((await request(app).get('/api/apps/registry')).status).toBe(401);
    const withBearer = await request(app)
      .get('/api/apps/registry')
      .set('Cookie', ownerCookie)
      .set('Authorization', 'Bearer junk');
    expect(withBearer.status).toBe(401);
  });

  it('an unregistered scope is rejected BY THE SERVER, naming it, in the field the form renders', async () => {
    // PF-664: rejected by validateRequestedScopes "rather than by the form".
    // The form is therefore allowed to send it, and the message has to arrive in
    // `details.fieldErrors.requested_scopes` — that path is what
    // RegisterAppDialog renders under the scope checkboxes.
    const res = await registerThroughTheForm({
      ...FORM_BODY,
      requested_scopes: ['documents:read', 'apps:manage'],
    });
    expect(res.status).toBe(400);
    const messages: string[] = res.body.error.details.fieldErrors.requested_scopes;
    expect(messages.join(' ')).toContain('apps:manage');
  });

  it('a bad redirect URI lands in its own field, so the form can point at it', async () => {
    const res = await registerThroughTheForm({
      ...FORM_BODY,
      redirect_uris: ['http://not-loopback.example/cb'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors.redirect_uris.join(' ')).toContain('https');
  });
});

describe('PF-670 — rotation copy is DATA, so D3 can flip without a UI rewrite', () => {
  it('the registry read and the rotate response agree with the shipped constant', async () => {
    const created = await registerThroughTheForm();
    expect(created.status).toBe(201);

    const registry = await request(app).get('/api/apps/registry').set('Cookie', ownerCookie);
    expect(registry.body.data.rotation_policy).toBe(ROTATION_POLICY);

    const { cookies, token } = await csrfFor(ownerCookie);
    const rotated = await request(app)
      .post(`/api/apps/${created.body.data.id}/rotate-secret`)
      .set('Cookie', cookies)
      .set('x-csrf-token', token)
      .send({});
    expect(rotated.status).toBe(200);
    // Two independent reads of the same fact. If they ever disagree, the
    // pre-rotation warning and the post-rotation consequence would describe
    // different security models on the same screen.
    expect(rotated.body.data.rotation_policy).toBe(registry.body.data.rotation_policy);
  });

  it('rotation returns a NEW raw secret and a bumped version, once', async () => {
    const created = await registerThroughTheForm();
    const first: string = created.body.data.client_secret;

    const { cookies, token } = await csrfFor(ownerCookie);
    const rotated = await request(app)
      .post(`/api/apps/${created.body.data.id}/rotate-secret`)
      .set('Cookie', cookies)
      .set('x-csrf-token', token)
      .send({});

    expect(rotated.body.data.client_secret).not.toBe(first);
    expect(rotated.body.data.secret_version).toBe(created.body.data.secret_version + 1);

    // …and the read that follows carries no secret at all. A test that could
    // re-read it would be testing a bug (p.2: shown exactly once).
    const read = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(JSON.stringify(read.body)).not.toContain(rotated.body.data.client_secret);
  });
});

describe('PF-663 — the app record the panel renders', () => {
  it('carries client_id, scopes, redirect URIs and created_at, and no raw secret', async () => {
    const created = await registerThroughTheForm();
    const rawSecret: string = created.body.data.client_secret;

    const read = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(read.status).toBe(200);

    const record = read.body.data;
    // Every field AppRecordPanel renders, named here so removing one from the
    // projection fails as "the portal panel loses a field" rather than silently
    // rendering `undefined`.
    expect(record.client_id).toMatch(/^ship_app_/);
    expect(record.requested_scopes).toEqual(FORM_BODY.requested_scopes);
    expect(record.redirect_uris).toEqual(FORM_BODY.redirect_uris);
    expect(typeof record.created_at).toBe('string');
    expect(typeof record.secret_prefix).toBe('string');
    expect(typeof record.secret_version).toBe('number');

    // The raw secret is absent as a VALUE, not merely under a different key.
    expect(JSON.stringify(record)).not.toContain(rawSecret);

    // And no field whose name mentions a secret, beyond the two that name one
    // without being one (PF-035: a prefix identifies a credential; it does not
    // authenticate as it).
    const secretish = Object.keys(record).filter((k) => /secret/i.test(k));
    expect(secretish.sort()).toEqual(['secret_prefix', 'secret_version']);
  });
});

describe('PF-665 — CSRF on the app-form and rotate-secret endpoints', () => {
  it('(a) POST /api/apps without the synchroniser token is rejected', async () => {
    // Session cookie present and valid; only the `x-csrf-token` header missing.
    const res = await request(app).post('/api/apps').set('Cookie', ownerCookie).send(FORM_BODY);
    expect(res.status).toBe(403);

    const count = await pool.query('SELECT count(*)::int AS n FROM oauth_apps');
    expect(count.rows[0]!.n).toBe(0);
  });

  it('(a) rotate-secret without the synchroniser token is rejected too', async () => {
    const created = await registerThroughTheForm();
    const before = created.body.data.secret_prefix;

    const res = await request(app)
      .post(`/api/apps/${created.body.data.id}/rotate-secret`)
      .set('Cookie', ownerCookie)
      .send({});
    expect(res.status).toBe(403);

    // The credential is untouched — a rejected CSRF must not half-rotate.
    const read = await request(app)
      .get(`/api/apps/${created.body.data.id}`)
      .set('Cookie', ownerCookie);
    expect(read.body.data.secret_prefix).toBe(before);
  });

  it('(b) the bearer skip cannot be turned into a CSRF bypass', async () => {
    // `conditionalCsrf` (app.ts) steps aside for ANY Authorization: Bearer
    // header, and `authMiddleware` does not fall back to the session when a
    // bearer is present and invalid. `rejectBearerAuth` closes it here first.
    // Session cookie + junk bearer + no CSRF token — the dangerous shape.
    const res = await request(app)
      .post('/api/apps')
      .set('Cookie', ownerCookie)
      .set('Authorization', 'Bearer junk')
      .send(FORM_BODY);
    expect(res.status).toBe(401);

    const rotate = await request(app)
      .post('/api/apps/00000000-0000-0000-0000-000000000000/rotate-secret')
      .set('Cookie', ownerCookie)
      .set('Authorization', 'Bearer junk')
      .send({});
    expect(rotate.status).toBe(401);
  });

  it('(c) /api/v1 needs no CSRF token — the browser never attaches a bearer on its own', async () => {
    // A bearer POST with no synchroniser token must fail at AUTHENTICATION,
    // not at CSRF. That is what makes the SDK usable from a non-browser client
    // and is why the portal's `/api/v1` half needs no token negotiation.
    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ target_url: 'https://example.test/hook', event_types: ['document.created'] });

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('csrf');
  });
});
