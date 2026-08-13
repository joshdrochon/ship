/**
 * PKCE (RFC 7636) computed in the BROWSER, with Web Crypto.
 *
 * ── The property this file exists to guarantee ──────────────────────────────
 * PF-734: *"the `code_verifier` never leaves the browser."* It is generated
 * here, kept in `sessionStorage`, and read back exactly once — to be placed in
 * the **body** of the `POST /oauth/token` request. It never appears in a URL,
 * a query string, a fragment, or anything a `Referer` header could carry.
 *
 * That is the whole point of PKCE for a public client. The authorization
 * request carries only the S256 CHALLENGE, which is a one-way digest: an
 * attacker who intercepts the redirect (browser history, a shoulder-surfed URL
 * bar, a proxy log, a `Referer` leaked to a third-party script on the callback
 * page) gets the code and the challenge, and can do nothing with them, because
 * redeeming the code requires the pre-image.
 *
 * ── Why this is hand-written rather than an SDK call ────────────────────────
 * `ShipClient.authorizationCodeFlow()` is PRD p.4's helper and it is L18's
 * PF-539. It is **not built** — `sdk/src/auth/flows.ts` is a TODO block on
 * `pf/integration` as of 2026-08-13, verified before writing this file. Rather
 * than block an MVP gate item on another lane's unwritten ticket, the demo does
 * the four operations itself: they are 30 lines of Web Crypto and no more.
 *
 * **L18: this is the browser half of your helper's job description, and it is
 * deliberately shaped so `authorizationCodeFlow()` can replace it.** When
 * PF-539 lands, `startAuthorization` and `exchangeCode` in `main.ts` collapse
 * into two SDK calls and this module is deleted. The demo's Playwright
 * assertions are written against the WIRE, not against these functions, so they
 * keep passing across that substitution — which is what makes the swap safe to
 * do without re-deriving what the test proves.
 *
 * Nothing here reaches for `node:crypto`. `crypto.subtle` is the browser's own
 * SHA-256 and is available on every secure context (and on `http://localhost`,
 * which the spec treats as secure — this matters, because the demo runs on
 * `http://localhost:4173` in CI and would otherwise have no `subtle` at all).
 */

/** The `sessionStorage` key the verifier lives at between the two legs. */
export const VERIFIER_STORAGE_KEY = 'ship.demo.pkce.verifier';

/** And the `state` value, so the callback can check the redirect is ours. */
export const STATE_STORAGE_KEY = 'ship.demo.pkce.state';

/**
 * Unpadded base64url (RFC 7636 §A).
 *
 * The padding is stripped rather than left on, and the reason is not cosmetic:
 * `authorize.ts` rejects a `code_challenge` that is not exactly 43 characters
 * of unpadded base64url, and it says so in its own comment that a 44-character
 * padded value "is the single most common way a client's PKCE implementation is
 * wrong". Getting it wrong here would fail with `invalid_request` at the
 * authorize step, before the flow this demo exists to show ever starts.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh verifier: 32 bytes of CSPRNG output, base64url-encoded to 43 chars.
 *
 * RFC 7636 §4.1 permits 43–128 characters. 32 bytes is the low end and it is
 * the right end: it is 256 bits of entropy, and a longer verifier buys nothing
 * against a digest that is 256 bits wide.
 */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** `state` — the client's own CSRF defence for the redirect leg (RFC 6749 §10.12). */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * S256: `BASE64URL(SHA256(ASCII(verifier)))`.
 *
 * `plain` is not implemented and cannot be selected. Ship's authorize endpoint
 * rejects it outright (`SUPPORTED_CODE_CHALLENGE_METHOD = 'S256'`), and with
 * `plain` the verifier and the challenge are the same string — so the verifier
 * WOULD travel in the authorization URL, which is the exact property this demo
 * is here to disprove.
 */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
