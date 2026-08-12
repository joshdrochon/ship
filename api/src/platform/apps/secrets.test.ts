/**
 * PF-032, PF-033, PF-034, PF-035, PF-036 — credential generation and hashing.
 *
 * These run in a bare Node context: no Express, no database, no HTTP stack.
 * That is deliberate and is the property PF-037 depends on, because L04/L05/L06
 * have to be able to build against this module before any of L02's HTTP surface
 * exists.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  CLIENT_ID_TAG,
  CLIENT_SECRET_TAG,
  generateClientId,
  generateClientSecret,
  hashClientSecret,
  secretPrefix,
  digestsEqual,
} from './secrets.js';

describe('PF-032 — client_id is a public identifier', () => {
  it('is tagged and carries at least 128 bits of entropy', () => {
    const id = generateClientId();
    expect(id.startsWith(CLIENT_ID_TAG)).toBe(true);

    const body = id.slice(CLIENT_ID_TAG.length);
    // base64url of 16 bytes is 22 characters (no padding). Asserting the decoded
    // byte length rather than the string length is what actually pins entropy.
    expect(Buffer.from(body, 'base64url').length).toBeGreaterThanOrEqual(16);
  });

  it('yields 10 000 distinct values over 10 000 generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateClientId());
    expect(seen.size).toBe(10_000);
  });
});

describe('PF-033 — client_secret is 32 bytes of CSPRNG output', () => {
  it('is tagged and decodes to exactly 32 bytes', () => {
    const secret = generateClientSecret();
    expect(secret.startsWith(CLIENT_SECRET_TAG)).toBe(true);

    const body = secret.slice(CLIENT_SECRET_TAG.length);
    // 32 bytes is the constant D1's no-salt defense rests on. If this assertion
    // ever needs relaxing, the argument in docs/architecture.md changes too.
    expect(Buffer.from(body, 'base64url').length).toBe(32);
  });

  it('yields 10 000 distinct values, none shorter than the declared length', () => {
    const seen = new Set<string>();
    const minLength = CLIENT_SECRET_TAG.length + 43; // base64url of 32 bytes
    for (let i = 0; i < 10_000; i++) {
      const s = generateClientSecret();
      expect(s.length).toBeGreaterThanOrEqual(minLength);
      seen.add(s);
    }
    expect(seen.size).toBe(10_000);
  });
});

describe('PF-034 — D1: SHA-256, unsalted', () => {
  it('string-equals a SHA-256 computed independently in the test', () => {
    const raw = generateClientSecret();
    // Computed here from primitives, not by calling the module under test —
    // otherwise this asserts only that the function is deterministic.
    const independent = crypto.createHash('sha256').update(raw).digest('hex');
    expect(hashClientSecret(raw)).toBe(independent);
  });

  it('is unsalted: the same input always produces the same digest', () => {
    // This is the observable consequence of "no salt". A salted hash would
    // produce a different digest on each call, and rows could not be looked up
    // by digest at all — which is how /oauth/token finds an app.
    const raw = generateClientSecret();
    expect(hashClientSecret(raw)).toBe(hashClientSecret(raw));
  });

  it('produces a 64-character hex digest', () => {
    expect(hashClientSecret('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a wrong secret does not hash to the right digest', () => {
    const raw = generateClientSecret();
    expect(hashClientSecret(raw + 'x')).not.toBe(hashClientSecret(raw));
  });
});

describe('PF-035 — secret_prefix', () => {
  it('is the first 8 characters after the tag, not of the whole string', () => {
    const secret = generateClientSecret();
    const body = secret.slice(CLIENT_SECRET_TAG.length);

    const prefix = secretPrefix(secret);
    expect(prefix).toHaveLength(8);
    expect(prefix).toBe(body.slice(0, 8));
    // The failure this guards: taking secret.slice(0, 8) would return
    // "ship_sec" for every app ever registered, identifying nothing.
    expect(prefix.startsWith('ship_')).toBe(false);
  });

  it('leaves the overwhelming majority of the secret undisclosed', () => {
    const secret = generateClientSecret();
    const undisclosed = secret.slice(CLIENT_SECRET_TAG.length + 8);
    expect(undisclosed.length).toBeGreaterThan(30);
  });
});

describe('PF-036 — constant-time comparison', () => {
  it('is true for equal digests and false for unequal ones', () => {
    const a = hashClientSecret('one');
    const b = hashClientSecret('two');
    expect(digestsEqual(a, a)).toBe(true);
    expect(digestsEqual(a, b)).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // crypto.timingSafeEqual throws on unequal lengths. An uncaught throw here
    // would be a 500 on a wrong-secret request, which is itself an oracle:
    // "malformed" would be distinguishable from "wrong".
    expect(() => digestsEqual('short', hashClientSecret('x'))).not.toThrow();
    expect(digestsEqual('short', hashClientSecret('x'))).toBe(false);
  });

  it('does not short-circuit on the first differing character', () => {
    // Two digests differing only in the last character must compare false, the
    // same as two differing in the first. This does not measure timing — it
    // asserts correctness at both ends, which is what a === would also pass;
    // the single-comparison-site grep in oauth-apps-fitness.test.ts is what
    // actually pins timingSafeEqual.
    const base = 'a'.repeat(64);
    expect(digestsEqual(base, 'a'.repeat(63) + 'b')).toBe(false);
    expect(digestsEqual(base, 'b' + 'a'.repeat(63))).toBe(false);
  });
});
