/**
 * L07 S2 — `request_id` originates in exactly one place and reaches body,
 * header and audit row.
 *
 * PF-190 (mint, first in the stack), PF-191 (header on 2xx and failures, equal
 * to the body), PF-192 (inbound header ignored), PF-193 (audit handoff).
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { REQUEST_ID_HEADER } from './requestId.js';
import { createTestPublicApp, V1_PREFIX } from './testSupport.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('PF-190 — a UUID per request, minted before bearer auth', () => {
  it('a 401 from an UNAUTHENTICATED request still carries a request_id', () => {
    // The ordering proof. If requestIdMiddleware sat below bearer auth, this
    // request would never reach it and the body would have no id — which is
    // exactly the request an integrator is most likely to send us first.
    return request(createTestPublicApp({ auth: null }).app)
      .get(`${V1_PREFIX}/anything`)
      .expect(401)
      .expect((res) => {
        expect(res.body.code).toBe('unauthorized');
        expect(res.body.request_id).toMatch(UUID_V4);
      });
  });

  it('mints a distinct id per request over 1000 sequential requests', async () => {
    const { app } = createTestPublicApp({ auth: null });
    // One long-lived server rather than `request(app)` per call: supertest binds
    // a fresh ephemeral port for every invocation, and 1000 of those exhausts
    // the local port range and fails with "socket hang up" — a property of the
    // test harness, not of the middleware.
    const server = app.listen(0);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const res = await request(server).get(`${V1_PREFIX}/anything`);
        seen.add(res.body.request_id as string);
      }
      expect(seen.size, 'request ids collided — they are audit-trail keys').toBe(1000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('PF-191 — X-Request-Id on every response', () => {
  it('is present on a 2xx', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get('/ok', (_req, res) => {
          res.json({ data: [] });
        });
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/ok`).expect(200);
    expect(res.headers['x-request-id']).toMatch(UUID_V4);
  });

  it('is present on a failure AND string-equals the body request_id', async () => {
    // The grader-reads-a-500 case: one id, quotable back to us from either place.
    const res = await request(createTestPublicApp({ auth: null }).app)
      .get(`${V1_PREFIX}/anything`)
      .expect(401);

    expect(res.headers['x-request-id']).toMatch(UUID_V4);
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
  });

  it('uses the canonical header name', () => {
    expect(REQUEST_ID_HEADER).toBe('X-Request-Id');
  });
});

describe('PF-192 — inbound X-Request-Id is ignored, never echoed', () => {
  it('replaces an attacker-chosen id in both header and body', async () => {
    const attacker = 'attacker-chosen-id';

    const res = await request(createTestPublicApp({ auth: null }).app)
      .get(`${V1_PREFIX}/anything`)
      .set(REQUEST_ID_HEADER, attacker)
      .expect(401);

    expect(res.headers['x-request-id']).not.toBe(attacker);
    expect(res.body.request_id).not.toBe(attacker);
    expect(res.headers['x-request-id']).toMatch(UUID_V4);
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
  });

  it('two requests sending the SAME inbound id still get distinct ids', async () => {
    // The collision attack the decision is actually defending against: if the
    // client picked the key, it could file two different calls under one row.
    const { app } = createTestPublicApp({ auth: null });
    const send = () =>
      request(app).get(`${V1_PREFIX}/anything`).set(REQUEST_ID_HEADER, 'same-every-time');

    const [a, b] = await Promise.all([send(), send()]);
    expect(a.body.request_id).not.toBe(b.body.request_id);
  });
});

describe('PF-193 — the audit sink consumes the id and never mints its own', () => {
  it("records the request_id, never the 'unknown' fallback — including on a 401", async () => {
    const { app, auditSink } = createTestPublicApp({ auth: null });

    const res = await request(app).get(`${V1_PREFIX}/anything`).expect(401);

    // `res.on('finish')` may land a tick after supertest resolves.
    await new Promise((resolve) => setImmediate(resolve));

    expect(auditSink.records.length).toBeGreaterThan(0);
    for (const record of auditSink.records) {
      expect(record.requestId, "audit row fell back to 'unknown'").not.toBe('unknown');
      expect(record.requestId).toMatch(UUID_V4);
    }
    expect(auditSink.records.at(-1)?.requestId).toBe(res.body.request_id);
  });

  it('records the request_id on a 500 too', async () => {
    const { app, auditSink } = createTestPublicApp({
      mountResources: (router) => {
        router.get('/boom', () => {
          throw new Error('kaboom');
        });
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/boom`).expect(500);
    await new Promise((resolve) => setImmediate(resolve));

    const record = auditSink.records.at(-1);
    expect(record?.requestId).not.toBe('unknown');
    expect(record?.requestId).toBe(res.body.request_id);
    expect(record?.status).toBe(500);
  });
});
