/**
 * F113 — the public audit trail, read through `@ship/sdk`.
 *
 * PRD p.4 requires the trail *"Queryable in the developer portal"*, and p.10
 * requires the portal to reuse the public API *"like any other client (eat the
 * dog food)"*. Both are satisfied by the one line that matters below:
 * `client.audit.list(...)`. There is no `fetch` and no URL string in this file —
 * `portalTransport.test.ts` fails the build if one appears.
 *
 * ## The filter set is exactly what the route declares
 *
 * `status`, `route`, `from`, `to`. Not one more: `/api/v1/audit` puts these on
 * L08's strict allowlist and rejects anything else with `validation_failed`, so
 * a fifth filter here would be a 422 the developer sees rather than a filter
 * that silently does nothing. `client_id` is deliberately absent — the server
 * takes it from the token, and sending one is an error.
 */
import type { AuditCall } from '@ship/sdk';
import { useCursorPage, type UseCursorPageResult } from './useCursorPage';
import type { PortalError } from '@/lib/portalError';

export type { PortalError };

/** The four filters `/api/v1/audit` accepts, and no fifth. */
export interface AuditFilters {
  /** Exact HTTP status. `429` answers "when was I throttled". */
  status?: number;
  /** Exact route TEMPLATE, e.g. `/api/v1/documents/:id`. */
  route?: string;
  /** ISO 8601, inclusive. */
  from?: string;
  /** ISO 8601, exclusive. */
  to?: string;
}

export interface UsePortalAuditCallsResult extends Omit<UseCursorPageResult<AuditCall>, 'items'> {
  calls: AuditCall[] | null;
}

const PAGE_SIZE = 25;

export function usePortalAuditCalls(
  appId: string | null,
  filters: AuditFilters,
): UsePortalAuditCallsResult {
  const filterKey = JSON.stringify(filters);

  const page = useCursorPage<AuditCall>({
    appId,
    filterKey,
    limit: PAGE_SIZE,
    errorMessage: 'The audit trail could not be loaded.',
    fetchPage: (client, cursor) =>
      client.audit.list({ limit: PAGE_SIZE, cursor, ...filters }),
  });

  const { items, ...rest } = page;
  return { calls: items, ...rest };
}
