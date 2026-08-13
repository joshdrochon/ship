/**
 * Stripe-style webhook signatures — the SERVER signer, and the reference
 * verifier the SDK's `verifyWebhook` is checked against.
 *
 * Tickets: PF-434 (what is signed), PF-435 (the header grammar), PF-436 (one
 * serialization), PF-437 (the injected clock), PF-438 (the verifier contract),
 * PF-439 (the four-block suite).
 *
 *     Ship-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *
 * PRD p.3, HMAC-SHA256 Signing: *"Stripe-style header: `Ship-Signature:
 * t=<unix-seconds>,v1=<hex-hmac>`. Timestamp prevents replay; SDK rejects any
 * signature older than 5 minutes by default."* p.7 pins the verifier the SDK
 * must publish: `verifyWebhook(headers, rawBody, secret, toleranceSec?)` with
 * `toleranceSec` defaulting to 300.
 *
 * ## PF-434 — WHAT IS SIGNED. This is OUR decision; the PRD asks and does not answer.
 *
 * p.16's Pre-Search 2.3 asks it directly: *"What exactly is signed — the raw
 * request body, the body plus the timestamp, the body plus a versioned scheme
 * tag? Why?"* The PRD's only constraint is the header shape on p.3 and p.7,
 * which is compatible with all three.
 *
 * **Answer: the timestamp, a literal `.`, then the raw body bytes.**
 *
 *     signed = utf8(`${t}.`) ‖ rawBody
 *
 * *Why not the raw body alone.* The timestamp would then be unauthenticated
 * header data. An attacker who captured a valid signed request could rewrite
 * `t=` to the current second and replay it forever, and every verifier on earth
 * would accept it — the signature over the body is still perfectly valid. The
 * anti-replay property the PRD asks for does not merely weaken, it disappears.
 * Putting `t` inside the MAC is what makes the tolerance window mean anything.
 *
 * *Why the scheme tag is not inside the signed bytes.* It lives in the header as
 * the `v1=` key instead. That makes a future `v2` an ADDITIONAL header field a
 * verifier checks alongside `v1` — both can be emitted during a migration and a
 * subscriber upgrades on its own schedule. Baking the tag into the signed bytes
 * would make the same migration a breaking change to what is signed, so every
 * subscriber would have to cut over at once. The tolerant parser below is the
 * other half of that promise: it accepts unknown `key=value` pairs today so that
 * adding one tomorrow does not break anything reading this format now.
 *
 * ## PF-436 — RAW BYTES, serialized exactly once
 *
 * The signer takes a `Buffer`, never an object. The bytes it MACs are the bytes
 * that go on the wire, because they are the same `Buffer` — not a re-serialized
 * copy of a parsed structure. `JSON.stringify` is not canonical: key order,
 * unicode escaping and float formatting are all free to differ between two
 * serializations of one logical value, and a verifier re-serializing what it
 * parsed computes a different digest for a payload nobody tampered with. That
 * failure looks exactly like an attack, which is the worst possible way for it
 * to present.
 *
 * ## PF-437 — the clock is injected
 *
 * `Date.now()` and `new Date()` appear nowhere in this file and a grep asserts
 * it. With a `FakeClock` pinned to an instant the emitted header is byte-stable
 * across runs, which is what lets the golden vectors be committed and the replay
 * case be tested without sleeping. p.11 names timing-based webhook tests as
 * flaky tests; the deterministic clock is how this lane obeys that.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock.js';

/** The header name. One definition — emitter, verifier and L16's courier. */
export const SIGNATURE_HEADER = 'Ship-Signature';

/** The scheme tag. A future scheme is an ADDITIONAL key, never a changed one. */
export const SIGNATURE_SCHEME = 'v1';

/**
 * p.3's *"older than 5 minutes"*, and p.7's *"default 300"*. Seconds.
 *
 * 300 is Stripe's default and is chosen for the same reason: it is wide enough
 * to absorb ordinary clock skew between two hosts that both run NTP, and narrow
 * enough that a captured request is worthless within minutes.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * PF-435 — the emitted grammar, to the byte.
 *
 * Seconds not milliseconds, lowercase hex, exactly 64 characters, one comma
 * with no surrounding whitespace, `t` before `v1`. Exported so the test asserts
 * against the shipped pattern rather than a retyped copy of it.
 */
export const SIGNATURE_HEADER_PATTERN = /^t=\d+,v1=[0-9a-f]{64}$/;

/** The bytes that get MACed. See PF-434 in the module header. */
export function signedPayload(timestampSeconds: number, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestampSeconds}.`, 'utf8'), rawBody]);
}

/** HMAC-SHA256 over `t . rawBody`, lowercase hex. */
export function computeSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: Buffer,
): string {
  return createHmac('sha256', secret).update(signedPayload(timestampSeconds, rawBody)).digest('hex');
}

/** The full header VALUE for a known timestamp. */
export function formatSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: Buffer,
): string {
  return `t=${timestampSeconds},${SIGNATURE_SCHEME}=${computeSignature(secret, timestampSeconds, rawBody)}`;
}

export interface ParsedSignature {
  timestamp: number;
  v1: string;
}

/**
 * PF-435 — the parser is TOLERANT on input where the emitter is STRICT on output.
 *
 * Postel's rule, applied narrowly and on purpose. Tolerant means: unknown
 * `key=value` pairs are ignored, so a `v2=` added later does not break a
 * verifier written today. It does NOT mean lenient about the fields it does
 * read — a malformed `t`, a malformed `v1`, an empty value or a DUPLICATED key
 * all return `null`.
 *
 * The duplicate case is the one worth naming. A naive `Map` parse lets the last
 * value win, so `t=<old>,v1=<sig>,t=<now>` would verify against whichever `t`
 * the implementation happened to keep — and an attacker who can pick that gets
 * the replay window back. Two answers to "what is the timestamp" is not a
 * question a verifier may resolve by preference.
 *
 * Returns `null` and NEVER throws: this parses attacker-controlled input, and a
 * verifier that can be made to throw is a verifier that can be made to 500.
 */
export function parseSignatureHeader(header: string): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0) return null;

  const seen = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) return null; // no `=`, or an empty key
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key.length === 0 || value.length === 0) return null;
    if (seen.has(key)) return null; // PF-435 — a duplicated key is not resolvable
    seen.set(key, value);
  }

  const rawTimestamp = seen.get('t');
  const signature = seen.get(SIGNATURE_SCHEME);
  // Digits only. `Number('')` is 0 and `Number(' 5 ')` is 5, so a `Number()`
  // check would accept both — and a `t` of 0 is the epoch, which verifies
  // against a tolerance window if the clock is also 0.
  if (rawTimestamp === undefined || !/^\d+$/.test(rawTimestamp)) return null;
  // 64 lowercase hex characters. Without the length check `Buffer.from(hex)`
  // silently TRUNCATES at the first invalid pair, so `'ab' + 'zz'…` would
  // compare as a one-byte digest.
  if (signature === undefined || !/^[0-9a-f]{64}$/.test(signature)) return null;

  return { timestamp: Number.parseInt(rawTimestamp, 10), v1: signature };
}

/**
 * PF-438 — the server-side verifier, symmetric with the signer.
 *
 * This is the reference implementation of p.7's `verifyWebhook(headers,
 * rawBody, secret, toleranceSec?)`. The SDK owns the exported version (L18);
 * this owns the server function and the vectors that prove the two agree.
 *
 * `nowSeconds` is a parameter rather than read from a clock, because a verifier
 * is a pure function of what it is given. The CALLER supplies the time — in the
 * server that is `SignatureSigner`'s clock, in the SDK it is the consumer's.
 *
 * The tolerance is symmetric (`Math.abs`) and that is deliberate: a timestamp
 * far in the FUTURE is as suspicious as one far in the past. It means either the
 * sender's clock is broken or someone is pre-minting signatures to replay later,
 * and neither is a request to accept.
 */
export function verifySignature(
  secret: string,
  header: string,
  rawBody: Buffer,
  nowSeconds: number,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false;

  const expected = Buffer.from(computeSignature(secret, parsed.timestamp, rawBody), 'hex');
  const presented = Buffer.from(parsed.v1, 'hex');

  // Length first. `timingSafeEqual` THROWS on a length mismatch, and a throw is
  // itself a timing signal as well as a 500 waiting to happen. The parser
  // already pinned `v1` to 64 hex characters, so this is belt-and-braces rather
  // than the primary guard — which is the right order for a security check.
  if (expected.length !== presented.length || presented.length === 0) return false;

  // `timingSafeEqual`, never `===`. A string comparison short-circuits at the
  // first differing character, which leaks digest bytes to an attacker who can
  // time the endpoint. Slow, but real, and the whole class disappears for the
  // cost of one call.
  return timingSafeEqual(expected, presented);
}

/**
 * PF-437 — the signer as an object, so the clock is a constructor argument and
 * not an ambient capability.
 *
 * The one thing this adds over `formatSignatureHeader` is that it decides
 * *when*. That is exactly the thing that must be injectable: with a `FakeClock`
 * the emitted header is byte-stable, which is what makes the golden vectors
 * committable and the replay boundary assertable from both sides without a
 * single `setTimeout`.
 *
 * `Pick<Clock, 'nowMs'>` rather than the whole `Clock`, on the same reasoning
 * L14's bus uses: the signer READS time and never SCHEDULES any, and asking for
 * the narrower type means a caller cannot read a scheduling capability into
 * this dependency.
 */
export interface SignedRequest {
  /** The `Ship-Signature` value. */
  header: string;
  /** The unix second inside it, so a caller can record what was signed. */
  timestamp: number;
}

export class SignatureSigner {
  constructor(private readonly clock: Pick<Clock, 'nowMs'>) {}

  /** Unix SECONDS. p.3 and p.7 both say seconds; milliseconds is the classic bug. */
  nowSeconds(): number {
    return Math.floor(this.clock.nowMs() / 1000);
  }

  /**
   * Sign the exact bytes that will be sent.
   *
   * Takes a `Buffer` and not an object, which is PF-436 made structural: there
   * is no overload that could re-serialize, so the canonicalization bug is not
   * a mistake a caller can make here.
   */
  sign(secret: string, rawBody: Buffer): SignedRequest {
    const timestamp = this.nowSeconds();
    return { header: formatSignatureHeader(secret, timestamp, rawBody), timestamp };
  }

  /** Verify against this signer's own clock. Used by the portal's test delivery. */
  verify(
    secret: string,
    header: string,
    rawBody: Buffer,
    toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  ): boolean {
    return verifySignature(secret, header, rawBody, this.nowSeconds(), toleranceSeconds);
  }
}
