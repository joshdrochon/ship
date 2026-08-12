/**
 * The terminal error handler for `/api/v1` — and the async wrapper without which
 * it would not see most failures.
 *
 * Tickets: PF-194 (one terminal handler, v1 only), PF-195 (`asyncRoute`),
 * PF-196 (unhandled exceptions leak nothing), PF-197 (unknown path → envelope).
 *
 * ## Mounted on the v1 router ONLY
 *
 * Never on the internal app. The internal `/api` surface has no error middleware
 * at all — its ~400 `res.status(…).json({ error: '…' })` call sites do the job
 * inline (finding F5), and there are at least two different internal body shapes
 * among them. Mounting this handler app-wide would quietly restyle all of that
 * into the public envelope, which is a breaking change to the UI's contract
 * dressed up as a refactor. The public/internal split is a one-way door (PRD
 * p.11); this is one of the hinges.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiError, apiErrorBodySchema, type ApiErrorBody } from './errors.js';
import { getRequestId } from './requestId.js';

/**
 * The only message a caller ever sees for an unhandled exception.
 *
 * Fixed, generic, and deliberately uninformative: PF-196's whole point is that
 * the failure text a caller receives cannot be a channel for connection strings,
 * credentials, internal hostnames or file paths. The real error goes to the log,
 * joined to the same `request_id` the caller was given, which is what makes a
 * support conversation possible without making the API an information leak.
 */
export const GENERIC_SERVER_ERROR_MESSAGE = 'An unexpected error occurred.';

/**
 * PF-195 — makes a rejected promise reach the error handler.
 *
 * Express is pinned at **4.22.1** (`api/package.json`). Express 4 calls the
 * handler and ignores the promise it returns, so an `async` handler that
 * rejects never calls `next(err)`: the request hangs until the client or the
 * proxy times out. No error middleware in the world sees it. Verified finding
 * F4 — and since nearly every handler in this codebase is `async`, an unwrapped
 * one silently exempts the single most common failure path from the envelope
 * that MVP gate item 5 is about.
 *
 * Express 5 forwards rejections natively. When the pin moves, this becomes a
 * no-op that is safe to keep and safer to delete deliberately than by accident.
 *
 *   router.get('/documents/:id', asyncRoute(async (req, res) => {
 *     const doc = await service.find(req.params.id);
 *     if (!doc) throw new ApiError('not_found', 'No such document.');
 *     res.json({ data: doc });
 *   }));
 *
 * The returned function is intentionally NOT `async`, which is what lets
 * `isBareAsyncHandler` below tell a wrapped handler from an unwrapped one.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return function wrappedAsyncRoute(req, res, next) {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (err) {
      // A handler that throws synchronously before returning a promise.
      next(err);
    }
  };
}

/**
 * True for a handler that is an `async function` and was NOT wrapped by
 * `asyncRoute` — i.e. one whose rejections Express 4 will drop on the floor.
 *
 * Used by the route-fitness harness (PF-200/PF-202) to fail the build rather
 * than discover the hang in production. `asyncRoute` returns an ordinary
 * function, so anything it wrapped reports `false` here.
 */
export function isBareAsyncHandler(handler: unknown): boolean {
  return typeof handler === 'function' && handler.constructor?.name === 'AsyncFunction';
}

/** Where unhandled errors are reported. Swappable so tests can assert on it. */
export interface ErrorLogger {
  error: (message: string, err: unknown) => void;
}

const defaultLogger: ErrorLogger = {
  error: (message, err) => {
    console.error(message, err);
  },
};

/**
 * PF-197 — the catch-all for an unrouted `/api/v1` path.
 *
 * Without it Express falls through to its default 404, which is an HTML page.
 * A public JSON API answering `<!DOCTYPE html>` to a typo'd path fails
 * "every public failure ships the envelope" in the most visible way there is,
 * and breaks any SDK that assumes it can parse the body.
 *
 * Mount immediately before `apiErrorMiddleware`, below every real route.
 */
export function notFoundHandler() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(new ApiError('not_found', `No such endpoint: ${req.method} ${req.path}`));
  };
}

/**
 * PF-194 — the ONE terminal handler. Mount last, on the v1 router only.
 *
 * Anything that reaches here leaves as the envelope: an `ApiError` keeps its
 * code, message and `details`; anything else becomes a scrubbed `server_error`.
 */
export function apiErrorMiddleware(logger: ErrorLogger = defaultLogger) {
  // Four parameters, and they must all be declared: Express identifies error
  // middleware by `fn.length === 4`. Dropping the unused `_next` silently
  // demotes this to an ordinary middleware that never runs on the error path.
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    // `?? randomUUID()` is unreachable on the v1 stack — requestIdMiddleware runs
    // first (PF-190) and PF-193 asserts it. It stays because a response with no
    // id at all is strictly worse than one with an untraceable id, and this is
    // the last line of defence before the caller.
    const requestId = getRequestId(res) ?? randomUUID();

    const isApiError = err instanceof ApiError;
    const apiErr = isApiError
      ? err
      : new ApiError('server_error', GENERIC_SERVER_ERROR_MESSAGE, { cause: err });

    if (!isApiError) {
      // The real error, joined to the id the caller was handed. This is the only
      // place the original message exists after this point.
      logger.error(`[api/v1] unhandled error (request_id=${requestId})`, err);
    }

    // Headers may already be sent if the failure happened mid-stream. Handing
    // off to Express's default handler destroys the socket, which is the only
    // correct move — writing a second set of headers throws.
    if (res.headersSent) {
      _next(err);
      return;
    }

    const body = {
      code: apiErr.code,
      message: apiErr.message,
      // Spread-or-nothing rather than `details: x ?? undefined`: the key must be
      // ABSENT, not present-and-undefined, for the strict envelope schema.
      ...(Object.hasOwn(apiErr, 'details') ? { details: apiErr.details } : {}),
      request_id: requestId,
    } as ApiErrorBody;

    // PF-199 — the serializer checks itself against the SAME schema the fitness
    // harness asserts with. This is a self-check, not a transformer: the body is
    // sent either way.
    //
    // Degrading a policy violation into a 500 would turn a detail-shape bug into
    // an outage, and silently stripping `details` would hide it. Logging keeps
    // the caller's response honest to what the code actually did, while making
    // the violation impossible to miss — the fitness test (PF-201) turns the same
    // check into a build failure, which is where it should be caught.
    const parsed = apiErrorBodySchema.safeParse(body);
    if (!parsed.success) {
      logger.error(
        `[api/v1] envelope violates the details policy (code=${apiErr.code}, request_id=${requestId})`,
        parsed.error.issues,
      );
    }

    res.status(apiErr.status).json(body);
  };
}
