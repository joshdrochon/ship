/**
 * PF-422 — the signing secret at rest: round-trip, and fail closed.
 *
 * The byte-scan over a real `SELECT *` lives in
 * `subscriptionSecretLeak.test.ts`, because it needs a database. This file is
 * the cipher on its own, in a bare Node context.
 */
import { describe, it, expect } from 'vitest';
import {
  AesGcmSecretCipher,
  envSecretCipher,
  parseWebhookSecretKey,
  WebhookSecretCryptoError,
  WEBHOOK_SECRET_KEY_BYTES,
  WEBHOOK_SECRET_KEY_ENV,
} from './secretCipher.js';
import { generateSigningSecret } from './signingSecret.js';

const KEY = Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x11);
const OTHER_KEY = Buffer.alloc(WEBHOOK_SECRET_KEY_BYTES, 0x22);

describe('PF-422 — AES-256-GCM at rest', () => {
  it('round-trips a signing secret', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const secret = generateSigningSecret();
    expect(cipher.decrypt(cipher.encrypt(secret))).toBe(secret);
  });

  it('never stores the plaintext inside the ciphertext', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const secret = generateSigningSecret();
    const stored = cipher.encrypt(secret);
    expect(stored).not.toContain(secret);
    // And not in the decoded bytes either — a base64 string can hide a
    // substring that a byte scan would still find.
    expect(Buffer.from(stored, 'base64').includes(Buffer.from(secret, 'utf8'))).toBe(false);
  });

  it('produces a different ciphertext every time (fresh nonce)', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const secret = generateSigningSecret();
    const seen = new Set(Array.from({ length: 50 }, () => cipher.encrypt(secret)));
    // 50 distinct ciphertexts for one plaintext. A repeated nonce under GCM
    // leaks the XOR of two plaintexts AND the authentication key, so this is
    // not a style assertion.
    expect(seen.size).toBe(50);
    for (const stored of seen) expect(cipher.decrypt(stored)).toBe(secret);
  });

  it('handles a non-ASCII secret unchanged', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const value = 'whsec_ünïcødé_🔐_secret';
    expect(cipher.decrypt(cipher.encrypt(value))).toBe(value);
  });
});

describe('PF-422 — fail closed', () => {
  it('throws on the WRONG key rather than returning garbage', () => {
    const stored = new AesGcmSecretCipher(KEY).encrypt(generateSigningSecret());
    expect(() => new AesGcmSecretCipher(OTHER_KEY).decrypt(stored)).toThrow(
      WebhookSecretCryptoError,
    );
  });

  it('throws when the ciphertext was tampered with', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const raw = Buffer.from(cipher.encrypt(generateSigningSecret()), 'base64');
    // Flip one bit in the middle of the ciphertext body.
    const at = Math.floor(raw.length / 2);
    raw.writeUInt8(raw.readUInt8(at) ^ 0x01, at);
    expect(() => cipher.decrypt(raw.toString('base64'))).toThrow(WebhookSecretCryptoError);
  });

  it('throws when the authentication tag was tampered with', () => {
    const cipher = new AesGcmSecretCipher(KEY);
    const raw = Buffer.from(cipher.encrypt(generateSigningSecret()), 'base64');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0xff, raw.length - 1);
    expect(() => cipher.decrypt(raw.toString('base64'))).toThrow(WebhookSecretCryptoError);
  });

  it('throws on a value too short to hold a nonce and a tag', () => {
    expect(() => new AesGcmSecretCipher(KEY).decrypt('AAAA')).toThrow(WebhookSecretCryptoError);
  });

  it('refuses a key of the wrong length at construction', () => {
    expect(() => new AesGcmSecretCipher(Buffer.alloc(16))).toThrow(WebhookSecretCryptoError);
    expect(() => new AesGcmSecretCipher(Buffer.alloc(64))).toThrow(WebhookSecretCryptoError);
  });

  it('throws when the key is ABSENT from the environment, naming the variable', () => {
    const cipher = envSecretCipher({} as NodeJS.ProcessEnv);
    expect(() => cipher.encrypt('whsec_anything')).toThrow(WEBHOOK_SECRET_KEY_ENV);
    expect(() => cipher.decrypt('AAAAAAAAAAAAAAAAAAAAAAAA')).toThrow(WEBHOOK_SECRET_KEY_ENV);
  });

  it('does not resolve the key until first use, so a missing key is not a boot failure', () => {
    // Construction alone must not throw — `productionDeps()` builds this for
    // every app in the repository, including 115 test files with no webhooks.
    expect(() => envSecretCipher({} as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('PF-422 — key parsing', () => {
  it('accepts base64 and hex of the right length', () => {
    expect(parseWebhookSecretKey(KEY.toString('base64')).equals(KEY)).toBe(true);
    expect(parseWebhookSecretKey(KEY.toString('hex')).equals(KEY)).toBe(true);
  });

  it('rejects a key that decodes to the wrong length rather than padding it', () => {
    // A silently padded key encrypts fine and cannot be decrypted by anyone
    // else's copy of the configuration — a failure that surfaces weeks later.
    expect(() => parseWebhookSecretKey(Buffer.alloc(16).toString('base64'))).toThrow(
      WebhookSecretCryptoError,
    );
    expect(() => parseWebhookSecretKey('')).toThrow(WebhookSecretCryptoError);
  });

  it('round-trips through envSecretCipher when the variable is set', () => {
    const cipher = envSecretCipher({
      [WEBHOOK_SECRET_KEY_ENV]: KEY.toString('base64'),
    } as NodeJS.ProcessEnv);
    const secret = generateSigningSecret();
    expect(cipher.decrypt(cipher.encrypt(secret))).toBe(secret);
  });
});
