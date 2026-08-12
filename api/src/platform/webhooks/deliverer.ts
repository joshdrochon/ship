/**
 * IWebhookDeliverer — the courier. HTTP implementation POSTs the signed
 * envelope; the in-memory implementation resolves synchronously for tests
 * (Liskov pair, same contract).
 */
import type { EventEnvelope } from './events.js';

export interface DeliveryRequest {
  targetUrl: string;
  /** Exact bytes to POST — the same bytes that were signed. */
  rawBody: string;
  signatureHeader: string; // value for Ship-Signature
  idempotencyKey: string;  // stable per event; carried unchanged on retry/replay
  eventId: string;
  subscriptionId: string;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;      // null = network error / timeout
  responseExcerpt: string | null;
  latencyMs: number;
  /** 4xx = permanent (straight to DLQ); 5xx/timeout = transient (retry). */
  permanentFailure: boolean;
}

export interface IWebhookDeliverer {
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
}

/** Test double: records every request, answers from a programmable queue. */
export class InMemoryDeliverer implements IWebhookDeliverer {
  readonly delivered: DeliveryRequest[] = [];
  private responses: DeliveryResult[] = [];

  queueResponse(result: Partial<DeliveryResult>): void {
    this.responses.push({
      ok: true,
      status: 200,
      responseExcerpt: null,
      latencyMs: 0,
      permanentFailure: false,
      ...result,
    });
  }

  deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    this.delivered.push(request);
    const next = this.responses.shift();
    return Promise.resolve(
      next ?? { ok: true, status: 200, responseExcerpt: null, latencyMs: 0, permanentFailure: false },
    );
  }
}

// TODO(josh): HttpDeliverer — fetch POST with Ship-Signature + Idempotency-Key
// headers, 10s timeout via AbortController, excerpt = first 256 chars of body.
// Target: P95 first-attempt latency < 2s (measured in the delivery log).
export function envelopeToRawBody(event: EventEnvelope): string {
  // Serialized ONCE here; these exact bytes are signed and POSTed.
  return JSON.stringify(event);
}
