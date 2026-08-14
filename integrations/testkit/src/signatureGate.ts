/**
 * The signature check every webhook-receiving integration runs FIRST, over the
 * bytes that arrived.
 *
 * PRD p.4 names the verifier `verifyWebhook(headers, rawBody, secret)` and p.7's
 * drill calls it before doing anything else. This wrapper exists so the two
 * consumers in this tree — the Slack listener (PF-741) and the idempotency drill
 * (PF-728) — cannot disagree about what "verified" means, and so neither of them
 * has to remember that the argument is `Buffer`, not `string`.
 *
 * ── The bug this shape prevents ────────────────────────────────────────────
 * The classic failure in an Express listener is an app-wide `express.json()`
 * parsing the body before the handler sees it. The handler then has an OBJECT,
 * re-serialises it to verify, and computes an HMAC over bytes the server never
 * signed — different key order, different whitespace, different unicode escapes.
 * Every legitimate delivery is rejected and the integration looks broken end to
 * end while each half looks correct in isolation.
 *
 * `signatureGate` only accepts a `Buffer`. A caller holding a parsed object has
 * a type error at the keyboard rather than a mystery at 3am.
 */
import { verifyWebhook, DEFAULT_TOLERANCE_SECONDS } from '@ship/sdk';

/**
 * 401, not 400.
 *
 * A signature that does not verify is an AUTHENTICATION failure — the sender is
 * not who the delivery claims. It is also, deliberately, in the 4xx family:
 * L16's `classifyDeliveryOutcome` treats 4xx as permanent, so a mis-keyed
 * subscriber dead-letters rather than burning six attempts on a secret that will
 * not become correct. That is the answer we want; re-signing is a human action.
 */
export const SIGNATURE_REJECTED_STATUS = 401;

export interface SignatureGateOptions {
  /** The subscription's signing secret, as returned once by `webhooks.create`. */
  secret: string;
  /** Seconds of clock skew tolerated. Defaults to the SDK's own 300. */
  toleranceSeconds?: number;
  /**
   * Unix SECONDS "now", injected — the unit the SDK's own `VerifyOptions` uses.
   *
   * p.11 forbids `setTimeout` waits and requires clock injection; the stale-
   * timestamp case (PF-741's second assertion) is exactly where a test would
   * otherwise be tempted to wait six minutes. Passing a `nowSeconds` six minutes
   * ahead makes that case instantaneous and deterministic. Omitted, it is the
   * wall clock, which is what a real subscriber uses.
   */
  nowSeconds?: number;
}

export interface SignatureGateResult {
  verified: boolean;
  /** What a subscriber should answer. 200-range is the caller's business. */
  status: number;
  reason: string | null;
}

/**
 * Verifies one delivery. Returns a decision rather than throwing, because the
 * caller has to answer the HTTP request either way and a throw invites a
 * `catch` that answers 500 — which would tell Ship to retry a delivery whose
 * signature will never become valid.
 */
export function signatureGate(
  headers: Record<string, string>,
  rawBody: Buffer,
  options: SignatureGateOptions,
): SignatureGateResult {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const at = options.nowSeconds;
  const verified =
    at === undefined
      ? verifyWebhook(headers, rawBody, options.secret, tolerance)
      : verifyWebhook(headers, rawBody, options.secret, tolerance, { nowSeconds: () => at });

  return verified
    ? { verified: true, status: 200, reason: null }
    : {
        verified: false,
        status: SIGNATURE_REJECTED_STATUS,
        reason:
          'signature did not verify over the raw body, or the timestamp is outside tolerance',
      };
}
