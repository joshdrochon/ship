/**
 * L99 F38 — the public surface's CORS policy. L24, PF-733/PF-734.
 *
 * Two things are asserted here and they fail differently:
 *
 *   the BEHAVIOUR of the middleware, over HTTP; and
 *   its POSITION in `V1_MIDDLEWARE_ORDER`, which is the half a behavioural test
 *   cannot see — a correct middleware mounted below `bearerAuth` produces a
 *   401 with no CORS headers, which a browser reports as an opaque network
 *   error rather than as "you are not authenticated".
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { publicCors } from './publicCors.js';
import { V1_MIDDLEWARE_ORDER } from './api/v1/middlewareOrder.js';

function app() {
  const server = express();
  server.use(publicCors());
  server.get('/thing', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  server.get('/boom', (_req, res) => {
    res.status(401).json({ code: 'unauthorized' });
  });
  return server;
}

describe('publicCors · a browser can call the public API', () => {
  it('answers a preflight with 204 and terminates it', async () => {
    const res = await request(app())
      .options('/thing')
      .set('Origin', 'https://someone-elses-app.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('exposes the rate-limit triple and the request id to a cross-origin reader', async () => {
    const res = await request(app()).get('/thing').set('Origin', 'https://someone-elses-app.example');

    // p.4 requires public responses to CARRY these. Without an expose list a
    // browser consumer cannot READ them, so `client.rateLimit` would be null
    // forever in a browser and PF-512 would silently mean nothing there.
    const exposed = res.headers['access-control-expose-headers'] ?? '';
    for (const header of [
      'X-Request-Id',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'Retry-After',
    ]) {
      expect(exposed).toContain(header);
    }
  });

  it('never sends Allow-Credentials — the wildcard must stay credential-free', async () => {
    // Structural, not stylistic: a browser refuses to pair `*` with
    // credentials, so this combination cannot be widened into the dangerous one
    // by an edit that only touches origins.
    const preflight = await request(app()).options('/thing').set('Origin', 'https://x.example');
    const simple = await request(app()).get('/thing').set('Origin', 'https://x.example');

    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    expect(simple.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('puts the headers on an ERROR response too', async () => {
    const res = await request(app()).get('/boom').set('Origin', 'https://x.example');

    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('varies on Origin, so a cache cannot serve the policy as origin-independent', async () => {
    const res = await request(app()).get('/thing').set('Origin', 'https://x.example');
    expect(res.headers['vary'] ?? '').toContain('Origin');
  });
});

describe('publicCors · position in the public stack', () => {
  it('is declared in V1_MIDDLEWARE_ORDER', () => {
    expect(V1_MIDDLEWARE_ORDER.map((entry) => entry.name)).toContain('v1_public_cors');
  });

  it('sits ABOVE every layer that can terminate a request', () => {
    const names = V1_MIDDLEWARE_ORDER.map((entry) => entry.name);
    const cors = names.indexOf('v1_public_cors');

    for (const below of [
      'v1_body_parser',
      'v1_bearer_auth',
      'v1_anon_rate_limit',
      'v1_not_found',
    ]) {
      const index = names.indexOf(below);
      if (index >= 0) {
        expect(cors, `${below} must not be able to answer before CORS headers are set`).toBeLessThan(
          index,
        );
      }
    }
  });

  it('sits BELOW audit, so a preflight is still recorded', () => {
    // p.4: "every public API call recorded", with no exception list. Same shape
    // as the spec route's null-clientId row (L99 F42).
    const names = V1_MIDDLEWARE_ORDER.map((entry) => entry.name);
    expect(names.indexOf('v1_audit')).toBeLessThan(names.indexOf('v1_public_cors'));
  });
});
