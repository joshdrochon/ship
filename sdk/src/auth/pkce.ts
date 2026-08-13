/**
 * PKCE (RFC 7636), generated client-side — PF-539.
 *
 * ── Why WebCrypto and not `node:crypto` ─────────────────────────────────────
 * `authorizationCodeFlow()` is a static on `ShipClient`, which lives in
 * `core.ts` — the runtime-neutral entry point both `index.ts` (Node) and
 * `browser.ts` are built from. `fitness.test.ts` walks `browser.ts`'s import
 * graph and asserts it reaches NO bare specifier at all, so a `node:crypto`
 * import here would break the browser bundle (L99 F14, the defect PF-507 just
 * closed) and would blow the p.9 budget on a crypto polyfill.
 *
 * `globalThis.crypto` — `getRandomValues` and `subtle.digest` — is present in
 * Node 20+ (this package declares `engines.node >= 20`), in browsers, in
 * workers and at the edge. It is a global, not an import, so nothing appears in
 * the graph.
 *
 * ── S256 only ───────────────────────────────────────────────────────────────
 * `plain` is a legal `code_challenge_method` in RFC 7636 §4.2 and it is
 * worthless: the challenge IS the verifier, so anything that could intercept
 * the authorization request has the secret. This module cannot emit it.
 */

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
const VERIFIER_BYTES = 32;

/** The only method this SDK will send. */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

/**
 * The two WebCrypto members this module uses, declared STRUCTURALLY.
 *
 * Not the DOM `Crypto` type: this package compiles without the `dom` lib (it
 * has to run in Node), so naming `Crypto` is a `TS2304` on a clean checkout.
 * Naming only what is used is also honest about the dependency — a consumer's
 * runtime has to provide exactly these two, and nothing else.
 */
interface WebCryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

function webCrypto(): WebCryptoLike {
  const available = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (available === undefined || typeof available.getRandomValues !== 'function') {
    throw new Error(
      'PKCE needs WebCrypto (globalThis.crypto). This SDK declares engines.node >= 20, ' +
        'where it is present without a flag. In a browser, a secure context is required.',
    );
  }
  return available;
}

/** RFC 4648 §5 base64url, no padding — the encoding RFC 7636 §4.2 requires. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // `btoa` is a global in Node 16+ and every browser, which keeps this module
  // free of `node:buffer` and therefore usable from `browser.ts`.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A cryptographically random `code_verifier`.
 *
 * 32 bytes → 43 base64url characters, the RFC's minimum length and 256 bits of
 * entropy. `Math.random()` would be catastrophic here and is the reason this is
 * a named function rather than an inline expression: the one place a reviewer
 * has to look.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(VERIFIER_BYTES);
  webCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** `state`, for CSRF. Same source, same encoding, different purpose. */
export function generateState(): string {
  const bytes = new Uint8Array(VERIFIER_BYTES);
  webCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** `code_challenge` = BASE64URL(SHA256(ASCII(code_verifier))) — RFC 7636 §4.2. */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const subtle = webCrypto().subtle;
  if (subtle === undefined) {
    throw new Error(
      'PKCE needs crypto.subtle for the S256 challenge. In a browser this requires a ' +
        'secure context (https or localhost). `plain` is not an option this SDK offers.',
    );
  }
  const encoded = new TextEncoder().encode(verifier);
  const digest = await subtle.digest('SHA-256', encoded);
  return base64UrlEncode(new Uint8Array(digest));
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: typeof CODE_CHALLENGE_METHOD;
}

/** A fresh verifier and its S256 challenge. */
export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: await deriveCodeChallenge(codeVerifier),
    codeChallengeMethod: CODE_CHALLENGE_METHOD,
  };
}
