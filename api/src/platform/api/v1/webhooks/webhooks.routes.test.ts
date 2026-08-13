/**
 * PF-428 – PF-433 — `/api/v1/webhooks` over the REAL bearer middleware.
 *
 * Runs against `InMemoryWebhookSubscriptionRepo`. That is deliberate rather
 * than a shortcut: `subscriptionRepo.test.ts` already runs the whole repository
 * contract against BOTH implementations, so re-proving persistence here would
 * measure the same thing twice and slowly. What is only observable at this layer
 * is the HTTP contract — status codes, the error envelope, the scope guard, the
 * cursor protocol, and what does and does not appear in a response body.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Router } from 'express';
import { createBearerTestApp, type BearerTestApp } from '../../../oauth/bearerTestSupport.js';
import { issueTokenPair } from '../../../oauth/issue.js';
import { secretMaterial, type InMemoryOAuthAppRepo } from '../../../apps/repo.js';
import { generateClientId, generateClientSecret } from '../../../apps/secrets.js';
import { V1_PREFIX } from '../testSupport.js';
import { FakeClock } from '../../../clock.js';
import { AesGcmSecretCipher, WEBHOOK_SECRET_KEY_BYTES } from '../../../webhooks/secretCipher.js';
import { InMemoryWebhookSubscriptionRepo } from '../../../webhooks/inMemorySubscriptionRepo.js';
import { EVENT_TYPES } from '../../../webhooks/events.js';
import { mountWebhooks, WEBHOOK_ROUTES, WEBHOOKS_SCOPE } from './routes.js';
import {
  webhookSubscriptionSchema,
  webhookSubscriptionWithSecretSchema,
  REJECTED_CREATE_FIELDS,
  IMMUTABLE_SUBSCRIPTION_FIELDS,
} from './webhooks.schema.js';
import { pageSchema } from '../page.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x2b));

interface Harness {
  bearer: BearerTestApp;
  repo: InMemoryWebhookSubscriptionRepo;
  tokenA: string;
  tokenB: string;
  /** A token for app A that holds every scope EXCEPT `webhooks:manage`. */
  tokenNoScope: string;
}

/**
 * Two apps on one server, both minted through the real issuance site.
 *
 * `createBearerTestApp` builds one app; the second is created on the SAME
 * in-memory repositories, because cross-app isolation is only observable when
 * both tokens hit one router. Two servers would prove nothing — of course app B
 * cannot see app A's rows if app B's server has none.
 */
async function harness(): Promise<Harness> {
  // A clock that advances a second per read, so `created_at` is strictly
  // increasing between inserts and the keyset walk has a real total order.
  const ticking = (() => {
    const fake = new FakeClock(1_700_000_000_000);
    return {
      nowMs: () => {
        fake.advance(1000);
        return fake.nowMs();
      },
    };
  })();
  const repo = new InMemoryWebhookSubscriptionRepo({ cipher: CIPHER, clock: ticking });

  const mount = (r: Router): void => mountWebhooks(r, { repo });
  const bearer = await createBearerTestApp({ mountResources: mount, workspaceId: 'ws-1' });

  const appsRepo = bearer.appsRepo as InMemoryOAuthAppRepo;
  const appB = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L15 second app',
    ownerUserId: 'user-2',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: [WEBHOOKS_SCOPE],
  });

  const tokenA = (await bearer.mint([WEBHOOKS_SCOPE])).access_token;
  const tokenNoScope = (await bearer.mint(['documents:read', 'documents:write'])).access_token;
  const { response: b } = await issueTokenPair(
    { tokenRepo: bearer.tokenRepo, clock: bearer.clock, ttl: bearer.ttl },
    { app: appB, userId: 'user-2', scopes: [WEBHOOKS_SCOPE] },
  );

  return { bearer, repo, tokenA, tokenB: b.access_token, tokenNoScope };
}

const url = (path = ''): string => `${V1_PREFIX}/webhooks${path}`;

function createBody(over: Record<string, unknown> = {}) {
  return { event: 'document.created', target_url: 'https://example.test/hooks/a', ...over };
}

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

/**
 * `request(app)[method](path)` with the method chosen at runtime.
 *
 * A helper rather than an index expression, because supertest's typings make
 * `agent[method]` possibly-undefined and the alternative is a cast at four call
 * sites. Table-driven method coverage is the whole point of PF-428 — a per-verb
 * copy of each test is how one verb quietly goes unasserted.
 */
function verb(method: 'get' | 'post' | 'patch' | 'delete', path: string): request.Test {
  const agent = request(h.bearer.app);
  return method === 'get'
    ? agent.get(path)
    : method === 'post'
      ? agent.post(path)
      : method === 'patch'
        ? agent.patch(path)
        : agent.delete(path);
}

async function seed(token: string, target: string, event = 'document.created') {
  const res = await request(h.bearer.app)
    .post(url())
    .set('Authorization', `Bearer ${token}`)
    .send({ event, target_url: target });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; signing_secret: string };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('PF-428 — every method declares webhooks:manage, and read is not exempt', () => {
  it('declares six methods and no more', () => {
    expect(WEBHOOK_ROUTES).toHaveLength(6);
  });

  it.each(WEBHOOK_ROUTES)('$method $path is 403 without the scope', async (route) => {
    const path = route.path.replace(':id', '11111111-1111-4111-8111-111111111111');
    const res = await verb(route.method, `${V1_PREFIX}${path}`)
      .set('Authorization', `Bearer ${h.tokenNoScope}`)
      .send({});

    expect(res.status, `${route.method} ${route.path}`).toBe(403);
    expect(res.body.code).toBe('forbidden');
    // MVP gate item 6 (p.2): the missing scope named explicitly, no opaque
    // "forbidden". A 403 that does not say what is missing sends a developer to
    // the docs; one that does sends them to the consent screen.
    expect(res.body.details.missing_scope).toBe(WEBHOOKS_SCOPE);
  });

  it('the scope check happens BEFORE the id is looked up', async () => {
    // Otherwise the 403/404 split leaks existence to a caller who may not read
    // the collection at all: "403" would mean "it exists", "404" would mean "it
    // does not", and neither should be answerable without the scope.
    const created = await seed(h.tokenA, 'https://example.test/hooks/exists');
    const res = await request(h.bearer.app)
      .get(url(`/${created.id}`))
      .set('Authorization', `Bearer ${h.tokenNoScope}`);
    expect(res.status).toBe(403);
  });

  it('no token at all is 401, not 403', async () => {
    const res = await request(h.bearer.app).get(url());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });
});

describe('PF-429 — POST /api/v1/webhooks', () => {
  it('201s, returns the secret once, and Locations the new resource', async () => {
    const res = await request(h.bearer.app)
      .post(url())
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send(createBody());

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/webhooks/${res.body.id}`);
    expect(webhookSubscriptionWithSecretSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.signing_secret).toMatch(/^whsec_/);
    expect(res.body.event).toBe('document.created');
    expect(res.body.active).toBe(true);
    expect(res.body.secret_version).toBe(1);
  });

  it('the secret appears in the create response and in NO read response', async () => {
    const created = await seed(h.tokenA, 'https://example.test/hooks/once');
    const auth = { Authorization: `Bearer ${h.tokenA}` };

    const one = await request(h.bearer.app).get(url(`/${created.id}`)).set(auth);
    const list = await request(h.bearer.app).get(url()).set(auth);
    const patched = await request(h.bearer.app).patch(url(`/${created.id}`)).set(auth).send({
      active: false,
    });

    for (const res of [one, list, patched]) {
      expect(JSON.stringify(res.body)).not.toContain(created.signing_secret);
      expect(JSON.stringify(res.body)).not.toContain('signing_secret');
    }
    // `.strict()` on the read schema is what makes that structural: a handler
    // that put the secret on a read body would fail `responseContract` before
    // the bytes left the process, not merely fail this assertion.
    expect(webhookSubscriptionSchema.safeParse(one.body).success).toBe(true);
  });

  it('an unregistered event type is validation_failed enumerating all eight', async () => {
    const res = await request(h.bearer.app)
      .post(url())
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send(createBody({ event: 'plugin.installed' }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    const message = JSON.stringify(res.body.details.fields);
    for (const type of EVENT_TYPES) expect(message).toContain(type);
  });

  it('a foreign app_id in the body is REJECTED, not honoured', async () => {
    // Not "ignored". Ignoring is how a caller comes to believe they bound a
    // subscription to an app they do not own.
    const res = await request(h.bearer.app)
      .post(url())
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send(createBody({ app_id: 'someone-elses-app' }));

    expect(res.status).toBe(422);
    expect(res.body.details.fields.map((f: { field: string }) => f.field)).toContain(
      'app_id',
    );

    // And the row that would have been created is not there.
    const list = await request(h.bearer.app).get(url()).set('Authorization', `Bearer ${h.tokenA}`);
    expect(list.body.data).toHaveLength(0);
  });

  it.each(REJECTED_CREATE_FIELDS)('rejects the internal field %s by name', async (field) => {
    const res = await request(h.bearer.app)
      .post(url())
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send(createBody({ [field]: 'x' }));
    expect(res.status).toBe(422);
    expect(res.body.details.fields.map((f: { field: string }) => f.field)).toContain(field);
  });

  // NOT in this list: `https://127.0.0.1/hooks`. The suite runs under
  // `NODE_ENV=test`, where PF-425's one named exception permits loopback
  // targets — TS-6 and the TTFE drill both point at a local listener. The
  // private-range rejection is asserted against an explicit non-test
  // environment in `targetUrl.test.ts`, which is the only honest place for it:
  // asserting it here would require the route to disagree with its own
  // environment. The consequence for the demo recording is filed as B8.
  it.each([
    'http://example.test/hooks',
    '/hooks',
    'https://user:pw@example.test/hooks',
    'file:///etc/passwd',
  ])('rejects target_url %s, naming the field', async (target) => {
    const res = await request(h.bearer.app)
      .post(url())
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send(createBody({ target_url: target }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('target_url');
  });

  it('a loopback target IS accepted under NODE_ENV=test — the exception, asserted', async () => {
    // The positive half of the carve-out above. Without this, "we permit
    // localhost in tests" is a claim in a comment; with it, weakening or
    // widening the exception is a visible test change.
    expect(process.env.NODE_ENV).toBe('test');
    await seed(h.tokenA, 'http://localhost:9099/hooks');
  });

  it('a duplicate (event, target) for the same app is 422, not 500', async () => {
    await seed(h.tokenA, 'https://example.test/hooks/dupe');
    const res = await request(h.bearer.app)
      .post(url())
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send(createBody({ target_url: 'https://example.test/hooks/dupe' }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
  });

  it('two apps may point at the SAME url for the same event', async () => {
    await seed(h.tokenA, 'https://example.test/hooks/shared');
    await seed(h.tokenB, 'https://example.test/hooks/shared');
  });
});

describe('PF-430 — GET /api/v1/webhooks is cursor-paginated and app-scoped', () => {
  it('a full cursor walk by app A never surfaces an app B row', async () => {
    const mine: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      mine.push((await seed(h.tokenA, `https://example.test/a/${i}`)).id);
    }
    const theirs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      theirs.push((await seed(h.tokenB, `https://example.test/b/${i}`)).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const res: request.Response = await request(h.bearer.app)
        .get(`${url()}${query}`)
        .set('Authorization', `Bearer ${h.tokenA}`);
      expect(res.status).toBe(200);
      expect(pageSchema(webhookSubscriptionSchema).safeParse(res.body).success).toBe(true);
      seen.push(...res.body.data.map((row: { id: string }) => row.id));
      cursor = res.body.next_cursor;
      if (cursor === null) break;
    }

    expect(seen.sort()).toEqual([...mine].sort());
    for (const id of theirs) expect(seen).not.toContain(id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('next_cursor is PRESENT and null on the last page', async () => {
    await seed(h.tokenA, 'https://example.test/a/only');
    const res = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);
    // `== null` would be true for an absent key too, which is exactly why it is
    // the wrong check: `{data}` deserialises to `undefined` in TS and a KeyError
    // in Python.
    expect('next_cursor' in res.body).toBe(true);
    expect(res.body.next_cursor).toBeNull();
  });

  it('an empty list is [] with a null cursor, not a 404', async () => {
    const res = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], next_cursor: null });
  });

  it('?offset= is a 422 pointing at the cursor, not an ignored parameter', async () => {
    const res = await request(h.bearer.app)
      .get(`${url()}?offset=10`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/cursor/);
  });

  it("a cursor minted by another collection is rejected", async () => {
    // PF-218 — cursors are bound to the collection that minted them. A
    // documents cursor replayed here would otherwise index into a different
    // table's ordering.
    const res = await request(h.bearer.app)
      .get(`${url()}?cursor=${Buffer.from(
        JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', timestamp: '2026-01-01T00:00:00.000Z', resource: 'documents' }),
      ).toString('base64url')}`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(res.status).toBe(422);
  });
});

describe('PF-431 — GET/:id, PATCH/:id, DELETE/:id', () => {
  it('GET returns the subscription without the secret', async () => {
    const created = await seed(h.tokenA, 'https://example.test/a/get');
    const res = await request(h.bearer.app)
      .get(url(`/${created.id}`))
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body).not.toHaveProperty('signing_secret');
  });

  it('PATCH accepts only { active }', async () => {
    const created = await seed(h.tokenA, 'https://example.test/a/patch');
    const off = await request(h.bearer.app)
      .patch(url(`/${created.id}`))
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body.active).toBe(false);
    expect(off.body.deactivated_at).not.toBeNull();

    const on = await request(h.bearer.app)
      .patch(url(`/${created.id}`))
      .set('Authorization', `Bearer ${h.tokenA}`)
      .send({ active: true });
    expect(on.body.active).toBe(true);
    expect(on.body.deactivated_at).toBeNull();
  });

  it.each(IMMUTABLE_SUBSCRIPTION_FIELDS)(
    'PATCH %s is validation_failed naming the immutable field',
    async (field) => {
      const created = await seed(h.tokenA, `https://example.test/a/immutable-${field}`);
      const res = await request(h.bearer.app)
        .patch(url(`/${created.id}`))
        .set('Authorization', `Bearer ${h.tokenA}`)
        .send({ [field]: 'https://elsewhere.test/hooks' });

      expect(res.status).toBe(422);
      const reported = res.body.details.fields.find(
        (f: { field: string }) => f.field === field,
      );
      expect(reported, `${field} was not named`).toBeDefined();
      // "There is no such field" and "you may not change that field" are
      // different facts, and the caller needs the second one.
      expect(reported.message).toMatch(/immutable/i);
    },
  );

  it('DELETE deactivates, retains the row, and is idempotent', async () => {
    const created = await seed(h.tokenA, 'https://example.test/a/delete');
    const auth = { Authorization: `Bearer ${h.tokenA}` };

    const first = await request(h.bearer.app).delete(url(`/${created.id}`)).set(auth);
    expect(first.status).toBe(200);
    expect(first.body.active).toBe(false);

    const second = await request(h.bearer.app).delete(url(`/${created.id}`)).set(auth);
    expect(second.status).toBe(200);
    expect(second.body.deactivated_at).toBe(first.body.deactivated_at);

    // Retained, not removed — L16's delivery log keeps a resolvable
    // `subscription_id` after a subscriber walks away.
    const after = await request(h.bearer.app).get(url(`/${created.id}`)).set(auth);
    expect(after.status).toBe(200);
  });
});

describe('PF-432 — a foreign id is not_found on all four verbs, never forbidden', () => {
  it.each([
    ['get', (id: string) => url(`/${id}`)],
    ['patch', (id: string) => url(`/${id}`)],
    ['delete', (id: string) => url(`/${id}`)],
    ['post', (id: string) => url(`/${id}/rotate`)],
  ] as const)("%s on app A's id, as app B, is 404", async (method, path) => {
    const created = await seed(h.tokenA, `https://example.test/a/oracle-${method}`);
    const res = await verb(method, path(created.id))
      .set('Authorization', `Bearer ${h.tokenB}`)
      .send({ active: false });

    // NOT 403. A 403 confirms the id EXISTS, which turns the endpoint into an
    // existence oracle over UUIDs — a caller iterating ids learns which ones are
    // real subscriptions in apps they cannot read.
    expect(res.status, `${method} leaked existence`).toBe(404);
    expect(res.body.code).toBe('not_found');
    // `not_found` carries no `details` (PF-198's per-code policy). Anything here
    // would be the same leak arriving by another door.
    expect(res.body).not.toHaveProperty('details');
  });

  it('app B cannot deactivate app A"s subscription by trying', async () => {
    const created = await seed(h.tokenA, 'https://example.test/a/untouched');
    await request(h.bearer.app)
      .delete(url(`/${created.id}`))
      .set('Authorization', `Bearer ${h.tokenB}`);
    const still = await request(h.bearer.app)
      .get(url(`/${created.id}`))
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(still.body.active).toBe(true);
  });

  it.each(['not-a-uuid', '123', '11111111-1111-4111-8111'])(
    'a malformed id (%s) is validation_failed, not a database error',
    async (bad) => {
      const res = await request(h.bearer.app)
        .get(url(`/${bad}`))
        .set('Authorization', `Bearer ${h.tokenA}`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
    },
  );

  it('a well-formed UUID matching nothing is 404', async () => {
    const res = await request(h.bearer.app)
      .get(url('/11111111-1111-4111-8111-111111111111'))
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(res.status).toBe(404);
  });
});

describe('PF-433 — POST /:id/rotate', () => {
  it('returns a NEW secret once, bumps the version, and kills the old one', async () => {
    const created = await seed(h.tokenA, 'https://example.test/a/rotate');
    const res = await request(h.bearer.app)
      .post(url(`/${created.id}/rotate`))
      .set('Authorization', `Bearer ${h.tokenA}`);

    expect(res.status).toBe(200);
    expect(webhookSubscriptionWithSecretSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.signing_secret).not.toBe(created.signing_secret);
    expect(res.body.secret_version).toBe(2);
    expect(res.body.secret_prefix).toBe(res.body.signing_secret.slice(6, 14));

    // Instant invalidation, no grace period (matching D3 for `client_secret`).
    // The matcher now hands the signer only the new secret.
    const matches = await h.repo.findActiveByEventType('ws-1', 'document.created');
    expect(matches[0]!.signing_secret).toBe(res.body.signing_secret);
    expect(matches[0]!.signing_secret).not.toBe(created.signing_secret);
  });

  it('rotating twice yields three distinct secrets and version 3', async () => {
    const created = await seed(h.tokenA, 'https://example.test/a/rotate-twice');
    const auth = { Authorization: `Bearer ${h.tokenA}` };
    const one = await request(h.bearer.app).post(url(`/${created.id}/rotate`)).set(auth);
    const two = await request(h.bearer.app).post(url(`/${created.id}/rotate`)).set(auth);
    expect(two.body.secret_version).toBe(3);
    expect(
      new Set([created.signing_secret, one.body.signing_secret, two.body.signing_secret]).size,
    ).toBe(3);
  });
});
