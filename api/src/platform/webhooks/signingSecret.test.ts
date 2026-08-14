/**
 * PF-423 — the secret is minted with real entropy, and only 8 characters of it
 * are allowed to survive.
 */
import { describe, it, expect } from 'vitest';
import {
  generateSigningSecret,
  signingSecretPrefix,
  SIGNING_SECRET_CONSTANTS,
  SIGNING_SECRET_TAG,
} from './signingSecret.js';

describe('PF-423 — generateSigningSecret', () => {
  it('10 000 generations yield 10 000 distinct values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(generateSigningSecret());
    expect(seen.size).toBe(10_000);
  });

  it('carries at least 256 bits of entropy, and none is shorter than declared', () => {
    // base64url of N bytes is ceil(N * 4 / 3) characters with no padding.
    const bodyLength = Math.ceil((SIGNING_SECRET_CONSTANTS.entropyBytes * 4) / 3);
    const expected = SIGNING_SECRET_TAG.length + bodyLength;
    expect(SIGNING_SECRET_CONSTANTS.entropyBytes * 8).toBeGreaterThanOrEqual(256);
    for (let i = 0; i < 1000; i += 1) {
      const secret = generateSigningSecret();
      expect(secret.length).toBe(expected);
      expect(secret.startsWith(SIGNING_SECRET_TAG)).toBe(true);
    }
  });

  it('is base64url after the tag — no `+`, `/` or `=`', () => {
    // The value is pasted into a subscriber's environment file and appears in a
    // shell. A `+` or `/` survives that; padding `=` regularly does not.
    for (let i = 0; i < 200; i += 1) {
      const body = generateSigningSecret().slice(SIGNING_SECRET_TAG.length);
      expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('PF-423 — signingSecretPrefix', () => {
  it('takes 8 characters from AFTER the tag', () => {
    const secret = generateSigningSecret();
    const prefix = signingSecretPrefix(secret);
    expect(prefix).toHaveLength(SIGNING_SECRET_CONSTANTS.prefixLength);
    expect(prefix).toBe(secret.slice(SIGNING_SECRET_TAG.length, SIGNING_SECRET_TAG.length + 8));
    // Storing `whsec_wh` would identify nothing.
    expect(prefix.startsWith('whsec')).toBe(false);
  });

  it('discloses only 8 of the ~43 random characters', () => {
    const secret = generateSigningSecret();
    const disclosed = signingSecretPrefix(secret).length;
    const total = secret.length - SIGNING_SECRET_TAG.length;
    expect(total - disclosed).toBeGreaterThan(30);
  });

  it('tolerates an untagged value rather than returning the wrong slice', () => {
    expect(signingSecretPrefix('abcdefghijklmno')).toBe('abcdefgh');
  });
});
