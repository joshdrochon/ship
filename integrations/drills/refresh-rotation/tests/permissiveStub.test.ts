/**
 * PF-727's anti-vacuity clause: *"pointed at a stub token endpoint that
 * cheerfully accepts a reused refresh token, the drill **fails**. A drill that
 * cannot fail is a screenshot."*
 *
 * This is the same `runRotationDrill` and the same `rotationViolations` that
 * `rotation.test.ts` runs against a real Ship. Only the target changes. That is
 * what makes it evidence rather than a second, weaker test: if somebody softens
 * an assertion to make the real run green, this run goes green too and says so.
 *
 * ── The stub is the SHARED listener, not a second server ───────────────────
 * PF-721 permits exactly one listener implementation across `integrations/**`,
 * and `oneListener.test.ts` enforces it. A permissive OAuth server is just a
 * programmed reply, so it is `createTestListener` with a router in the handler.
 *
 * ── This file needs no booted Ship ─────────────────────────────────────────
 * Which is deliberate: the anti-vacuity proof should not be able to fail for
 * environmental reasons. It runs on a laptop with no database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestListener, type TestListener } from '@ship/integration-testkit';
import {
  rotationViolations,
  runRotationDrill,
  type RotationObservations,
} from '../src/drill.js';

let stub: TestListener;
let observed: RotationObservations;
let issued = 0;

beforeAll(async () => {
  stub = await createTestListener();

  stub.respondWith((request) => {
    const path = request.url.split('?')[0] ?? '';

    // A token endpoint with no memory: every refresh token, spent or invented,
    // buys a fresh pair. This is exactly the platform p.3 forbids.
    if (path.endsWith('/oauth/token')) {
      issued += 1;
      return {
        status: 200,
        body: JSON.stringify({
          access_token: `stub_access_${issued}`,
          refresh_token: `stub_refresh_${issued}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'documents:read',
        }),
      };
    }

    // Every bearer token works forever, including one from a revoked family.
    if (path.endsWith('/me')) {
      return { status: 200, body: JSON.stringify({ id: 'usr_stub', email: 'stub@example.test' }) };
    }

    return { status: 404, body: JSON.stringify({ error: 'not_found' }) };
  });

  const target = { baseUrl: stub.url, clientId: 'stub_client' };
  const pair = {
    accessToken: 'stub_access_0',
    refreshToken: 'stub_refresh_0',
    expiresAtSeconds: null,
    scopes: ['documents:read'],
  };

  observed = await runRotationDrill({
    target,
    sessionA: pair,
    sessionB: { ...pair, accessToken: 'stub_access_b', refreshToken: 'stub_refresh_b' },
    expiredPair: {
      target,
      tokens: { ...pair, accessToken: 'stub_access_x', refreshToken: 'stub_refresh_x' },
    },
    unknownRefreshToken: 'stub_refresh_never_issued',
  });
}, 60_000);

afterAll(async () => {
  await stub?.close();
});

describe('PF-727 — the drill goes red against a permissive server', () => {
  it('reports violations rather than passing', () => {
    const problems = rotationViolations(observed);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('names the one-time-use failure specifically', () => {
    expect(rotationViolations(observed).join('\n')).toContain('presenting the SAME refresh token');
  });

  it('names the family-revocation failure — both halves of it', () => {
    const text = rotationViolations(observed).join('\n');
    expect(text).toContain('R3 still exchanges');
    expect(text).toContain('not 401');
  });

  it('names the distinguishability failure: one body for all three cases', () => {
    // The stub answers 200 to everything, so the three "failures" are not
    // failures at all — which is caught before the body comparison is reached.
    expect(rotationViolations(observed).join('\n')).toContain("SUCCEEDED. It is not a failure");
  });

  it('the stub really was reached, so the run is not failing for want of a server', () => {
    expect(issued).toBeGreaterThan(4);
  });
});
