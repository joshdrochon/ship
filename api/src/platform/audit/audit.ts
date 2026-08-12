/**
 * Public audit trail — every /api/v1 call recorded:
 * timestamp, app client_id, user_id, route, scope used, status, latency.
 * Queryable per-app in the developer portal.
 */
import type { Request, Response, NextFunction } from 'express';
import type { PlatformAuthContext } from '../scopes/auth-context.js';

export interface PublicApiCallRecord {
  requestId: string;
  clientId: string | null;
  userId: string | null;
  method: string;
  route: string;
  scopeUsed: string | null;
  status: number;
  latencyMs: number;
  occurredAt: Date;
}

export interface IAuditSink {
  record(entry: PublicApiCallRecord): void; // fire-and-forget; never fails a request
}

/** Test double + local dev sink. Postgres sink lands with migration 039. */
export class InMemoryAuditSink implements IAuditSink {
  readonly records: PublicApiCallRecord[] = [];
  record(entry: PublicApiCallRecord): void {
    this.records.push(entry);
  }
}

export function publicAuditMiddleware(sink: IAuditSink) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const auth = res.locals.platformAuth as PlatformAuthContext | undefined;
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      sink.record({
        requestId: (res.locals.requestId as string | undefined) ?? 'unknown',
        clientId: auth?.clientId ?? null,
        userId: auth?.userId ?? null,
        method: req.method,
        route: req.route?.path ? String(req.route.path) : req.path,
        scopeUsed: (res.locals.scopeUsed as string | undefined) ?? null,
        status: res.statusCode,
        latencyMs,
        occurredAt: new Date(),
      });
    });
    next();
  };
}
