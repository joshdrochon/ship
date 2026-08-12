/**
 * Typed error union — discriminated on `kind` so consumers switch exhaustively.
 * Maps 1:1 from the server's ApiError envelope codes.
 */

export type ShipErrorKind = 'auth' | 'rate_limit' | 'not_found' | 'validation' | 'server';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  request_id?: string;
}

export class ShipError extends Error {
  readonly kind: ShipErrorKind;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: unknown;
  /** Present on kind === 'rate_limit' when the server sent Retry-After. */
  readonly retryAfterSeconds: number | null;

  constructor(args: {
    kind: ShipErrorKind;
    message: string;
    status: number;
    requestId?: string | null;
    details?: unknown;
    retryAfterSeconds?: number | null;
  }) {
    super(args.message);
    this.name = 'ShipError';
    this.kind = args.kind;
    this.status = args.status;
    this.requestId = args.requestId ?? null;
    this.details = args.details;
    this.retryAfterSeconds = args.retryAfterSeconds ?? null;
  }
}

const KIND_BY_CODE: Record<string, ShipErrorKind> = {
  unauthorized: 'auth',
  forbidden: 'auth',
  not_found: 'not_found',
  validation_failed: 'validation',
  rate_limited: 'rate_limit',
  server_error: 'server',
};

export function errorFromResponse(status: number, body: ApiErrorBody | null, retryAfterHeader?: string | null): ShipError {
  const kind: ShipErrorKind = (body && KIND_BY_CODE[body.code]) ?? (status === 429 ? 'rate_limit' : status >= 500 ? 'server' : status === 404 ? 'not_found' : status === 401 || status === 403 ? 'auth' : 'server');
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : null;
  return new ShipError({
    kind,
    message: body?.message ?? `Request failed with status ${status}`,
    status,
    requestId: body?.request_id ?? null,
    details: body?.details,
    retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
  });
}
