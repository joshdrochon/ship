/**
 * PF-166–171 — rotation, one-time use, family revocation, and the D14 window.
 *
 * The in-memory backend covers semantics. The genuine CONCURRENCY guarantee
 * (PF-170) cannot be tested in-memory — single-threaded JavaScript serializes
 * the callbacks for free, which would prove nothing about what Postgres does —
 * so `rotationConcurrency.test.ts` drives that against a real database.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDirectory } from '../../test/sourceScan.js';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { issueTokenPair } from './issue.js';
import { resolveToken } from './resolve.js';
import { hashToken, DEFAULT_TOKEN_TTL } from './tokens.js';
import {
  rotateRefreshToken,
  clearReplayCache,
  REFRESH_ERROR_DESCRIPTIONS,
  type RotationDeps,
} from './rotation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRANTED: Scope[] = ['documents:read', 'issues:read'];

let appsRepo: InMemoryOAuthAppRepo;
let tokenRepo: InMemoryTokenRepo;
let clock: FakeClock;
let app: OAuthApp;

async function makeApp(): Promise<OAuthApp> {
  return appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L06 rotation app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: ['https://example.test/cb'],
    requestedScopes: ['documents:read', 'documents:write', 'issues:read'],
  });
}

function deps(overrides: Partial<RotationDeps> = {}): RotationDeps {
  return { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL, ...overrides };
}

async function grant(target: OAuthApp = app, userId = 'user-1') {
  return issueTokenPair(
    { tokenRepo, clock, ttl: DEFAULT_TOKEN_TTL },
    { app: target, userId, scopes: GRANTED },
  );
}

beforeEach(async () => {
  clearReplayCache();
  appsRepo = new InMemoryOAuthAppRepo();
  tokenRepo = new InMemoryTokenRepo();
  clock = new FakeClock(1_700_000_000_000);
  app = await makeApp();
});

describe('PF-166: grant_type=refresh_token returns a NEW PAIR', () => {
  it('issues R2 !== R1 and A2 !== A1', async () => {
    const g1 = await grant();
    const result = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.refresh_token).not.toBe(g1.response.refresh_token);
    expect(result.response.access_token).not.toBe(g1.response.access_token);
    expect(result.response.token_type).toBe('Bearer');
  });

  it('keeps family_id unchanged and links replaces_token_id to R1', async () => {
    const g1 = await grant();
    const r1Row = await tokenRepo.findByHash(hashToken(g1.response.refresh_token));
    const result = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.familyId).toBe(g1.familyId);
    const r2Row = await tokenRepo.findByHash(hashToken(result.response.refresh_token));
    expect(r2Row!.familyId).toBe(g1.familyId);
    expect(r2Row!.replacesTokenId).toBe(r1Row!.id);
  });

  it('A2 authenticates on /api/v1 and A1 is REVOKED, not merely superseded', async () => {
    const g1 = await grant();
    const result = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A2 works.
    expect((await resolveToken({ tokenRepo, appsRepo, clock }, result.response.access_token)).ok).toBe(
      true,
    );

    // A1 does not. Leaving it live for the rest of its hour is the difference
    // between rotation and mere re-issuance.
    expect(await resolveToken({ tokenRepo, appsRepo, clock }, g1.response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });

    const a1 = await tokenRepo.findByHash(hashToken(g1.response.access_token));
    expect(a1!.revokedAt).not.toBeNull();
    expect(a1!.revocationReason).toBe('rotated');
  });

  it('marks R1 spent', async () => {
    const g1 = await grant();
    await rotateRefreshToken(deps(), { app, presentedToken: g1.response.refresh_token });
    const r1 = await tokenRepo.findByHash(hashToken(g1.response.refresh_token));
    expect(r1!.spentAt).not.toBeNull();
  });

  it('carries the same scopes forward', async () => {
    const g1 = await grant();
    const result = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.scope).toBe('documents:read issues:read');
  });

  it('lets a refresh NARROW scope but never WIDEN it (D4 from the token endpoint)', async () => {
    const g1 = await grant();

    const widened = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
      // The app REQUESTED documents:write at registration; the user never
      // granted it. A refresh must not be a back door to it.
      requestedScopes: ['documents:read', 'documents:write'],
    });
    expect(widened.ok).toBe(false);
    if (widened.ok) return;
    expect(widened.body.error).toBe('invalid_scope');

    const narrowed = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
      requestedScopes: ['documents:read'],
    });
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.response.scope).toBe('documents:read');
  });

  it('an invalid_scope request does NOT consume the refresh token', async () => {
    // Regression. The scope check originally ran AFTER the conditional spend,
    // so an app that asked for one scope too many burned the user's refresh
    // token — and the user's honest retry then looked like REUSE and revoked
    // their whole family. A client error became a forced logout.
    const g1 = await grant();

    const rejected = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
      requestedScopes: ['documents:write'],
    });
    expect(rejected.ok).toBe(false);

    const r1 = await tokenRepo.findByHash(hashToken(g1.response.refresh_token));
    expect(r1!.spentAt, 'a rejected request must not spend the token').toBeNull();
    expect(r1!.revokedAt).toBeNull();

    // The honest retry still works, and the family is intact.
    const retry = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(retry.ok).toBe(true);
  });

  it('refuses a refresh token belonging to another client', async () => {
    const other = await makeApp();
    const g1 = await grant(other);
    const result = await rotateRefreshToken(deps(), {
      app, // authenticated as a DIFFERENT app
      presentedToken: g1.response.refresh_token,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error_description).toBe(REFRESH_ERROR_DESCRIPTIONS.unknown);
  });

  it('refuses an ACCESS token presented at the refresh grant', async () => {
    const g1 = await grant();
    const result = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.access_token,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses an expired refresh token', async () => {
    const g1 = await grant();
    clock.advance(DEFAULT_TOKEN_TTL.refreshSeconds * 1000 + 1);
    const result = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error_description).toBe(REFRESH_ERROR_DESCRIPTIONS.expired);
  });
});

describe('PF-167: one-time use', () => {
  it('a spent refresh token never exchanges again', async () => {
    const g1 = await grant();
    const first = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(first.ok).toBe(true);

    const second = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.body.error).toBe('invalid_grant');
    expect(second.body.error_description).toBe(REFRESH_ERROR_DESCRIPTIONS.reused);
  });

  it('the spend is a conditional write, not a read-then-write', () => {
    const pg = scanDirectory(HERE).find((f) => f.name === 'pgTokenRepo.ts');
    expect(pg!.code).toContain('spent_at IS NULL');
    // A SELECT-then-UPDATE is the shape two concurrent exchanges both pass.
    expect(pg!.code).toMatch(/UPDATE oauth_tokens\s+SET spent_at = \$2\s+WHERE id = \$1 AND spent_at IS NULL/);
  });
});

describe('PF-168: reuse invalidates the FAMILY, including the live access token', () => {
  it('kills R2/A2 when the already-spent R1 is replayed', async () => {
    const g1 = await grant();
    const rotated = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // A2 is live before the replay.
    expect(
      (await resolveToken({ tokenRepo, appsRepo, clock }, rotated.response.access_token)).ok,
    ).toBe(true);

    // THE THEFT SIGNAL.
    const replay = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(replay.ok).toBe(false);

    // R2 no longer exchanges…
    const afterR2 = await rotateRefreshToken(deps(), {
      app,
      presentedToken: rotated.response.refresh_token,
    });
    expect(afterR2.ok).toBe(false);

    // …and A2 — never itself stolen — 401s. This is the half a subscriber can
    // observe, and the half that is easy to omit.
    expect(await resolveToken({ tokenRepo, appsRepo, clock }, rotated.response.access_token)).toEqual(
      { ok: false, reason: 'invalid' },
    );
  });

  it('records the reason on every affected row', async () => {
    const g1 = await grant();
    await rotateRefreshToken(deps(), { app, presentedToken: g1.response.refresh_token });
    await rotateRefreshToken(deps(), { app, presentedToken: g1.response.refresh_token });

    const family = await tokenRepo.listFamily(g1.familyId);
    expect(family.length).toBeGreaterThanOrEqual(4);
    for (const row of family) {
      expect(row.revokedAt).not.toBeNull();
    }
    expect(family.some((r) => r.revocationReason === 'refresh_token_reuse')).toBe(true);
  });
});

describe('PF-169: the family survives the whole chain', () => {
  it('replaying a LONG-SPENT R1 after three rotations still kills R3 and A3', async () => {
    const g1 = await grant();

    const r2 = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const r3 = await rotateRefreshToken(deps(), {
      app,
      presentedToken: r2.response.refresh_token,
    });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;

    const r4 = await rotateRefreshToken(deps(), {
      app,
      presentedToken: r3.response.refresh_token,
    });
    expect(r4.ok).toBe(true);
    if (!r4.ok) return;

    // A3 (the current access token) is live.
    expect((await resolveToken({ tokenRepo, appsRepo, clock }, r4.response.access_token)).ok).toBe(
      true,
    );

    // Replay the ORIGINAL R1 — three generations old.
    const replay = await rotateRefreshToken(deps(), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(replay.ok).toBe(false);

    // Revocation is keyed on family_id, not on "the immediately previous
    // token". An implementation that only compared against the last-issued
    // value would pass PF-167 and PF-168 and fail here.
    const afterCurrent = await rotateRefreshToken(deps(), {
      app,
      presentedToken: r4.response.refresh_token,
    });
    expect(afterCurrent.ok).toBe(false);

    expect(await resolveToken({ tokenRepo, appsRepo, clock }, r4.response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('is not over-broad — a second user’s family is untouched', async () => {
    const mine = await grant(app, 'user-1');
    const theirs = await grant(app, 'user-2');

    await rotateRefreshToken(deps(), { app, presentedToken: mine.response.refresh_token });
    await rotateRefreshToken(deps(), { app, presentedToken: mine.response.refresh_token }); // reuse

    // Mine is dead.
    expect(await resolveToken({ tokenRepo, appsRepo, clock }, mine.response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });

    // Theirs is not.
    expect((await resolveToken({ tokenRepo, appsRepo, clock }, theirs.response.access_token)).ok).toBe(
      true,
    );
    const stillRotates = await rotateRefreshToken(deps(), {
      app,
      presentedToken: theirs.response.refresh_token,
    });
    expect(stillRotates.ok).toBe(true);
  });
});

describe('D14 / PF-171: strict by default, replay window behind one constant', () => {
  it('(a) STRICT — the shipped default revokes the family on a same-generation replay', async () => {
    const g1 = await grant();
    const first = await rotateRefreshToken(deps({ replayWindowMs: 0 }), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(first.ok).toBe(true);

    const second = await rotateRefreshToken(deps({ replayWindowMs: 0 }), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.body.error_description).toBe(REFRESH_ERROR_DESCRIPTIONS.reused);
  });

  it('(b) WINDOW — a replay inside the window returns the SAME pair, no revocation', async () => {
    const g1 = await grant();
    const first = await rotateRefreshToken(deps({ replayWindowMs: 10_000 }), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    clock.advance(2000); // inside the window

    const second = await rotateRefreshToken(deps({ replayWindowMs: 10_000 }), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    // The SAME pair, not a second one — two live pairs would be worse than the
    // problem the window solves.
    expect(second.response.access_token).toBe(first.response.access_token);
    expect(second.response.refresh_token).toBe(first.response.refresh_token);

    // And the family is still alive.
    expect((await resolveToken({ tokenRepo, appsRepo, clock }, first.response.access_token)).ok).toBe(
      true,
    );
  });

  it('(b) a replay OUTSIDE the window still revokes the family', async () => {
    const g1 = await grant();
    const first = await rotateRefreshToken(deps({ replayWindowMs: 10_000 }), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    clock.advance(11_000); // past the window

    const second = await rotateRefreshToken(deps({ replayWindowMs: 10_000 }), {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(second.ok).toBe(false);
    expect(await resolveToken({ tokenRepo, appsRepo, clock }, first.response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('(b) L24’s PF-725 still passes — a LONG-spent R1 is outside any window', async () => {
    // This is the checkable reason the window costs nothing against a graded
    // assertion: PF-725 replays R1 after three rotations, far outside 10 s.
    const g1 = await grant();
    const windowed = deps({ replayWindowMs: 10_000 });

    const r2 = await rotateRefreshToken(windowed, {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    clock.advance(60_000);

    const r3 = await rotateRefreshToken(windowed, { app, presentedToken: r2.response.refresh_token });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    clock.advance(60_000);

    const r4 = await rotateRefreshToken(windowed, { app, presentedToken: r3.response.refresh_token });
    expect(r4.ok).toBe(true);
    if (!r4.ok) return;
    clock.advance(60_000);

    const replay = await rotateRefreshToken(windowed, {
      app,
      presentedToken: g1.response.refresh_token,
    });
    expect(replay.ok).toBe(false);
    expect(await resolveToken({ tokenRepo, appsRepo, clock }, r4.response.access_token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('PF-172 / PF-176: the surface contract', () => {
  it('the three invalid_grant descriptions are pairwise distinct', () => {
    const values = Object.values(REFRESH_ERROR_DESCRIPTIONS);
    expect(new Set(values).size).toBe(values.length);
    expect(values).toHaveLength(3);
  });

  it('this lane imports nothing from L07’s ApiError module on the /oauth side', () => {
    for (const name of ['rotation.ts', 'router.ts']) {
      const file = scanDirectory(HERE).find((f) => f.name === name);
      expect(file, name).toBeDefined();
      expect(file!.code, `${name} must not import the public error envelope`).not.toContain(
        "from '../api/v1/errors.js'",
      );
    }
  });

  it('rotation lives at exactly one grep-unique site (the ★ in OAuth Flows)', () => {
    const definitions = scanDirectory(HERE)
      .filter((f) => /export\s+async\s+function\s+rotateRefreshToken\b/.test(f.code))
      .map((f) => f.name);
    expect(definitions).toEqual(['rotation.ts']);
  });

  it('the refresh_token grant dispatches to that site', () => {
    const router = scanDirectory(HERE).find((f) => f.name === 'router.ts');
    expect(router!.code).toContain('refresh_token:');
    expect(router!.code).toContain('rotateRefreshToken(');
  });
});
