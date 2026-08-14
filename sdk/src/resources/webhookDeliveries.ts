/**
 * PF-526 — the typed SDK surface for the webhook delivery log, DLQ and replay.
 *
 * L18 deliberately shipped without this and asserted its ABSENCE instead: p.4
 * specifies the routes, but L16 had not landed them, and binding SDK methods to
 * operations the server does not serve hands every consumer two 404s. When L16
 * merged, the spec gained three operations with nothing bound to them and
 * `sdkSurfaceParity.test.ts` went red naming all three by operationId. That is
 * Testing Scenario 5 (p.5) working exactly as specified — walk every spec method
 * and assert the SDK exposes a typed call for it — so this file is the answer the
 * failing test asked for, not a workaround for it.
 *
 * Deliveries are a NESTED collection under `/webhooks`, which is the detail L16's
 * F61 widened the cursor-resource rule for: a cursor minted for the
 * subscriptions list must not be accepted on the deliveries list. That is
 * enforced server-side; the SDK simply passes cursors back where it got them.
 */
import type { Transport } from '../transport.js';
import type { Page } from '../pagination.js';

/** Terminal and in-flight states a delivery attempt can hold. From the spec's enum. */
export const DELIVERY_STATUSES = [
  'in_flight',
  'delivered',
  'failed',
  'dead_lettered',
  'cancelled',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The delivery-log row, field-for-field with the public projection.
 *
 * `signature_header` is the header actually sent, not a re-derivation — B9 asked
 * for it so `ship webhooks tail --poll` can show a consumer the same bytes the
 * subscriber received. `idempotency_key` survives replay unchanged, which is the
 * half of Testing Scenario 8 (p.5) that a naive replay implementation loses.
 */
export const WEBHOOK_DELIVERY_FIELDS = [
  'id',
  'delivery_group_id',
  'subscription_id',
  'event_id',
  'event_type',
  'attempt_number',
  'status',
  'response_status',
  'response_excerpt',
  'latency_ms',
  'idempotency_key',
  'dlq_reason',
  'attempted_at',
  'created_at',
  'signature_header',
  'replay_of_delivery_id',
  'key_usage',
] as const;

export interface WebhookDelivery {
  id: string;
  delivery_group_id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  attempt_number: number;
  status: DeliveryStatus;
  response_status: number | null;
  response_excerpt: string | null;
  latency_ms: number | null;
  idempotency_key: string;
  dlq_reason: string | null;
  attempted_at: string | null;
  created_at: string;
  signature_header: string | null;
  replay_of_delivery_id: string | null;
  key_usage: string | null;
}

export interface ListDeliveriesInput {
  limit?: number;
  cursor?: string | null;
  /** `dead_lettered` is the DLQ view Testing Scenario 8 and the portal both read. */
  status?: DeliveryStatus;
  subscription_id?: string;
  event_type?: string;
}

export class WebhookDeliveriesClient {
  constructor(private readonly transport: Transport) {}

  /** One page of delivery attempts, newest first. */
  list(input: ListDeliveriesInput = {}): Promise<Page<WebhookDelivery>> {
    const query: Record<string, string> = {};
    if (input.limit !== undefined) query.limit = String(input.limit);
    if (input.cursor) query.cursor = input.cursor;
    if (input.status) query.status = input.status;
    if (input.subscription_id) query.subscription_id = input.subscription_id;
    if (input.event_type) query.event_type = input.event_type;

    return this.transport.request<Page<WebhookDelivery>>('GET', '/webhooks/deliveries', { query });
  }

  /** A single attempt by id. */
  get(id: string): Promise<WebhookDelivery> {
    return this.transport.request<WebhookDelivery>(
      'GET',
      `/webhooks/deliveries/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Re-emit a logged delivery. Returns the NEW attempt row (201).
   *
   * The original `idempotency_key` rides through unchanged — p.5's Testing
   * Scenario 8 requires the replay to arrive with it intact, so a subscriber that
   * deduped on it the first time dedupes on it again. `replay_of_delivery_id`
   * on the returned row points back at what was replayed.
   */
  replay(id: string): Promise<WebhookDelivery> {
    return this.transport.request<WebhookDelivery>(
      'POST',
      `/webhooks/deliveries/${encodeURIComponent(id)}/replay`,
    );
  }
}
