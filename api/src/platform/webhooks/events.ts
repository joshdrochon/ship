/**
 * Event registry — events as data (OCP). Eight types ship this week.
 * Each payload is Zod-typed so the OpenAPI webhooks section and the SDK's
 * event types generate from the same source.
 */
import { z } from 'zod';

export const EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'issue.created',
  'issue.assigned',
  'issue.status_changed',
  'sprint.started',
  'sprint.completed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Envelope every subscriber receives (the signed body). */
export const eventEnvelopeSchema = z.object({
  id: z.string(),           // event id — also the basis of the Idempotency-Key
  type: z.enum(EVENT_TYPES),
  created_at: z.string(),   // ISO 8601
  workspace_id: z.string(),
  data: z.record(z.unknown()), // refined per-type below
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

// TODO(josh): tighten per-type payload schemas as resources land (E2/E4).
// Ship IDs only in payloads (subscribers fetch full content via the API) —
// keeps exposure surface small; defend this in the pre-search 1.4 answer.
const idPayload = z.object({ id: z.string() });

export const eventPayloadSchemas: Record<EventType, z.ZodTypeAny> = {
  'document.created': idPayload.extend({ title: z.string() }),
  'document.updated': idPayload,
  'document.deleted': idPayload,
  'issue.created': idPayload.extend({ title: z.string() }),
  'issue.assigned': idPayload.extend({ assignee_id: z.string().nullable() }),
  'issue.status_changed': idPayload.extend({ from: z.string(), to: z.string() }),
  'sprint.started': idPayload,
  'sprint.completed': idPayload,
};
