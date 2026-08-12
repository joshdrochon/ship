/**
 * PF-155 (the single issuance site), PF-153 (families and the rotation chain)
 * and PF-156 (resolution honours D2's `active` flag).
 *
 * Everything here runs against `InMemoryTokenRepo` and `InMemoryOAuthAppRepo` in
 * a bare Node context — no Express, no database, no wall clock. That is the
 * property PF-154 exists to buy, and running these without a server is the proof
 * that the repository seam actually has it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../../test/sourceScan.js';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/registry.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { issueTokenPair, type IssueTokenPairDeps } from './issue.js';
import { resolveToken } from './resolve.js';
import { DEFAULT_TOKEN_TTL, hashToken, ACCESS_TOKEN_TTL_SECONDS } from './tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRANTED: Scope[] = ['documents:read', 'issues:read'];

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let clock: FakeClock;
let app: OAuthApp;

async function makeApp(overrides: { requestedScopes?: Scope[] } = {}): Promise<OAuthApp> {
  return appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L06 test app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    // Deliberately WIDER than the granted set, so a test can catch this being
    // read instead of the argument.
    requestedScopes: overrides.requestedScopes ?? ['documents:read', 'documents:write', 'issues:read'],
  });
}

function deps(): IssueTokenPairDeps {
  return { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL };
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  // A non-zero start: a FakeClock at 0 makes "is this timestamp set" and "is this
  // timestamp the epoch" indistinguishable.
  clock = new FakeClock(1_700_000_000_000);
  app = await makeApp();
});

describe('PF-155: the RFC 6749 §5.1 response shape', () => {
  it('returns exactly the five §5.1 fields and nothing else', async () => {
    const { response } = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    expect(Object.keys(response).sort()).toEqual([
      'access_token',
      'expires_in',
      'refresh_token',
      'scope',
      'token_type',
    ]);
    expect(response.token_type).toBe('Bearer');
  });

  it('reads expires_in from the injected TTL rather than restating it', async () => {
    const { response } = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    expect(response.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);

    // And it genuinely follows the injection, which is PF-173's seam.
    const short = await issueTokenPair(
      { tokenRepo, clock, ttl: { accessSeconds: 2, refreshSeconds: 5 } },
      { app, userId: 'user-1', scopes: GRANTED },
    );
    expect(short.response.expires_in).toBe(2);
  });

  it('returns the RESOLVED grant as a space-delimited scope string', async () => {
    const { response } = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    expect(response.scope).toBe('documents:read issues:read');
  });

  it('never returns the app’s requested_scopes — consent would be silently widened', async () => {
    const { response, access } = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
    });
    expect(app.requestedScopes).toContain('documents:write');
    expect(response.scope).not.toContain('documents:write');
    expect(access.scopes).toEqual(GRANTED);
  });
});

describe('PF-155: one issuance site', () => {
  it('has exactly one definition of issueTokenPair in the repository', () => {
    const definitions = scanDirectory(HERE)
      .filter((f) => /export\s+async\s+function\s+issueTokenPair\b/.test(f.code))
      .map((f) => f.name);
    expect(definitions).toEqual(['issue.ts']);
  });

  it('mints tokens only through tokens.ts — nothing else draws random bytes', () => {
    const offenders = scanDirectory(HERE)
      .filter((f) => f.code.includes('randomBytes'))
      .map((f) => f.name);
    expect(offenders).toEqual(['tokens.ts']);
  });
});

describe('PF-155: both rows land together', () => {
  it('writes an access row and a refresh row sharing one family', async () => {
    const { access, refresh, familyId } = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
    });
    expect(access.tokenType).toBe('access');
    expect(refresh.tokenType).toBe('refresh');
    expect(access.familyId).toBe(familyId);
    expect(refresh.familyId).toBe(familyId);
    expect(await tokenRepo.listFamily(familyId)).toHaveLength(2);
  });

  it('gives the two types different TTLs, both measured from the injected clock', async () => {
    const { access, refresh } = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
    });
    expect(access.expiresAt.getTime()).toBe(clock.nowMs() + 3600 * 1000);
    expect(refresh.expiresAt.getTime()).toBe(clock.nowMs() + 2592000 * 1000);
  });

  it('stores only digests — the raw tokens are not in the rows', async () => {
    const { response, access, refresh } = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
    });
    expect(access.tokenHash).toBe(hashToken(response.access_token));
    expect(refresh.tokenHash).toBe(hashToken(response.refresh_token));
    const serialized = JSON.stringify([access, refresh]);
    expect(serialized).not.toContain(response.access_token);
    expect(serialized).not.toContain(response.refresh_token);
  });

  it('carries a null user for a machine-to-machine token', async () => {
    const { access } = await issueTokenPair(deps(), { app, userId: null, scopes: GRANTED });
    expect(access.userId).toBeNull();
  });
});

describe('PF-153: families and the rotation chain', () => {
  it('starts a DISTINCT family per grant redemption', async () => {
    // Stands in for an authorization-code redemption and a device-grant
    // redemption: both call this seam and neither passes a familyId.
    const first = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    const second = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    expect(first.familyId).not.toBe(second.familyId);
  });

  it('keeps one family across three rotations and links the chain end to end', async () => {
    const g1 = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    const g2 = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
      familyId: g1.familyId,
      replacesAccessTokenId: g1.access.id,
      replacesRefreshTokenId: g1.refresh.id,
    });
    const g3 = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
      familyId: g1.familyId,
      replacesAccessTokenId: g2.access.id,
      replacesRefreshTokenId: g2.refresh.id,
    });

    expect(new Set([g1.familyId, g2.familyId, g3.familyId]).size).toBe(1);

    // Walk the chain from the newest refresh token back to the first.
    const family = await tokenRepo.listFamily(g1.familyId);
    expect(family).toHaveLength(6); // three pairs

    const byId = new Map(family.map((r) => [r.id, r]));
    let cursor = byId.get(g3.refresh.id);
    const walked: string[] = [];
    while (cursor) {
      walked.push(cursor.id);
      cursor = cursor.replacesTokenId ? byId.get(cursor.replacesTokenId) : undefined;
    }
    expect(walked).toEqual([g3.refresh.id, g2.refresh.id, g1.refresh.id]);
  });
});

describe('PF-156: resolution', () => {
  async function mint() {
    return issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
  }

  const resolveDeps = () => ({ tokenRepo, appsRepo, clock });

  it('resolves a live token to app, user and GRANTED scopes', async () => {
    const { response } = await mint();
    const result = await resolveToken(resolveDeps(), response.access_token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.appId).toBe(app.id);
    expect(result.context.clientId).toBe(app.clientId);
    expect(result.context.userId).toBe('user-1');
    expect(result.context.scopes).toEqual(GRANTED);
    expect(result.context.tokenId).toBeTruthy();
  });

  it('D2: a deactivated app’s token is INVALID, not a distinct error', async () => {
    const { response } = await mint();
    // Live before.
    expect((await resolveToken(resolveDeps(), response.access_token)).ok).toBe(true);

    await appsRepo.deactivateByOwner('user-1', new Date(clock.nowMs()));

    const after = await resolveToken(resolveDeps(), response.access_token);
    expect(after).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports an expired token as EXPIRED — the one reason that means "refresh"', async () => {
    const { response } = await mint();
    clock.advance(ACCESS_TOKEN_TTL_SECONDS * 1000 + 1);
    expect(await resolveToken(resolveDeps(), response.access_token)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports a deactivated app’s EXPIRED token as invalid, not expired', async () => {
    // Check order matters: telling a client to refresh when its app is switched
    // off produces a second failure and a confusing loop.
    const { response } = await mint();
    await appsRepo.deactivateByOwner('user-1', new Date(clock.nowMs()));
    clock.advance(ACCESS_TOKEN_TTL_SECONDS * 1000 + 1);
    expect(await resolveToken(resolveDeps(), response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects a REFRESH token presented as a bearer credential', async () => {
    const { response } = await mint();
    expect(await resolveToken(resolveDeps(), response.refresh_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('rejects unknown, malformed and revoked tokens identically', async () => {
    const { response, access } = await mint();
    await tokenRepo.revokeFamily(access.familyId, 'app_revoked', new Date(clock.nowMs()));

    const outcomes = await Promise.all([
      resolveToken(resolveDeps(), 'ship_at_completely-unknown'),
      resolveToken(resolveDeps(), 'not-even-a-token'),
      resolveToken(resolveDeps(), ''),
      resolveToken(resolveDeps(), response.access_token),
    ]);
    for (const outcome of outcomes) {
      expect(outcome).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('PF-165: revokeByApp — the revoke half of L02’s leak playbook', () => {
  it('kills a token minted before the call, and UPDATES rather than deletes', async () => {
    const { response, access } = await issueTokenPair(deps(), {
      app,
      userId: 'user-1',
      scopes: GRANTED,
    });
    expect((await resolveToken({ tokenRepo, appsRepo, clock }, response.access_token)).ok).toBe(true);

    const count = await tokenRepo.revokeByApp(app.id, 'app_revoked', new Date(clock.nowMs()));
    expect(count).toBe(2); // the pair

    expect(await resolveToken({ tokenRepo, appsRepo, clock }, response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });

    // The rows are still there, with the reason recorded — the audit trail has
    // to stay resolvable.
    const family = await tokenRepo.listFamily(access.familyId);
    expect(family).toHaveLength(2);
    for (const row of family) {
      expect(row.revokedAt).not.toBeNull();
      expect(row.revocationReason).toBe('app_revoked');
    }
  });

  it('leaves another app’s tokens alone', async () => {
    const other = await makeApp();
    const mine = await issueTokenPair(deps(), { app, userId: 'user-1', scopes: GRANTED });
    const theirs = await issueTokenPair(deps(), { app: other, userId: 'user-1', scopes: GRANTED });

    await tokenRepo.revokeByApp(app.id, 'app_revoked', new Date(clock.nowMs()));

    expect(
      (await resolveToken({ tokenRepo, appsRepo, clock }, mine.response.access_token)).ok,
    ).toBe(false);
    expect(
      (await resolveToken({ tokenRepo, appsRepo, clock }, theirs.response.access_token)).ok,
    ).toBe(true);
  });
});
