/**
 * F113 — the typed SDK surface for `GET /api/v1/audit`, PRD p.4's public audit
 * trail.
 *
 * ## Why this is a standalone client and not a `ResourceClient` subclass
 *
 * `ResourceClient` gives every subclass `list`, `get` and `iterate`. There is no
 * `GET /api/v1/audit/{id}` operation — a single audit row has no addressable
 * identity worth fetching, and the trail is only ever read as a page — so
 * inheriting `get()` would put a public SDK method on the prototype with no spec
 * operation behind it. PF-531's reverse-parity walk reads the real prototypes
 * and would correctly report it. The same reasoning made
 * `WebhookDeliveriesClient` standalone, and this follows it.
 *
 * ## Scope
 *
 * None. The route declares `scope: null` because the token already determines
 * the whole answer — an app can only ever read its own calls. A consumer holding
 * a token with no scopes at all can still call this, which is deliberate: the
 * developer most likely to be reading their audit trail is the one debugging why
 * their calls are 403ing.
 */
import { paginate, type Page } from '../pagination.js';
import type { Transport } from '../transport.js';

/**
 * One recorded public API call — PRD p.4's seven fields.
 *
 * snake_case because these are WIRE names: this is the server's JSON, not an
 * object the SDK invented.
 */
export const AUDIT_CALL_FIELDS = [
  'id',
  'request_id',
  'client_id',
  'user_id',
  'method',
  'route',
  'scope_used',
  'status',
  'latency_ms',
  'occurred_at',
] as const;

export interface AuditCall {
  id: string;
  /** Ties a row to one request — the same id on that call's `ApiError` body. */
  request_id: string;
  /** Always the caller's own app. The server ignores any client_id you send. */
  client_id: string;
  /** Null for machine-to-machine tokens, which have no consenting user. */
  user_id: string | null;
  method: string;
  /** The route TEMPLATE (`/api/v1/documents/:id`), not the concrete path. */
  route: string;
  /** Null on routes that require no scope, and on calls that never reached one. */
  scope_used: string | null;
  status: number;
  latency_ms: number;
  /** ISO 8601. */
  occurred_at: string;
}

export interface ListAuditCallsInput {
  /** Page size. The server's maximum is 100 and it REJECTS above it, not clamps. */
  limit?: number;
  /** Opaque, from a previous response's `next_cursor`. Never construct one. */
  cursor?: string | null;
  /** Exact HTTP status. `429` answers "when was I throttled". */
  status?: number;
  /** Exact route TEMPLATE match. */
  route?: string;
  /** Inclusive lower bound on `occurred_at`, ISO 8601. */
  from?: string;
  /** Exclusive upper bound on `occurred_at`, ISO 8601. */
  to?: string;
}

/**
 * `iterate()`'s options — p.4's *"Cursors handled internally; consumer code
 * never sees them."*
 *
 * No `cursor` field, so passing one is a compile error rather than a silently
 * ignored argument. `limit` survives because it is a page SIZE, not a position.
 */
export type IterateAuditCallsInput = Omit<ListAuditCallsInput, 'cursor'>;

export class AuditClient {
  constructor(private readonly transport: Transport) {}

  /** One page of this app's calls, newest first. */
  list(input: ListAuditCallsInput = {}): Promise<Page<AuditCall>> {
    return this.transport.request<Page<AuditCall>>('GET', '/audit', {
      query: auditQuery(input),
    });
  }

  /**
   * `for await (const call of client.audit.iterate())` — walks every page.
   *
   * Delegates to the SINGLE `paginate()` generator in `pagination.ts`, per
   * PF-533: a hand-rolled loop here would be the fifth copy of the same walk and
   * the one that gets a fix last.
   */
  iterate(input: IterateAuditCallsInput = {}): AsyncGenerator<AuditCall, void, undefined> {
    return paginate<AuditCall>((cursor) =>
      this.list({ ...input, ...(cursor !== null ? { cursor } : {}) }),
    );
  }
}

/** Filters → the transport's flat query record. Empty values are omitted, not sent blank. */
function auditQuery(input: ListAuditCallsInput): Record<string, string> {
  const query: Record<string, string> = {};
  if (input.limit !== undefined) query.limit = String(input.limit);
  if (input.cursor) query.cursor = input.cursor;
  if (input.status !== undefined) query.status = String(input.status);
  if (input.route) query.route = input.route;
  if (input.from) query.from = input.from;
  if (input.to) query.to = input.to;
  return query;
}
