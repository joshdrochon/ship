/**
 * PF-152, PF-153, PF-157 — token generation, hashing and TTL constants.
 *
 * These are the assertions that make `docs/architecture.md:138` a checked claim
 * rather than a sentence. Line 138 says access tokens are "opaque high-entropy
 * strings stored hashed"; three of the four describes below correspond one-for-
 * one to those three words, which is PF-176's point — the document and the code
 * cannot drift because a test fails when they do.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../../test/sourceScan.js';
import {
  ACCESS_TOKEN_TAG,
  REFRESH_TOKEN_TAG,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  DEFAULT_TOKEN_TTL,
  REFRESH_REPLAY_WINDOW_MS,
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  tokenPrefix,
  newFamilyId,
} from './tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every non-test source file in this lane's directory, COMMENTS STRIPPED.
 *
 * Stripping matters. These assertions are about what the code does, and a raw
 * grep fires on the comment that explains the rule as readily as on a breach of
 * it — the first version of this file failed on its own documentation, which
 * says "never from `Date.now()`" and "well-formed for the UUID column". A
 * fitness test that cannot tell code from prose teaches the next person to
 * delete the explanation instead of fixing the code.
 */
function laneSourceFiles(): { name: string; text: string }[] {
  return scanDirectory(HERE).map((f) => ({ name: f.name, text: f.code }));
}

describe('PF-152: high entropy', () => {
  it('draws 10 000 access tokens with no collision', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(generateAccessToken());
    expect(seen.size).toBe(10_000);
  });

  it('draws 10 000 refresh tokens with no collision', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(generateRefreshToken());
    expect(seen.size).toBe(10_000);
  });

  it('carries 32 bytes of entropy after the tag', () => {
    const body = generateAccessToken().slice(ACCESS_TOKEN_TAG.length);
    // 32 bytes base64url-encodes to 43 characters, unpadded.
    expect(body).toHaveLength(43);
    expect(Buffer.from(body, 'base64url')).toHaveLength(32);
  });

  it('tags the two types differently, so a leaked credential is identifiable', () => {
    expect(generateAccessToken().startsWith(ACCESS_TOKEN_TAG)).toBe(true);
    expect(generateRefreshToken().startsWith(REFRESH_TOKEN_TAG)).toBe(true);
    expect(ACCESS_TOKEN_TAG).not.toBe(REFRESH_TOKEN_TAG);
  });
});

describe('PF-152: opaque — not a JWT, no decodable payload', () => {
  /**
   * "Opaque" in `docs/architecture.md:138` is a property a reviewer can only
   * confirm if something confirms it. This is that something.
   */
  it('is not a JWT', () => {
    const token = generateAccessToken();
    // A JWT is three base64url segments separated by dots.
    expect(token.split('.')).toHaveLength(1);
    expect(token).not.toMatch(/^eyJ/);
  });

  it('carries no decodable JSON payload', () => {
    const body = generateAccessToken().slice(ACCESS_TOKEN_TAG.length);
    let decoded: string;
    try {
      decoded = Buffer.from(body, 'base64url').toString('utf8');
    } catch {
      return; // undecodable is even more opaque than unparseable
    }
    expect(() => JSON.parse(decoded) as unknown).toThrow();
  });

  it('encodes nothing about the app, user or scopes — there is nothing to encode', () => {
    // Two tokens drawn back to back share no structure beyond the tag. If the
    // value carried claims, a common substring would show up here.
    const a = generateAccessToken().slice(ACCESS_TOKEN_TAG.length);
    const b = generateAccessToken().slice(ACCESS_TOKEN_TAG.length);
    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared += 1;
    expect(shared).toBeLessThan(8);
  });
});

describe('PF-152: hashing discipline', () => {
  it('hashes to a 64-character hex SHA-256 digest', () => {
    expect(hashToken('ship_at_example')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and collision-free across distinct inputs', () => {
    const raw = generateAccessToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
    expect(hashToken(raw)).not.toBe(hashToken(generateAccessToken()));
  });

  it('never reveals the raw token in its digest', () => {
    const raw = generateAccessToken();
    expect(hashToken(raw)).not.toContain(raw.slice(ACCESS_TOKEN_TAG.length));
  });

  it('is the only TOKEN-hashing site under platform/oauth/', () => {
    const hits = laneSourceFiles().filter((f) => f.text.includes("createHash('sha256')"));
    // `pkce.ts` is the other one, and legitimately so: RFC 7636's S256 challenge
    // method IS a SHA-256, over a `code_verifier` rather than over a token. It
    // belongs to L04's ticket, not this lane's. Naming it here rather than
    // loosening the assertion keeps a THIRD site from appearing unnoticed.
    expect(hits.map((h) => h.name)).toEqual(['pkce.ts', 'tokens.ts']);
  });
});

describe('PF-152: the prefix mirrors api_tokens.token_prefix', () => {
  it('takes 8 characters from AFTER the tag', () => {
    const raw = generateAccessToken();
    const prefix = tokenPrefix(raw);
    expect(prefix).toHaveLength(8);
    expect(prefix).toBe(raw.slice(ACCESS_TOKEN_TAG.length, ACCESS_TOKEN_TAG.length + 8));
    // Storing `ship_at_` would identify nothing.
    expect(prefix).not.toContain('ship_');
  });

  it('handles a refresh token the same way', () => {
    const raw = generateRefreshToken();
    expect(tokenPrefix(raw)).toBe(raw.slice(REFRESH_TOKEN_TAG.length, REFRESH_TOKEN_TAG.length + 8));
  });
});

describe('PF-152: nothing in this lane mints from a weak source', () => {
  /**
   * The ticket's grep, run as a test. `Math.random` is not a CSPRNG, a
   * `Date.now()`-derived seed is guessable, and a generator library would be a
   * second source of random bytes to audit.
   */
  it('uses no Math.random anywhere under platform/oauth/', () => {
    const hits = laneSourceFiles().filter((f) => f.text.includes('Math.random'));
    expect(hits.map((h) => h.name)).toEqual([]);
  });

  it('reads no wall clock — every expiry check goes through the injected Clock (PF-173)', () => {
    const hits = laneSourceFiles().filter((f) => f.text.includes('Date.now('));
    expect(hits.map((h) => h.name)).toEqual([]);
  });

  it('schedules nothing — a setTimeout in this lane would be a flake (PF-173)', () => {
    const hits = laneSourceFiles().filter((f) => /\bsetTimeout\s*\(/.test(f.text));
    expect(hits.map((h) => h.name)).toEqual([]);
  });

  it('mints no credential-shaped value from a generator library', () => {
    const hits = laneSourceFiles().filter((f) => /\buuid\b/i.test(f.text));
    expect(hits.map((h) => h.name)).toEqual([]);
  });
});

describe('PF-153: family identifiers', () => {
  it('are unique across 10 000 draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(newFamilyId());
    expect(seen.size).toBe(10_000);
  });

  it('are well-formed for the UUID column in migration 043', () => {
    expect(newFamilyId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('PF-157: the TTL decision, as constants', () => {
  it('is 1 hour access and 30 days refresh', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(60 * 60);
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('exposes them as one injectable config', () => {
    expect(DEFAULT_TOKEN_TTL).toEqual({
      accessSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshSeconds: REFRESH_TOKEN_TTL_SECONDS,
    });
  });

  it('states each number exactly once in this lane, so there is nothing to drift', () => {
    // The literals may appear only in `tokens.ts`, and only once each. A second
    // occurrence is a restated TTL, which is how the config and the behaviour
    // stop agreeing.
    for (const literal of ['3600', '2592000']) {
      const occurrences = laneSourceFiles().flatMap((f) =>
        f.text.split(literal).length - 1 > 0
          ? [{ name: f.name, count: f.text.split(literal).length - 1 }]
          : [],
      );
      expect(occurrences).toEqual([{ name: 'tokens.ts', count: 1 }]);
    }
  });
});

describe('D14 / PF-171: the replay window is one constant', () => {
  it('ships CLOSED — option (a), strict revocation, is the default', () => {
    expect(REFRESH_REPLAY_WINDOW_MS).toBe(0);
  });

  it('is a single exported number, so switching to option (b) is one line', () => {
    expect(typeof REFRESH_REPLAY_WINDOW_MS).toBe('number');
    const source = readFileSync(join(HERE, 'tokens.ts'), 'utf8');
    const declarations = source.match(/export const REFRESH_REPLAY_WINDOW_MS/g) ?? [];
    expect(declarations).toHaveLength(1);
  });
});
