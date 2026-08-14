/**
 * PKCE (RFC 7636) — S256 only. Plain is rejected by policy: if you can compute
 * SHA-256 you have no reason to send the verifier in the clear.
 *
 * The negative case (wrong verifier → invalid_grant) is a REQUIRED test.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function s256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/** Constant-time comparison of the derived challenge against the stored one. */
export function verifyPkce(codeVerifier: string, storedChallenge: string): boolean {
  const derived = Buffer.from(s256Challenge(codeVerifier));
  const stored = Buffer.from(storedChallenge);
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

/** RFC 7636 §4.1: verifier must be 43–128 chars of [A-Z a-z 0-9 - . _ ~]. */
export function isValidVerifier(codeVerifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier);
}
