/**
 * L07 S3 — every v1 failure leaves in the envelope, however it was raised.
 *
 * PF-194 (one terminal handler, v1 only), PF-195 (async rejections — finding F4),
 * PF-196 (unhandled exceptions leak nothing), PF-197 (unknown path → JSON).
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { ApiError } from './errors.js';
import {
  apiErrorMiddleware,
  asyncRoute,
  isBareAsyncHandler,
  GENERIC_SERVER_ERROR_MESSAGE,
} from './errorMiddleware.js';
import { createTestPublicApp, V1_PREFIX } from './testSupport.js';

/**
 * A fixed id so the log line and the response body can be asserted to carry the
 * same one. It has to be a real UUID: `apiErrorBodySchema` requires it, and the
 * middleware's PF-199 self-check logs a second time when the envelope is
 * invalid — which would make the "logged exactly once" assertion below lie.
 */
const FIXED_REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('PF-195 — asyncRoute, because Express 4.22.1 drops async rejections (F4)', () => {
  it('the pin that makes this necessary is still 4.22.1', async () => {
    // Re-verified rather than trusted: if the pin moves to Express 5 this
    // wrapper becomes a no-op and should be retired deliberately, not
    // discovered later.
    const pkg = await import('../../../../package.json', { with: { type: 'json' } });
    expect((pkg.default as { dependencies: Record<string, string> }).dependencies.express).toBe(
      '4.22.1',
    );
  });

  it('an async handler rejecting with ApiError returns 404 + envelope, fast', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/async-missing',
          asyncRoute(async () => {
            await Promise.resolve();
            throw new ApiError('not_found', 'No such document.');
          }),
        );
      },
    });

    const startedAt = Date.now();
    const res = await request(app).get(`${V1_PREFIX}/async-missing`).expect(404);
    const elapsed = Date.now() - startedAt;

    expect(res.body.code).toBe('not_found');
    expect(res.body.message).toBe('No such document.');
    expect(res.body.request_id).toBeTypeOf('string');
    // The failure mode this guards is a HANG, so the timing is the assertion.
    expect(elapsed, 'request did not resolve promptly — rejection was dropped').toBeLessThan(100);
  });

  it('THE REGRESSION: the same handler UNWRAPPED hangs instead of answering', async () => {
    // This is finding F4 demonstrated rather than asserted. Without the wrapper
    // Express 4 ignores the returned promise, never calls next(err), and the
    // request sits until something times out. If this test ever starts getting
    // a response, Express began forwarding rejections and asyncRoute can go.
    //
    // The handler is written as "a function returning a promise" rather than
    // with the `async` keyword purely so the test can keep a reference to that
    // promise and settle it itself at the end. An `async` handler is exactly
    // this — Express 4 ignores the returned promise either way, which is the
    // whole point — but letting it reject with nothing attached makes Node
    // report an unhandled rejection that vitest then attributes to whichever
    // test happens to be running.
    let rejectedWith: unknown;
    let handlerRan = false;
    const app = express();
    app.get('/bare', () => {
      handlerRan = true;
      const promise = (async () => {
        await Promise.resolve();
        throw new ApiError('not_found', 'No such document.');
      })();
      // Recorded synchronously, so Node sees a handler attached the moment the
      // promise exists. Express does NOT do this — that is the defect. Doing it
      // here changes nothing about what Express sees; it only keeps the rejection
      // from being reported against an unrelated test.
      promise.catch((err: unknown) => {
        rejectedWith = err;
      });
      return promise;
    });
    app.use(apiErrorMiddleware({ error: () => {} }));

    const responded = await Promise.race([
      request(app)
        .get('/bare')
        .then(() => 'responded' as const)
        .catch(() => 'responded' as const),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 300)),
    ]);

    expect(responded, 'Express 4 forwarded an async rejection — re-check the pin').toBe('hung');

    // The handler really did run and really did reject — Express simply ignored
    // it. Without that check "hung" could just mean the route never matched.
    expect(handlerRan).toBe(true);
    expect(rejectedWith).toBeInstanceOf(ApiError);
  });

  it('also catches a handler that throws synchronously', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/sync-throw',
          asyncRoute(() => {
            throw new ApiError('not_found', 'Sync miss.');
          }),
        );
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/sync-throw`).expect(404);
    expect(res.body.code).toBe('not_found');
  });

  it('isBareAsyncHandler distinguishes wrapped from unwrapped', () => {
    const bare = async () => {};
    expect(isBareAsyncHandler(bare)).toBe(true);
    expect(isBareAsyncHandler(asyncRoute(bare))).toBe(false);
    expect(isBareAsyncHandler(() => {})).toBe(false);
  });
});

describe('PF-196 — an unhandled exception leaks nothing', () => {
  const SECRET_MESSAGE = 'connect ECONNREFUSED 10.0.0.4:5432 password=hunter2';

  it('returns a scrubbed server_error and logs the real one', async () => {
    const logger = { error: vi.fn() };

    // A minimal stack rather than the full public router: this test is about
    // the scrubbing, and a fixed request id makes the log/body join assertable.
    const app = express();
    app.use((_req, res, next) => {
      res.locals.requestId = FIXED_REQUEST_ID;
      next();
    });
    app.get(
      '/leaky',
      asyncRoute(async () => {
        await Promise.resolve();
        throw new Error(SECRET_MESSAGE);
      }),
    );
    app.use(apiErrorMiddleware(logger));

    const res = await request(app).get('/leaky').expect(500);
    const raw = JSON.stringify(res.body);

    expect(res.body.code).toBe('server_error');
    expect(res.body.message).toBe(GENERIC_SERVER_ERROR_MESSAGE);
    expect(res.body.request_id).toBe(FIXED_REQUEST_ID);

    // Nothing about the internals reaches the caller.
    expect(raw).not.toContain('ECONNREFUSED');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('10.0.0.4');
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('.ts');
    expect(Object.keys(res.body)).toEqual(['code', 'message', 'request_id']);
    expect('details' in res.body).toBe(false);

    // ...but the server log has the real error AND the id the caller was given.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [logMessage, loggedError] = logger.error.mock.calls[0]!;
    expect(logMessage).toContain(FIXED_REQUEST_ID);
    expect((loggedError as Error).message).toBe(SECRET_MESSAGE);
  });

  it('keeps an ApiError\'s own message and details (it is ours, not a leak)', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/forbidden',
          asyncRoute(async () => {
            await Promise.resolve();
            throw new ApiError('forbidden', 'Missing required scope: documents:read', {
              details: { missing_scope: 'documents:read' },
            });
          }),
        );
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/forbidden`).expect(403);
    expect(res.body.code).toBe('forbidden');
    expect(res.body.details).toEqual({ missing_scope: 'documents:read' });
  });

  it('never serializes an ApiError cause', async () => {
    const { app } = createTestPublicApp({
      mountResources: (router) => {
        router.get(
          '/caused',
          asyncRoute(() => {
            throw new ApiError('server_error', 'An unexpected error occurred.', {
              cause: new Error(SECRET_MESSAGE),
            });
          }),
        );
      },
    });

    const res = await request(app).get(`${V1_PREFIX}/caused`).expect(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('PF-197 — unknown /api/v1 path is JSON, not Express\'s HTML 404', () => {
  it('answers a schema-shaped envelope with a request id', async () => {
    const { app } = createTestPublicApp();

    const res = await request(app).get(`${V1_PREFIX}/does-not-exist`).expect(404);

    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).not.toContain('<!DOCTYPE html>');
    expect(res.body.code).toBe('not_found');
    expect(res.body.request_id).toBeTypeOf('string');
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
  });

  it('applies to every method, not just GET', async () => {
    const { app } = createTestPublicApp();
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method](`${V1_PREFIX}/nope`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    }
  });
});

describe('PF-194 — the handler is mounted on the v1 router ONLY', () => {
  it('is registered as error middleware (four-arity) — a three-arg copy never runs', () => {
    expect(apiErrorMiddleware().length).toBe(4);
  });

  it('does not swallow a response that already started', async () => {
    const logger = { error: vi.fn() };
    const app = express();
    app.get('/streamed', (_req, res) => {
      res.status(200);
      res.write('partial');
      throw new Error('failed mid-stream');
    });
    app.use(apiErrorMiddleware(logger));

    // The correct behaviour is to hand off to Express, which destroys the
    // socket. Writing a second set of headers would throw.
    await request(app)
      .get('/streamed')
      .catch(() => undefined);

    expect(logger.error).toHaveBeenCalled();
  });
});
