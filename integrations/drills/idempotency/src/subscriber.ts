/**
 * PF-729 — the dedupe contract, implemented.
 *
 * PRD p.4, Replay: *"Idempotency-Key header passed through so subscribers can
 * dedupe."* Every lane in this build produces the SENDER's half of that; nothing
 * else in the plan produces a subscriber that actually dedupes, and Pre-Search
 * 2.3 (p.16) asks for the subscriber contract by name.
 *
 * ── The contract, in three lines ───────────────────────────────────────────
 *   header      `Idempotency-Key`, case-insensitively, on every delivery
 *   lifetime    the subscriber remembers a key for as long as its side effect
 *               is observable. Here that is the process; a real subscriber
 *               persists it beside the side effect, in the same transaction.
 *   duplicate   **200**, and the side effect does NOT run again
 *
 * The written-out version, with the reasoning, is `README.md`. This file is the
 * executable copy and `contract.test.ts` asserts the two agree.
 *
 * ── Why 200 on a duplicate, and not 409 ────────────────────────────────────
 * A duplicate delivery is the sender doing exactly what it promised: retrying
 * something it is not sure landed. The subscriber's answer has to mean "you can
 * stop now", and the only status that means that in L16's classifier is a 2xx.
 * A 409 is a permanent 4xx, so the delivery would DEAD-LETTER — the platform
 * would record a delivery failure for the one case where everything worked.
 *
 * ── Verification comes first, always ───────────────────────────────────────
 * `handle` verifies the signature over the RAW bytes before it looks at any
 * header. A subscriber that dedupes first is one that lets an unauthenticated
 * caller poison its key store: send a forged request carrying a key you guessed,
 * and the real delivery that follows is silently swallowed as a duplicate.
 *
 * ── The structural inbound type is deliberate ──────────────────────────────
 * This module takes `{ headers, rawBody }` rather than importing the testkit's
 * `CapturedRequest`. The testkit is a DEV dependency (it is a fixture, and the
 * front-door claim is about what an integration's process depends on at
 * runtime), so a `src/` file importing it would be a real violation of the rule
 * `scripts/check-integration-deps.mjs` enforces. `CapturedRequest` satisfies
 * this shape structurally, so the tests wire the two together with no adapter.
 */
import { verifyWebhook } from '@ship/sdk';

/** The header, lower-cased. Node delivers header names lower-cased already. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** Anything with headers and the bytes that arrived. */
export interface InboundDelivery {
  headers: Record<string, string>;
  rawBody: Buffer;
}

/** One unit of work the subscriber did. The thing that must not happen twice. */
export interface SideEffect {
  idempotencyKey: string;
  eventId: string | null;
  eventType: string | null;
  /** 1-based order in which side effects were performed. */
  ordinal: number;
}

export interface SubscriberDecision {
  status: number;
  body: string;
  /** True when the key had been seen and the side effect was NOT repeated. */
  deduped: boolean;
  /** False when the signature did not verify. Nothing else ran. */
  verified: boolean;
}

export interface DedupeSubscriberOptions {
  /** The `signing_secret` returned once by `client.webhooks.create()`. */
  secret: string;
  /**
   * What to answer for the Nth request whose key is NEW (1-based).
   *
   * Defaults to 200. PF-731 uses `(n) => (n <= 3 ? 500 : 200)` to make Ship
   * climb its real retry ladder, and PF-730 uses a permanent 4xx to drive a
   * delivery straight to the dead-letter queue.
   *
   * Counted over ATTEMPTS, not over keys: a retry has to be able to see a
   * different answer from the attempt before it, which is the whole point.
   */
  answer?: (attempt: number) => number;
  /** Injected clock in Unix seconds, for the stale-timestamp case. */
  nowSeconds?: () => number;
}

export interface DedupeSubscriber {
  handle(delivery: InboundDelivery): SubscriberDecision;
  /** One entry per NEW key. Length is the answer to "how many times did it run". */
  readonly sideEffects: readonly SideEffect[];
  /** Every key seen, in arrival order, duplicates included. */
  readonly keysSeen: readonly string[];
  /** Every attempt's decision, in order. */
  readonly decisions: readonly SubscriberDecision[];
}

export function createDedupeSubscriber(options: DedupeSubscriberOptions): DedupeSubscriber {
  const answer = options.answer ?? ((): number => 200);
  const sideEffects: SideEffect[] = [];
  const keysSeen: string[] = [];
  const decisions: SubscriberDecision[] = [];
  const performed = new Set<string>();
  let attempts = 0;

  function record(decision: SubscriberDecision): SubscriberDecision {
    decisions.push(decision);
    return decision;
  }

  return {
    sideEffects,
    keysSeen,
    decisions,

    handle(delivery: InboundDelivery): SubscriberDecision {
      // 1. Signature, over the raw bytes, before anything else.
      const verified =
        options.nowSeconds === undefined
          ? verifyWebhook(delivery.headers, delivery.rawBody, options.secret)
          : verifyWebhook(delivery.headers, delivery.rawBody, options.secret, 300, {
              nowSeconds: options.nowSeconds,
            });

      if (!verified) {
        // 401 is a permanent 4xx under L16's classifier, so Ship dead-letters
        // rather than retrying a secret that will not become correct.
        return record({
          status: 401,
          body: JSON.stringify({ error: 'signature_did_not_verify' }),
          deduped: false,
          verified: false,
        });
      }

      // 2. The key.
      const key = delivery.headers[IDEMPOTENCY_HEADER];
      if (key === undefined || key === '') {
        return record({
          status: 400,
          body: JSON.stringify({ error: 'missing_idempotency_key' }),
          deduped: false,
          verified: true,
        });
      }
      keysSeen.push(key);
      attempts += 1;

      // 3. Seen before → 200, and the side effect does NOT run again.
      if (performed.has(key)) {
        return record({
          status: 200,
          body: JSON.stringify({ ok: true, deduped: true, key }),
          deduped: true,
          verified: true,
        });
      }

      // 4. New key. The subscriber's answer decides whether the side effect
      //    COMMITS: a 5xx means "I did not process this", so recording it would
      //    make the retry a no-op and the work would never happen. This ordering
      //    is the difference between deduping and dropping.
      const status = answer(attempts);
      if (status >= 200 && status < 300) {
        performed.add(key);
        const payload = readEnvelope(delivery.rawBody);
        sideEffects.push({
          idempotencyKey: key,
          eventId: payload.id,
          eventType: payload.type,
          ordinal: sideEffects.length + 1,
        });
      }

      return record({
        status,
        body: JSON.stringify({ ok: status < 300, deduped: false, key }),
        deduped: false,
        verified: true,
      });
    },
  };
}

/** Best-effort read of the event envelope. A subscriber never trusts it to parse. */
function readEnvelope(rawBody: Buffer): { id: string | null; type: string | null } {
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    const id = typeof parsed.id === 'string' ? parsed.id : null;
    const type = typeof parsed.type === 'string' ? parsed.type : null;
    return { id, type };
  } catch {
    return { id: null, type: null };
  }
}
