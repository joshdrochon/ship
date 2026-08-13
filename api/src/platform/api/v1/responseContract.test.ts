/**
 * PF-360 — the declared response schema is the object the handler actually
 * returns.
 *
 * The acceptance criterion is the negative case: *"a test that adds an
 * undeclared field to a handler's return value makes the request **fail**, not
 * pass."* Without this, a spec entry can exist and still lie, and PF-373's
 * parity test would stay green forever.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { z } from 'zod';
import { createTestPublicApp, V1_PREFIX } from './testSupport.js';
import { responseContract, isResponseContractEnforced } from './responseContract.js';

const bodySchema = z.object({ id: z.string(), title: z.string() }).strict();

function appWith(handler: (router: Router) => void) {
  return createTestPublicApp({
    scopes: ['documents:read'],
    mountResources: handler,
  }).app;
}

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('PF-360 — a handler cannot silently drift from its declared response', () => {
  it('a conforming body passes through untouched', async () => {
    const app = appWith((router) => {
      router.get('/thing', responseContract(bodySchema, 'GET /thing'), (_req, res) => {
        res.json({ id: 'a', title: 'b' });
      });
    });

    const res = await request(app).get(`${V1_PREFIX}/thing`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'a', title: 'b' });
  });

  it('an UNDECLARED field makes the request fail — this is the whole ticket', async () => {
    const app = appWith((router) => {
      router.get('/thing', responseContract(bodySchema, 'GET /thing'), (_req, res) => {
        // `internal_position` is exactly the class of leak PF-252's allowlist
        // exists to prevent, arriving through the handler instead of the query.
        res.json({ id: 'a', title: 'b', internal_position: 42 });
      });
    });

    const res = await request(app).get(`${V1_PREFIX}/thing`);
    expect(
      res.status,
      'A handler that returns more than it declared has changed the public contract ' +
        'without anyone saying so.',
    ).toBe(500);
    expect(res.body.code).toBe('server_error');
  });

  it('a MISSING declared field fails too — drift in the other direction', async () => {
    const app = appWith((router) => {
      router.get('/thing', responseContract(bodySchema, 'GET /thing'), (_req, res) => {
        res.json({ id: 'a' });
      });
    });

    expect((await request(app).get(`${V1_PREFIX}/thing`)).status).toBe(500);
  });

  it('a WRONG-TYPED field fails', async () => {
    const app = appWith((router) => {
      router.get('/thing', responseContract(bodySchema, 'GET /thing'), (_req, res) => {
        res.json({ id: 'a', title: 7 });
      });
    });

    expect((await request(app).get(`${V1_PREFIX}/thing`)).status).toBe(500);
  });

  it('does NOT check error bodies — those are apiErrorBodySchema\'s shape, not this one', async () => {
    const app = appWith((router) => {
      router.get('/thing', responseContract(bodySchema, 'GET /thing'), (_req, res) => {
        // A 404 envelope is not a `{id,title}`; checking it here would fail
        // every error path on every route.
        res.status(404).json({ code: 'not_found', message: 'nope', request_id: 'r' });
      });
    });

    const res = await request(app).get(`${V1_PREFIX}/thing`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
  });

  it('production is log-only — the +10% P95 budget (p.6) buys the difference', async () => {
    // The decision, asserted rather than described. Production serves the body
    // and shouts; test and dev throw. A violation reaching production means the
    // test suite has a hole, and turning that into a 500 for a paying consumer
    // makes a documentation bug into an outage.
    process.env.NODE_ENV = 'production';
    expect(isResponseContractEnforced()).toBe(false);

    const app = appWith((router) => {
      router.get('/thing', responseContract(bodySchema, 'GET /thing'), (_req, res) => {
        res.json({ id: 'a', title: 'b', undeclared: true });
      });
    });

    const res = await request(app).get(`${V1_PREFIX}/thing`);
    expect(res.status).toBe(200);
    expect(res.body.undeclared).toBe(true);
  });

  it('is enforced under test and dev', () => {
    process.env.NODE_ENV = 'test';
    expect(isResponseContractEnforced()).toBe(true);
    process.env.NODE_ENV = 'development';
    expect(isResponseContractEnforced()).toBe(true);
  });
});

describe('PF-360 — over the REAL documents routes', () => {
  it('the list route is wrapped: its guard installs the contract layer', async () => {
    // Structural, not behavioural: the behavioural half is
    // `documents.routes.test.ts`, which drives the real handlers against a real
    // database and would 500 on any drift. This asserts the wiring exists at
    // all, which is what a future refactor would silently remove.
    const { default: fs } = await import('node:fs');
    const source = fs.readFileSync(new URL('./declareV1Route.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/responseContract\(declaration\.response/);
  });
});
