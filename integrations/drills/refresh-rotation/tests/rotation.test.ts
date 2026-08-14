/**
 * PRD p.8 option 5, executed. PF-723 – PF-727.
 *
 * Every number in this file was produced by an HTTP request to a really booted
 * Ship, through `@ship/sdk`, holding nothing but an OAuth `client_id`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredTokens } from '@ship/sdk';
import {
  formatFailureShapes,
  meStatus,
  rotationViolations,
  runRotationDrill,
  type DrillTarget,
  type RotationObservations,
} from '../src/drill.js';
import { baseUrl, clientId, expiredBaseUrl } from './support/env.js';
import { realTokenPair } from './support/login.js';

/** The demo app's scopes. `me` needs none of them, which is the point of `me`. */
const SCOPES = ['documents:read'];

/** PF-726's deliverable, as a CI artifact. */
const SHAPES_REPORT = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  'test-results',
  'refresh-failure-shapes.txt',
);

let target: DrillTarget;
let sessionA: StoredTokens;
let sessionB: StoredTokens;
let observed: RotationObservations;

beforeAll(async () => {
  target = { baseUrl: baseUrl(), clientId: clientId() };

  // PF-723 — three REAL grants. No row inserted, no helper that mints a signed
  // token: every credential below came out of `/oauth/token`.
  sessionA = await realTokenPair(target.baseUrl, target.clientId, SCOPES);
  sessionB = await realTokenPair(target.baseUrl, target.clientId, SCOPES);

  const expiredTarget: DrillTarget = { baseUrl: expiredBaseUrl(), clientId: clientId() };
  const expiredTokens = await realTokenPair(expiredTarget.baseUrl, expiredTarget.clientId, SCOPES);

  observed = await runRotationDrill({
    target,
    sessionA,
    sessionB,
    expiredPair: { target: expiredTarget, tokens: expiredTokens },
    // Syntactically plausible, matching no row. 32 bytes of CSPRNG, so the odds
    // of colliding with a real token are not a thing anyone has to reason about.
    unknownRefreshToken: `shr_${randomBytes(32).toString('hex')}`,
  });

  // PF-726 requires the three shapes be RECORDED so a CI reader can tell them
  // apart. Written to a file rather than logged, and the reason is measured
  // rather than assumed: vitest 4 swallows console output from a passing file,
  // so a `console.log` here is invisible on exactly the runs anyone reads it on.
  // A file is also what a CI job uploads as an artifact.
  mkdirSync(dirname(SHAPES_REPORT), { recursive: true });
  writeFileSync(
    SHAPES_REPORT,
    `PF-726 — the three refresh failures, as a consumer sees them.\n` +
      `Recorded ${new Date().toISOString()} against ${target.baseUrl}\n\n` +
      `${formatFailureShapes(observed)}\n`,
    'utf8',
  );
}, 180_000);

describe('PF-723 — the drill gets its first pair from a real flow', () => {
  it('the access token the device grant issued answers 200 on /api/v1/me', () => {
    expect(observed.meStatusBeforeAnyRotation).toBe(200);
  });

  it('the grant really issued a refresh token, so there is something to rotate', () => {
    expect(sessionA.refreshToken).toEqual(expect.any(String));
    expect(sessionA.refreshToken).not.toBe('');
    expect(sessionB.refreshToken).not.toBe(sessionA.refreshToken);
  });
});

describe('PF-724 — rotation is observable from the client', () => {
  it('R1 → {A2, R2}: both halves are new', () => {
    expect(observed.firstRotation.exchanged).toBe(true);
    expect(observed.firstRotation.refreshTokenChanged).toBe(true);
    expect(observed.firstRotation.accessTokenChanged).toBe(true);
  });

  it('A2 answers 200 on /api/v1/me', () => {
    expect(observed.firstRotation.meStatusWithNewAccessToken).toBe(200);
  });

  it('presenting R1 a second time FAILS — one-time use, from the outside', () => {
    const replay = observed.firstRotation.replayOfSpentToken;
    expect(replay.ok).toBe(false);
    // RFC 6749 §5.2. The drill asserts the FAMILY of the answer, not a code set
    // it has no business defining — see PF-726 below.
    expect(replay.rawStatus).toBeGreaterThanOrEqual(400);
    expect(replay.rawStatus).toBeLessThan(500);
    expect(replay.sdkError?.kind).toBe('auth');
  });
});

describe('PF-725 — the theft scenario, and the half only a client can see', () => {
  it('A3 worked BEFORE the replay, so the 401 after it is not vacuous', () => {
    expect(observed.theftScenario.meStatusWithA3BeforeReplay).toBe(200);
  });

  it('replaying the long-spent R1 after three rotations fails', () => {
    expect(observed.theftScenario.replayOfR1.ok).toBe(false);
  });

  it('R3 — never presented by the thief — no longer exchanges', () => {
    expect(observed.theftScenario.r3ExchangeAfterReplay.ok).toBe(false);
  });

  it('A3 returns 401 on /api/v1/me: the whole family died, not just R1', () => {
    // This is the assertion PF-725 exists for. A platform that revokes only the
    // token presented passes every test above and fails here, and p.3 / p.15
    // both state the guarantee as family-wide.
    expect(observed.theftScenario.meStatusWithA3AfterReplay).toBe(401);
  });
});

describe('PF-726 — the three failure shapes are distinguishable at the SDK boundary', () => {
  it('all three are failures', () => {
    expect(observed.failureShapes.reused.ok).toBe(false);
    expect(observed.failureShapes.expired.ok).toBe(false);
    expect(observed.failureShapes.unknown.ok).toBe(false);
  });

  it('a caller can tell them apart', () => {
    const bodies = [
      observed.failureShapes.reused.rawBody,
      observed.failureShapes.expired.rawBody,
      observed.failureShapes.unknown.rawBody,
    ];
    expect(new Set(bodies).size).toBe(3);
  });

  it('each one surfaces through the SDK as a typed auth error, not a transport crash', () => {
    for (const shape of Object.values(observed.failureShapes)) {
      expect(shape.sdkError?.kind).toBe('auth');
      expect(shape.sdkError?.message ?? '').not.toBe('');
    }
  });

  it('the three shapes are written down where a CI reader will find them', () => {
    const report = readFileSync(SHAPES_REPORT, 'utf8');
    for (const name of ['reused', 'expired', 'unknown']) expect(report).toContain(name);
    // Both halves PF-726 asks for: what the SDK gave the consumer, and the wire.
    expect(report).toContain('sdk   :');
    expect(report).toContain('wire  :');
  });

  it('DELIBERATELY does not assert the codes — see the drill header', () => {
    // p.2 names distinct 401 codes for BEARER tokens and `invalid_grant` for the
    // token endpoint; it names no code set for refresh failures. Asserting one
    // here would write L06's contract from a consumer lane. What IS asserted is
    // that the wire carries RFC 6749's shape at all, so the distinguishability
    // above is a property of the protocol rather than of an error string.
    for (const shape of Object.values(observed.failureShapes)) {
      expect(JSON.parse(shape.rawBody)).toHaveProperty('error');
    }
  });
});

describe('PF-727 — the drill fails against a permissive server', () => {
  it('a real Ship produces zero violations', () => {
    const problems = rotationViolations(observed);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('the unknown-token probe is not silently a no-op', async () => {
    // Guards the one way `unknown` could pass for the wrong reason: if the base
    // URL were wrong, every request would fail and every "must fail" assertion
    // in this file would pass. A working /api/v1/me on the same base URL rules
    // that out.
    expect(await meStatus(target.baseUrl, 'shp_not_a_real_token')).toBe(401);
  });
});
