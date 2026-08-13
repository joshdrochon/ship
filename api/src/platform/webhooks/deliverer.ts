/**
 * IWebhookDeliverer — the courier. HTTP implementation POSTs the signed
 * envelope; the in-memory implementation resolves synchronously for tests
 * (Liskov pair, same contract).
 */
import type { EventEnvelope } from './events.js';

export interface DeliveryRequest {
  targetUrl: string;
  /**
   * Exact bytes to POST — the same bytes that were signed.
   *
   * A `Buffer`, not a `string`, and that is PF-436 made structural. The bytes
   * the HMAC consumed and the bytes that go on the wire are the SAME object, so
   * there is no second serialization for key order, unicode escaping or float
   * formatting to differ across. `JSON.stringify` is not canonical, and a
   * re-serialized payload produces a different digest for a value nobody
   * tampered with — a failure that looks exactly like an attack.
   *
   * **Note for L16:** POST this buffer directly. `JSON.stringify(JSON.parse(...))`
   * anywhere on the delivery path re-introduces exactly the bug this type
   * prevents. `rawBody.toString('utf8')` is correct for the delivery LOG.
   */
  rawBody: Buffer;
  /** The `Ship-Signature` value, computed at send time per attempt (PF-442). */
  signatureHeader: string;
  /** Stable per event; carried unchanged on retry and replay (PF-394, TS-8). */
  idempotencyKey: string;
  eventId: string;
  subscriptionId: string;
  /** The unix second inside `signatureHeader`, so a log need not re-parse it. */
  signedAtSeconds: number;
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

// TODO(L16): HttpDeliverer — fetch POST with Ship-Signature + Idempotency-Key
// headers, 10s timeout via AbortController, excerpt = first 256 chars of body.
// Target: P95 first-attempt latency < 2s (measured in the delivery log).

/**
 * PF-436 — the ONE serialization site. An envelope becomes bytes here and
 * nowhere else.
 *
 * Returns a `Buffer` rather than a string so the value that is MACed and the
 * value that is POSTed cannot become two different things. If this returned a
 * string, every caller between here and the wire would be free to re-encode it
 * — and one of them eventually would.
 */
export function envelopeToRawBody(event: EventEnvelope): Buffer {
  return Buffer.from(JSON.stringify(event), 'utf8');
}
