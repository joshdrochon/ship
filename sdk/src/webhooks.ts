/**
 * verifyWebhook — one call, boolean answer, < 1 ms.
 *
 *   const ok = verifyWebhook(req.headers, rawBody, signingSecret);
 *
 * Verifies HMAC-SHA256 over `${t}.${rawBody}` from the Ship-Signature header
 * (t=<unix>,v1=<hex>) and rejects signatures older than `toleranceSec`
 * (default 300) — the anti-replay window. Pass the RAW request body bytes,
 * not re-parsed JSON.
 *
 * Node runtime (node:crypto). Browser demo uses the server-side test endpoint.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'ship-signature';

export interface VerifyOptions {
  toleranceSec?: number;
  /** Injectable for tests; defaults to wall clock. */
  nowSeconds?: () => number;
}

export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string | Uint8Array,
  secret: string,
  options: VerifyOptions = {},
): boolean {
  const tolerance = options.toleranceSec ?? 300;
  const now = options.nowSeconds ? options.nowSeconds() : Math.floor(Date.now() / 1000);

  const headerValue = headers[SIGNATURE_HEADER] ?? headers['Ship-Signature'];
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!header) return false;

  let timestamp: number | null = null;
  let v1: string | null = null;
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) return false;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    if (key === 'v1') v1 = value;
  }
  if (timestamp === null || !Number.isFinite(timestamp) || !v1) return false;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]);
  const expected = createHmac('sha256', secret).update(signed).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(v1, 'hex');
  } catch {
    return false;
  }
  if (presented.length !== expected.length || presented.length === 0) return false;
  return timingSafeEqual(expected, presented);
}
