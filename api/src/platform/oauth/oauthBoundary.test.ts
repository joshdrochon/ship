/**
 * PF-107 — `/oauth/*` shares NO middleware with the v1 stack, and the audit
 * consequence is written down rather than discovered.
 *
 * Every assertion here runs against the SHIPPED application — `createApp(...)`,
 * the real composition root — not against a router assembled by the test. That
 * is the whole point: the property is about mount position, and a test that
 * builds its own Express app cannot observe mount position at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../app.js';
import { testDeps } from '../../deps.js';

interface InnerLayer {
  route?: { path: string };
}

let app: Express;

/** Every path this app mounts something at, walked from the live Express stack. */
function mountedPaths(a: Express): string[] {
  const stack = (a as unknown as { _router?: { stack: { regexp: RegExp; name: string }[] } })._router
    ?.stack;
  return (stack ?? []).map((layer) => String(layer.regexp));
}

beforeAll(() => {
  app = createApp(testDeps());
});

describe('PF-107 — the OAuth router is a sibling of /api/v1, not a child', () => {
  it('is mounted, and mounted at /oauth', () => {
    // The mount itself. Its absence is the failure mode the whole slice would
    // otherwise ship silently: every unit test passes against a router nothing
    // reaches.
    expect(mountedPaths(app).some((r) => r.includes('oauth'))).toBe(true);
  });

  it('a request to /oauth/token with no Authorization header is NOT 401ed by v1 auth', async () => {
    // `testDeps()` wires `rejectAllBearerAuth`, which 401s everything under
    // /api/v1. If the OAuth router were mounted inside or below it, this would
    // come back 401 with an ApiError envelope instead of an OAuth error.
    const res = await request(app).post('/oauth/token').type('form').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body).not.toHaveProperty('request_id');
    expect(res.body).not.toHaveProperty('code');
  });

  it('the same request under /api/v1 IS 401ed, proving the two stacks differ', async () => {
    // The control. Without it the assertion above could pass because the app is
    // broken rather than because the boundary is correct.
    const res = await request(app).post('/api/v1/token').type('form').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body).toHaveProperty('request_id');
  });

  it('no /oauth path appears in the v1 router', () => {
    // Walks the v1 mount's own sub-stack rather than calling
    // `enumerateV1Routes(app)`.
    //
    // ⚑ CROSS-LANE DEFECT, found here and filed in lane-99-unassigned.md:
    // `enumerateV1Routes` throws `suffix.startsWith is not a function` on any
    // app carrying a RegExp route, and `createApp` mounts exactly one — the SPA
    // fallback — whenever `web/dist` is on disk. So the helper passes on a
    // machine that has not run `pnpm build:web` and throws on one that has,
    // which is an environment-dependent failure rather than a real one.
    // Production boot is unaffected: `assertEveryRouteDeclaresList` runs before
    // the SPA block. Not fixed here because the file is L07/L08's.
    const stack = (app as unknown as {
      _router: { stack: { regexp: RegExp; handle?: { stack?: InnerLayer[] } }[] };
    })._router.stack;

    const v1Mount = stack.find((l) => String(l.regexp).includes('api\\/v1'));
    expect(v1Mount, 'the /api/v1 mount must exist for this assertion to mean anything').toBeDefined();

    const inner = v1Mount!.handle?.stack ?? [];
    for (const layer of inner) {
      expect(String(layer.route?.path ?? '')).not.toContain('oauth');
    }
  });

  it('the internal apiLimiter does not reach /oauth — checked by PATH, not by prefix', async () => {
    // L99 F1: `app.use('/api/', apiLimiter)` is a PATH-PREFIX mount, and the
    // lesson of F1 is that prefix mounts reach further than people expect.
    // `/api/` does not match `/oauth`, but the way to know that is to look for
    // the limiter's fingerprint on an /oauth response, not to reason about it.
    const res = await request(app).post('/oauth/token').type('form').send({});

    // express-rate-limit's OWN headers, in either the standard or the legacy
    // spelling. These are the internal limiter's fingerprint and must not appear.
    expect(res.headers['ratelimit-limit']).toBeUndefined();
    expect(res.headers['ratelimit-remaining']).toBeUndefined();
    expect(res.headers['ratelimit-policy']).toBeUndefined();
    // And not the internal limiter's error body either.
    expect(res.text).not.toContain('Please slow down');

    // `x-ratelimit-limit` USED to be asserted absent here, and under finding F29
    // that assertion was the bug rather than the guard: it certified that
    // `/oauth/*` — a credential-presenting surface — met no rate limit at all.
    // L11 now mounts its own IP-keyed throttle in the composition root, so the
    // X- family is PRESENT and that is the fix. What this test still proves, and
    // the only thing it was ever really about, is that the limiter reaching
    // /oauth is OURS and not the internal one leaking across the boundary.
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
  });

  it('the OAuth router carries its own security headers, not helmet defaults', async () => {
    const res = await request(app).post('/oauth/token').type('form').send({});
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('an /api/v1 response does NOT carry the OAuth router’s headers', async () => {
    // The mirror image. If these matched, the "own headers" assertion above
    // would be measuring helmet rather than this lane.
    const res = await request(app).get('/api/v1/anything');
    expect(res.headers['content-security-policy']).not.toBe("frame-ancestors 'none'");
  });

  it('GET /oauth/authorize is reachable and is NOT swallowed by the SPA fallback', async () => {
    // The SPA fallback in `createApp` is a catch-all GET regexp excluding
    // /api/, /health, /ready and /collaboration — but NOT /oauth. It is only
    // harmless because the OAuth router is mounted above it, and mount order is
    // exactly the kind of thing a later refactor reorders.
    const res = await request(app).get('/oauth/authorize');
    expect(res.status).toBe(400);
    expect(res.text).toContain('client_id');
    expect(res.text).not.toContain('<div id="root">');
  });
});

describe('PF-107 — the terminal error handler for /oauth is this lane’s, not L07’s', () => {
  it('an unhandled throw inside /oauth does not produce an ApiError envelope', async () => {
    // Forced by giving the OAuth router a repository that throws. The assertion
    // is about the BODY SHAPE of the resulting 500: L07's `apiErrorMiddleware`
    // is mounted inside the v1 router and must not be reachable from here.
    const exploding = testDeps({
      appsRepo: {
        findByClientId: () => Promise.reject(new Error('boom')),
      } as unknown as ReturnType<typeof testDeps>['appsRepo'],
    });
    const brokenApp = createApp(exploding);

    const res = await request(brokenApp)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'x', client_secret: 'y' });

    expect(res.status).toBe(500);
    // Express's default handler, not L07's envelope.
    expect(res.body).not.toHaveProperty('request_id');
    expect(res.body).not.toHaveProperty('code');
  });
});

/**
 * The consequence PF-107 asks to be STATED rather than left for someone to
 * find, asserted so that the statement cannot quietly become false.
 */
describe('PF-107 — no public_api_calls row will ever record a token exchange', () => {
  it('the audit sink sees nothing from an /oauth request', async () => {
    const deps = testDeps();
    const auditApp = createApp(deps);
    const sink = deps.auditSink as unknown as { records?: unknown[]; calls?: unknown[] };

    const before = (sink.records ?? sink.calls ?? []).length;
    await request(auditApp).post('/oauth/token').type('form').send({ grant_type: 'nope' });
    const after = (sink.records ?? sink.calls ?? []).length;

    // Not a defect — a consequence of the boundary, and the reason L02's
    // `recordSecretAuth` exists as a separate signal. If a later lane moves
    // /oauth under /api/v1, this test fails, which is the intended trigger to
    // revisit whether that separate signal is still needed.
    expect(after).toBe(before);
  });

  it('an /api/v1 request DOES reach the sink, proving the sink works', async () => {
    const deps = testDeps();
    const auditApp = createApp(deps);
    const sink = deps.auditSink as unknown as { records?: unknown[]; calls?: unknown[] };

    const before = (sink.records ?? sink.calls ?? []).length;
    await request(auditApp).get('/api/v1/anything');
    const after = (sink.records ?? sink.calls ?? []).length;

    expect(after).toBeGreaterThan(before);
  });
});
