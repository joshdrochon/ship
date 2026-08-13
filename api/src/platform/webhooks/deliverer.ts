/**
 * `IWebhookDeliverer` — the courier, and the Liskov substitution point
 * `docs/architecture.md` names.
 *
 * Tickets: PF-465 (the shared contract suite), PF-466 (`HttpDeliverer`),
 * PF-467 (`permanentFailure` is computed, never decided per implementation),
 * PF-468 (the in-memory double's per-attempt script).
 *
 * `HttpDeliverer` POSTs the signed envelope; `InMemoryDeliverer` resolves
 * synchronously for tests. `delivererContract.ts` runs one suite against both,
 * unedited — which is what makes them a pair rather than two classes sharing a
 * type name.
 */
import type { EventEnvelope } from './events.js';
import type { Clock } from '../clock.js';
import { classifyDeliveryOutcome } from './classify.js';
import { SIGNATURE_HEADER as SHIP_SIGNATURE } from './signer.js';

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
  status: number | null; // null = network error / timeout
  responseExcerpt: string | null;
  latencyMs: number;
  /**
   * PF-467. Computed by `classifyDeliveryOutcome`, never set by hand.
   *
   * It used to be a field each implementation filled in for itself, with the
   * 4xx/5xx rule stated only in a comment — so `InMemoryDeliverer` was free to
   * call a 410 transient while `HttpDeliverer` called it permanent, and every
   * test written against the double proved nothing about production. Both now go
   * through `deliveryResult()` below, and `delivererFitness.test.ts` greps for
   * any assignment to this field outside that factory.
   */
  permanentFailure: boolean;
}

export interface IWebhookDeliverer {
  /**
   * **Never throws.** Every failure path returns a `DeliveryResult`.
   *
   * A thrown exception would abort the ladder mid-run and leave an `in_flight`
   * row with no terminal state — a delivery that is neither delivered nor
   * dead-lettered, invisible to the DLQ and to replay alike.
   */
  deliver(request: DeliveryRequest): Promise<DeliveryResult>;
}

/**
 * PF-467 — the ONE place a `DeliveryResult` is constructed.
 *
 * `ok` and `permanentFailure` are both derived from the status, so the pair
 * `{ok: true, permanentFailure: true}` — which means nothing — is not
 * representable through this function.
 */
export function deliveryResult(input: {
  status: number | null;
  responseExcerpt: string | null;
  latencyMs: number;
}): DeliveryResult {
  const outcome = classifyDeliveryOutcome(input.status);
  return {
    ok: outcome === 'success',
    status: input.status,
    responseExcerpt: input.responseExcerpt,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    permanentFailure: outcome === 'permanent',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-460 — the excerpt
// ─────────────────────────────────────────────────────────────────────────────

/** First 256 characters of the body. The DB CHECK is 280; the marker fits. */
export const EXCERPT_LIMIT = 256;
export const TRUNCATION_MARKER = '…[truncated]';

/**
 * PF-460 — bounded, body-only, and it marks its own truncation.
 *
 * Never headers, never the request, never the signing secret: the argument is
 * the response body and nothing else is in scope here.
 *
 * `''` and `null` are DIFFERENT and both are reachable. `''` is an empty body —
 * a subscriber answering `204` — and `null` is reserved for "no response
 * arrived". Collapsing them would make a timeout indistinguishable from a
 * successful empty reply in the delivery log.
 *
 * Invalid UTF-8 does not throw: `Buffer.toString('utf8')` substitutes U+FFFD,
 * which is what a subscriber's mangled error page should look like in a log
 * rather than a reason the whole attempt fails to record.
 */
export function excerptOf(body: string): string {
  if (body.length <= EXCERPT_LIMIT) return body;
  return body.slice(0, EXCERPT_LIMIT) + TRUNCATION_MARKER;
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-468 — the test double
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a scripted deliverer is asked for one more response than it has. */
export class ResponseScriptExhaustedError extends Error {
  constructor(
    readonly scripted: number,
    readonly requested: number,
  ) {
    super(
      `The response script has ${scripted} entries and attempt ${requested} was requested. ` +
        `This is a TEST FAILURE, not a default 200: the old fallback made a 7-attempt bug ` +
        `look like a pass in Testing Scenario 8, whose entire assertion is that there is no ` +
        `7th attempt. Extend the script if the extra attempt is expected.`,
    );
    this.name = 'ResponseScriptExhaustedError';
  }
}

/**
 * Test double: records every request, answers from a programmable queue.
 *
 * `delivered[]` retains the FULL `DeliveryRequest`, headers included, so a test
 * can read `Idempotency-Key` and `Ship-Signature` back off the wire — which is
 * what Testing Scenario 8's "original idempotency key intact" is asserted
 * against.
 */
export class InMemoryDeliverer implements IWebhookDeliverer {
  readonly delivered: DeliveryRequest[] = [];
  private responses: DeliveryResult[] = [];
  private scripted = false;

  /** Queue one response. `permanentFailure` is DERIVED, never passed in. */
  queueResponse(result: Partial<Omit<DeliveryResult, 'permanentFailure'>>): void {
    this.responses.push(
      deliveryResult({
        // `'status' in result` and NOT `result.status ?? 200`: an explicit
        // `status: null` is the NETWORK-FAILURE case — the single most important
        // response a test can queue — and `??` would silently turn it into a
        // healthy 200. That is a double quietly disagreeing with production
        // about the one outcome the retry ladder exists for.
        status: 'status' in result ? (result.status ?? null) : 200,
        responseExcerpt: result.responseExcerpt ?? null,
        latencyMs: result.latencyMs ?? 0,
      }),
    );
  }

  /**
   * PF-468 — `script([500, 500, 500, 200])`, the shape both graded scenarios
   * need.
   *
   * Scripting also switches OFF the "empty queue means 200" fallback: running
   * past the end of a script is a test failure. The old `?? {ok: true}` default
   * is what would let a 7-attempt bug pass Testing Scenario 8 silently, and a
   * silent pass on the one assertion the PRD wrote itself is the worst possible
   * outcome for this lane.
   */
  script(statuses: (number | null)[], latencyMs = 0): void {
    this.scripted = true;
    for (const status of statuses) {
      this.responses.push(
        deliveryResult({
          status,
          responseExcerpt: status === null ? null : `scripted ${status}`,
          latencyMs,
        }),
      );
    }
  }

  /** How many scripted responses are left. Lets a test assert the script ran out. */
  remaining(): number {
    return this.responses.length;
  }

  reset(): void {
    this.delivered.length = 0;
    this.responses.length = 0;
    this.scripted = false;
  }

  deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    this.delivered.push(request);
    const next = this.responses.shift();
    if (next) return Promise.resolve(next);
    if (this.scripted) {
      return Promise.reject(
        new ResponseScriptExhaustedError(this.delivered.length - 1, this.delivered.length),
      );
    }
    // Unscripted: a healthy subscriber. Still built through the factory, so the
    // double cannot disagree with production about what a 200 means.
    return Promise.resolve(
      deliveryResult({ status: 200, responseExcerpt: null, latencyMs: 0 }),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PF-466 — the production courier
// ─────────────────────────────────────────────────────────────────────────────

/** p.6's budget is 2 s for the FIRST attempt; 10 s is the hard abort. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The signature header name comes from L15's signer, not from a second literal
 * here. `signer.ts` is where `Ship-Signature` is defined and where its format is
 * documented; a copy in this file would be a second answer to "what is the
 * header called", and it collided as TS2308 the moment both were re-exported
 * through `platform/index.ts` — which is the barrel telling the truth.
 */
export { SIGNATURE_HEADER } from './signer.js';
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface HttpDelivererOptions {
  /**
   * PF-461 — latency comes from the injected clock, so `FakeClock` produces
   * exact values and the number in the log is the one a subscriber would
   * measure.
   */
  clock: Clock;
  timeoutMs?: number;
  /** Injected so the contract suite can point it at a local `http.Server`. */
  fetchImpl?: typeof fetch;
}

/**
 * PF-466 — POST, three headers, a 10 s abort, and it NEVER throws.
 *
 * ## The body is the buffer, byte for byte
 *
 * `request.rawBody` goes on the wire unchanged. There is no `JSON.parse`, no
 * `JSON.stringify`, no re-encode: the bytes the HMAC consumed are the bytes the
 * subscriber verifies. PF-436 made this structural by typing `rawBody` as a
 * `Buffer`, and this is the call site that has to honour it.
 *
 * ## Redirects are NOT followed
 *
 * `redirect: 'manual'`, and a 3xx classifies as permanent. Following a redirect
 * on a webhook POST is an SSRF primitive: the subscriber controls `Location`
 * and could point it into the private address space L15's `checkTargetUrl`
 * explicitly refused at subscribe time (PF-425). Following it would launder the
 * check.
 *
 * ## Every failure path returns
 *
 * DNS failure, connection refused, TLS error, abort, and a body that fails to
 * read all become `{status: null}` — transient by `classifyDeliveryOutcome`,
 * because nothing was said about the request so nothing can be concluded. A
 * thrown exception here would abort the ladder and strand an `in_flight` row.
 */
export class HttpDeliverer implements IWebhookDeliverer {
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpDelivererOptions) {
    this.clock = options.clock;
    this.timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    const controller = new AbortController();
    // The abort timer is the one place this module schedules anything, and it
    // goes through the injected clock like everything else under
    // `platform/webhooks/` (PF-456).
    const cancelTimer = this.clock.setTimeout(() => controller.abort(), this.timeoutMs);
    const startedMs = this.clock.nowMs();

    try {
      const response = await this.fetchImpl(request.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SHIP_SIGNATURE]: request.signatureHeader,
          [IDEMPOTENCY_HEADER]: request.idempotencyKey,
        },
        // The buffer, not a string. See the class comment.
        body: new Uint8Array(request.rawBody),
        signal: controller.signal,
        redirect: 'manual',
      });

      // Read the body INSIDE the try: a subscriber that answers 200 and then
      // drops the connection mid-body would otherwise reject after the status
      // is known, and the attempt would be recorded as a network failure when
      // the subscriber had in fact accepted it.
      let excerpt: string | null = null;
      try {
        excerpt = excerptOf(await response.text());
      } catch {
        // The status arrived and is the fact that matters; the body did not.
        excerpt = null;
      }

      return deliveryResult({
        status: response.status,
        responseExcerpt: excerpt,
        latencyMs: this.clock.nowMs() - startedMs,
      });
    } catch (err) {
      // DNS, refused, TLS, abort — all indistinguishable to a sender and all
      // transient. The reason goes in the excerpt so the log says which.
      return deliveryResult({
        status: null,
        responseExcerpt: excerptOf(describeNetworkFailure(err)),
        latencyMs: this.clock.nowMs() - startedMs,
      });
    } finally {
      cancelTimer();
    }
  }
}

/** A network failure, as one readable line for the delivery log. */
function describeNetworkFailure(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.name}: ${err.message} (${cause.code})` : `${err.name}: ${err.message}`;
  }
  return String(err);
}

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
