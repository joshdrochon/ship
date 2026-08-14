/**
 * PF-423 — minting a webhook signing secret, and the 8 characters of it that
 * are allowed to survive.
 *
 * The raw value is returned by `POST /api/v1/webhooks` and
 * `POST /api/v1/webhooks/:id/rotate` and by nothing else in this codebase.
 * That is p.8's *"Subscription persisted; signing secret returned once"* and it
 * is the same discipline the MVP gate already requires of `client_secret`
 * (p.2, *"raw secret shown exactly once on creation"*).
 *
 * The `whsec_` tag is Stripe's, deliberately: a developer who has integrated
 * with Stripe recognises the shape, and — more usefully — a leaked secret is
 * greppable in a log dump or a public-repository scan by a string that means
 * exactly one thing.
 */
import { randomBytes } from 'node:crypto';

/** Tag on the secret. Distinct from L02's `ship_secret_` so the two are never confused. */
export const SIGNING_SECRET_TAG = 'whsec_';

/**
 * 32 bytes = 256 bits of CSPRNG output.
 *
 * The number is load-bearing rather than round. It is the HMAC-SHA256 key, and
 * a key shorter than the digest reduces the security of the MAC to the key
 * length; it also has to survive being stored encrypted, printed once, and
 * pasted into a subscriber's environment by hand, so a longer value buys
 * nothing and costs usability.
 */
const SIGNING_SECRET_ENTROPY_BYTES = 32;

/**
 * Characters kept in clear, after the tag (PF-423).
 *
 * 8, matching `oauth_apps.secret_prefix` and `api_tokens.token_prefix`.
 * Disclosure budget: 8 base64url characters is 48 bits of a 256-bit value,
 * leaving 208 bits unknown — not a meaningful reduction in the search space.
 * Taken from AFTER the tag, because storing `whsec_wh` would identify nothing.
 */
const SECRET_PREFIX_LENGTH = 8;

/** A fresh signing secret. Persisted only in encrypted form (PF-422). */
export function generateSigningSecret(): string {
  return SIGNING_SECRET_TAG + randomBytes(SIGNING_SECRET_ENTROPY_BYTES).toString('base64url');
}

/**
 * The clear-text identifier for a secret.
 *
 * Callers pass the RAW secret; this never sees a stored value, because the
 * stored value is ciphertext and there is nothing to take a prefix of.
 */
export function signingSecretPrefix(rawSecret: string): string {
  const body = rawSecret.startsWith(SIGNING_SECRET_TAG)
    ? rawSecret.slice(SIGNING_SECRET_TAG.length)
    : rawSecret;
  return body.slice(0, SECRET_PREFIX_LENGTH);
}

/** Exported so tests assert the shipped numbers rather than restating them. */
export const SIGNING_SECRET_CONSTANTS = {
  tag: SIGNING_SECRET_TAG,
  entropyBytes: SIGNING_SECRET_ENTROPY_BYTES,
  prefixLength: SECRET_PREFIX_LENGTH,
} as const;
