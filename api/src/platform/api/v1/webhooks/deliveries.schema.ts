/**
 * Request and response Zod for `/api/v1/webhooks/deliveries`, adjacent to the
 * handler.
 *
 * Tickets: PF-464 (the list), PF-472 (key usage on the response), PF-476 (replay).
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."*
 *
 * ## What is NOT on the wire, and why
 *
 * `raw_body` and `app_id` are absent from `deliverySchema`. The first is the
 * stored event payload — serialising it into every row of a paginated list would
 * turn a delivery page into a bulk event export, and the one caller that needs
 * the bytes (replay) reads them server-side. The second is a storage-and-index
 * concern; a caller already knows which app it asked about.
 *
 * `.strict()` is what enforces both: L13's `responseContract` parses every 2xx
 * body through this schema, so a handler that added a field would fail to
 * serialise rather than quietly widening the public contract.
 */
import { z } from 'zod';
import { EVENT_TYPES } from '../../../webhooks/events.js';
import { DELIVERY_STATUSES, DLQ_REASONS } from '../../../webhooks/deliveryLog.js';

/** The cursor's resource binding. A cursor minted here is rejected elsewhere (PF-218). */
export const DELIVERIES_RESOURCE = 'webhooks_deliveries';

/**
 * Derived from the runtime unions rather than restated, so a widened status
 * cannot appear in the database and be rejected by the response contract — which
 * is a 500 on a route that would otherwise have worked.
 */
const statusEnum = z.enum(DELIVERY_STATUSES as unknown as [string, ...string[]]);
const dlqReasonEnum = z.enum(DLQ_REASONS as unknown as [string, ...string[]]);

export const deliverySchema = z
  .object({
    id: z.string().uuid(),
    /** The ladder this attempt belongs to. Groups the rows of one delivery. */
    delivery_group_id: z.string().uuid(),
    subscription_id: z.string().uuid(),
    event_id: z.string().uuid(),
    event_type: z.string(),
    attempt_number: z.number().int(),
    status: statusEnum,
    /** Null when no response arrived: timeout, refused connection, TLS failure. */
    response_status: z.number().int().nullable(),
    /** First 256 characters of the response BODY, truncation marked in-band. */
    response_excerpt: z.string().nullable(),
    /** Brackets the HTTP call only. Null until the attempt completes. */
    latency_ms: z.number().int().nullable(),
    idempotency_key: z.string(),
    dlq_reason: dlqReasonEnum.nullable(),
    attempted_at: z.string(),
    created_at: z.string(),
    /**
     * The `Ship-Signature` actually sent on this attempt (finding B9). Null on an
     * attempt where nothing was sent. Not a secret: it is the MAC that already
     * went over the wire, and the subscriber already holds it.
     */
    signature_header: z.string().nullable(),
    replay_of_delivery_id: z.string().uuid().nullable(),
  })
  .strict();

export type DeliveryBody = z.infer<typeof deliverySchema>;

/**
 * PF-472 — Pre-Search 3.5 (p.18): *"How does Idempotency-Key reuse vs. fresh keys
 * show up in your delivery log? Could you tell whether a subscriber's dedupe is
 * working from your portal alone?"*
 *
 * **The honest answer is no, and this shape makes it yes for the half we
 * control.** `attempt_count` is how many times WE sent this key;
 * `terminal_statuses` is how those attempts ended. Neither can say whether the
 * subscriber processed it twice — that needs the subscriber's own signal, which
 * we do not have and do not pretend to.
 *
 * Exposed as a field on the list response rather than as a separate endpoint so
 * L22 renders it without a second round trip per row.
 */
export const keyUsageSchema = z
  .object({
    idempotency_key: z.string(),
    attempt_count: z.number().int(),
    terminal_statuses: z.array(statusEnum),
  })
  .strict();

/** `?status=`, `?subscription_id=`, `?event_type=` — the strict allowlist (PF-226). */
export const DELIVERY_FILTER_PARAMS = ['status', 'subscription_id', 'event_type'] as const;

/**
 * The filters, for L13's generator. Validated separately at runtime by
 * `parseDeliveryFilters` — this schema describes the parameters to a reader; it
 * does not replace the check that produces the `validation_failed` envelope.
 */
export const deliveryQuerySchema = z.object({
  status: statusEnum
    .optional()
    .describe(
      'Filter by attempt status. `dead_lettered` is the dead-letter queue — the ' +
        'deliveries that exhausted the retry ladder, hit a permanent status, or were ' +
        'refused by the per-subscription circuit breaker.',
    ),
  subscription_id: z
    .string()
    .uuid()
    .optional()
    .describe('Only attempts for this subscription. Must belong to the calling app.'),
  event_type: z
    .enum(EVENT_TYPES)
    .optional()
    .describe('Only attempts carrying this event type.'),
});

/** The path parameter, validated as a UUID before it reaches Postgres. */
export const deliveryIdParamSchema = z.object({ id: z.string().uuid() }).strict();
