/**
 * PF-159–162, PF-164 — the bearer middleware's behaviour, against a booted app
 * with the REAL middleware in it (`createBearerTestApp`, not L07's stub).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Router } from 'express';
import { apiErrorBodySchema, UNAUTHORIZED_REASONS } from '../api/v1/errors.js';
import { createBearerTestApp, type BearerTestApp } from './bearerTestSupport.js';
import { parseBearerHeader } from './bearer.js';

/** One protected resource, standing in for the routes L09/L10 will mount. */
const mountResources = (router: Router): void => {
  router.get('/things', (_req, res) => {
    res.json({ data: [], next_cursor: null });
  });
  router.get('/whoami', (_req, res) => {
    res.json(res.locals.platformAuth);
  });
};

let harness: BearerTestApp;

beforeEach(async () => {
  harness = await createBearerTestApp({ mountResources, scopes: ['documents:read'] });
});

describe('PF-159: a MISSING token is 401', () => {
  it('returns 401 with details.reason = "missing"', async () => {
    const res = await request(harness.app).get('/api/v1/things');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.details).toEqual({ reason: 'missing' });
  });

  it('ships L07’s envelope, schema-valid, with a request_id', async () => {
    const res = await request(harness.app).get('/api/v1/things');
    const parsed = apiErrorBodySchema.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.request_id).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
  });

  it('carries a bare RFC 6750 §3 Bearer challenge', async () => {
    const res = await request(harness.app).get('/api/v1/things');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('is 401 and not 403 — the distinction an SDK uses to refresh vs re-consent', async () => {
    const res = await request(harness.app).get('/api/v1/things');
    expect(res.status).toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('is audited — L07 moved audit ABOVE auth so 401s stop being invisible', async () => {
    await request(harness.app).get('/api/v1/things');
    expect(harness.auditSink.records).toHaveLength(1);
    expect(harness.auditSink.records[0]!.status).toBe(401);
  });
});

describe('PF-160: an INVALID token is 401, and the five cases are indistinguishable', () => {
  it('answers unknown, revoked, family-revoked, malformed and wrong-type identically', async () => {
    const live = await harness.mint();
    const other = await harness.mint();

    // 2: individually revoked.
    const revokedRow = await harness.tokenRepo.findByHash(
      (await import('./tokens.js')).hashToken(live.access_token),
    );
    await harness.tokenRepo.revokeFamily(
      revokedRow!.familyId,
      'app_revoked',
      new Date(harness.clock.nowMs()),
    );

    // 3: family revoked by the theft signal.
    const otherRow = await harness.tokenRepo.findByHash(
      (await import('./tokens.js')).hashToken(other.access_token),
    );
    await harness.tokenRepo.revokeFamily(
      otherRow!.familyId,
      'refresh_token_reuse',
      new Date(harness.clock.nowMs()),
    );

    const credentials = [
      'ship_at_totally-unknown-token-value-here', // 1: unknown
      live.access_token, // 2: revoked
      other.access_token, // 3: family revoked
      'not-a-token-at-all', // 4: malformed
      (await harness.mint()).refresh_token, // 5: a REFRESH token as bearer
    ];

    const bodies: string[] = [];
    for (const credential of credentials) {
      const res = await request(harness.app)
        .get('/api/v1/things')
        .set('Authorization', `Bearer ${credential}`);
      expect(res.status).toBe(401);
      expect(res.body.details).toEqual({ reason: 'invalid' });
      // Strip request_id, which is per-request by design, then compare the rest
      // byte for byte. Any split between the five would make the API a token
      // oracle.
      const { request_id: _ignored, ...rest } = res.body;
      bodies.push(JSON.stringify(rest));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it('never echoes the presented token back in the response', async () => {
    const secret = 'ship_at_super-secret-value-that-must-not-appear';
    const res = await request(harness.app)
      .get('/api/v1/things')
      .set('Authorization', `Bearer ${secret}`);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.headers)).not.toContain(secret);
  });
});

describe('PF-161: an EXPIRED token is 401 with a distinct, machine-readable reason', () => {
  it('reports details.reason = "expired" once the TTL has passed', async () => {
    const short = await createBearerTestApp({
      mountResources,
      ttl: { accessSeconds: 2, refreshSeconds: 5 },
    });
    const tokens = await short.mint();

    // Live first — otherwise this could pass for the wrong reason.
    const before = await request(short.app)
      .get('/api/v1/things')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(before.status).toBe(200);

    // PF-173: expiry by advancing an injected clock, never by waiting.
    short.clock.advance(3000);

    const after = await request(short.app)
      .get('/api/v1/things')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(after.status).toBe(401);
    expect(after.body.details).toEqual({ reason: 'expired' });
  });

  it('carries the RFC 6750 §3.1 challenge naming the expiry', async () => {
    const short = await createBearerTestApp({
      mountResources,
      ttl: { accessSeconds: 2, refreshSeconds: 5 },
    });
    const tokens = await short.mint();
    short.clock.advance(3000);
    const res = await request(short.app)
      .get('/api/v1/things')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer error="invalid_token", error_description="The access token expired"',
    );
  });

  it('keeps the ApiErrorCode union closed at six — no seventh member', async () => {
    const { API_ERROR_CODES } = await import('../api/v1/errors.js');
    expect(API_ERROR_CODES).toHaveLength(6);
    expect(API_ERROR_CODES).not.toContain('token_expired');
  });

  it('the three reasons are pairwise distinct and all are code: unauthorized', async () => {
    const short = await createBearerTestApp({
      mountResources,
      ttl: { accessSeconds: 2, refreshSeconds: 5 },
    });
    const tokens = await short.mint();
    short.clock.advance(3000);

    const cases = [
      { name: 'missing', header: undefined },
      { name: 'invalid', header: 'Bearer ship_at_nope' },
      { name: 'expired', header: `Bearer ${tokens.access_token}` },
    ];

    const seen: string[] = [];
    for (const c of cases) {
      const req = request(short.app).get('/api/v1/things');
      if (c.header) req.set('Authorization', c.header);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
      expect(apiErrorBodySchema.safeParse(res.body).success).toBe(true);
      expect(res.body.details.reason).toBe(c.name);
      seen.push(res.body.details.reason);
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('uses only reasons L07’s closed enum permits', () => {
    expect([...UNAUTHORIZED_REASONS].sort()).toEqual(['expired', 'invalid', 'missing']);
  });
});

describe('PF-162: header parsing is RFC-correct and never 500s', () => {
  const table: { name: string; header?: string; expectReason: 'missing' | 'invalid' }[] = [
    { name: 'absent', expectReason: 'missing' },
    { name: 'empty string', header: '', expectReason: 'missing' },
    { name: 'Bearer with no value', header: 'Bearer', expectReason: 'missing' },
    { name: 'Bearer with trailing space only', header: 'Bearer   ', expectReason: 'missing' },
    { name: 'a different scheme', header: 'Basic dXNlcjpwYXNz', expectReason: 'missing' },
    { name: 'lowercase scheme (RFC 7235 §2.1)', header: 'bearer ship_at_x', expectReason: 'invalid' },
    { name: 'MiXeD case scheme', header: 'BeArEr ship_at_x', expectReason: 'invalid' },
    { name: 'leading and trailing whitespace', header: '   Bearer   ship_at_x   ', expectReason: 'invalid' },
    { name: 'a scheme with no space', header: 'Bearership_at_x', expectReason: 'missing' },
  ];

  for (const row of table) {
    it(`${row.name} → 401 (${row.expectReason}), never 500`, async () => {
      const req = request(harness.app).get('/api/v1/things');
      if (row.header !== undefined) req.set('Authorization', row.header);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(500);
      expect(res.body.details).toEqual({ reason: row.expectReason });
      // A 500 here would report a client error as a platform fault and pollute
      // the audit trail's status column.
      expect(res.body.code).toBe('unauthorized');
      expect(res.body.code).not.toBe('server_error');
    });
  }

  it('two Authorization headers do not 500 — Node keeps the first', async () => {
    const res = await request(harness.app)
      .get('/api/v1/things')
      .set('Authorization', 'Bearer ship_at_first')
      .set('Authorization', 'Bearer ship_at_second');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });

  it('a 64 KB header value does not 500', () => {
    // Driven through the parser directly rather than over HTTP: Node's default
    // max header size is 16 KB, so a 64 KB header is rejected by the HTTP parser
    // before any middleware runs. That is the server's own limit doing its job;
    // what this lane owes is that the PARSER does not blow up on the value.
    const huge = `Bearer ${'a'.repeat(64 * 1024)}`;
    expect(() => parseBearerHeader(huge)).not.toThrow();
    expect(parseBearerHeader(huge)).toHaveLength(64 * 1024);
  });

  it('parses to null for every no-credential shape', () => {
    for (const input of [undefined, '', '   ', 'Bearer', 'Bearer ', 'Basic abc', 'Bearerabc']) {
      expect(parseBearerHeader(input)).toBeNull();
    }
  });
});

describe('PF-158: a resolved token populates app, user and granted scopes', () => {
  it('writes a PlatformAuthContext onto res.locals', async () => {
    const tokens = await harness.mint(['documents:read', 'issues:read']);
    const res = await request(harness.app)
      .get('/api/v1/whoami')
      .set('Authorization', `Bearer ${tokens.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      appId: harness.oauthApp.id,
      clientId: harness.oauthApp.clientId,
      userId: 'user-1',
      scopes: ['documents:read', 'issues:read'],
      tokenId: expect.any(String),
    });
  });
});

describe('PF-164: the public bearer path NEVER falls back to session auth', () => {
  it('401s a request carrying only a session cookie', async () => {
    const res = await request(harness.app)
      .get('/api/v1/things')
      .set('Cookie', 'session_id=a-perfectly-valid-looking-session');
    expect(res.status).toBe(401);
    expect(res.body.details).toEqual({ reason: 'missing' });
  });

  it('401s a request with a valid session cookie AND an invalid bearer token', async () => {
    const res = await request(harness.app)
      .get('/api/v1/things')
      .set('Cookie', 'session_id=a-perfectly-valid-looking-session')
      .set('Authorization', 'Bearer ship_at_not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.details).toEqual({ reason: 'invalid' });
  });

  it('reads no cookie at all — the absence is the feature', async () => {
    const { scanDirectory } = await import('../../test/sourceScan.js');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const bearer = scanDirectory(here).find((f) => f.name === 'bearer.ts');
    expect(bearer).toBeDefined();
    expect(bearer!.code).not.toContain('cookie');
    expect(bearer!.code).not.toContain('session');
  });
});
