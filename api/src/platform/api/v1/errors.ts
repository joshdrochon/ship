/**
 * ApiError — the single public error envelope.
 *
 * Every failure on /api/v1/* ships this exact shape:
 *   { code, message, details?, request_id }
 *
 * The code set is CLOSED: it maps 1:1 onto the SDK's discriminated error union.
 * A fitness test enumerates every /api/v1 route and asserts the shape on failure
 * paths, so a new route cannot quietly invent its own error format.
 */
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export const API_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'server_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  rate_limited: 429,
  server_error: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  request_id: string;
}

/** Attach a request id early so every response (and audit row) can carry it. */
export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = randomUUID();
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

/**
 * The ONE error handler for the public surface. Anything thrown by a v1 route —
 * ApiError or not — leaves in the envelope. Unknown errors become server_error
 * without leaking internals.
 */
export function apiErrorMiddleware() {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const requestId = (res.locals.requestId as string | undefined) ?? randomUUID();
    const apiErr =
      err instanceof ApiError
        ? err
        : new ApiError('server_error', 'An unexpected error occurred.');

    if (!(err instanceof ApiError)) {
      // Log the real error server-side; never send it to the caller.
      console.error(`[api/v1] unhandled error (request_id=${requestId}):`, err);
    }

    const body: ApiErrorBody = {
      code: apiErr.code,
      message: apiErr.message,
      ...(apiErr.details !== undefined ? { details: apiErr.details } : {}),
      request_id: requestId,
    };
    res.status(apiErr.status).json(body);
  };
}
