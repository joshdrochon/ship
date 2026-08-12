/**
 * PF-176 — `docs/architecture.md` is kept true by a test.
 *
 * Two sentences in that document are graded deliverables and were committed
 * before this lane existed. A document that describes behaviour nobody checks
 * is a document that quietly becomes wrong; this file is the code-side latch.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ASSERTS ON CONTENT AND NOT ON LINE NUMBERS.
 * ---------------------------------------------------------------------------
 * The lane file cites "line 118" and "line 138". Those numbers are ALREADY
 * STALE — L07's merge inserted 39 lines above them, so the rotation marker now
 * sits at 161 and the opaque-tokens sentence at 181, and both will move again
 * as other lanes edit the document. A test pinned to a line number would fail
 * for the wrong reason (an unrelated edit) and pass for the wrong reason (the
 * sentence deleted and a different one landing on that line).
 *
 * Asserting on the sentences themselves is what makes this a claim about the
 * document's CONTENT. If a rewrite means to change the claim, this test is the
 * thing that says so out loud.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../../test/sourceScan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// api/src/platform/oauth -> repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const ARCHITECTURE = join(REPO_ROOT, 'docs', 'architecture.md');

function doc(): string {
  return readFileSync(ARCHITECTURE, 'utf8');
}

describe('PF-176: the rotation marker (docs/architecture.md, Auth Code diagram)', () => {
  it('still marks rotation at the /oauth/token participant', () => {
    const text = doc();
    expect(text).toContain('★ rotation HERE');
    expect(text).toContain('new pair issued, old spent');
    expect(text).toContain('Reuse of a spent refresh token revokes the whole family');
  });

  it('names a site that exists exactly once in the code', () => {
    // The document points at a rotation site. If that function is renamed or
    // duplicated, the diagram's ★ stops pointing at anything.
    const definitions = scanDirectory(HERE)
      .filter((f) => /export\s+async\s+function\s+rotateRefreshToken\b/.test(f.code))
      .map((f) => f.name);
    expect(definitions).toEqual(['rotation.ts']);
  });

  it('and the family revocation the diagram promises fires from that site', () => {
    const rotation = scanDirectory(HERE).find((f) => f.name === 'rotation.ts');
    expect(rotation).toBeDefined();
    expect(rotation!.code).toContain('revokeFamily(');
    expect(rotation!.code).toContain("'refresh_token_reuse'");
    // …and it is reached from the zero-row reuse signal, not from some other path.
    expect(rotation!.code).toMatch(/if \(!spent\)[\s\S]*revokeFamily\(/);
  });
});

describe('PF-176: the opaque-access-token sentence', () => {
  it('still claims opaque, high-entropy and stored hashed', () => {
    expect(doc()).toContain(
      'Access tokens are opaque high-entropy strings stored hashed (same discipline as the existing `api_tokens` table); the bearer middleware resolves token → app + user + granted scopes on every `/api/v1/*` request.',
    );
  });

  it('is backed by assertions that actually check each of the three claims', () => {
    // Re-cited here so the document's claim has a NAMED OWNER rather than
    // relying on someone remembering which test covers it.
    const tokensTest = readFileSync(join(HERE, 'tokens.test.ts'), 'utf8');
    expect(tokensTest).toContain('is not a JWT'); // opaque
    expect(tokensTest).toContain('no collision'); // high-entropy
    expect(tokensTest).toContain('hashing discipline'); // stored hashed

    const pgTest = readFileSync(join(HERE, 'pgTokenRepo.test.ts'), 'utf8');
    expect(pgTest).toContain('the raw token is in NO column');
  });
});

describe('PF-176: the write-ups this lane owes are present and agree with the code', () => {
  it('records the TTL decision with both numbers', () => {
    const text = doc();
    expect(text).toContain('## Token Lifecycle & Refresh Rotation');
    expect(text).toContain('**One hour.**');
    expect(text).toContain('30 days, sliding');
  });

  it('answers Pre-Search 2.1 with the migration cost enumerated', () => {
    const text = doc();
    expect(text).toContain('Will you support refresh tokens from day one');
    expect(text).toContain('five surfaces');
  });

  it('records D14 with BOTH options and names the p.3 tension', () => {
    const text = doc();
    expect(text).toContain('Option (a) — **strict**, shipped');
    expect(text).toContain('Option (b) — **10 s same-generation window**');
    expect(text).toContain('a documented departure from that sentence');
    expect(text).toContain('REFRESH_REPLAY_WINDOW_MS');
  });

  it('states the SHIPPED option, and the code agrees with it', async () => {
    const { REFRESH_REPLAY_WINDOW_MS } = await import('./tokens.js');
    const text = doc();

    // The document says strict ships. If someone flips the constant without
    // updating the prose, this fails — which is the whole point, because the
    // Pre-Search answer above says "reuse invalidates the family" flatly.
    expect(text).toContain('**Shipped behaviour: strict. Reuse always revokes the family.**');
    expect(
      REFRESH_REPLAY_WINDOW_MS,
      'the document says strict ships; flip the prose in the same commit as the constant',
    ).toBe(0);
  });

  it('adds the Failure Modes paragraph for a server-initiated logout', () => {
    const text = doc();
    expect(text).toContain('Refresh-token family revoked mid-session');
    expect(text).toContain('every device holding a token from that family is logged out');
    expect(text).toContain('The recovery is re-authentication, not repair.');
  });
});
