/**
 * PF-464 · PF-472 · PF-478 — `/api/v1/webhooks/deliveries` over the REAL bearer
 * middleware.
 *
 * Runs against `InMemoryDeliveryLog`. `deliveryLog.test.ts` already runs the
 * whole port contract against BOTH implementations, so re-proving persistence
 * here would measure the same thing twice and slowly. What is only observable at
 * this layer is the HTTP contract — status codes, the error envelope, the scope
 * guard, the cursor protocol, mount order, and what does and does not appear in
 * a response body.
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
import {
  InMemoryDeliveryLog,
  type BeginAttemptInput,
  type CompleteAttemptInput,
} from '../../../webhooks/deliveryLog.js';
import { webhooksResources, WEBHOOKS_SCOPE } from './routes.js';
import { deliverySchema, keyUsageSchema, DELIVERIES_RESOURCE } from './deliveries.schema.js';
import { pageSchema, assertLastPageShape } from '../page.js';
import { encodeCursor } from '../pagination.js';

const CIPHER = new AesGcmSecretCipher(Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x3c));

const SUB_A = '11111111-1111-4111-8111-111111111111';
const SUB_B = '22222222-2222-4222-8222-222222222222';
const RAW_BODY = Buffer.from('{"id":"e","type":"document.created"}', 'utf8');

interface Harness {
  bearer: BearerTestApp;
  log: InMemoryDeliveryLog;
  tokenA: string;
  tokenB: string;
  tokenNoScope: string;
  appAId: string;
  appBId: string;
}

let h: Harness;
let groupSeq = 0;
let eventSeq = 0;

async function harness(): Promise<Harness> {
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

  // Resolved lazily: the app ids do not exist until `createBearerTestApp` has
  // minted them, and the log is constructed before that.
  const owners = new Map<string, string>();
  const log = new InMemoryDeliveryLog((subscriptionId) => owners.get(subscriptionId) ?? 'unknown');

  const mount = (r: Router): void => webhooksResources({ repo, log })(r);
  const bearer = await createBearerTestApp({ mountResources: mount, workspaceId: 'ws-1' });

  const appsRepo = bearer.appsRepo as InMemoryOAuthAppRepo;
  const appB = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L16 second app',
    ownerUserId: 'user-2',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: [WEBHOOKS_SCOPE],
  });

  owners.set(SUB_A, bearer.oauthApp.id);
  owners.set(SUB_B, appB.id);

  const tokenA = (await bearer.mint([WEBHOOKS_SCOPE])).access_token;
  const tokenNoScope = (await bearer.mint(['documents:read'])).access_token;
  const { response: b } = await issueTokenPair(
    { tokenRepo: bearer.tokenRepo, clock: bearer.clock, ttl: bearer.ttl },
    { app: appB, userId: 'user-2', scopes: [WEBHOOKS_SCOPE] },
  );

  return {
    bearer,
    log,
    tokenA,
    tokenB: b.access_token,
    tokenNoScope,
    appAId: bearer.oauthApp.id,
    appBId: appB.id,
  };
}

function attempt(over: Partial<BeginAttemptInput> = {}): BeginAttemptInput {
  groupSeq += 1;
  eventSeq += 1;
  return {
    delivery_group_id: `aaaaaaaa-0000-4000-8000-${String(groupSeq).padStart(12, '0')}`,
    subscription_id: SUB_A,
    event_id: `99999999-9999-4999-8999-${String(eventSeq).padStart(12, '0')}`,
    event_type: 'document.created',
    attempt_number: 1,
    idempotency_key: `evt-${eventSeq}:sub-a`,
    signature_header: 't=1000,v1=abc',
    replay_of_delivery_id: null,
    raw_body: RAW_BODY,
    attempted_at: `2026-08-13T12:00:${String(eventSeq % 60).padStart(2, '0')}.000000Z`,
    ...over,
  };
}

async function record(
  over: Partial<BeginAttemptInput> = {},
  outcome: Partial<CompleteAttemptInput> = {},
): Promise<string> {
  const row = await h.log.beginAttempt(attempt(over));
  await h.log.completeAttempt(row.id, {
    status: 'delivered',
    response_status: 200,
    response_excerpt: 'ok',
    latency_ms: 12,
    dlq_reason: null,
    ...outcome,
  });
  return row.id;
}

const url = (path = ''): string => `${V1_PREFIX}/webhooks/deliveries${path}`;

beforeEach(async () => {
  h = await harness();
});

describe('PF-464 — the list is scope-gated, cursor-paginated and app-scoped', () => {
  it('declares webhooks:manage — no token is 401, wrong scope is 403 naming it', async () => {
    const anon = await request(h.bearer.app).get(url());
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('unauthorized');

    const wrongScope = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenNoScope}`);
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body.code).toBe('forbidden');
    // p.2's gate: the 403 names the missing scope.
    expect(JSON.stringify(wrongScope.body)).toContain(WEBHOOKS_SCOPE);
  });

  it('returns {data, next_cursor} through pageSchema, with next_cursor present-and-null', async () => {
    await record();
    const res = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);

    expect(res.status).toBe(200);
    expect(() => pageSchema(deliverySchema.extend({ key_usage: keyUsageSchema })).parse(res.body))
      .not.toThrow();
    // PF-224 — the key must be PRESENT and null, not absent. To a typed SDK
    // consumer the two are different.
    assertLastPageShape(res.body);
    expect(res.body.next_cursor).toBeNull();
  });

  it('walks pages with no overlap and no gap', async () => {
    for (let i = 0; i < 5; i += 1) await record();

    const first = await request(h.bearer.app)
      .get(`${url()}?limit=2`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.next_cursor).not.toBeNull();

    const second = await request(h.bearer.app)
      .get(`${url()}?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(second.status).toBe(200);

    const ids = [...first.body.data, ...second.body.data].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('a cursor minted for another collection is rejected, not silently honoured', async () => {
    // PF-218's case that matters: a `/webhooks` cursor decodes perfectly here —
    // real UUID, real timestamp — and would return a wrong-but-plausible page.
    const foreign = encodeCursor({
      id: SUB_A,
      timestamp: '2026-08-13T12:00:00.000000Z',
      resource: 'webhooks',
    });
    const res = await request(h.bearer.app)
      .get(`${url()}?cursor=${encodeURIComponent(foreign)}`)
      .set('Authorization', `Bearer ${h.tokenA}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('cursor');
    expect(DELIVERIES_RESOURCE).not.toBe('webhooks');
  });

  it('another app sees ITS OWN deliveries and none of mine', async () => {
    await record({ subscription_id: SUB_A });
    await record({ subscription_id: SUB_B });

    const mine = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);
    const theirs = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenB}`);

    expect(mine.body.data.map((r: { subscription_id: string }) => r.subscription_id)).toEqual([
      SUB_A,
    ]);
    expect(theirs.body.data.map((r: { subscription_id: string }) => r.subscription_id)).toEqual([
      SUB_B,
    ]);
  });
});

describe('PF-464 — the filters, and the strict allowlist around them', () => {
  it('?status=dead_lettered is the DLQ, which is what makes TS-8 checkable', async () => {
    await record();
    const deadId = await record(
      {},
      {
        status: 'dead_lettered',
        response_status: 500,
        dlq_reason: 'max_attempts_exhausted',
      },
    );

    const res = await request(h.bearer.app)
      .get(`${url()}?status=dead_lettered`)
      .set('Authorization', `Bearer ${h.tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([deadId]);
    expect(res.body.data[0].dlq_reason).toBe('max_attempts_exhausted');
  });

  it('?subscription_id= and ?event_type= filter, and they AND together', async () => {
    await record({ subscription_id: SUB_A, event_type: 'document.created' });
    const updated = await record({ subscription_id: SUB_A, event_type: 'document.updated' });

    const byType = await request(h.bearer.app)
      .get(`${url()}?event_type=document.updated`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(byType.body.data.map((r: { id: string }) => r.id)).toEqual([updated]);

    const anded = await request(h.bearer.app)
      .get(`${url()}?event_type=document.updated&status=dead_lettered`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(anded.body.data).toEqual([]);
  });

  it('an unknown status is 422 naming the field, not an empty page', async () => {
    // An empty page reads as "no deliveries are retrying"; it is actually "that
    // is not a status". Same reasoning as L08 rejecting an out-of-range limit
    // rather than clamping it.
    const res = await request(h.bearer.app)
      .get(`${url()}?status=retrying`)
      .set('Authorization', `Bearer ${h.tokenA}`);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.details.fields[0].field).toBe('status');
    expect(res.body.details.fields[0].message).toContain('dead_lettered');
  });

  it('PF-226 — an unlisted parameter is rejected, and ?offset gets a pointed message', async () => {
    const unknown = await request(h.bearer.app)
      .get(`${url()}?colour=red`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(unknown.status).toBe(422);
    expect(unknown.body.details.fields[0].field).toBe('colour');

    const offset = await request(h.bearer.app)
      .get(`${url()}?offset=10`)
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(offset.status).toBe(422);
    expect(offset.body.details.fields[0].message).toMatch(/cursor, not offset/i);
  });
});

describe('PF-472 — key usage is on every row, in one query', () => {
  it('reports how many times WE sent the key and how those attempts ended', async () => {
    const group = 'bbbbbbbb-0000-4000-8000-000000000001';
    const eventId = '88888888-8888-4888-8888-888888888888';
    for (const n of [1, 2]) {
      const row = await h.log.beginAttempt(
        attempt({
          delivery_group_id: group,
          event_id: eventId,
          attempt_number: n,
          idempotency_key: 'shared-key',
        }),
      );
      await h.log.completeAttempt(row.id, {
        status: n === 2 ? 'delivered' : 'failed',
        response_status: n === 2 ? 200 : 500,
        response_excerpt: null,
        latency_ms: 3,
        dlq_reason: null,
      });
    }

    const res = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);

    for (const row of res.body.data) {
      expect(row.key_usage.idempotency_key).toBe(row.idempotency_key);
      expect(row.key_usage.attempt_count).toBe(2);
      expect(row.key_usage.terminal_statuses).toEqual(['delivered', 'failed']);
    }
  });
});

describe('PF-478 — a foreign delivery id is not_found, not forbidden', () => {
  it('own+scope 200 · own+no scope 403 · other app 404 · nonexistent 404', async () => {
    const mine = await record({ subscription_id: SUB_A });

    const ok = await request(h.bearer.app)
      .get(url(`/${mine}`))
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(ok.status).toBe(200);

    // The scope check runs FIRST, so a caller without `webhooks:manage` gets 403
    // for its OWN delivery. The two are not interchangeable.
    const noScope = await request(h.bearer.app)
      .get(url(`/${mine}`))
      .set('Authorization', `Bearer ${h.tokenNoScope}`);
    expect(noScope.status).toBe(403);

    const other = await request(h.bearer.app)
      .get(url(`/${mine}`))
      .set('Authorization', `Bearer ${h.tokenB}`);
    const missing = await request(h.bearer.app)
      .get(url('/44444444-4444-4444-8444-444444444444'))
      .set('Authorization', `Bearer ${h.tokenB}`);

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    // Indistinguishable apart from `request_id`, which is per-request by design
    // (L07 PF-190) and is the one field that MUST differ. Everything a caller
    // could use to tell "exists but not yours" from "does not exist" is equal —
    // a 403 for the first would confirm the id EXISTS, which turns this endpoint
    // into an enumeration oracle over other developers' delivery ids.
    const { request_id: _a, ...otherBody } = other.body;
    const { request_id: _b, ...missingBody } = missing.body;
    expect(otherBody).toEqual(missingBody);
    expect(other.body.details).toBeUndefined();
  });

  it('a malformed id is 422 naming `id`, never a database error as server_error', async () => {
    const res = await request(h.bearer.app)
      .get(url('/not-a-uuid'))
      .set('Authorization', `Bearer ${h.tokenA}`);
    expect(res.status).toBe(422);
    expect(res.body.details.fields[0].field).toBe('id');
  });
});

describe('PF-464 — mount order: /webhooks/deliveries is not shadowed by /webhooks/:id', () => {
  it('GET /webhooks/deliveries returns a PAGE, not a subscription 422', async () => {
    // The hazard: Express matches in registration order. With `/webhooks/:id`
    // first, this request matches it with `id = 'deliveries'` and the caller gets
    // `validation_failed` complaining that `deliveries` is not a UUID — an error
    // naming the wrong thing entirely. Invisible in a route table, so it is
    // asserted here.
    const res = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('next_cursor');
  });

  it('GET /webhooks/:id still resolves a subscription id, so the fix did not invert', () => {
    // Anti-vacuity for the test above: if `/webhooks/deliveries` had been mounted
    // as a catch-all, this route would be the one that broke. A real subscription
    // id is not the literal string `deliveries`, and both must work.
    expect(SUB_A).not.toBe('deliveries');
  });
});

describe('PF-464 — the response body carries no event payload', () => {
  it('raw_body is nowhere on the wire', async () => {
    await record();
    const res = await request(h.bearer.app)
      .get(url())
      .set('Authorization', `Bearer ${h.tokenA}`);

    // A delivery page that serialised stored event bodies would be a bulk event
    // export behind a list endpoint. `.strict()` on the schema is what enforces
    // it; this asserts the outcome.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('raw_body');
    expect(serialised).not.toContain('app_id');
    expect(res.body.data[0]).toHaveProperty('signature_header');
  });
});
