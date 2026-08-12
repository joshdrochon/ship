/**
 * Stripe-style webhook signatures.
 *
 *   Ship-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
 *   signed payload: `${t}.${rawBody}`
 *
 * Raw BYTES are signed — never re-serialized JSON — so there is no
 * canonicalization ambiguity between signer and verifier. The timestamp inside
 * the signed payload is the anti-replay measure (verifier default tolerance:
 * 300 s). The `v1` tag versions the scheme so rotation to v2 is additive.
 *
 * Own unit suite required: positive, negative, replay (stale t), tamper.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Ship-Signature';

export function computeSignature(secret: string, timestampSeconds: number, rawBody: string | Buffer): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const signed = Buffer.concat([Buffer.from(`${timestampSeconds}.`, 'utf8'), body]);
  return createHmac('sha256', secret).update(signed).digest('hex');
}

export function formatSignatureHeader(secret: string, timestampSeconds: number, rawBody: string | Buffer): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, timestampSeconds, rawBody)}`;
}

export interface ParsedSignature {
  timestamp: number;
  v1: string;
}

export function parseSignatureHeader(header: string): ParsedSignature | null {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) return null;
    parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return null;
  return { timestamp: t, v1 };
}

/** Server-side verify (portal "test delivery" + unit suite share this). */
export function verifySignature(
  secret: string,
  header: string,
  rawBody: string | Buffer,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false; // replay window
  const expected = Buffer.from(computeSignature(secret, parsed.timestamp, rawBody), 'hex');
  const presented = Buffer.from(parsed.v1, 'hex');
  if (expected.length !== presented.length || presented.length === 0) return false;
  return timingSafeEqual(expected, presented);
}
