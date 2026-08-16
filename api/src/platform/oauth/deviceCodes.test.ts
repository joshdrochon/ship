/**
 * PF-121 – PF-127 — the device authorization's codes, TTL and repository seam.
 * Lane L05, slice S1.
 *
 * No `setTimeout` anywhere in this file. Every temporal assertion advances a
 * `FakeClock`, which PRD p.11 requires by name — it calls timing-based tests
 * flaky tests, and it is right.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FakeClock } from '../clock.js';
import type { Scope } from '../scopes/scopes.js';
import {
  InMemoryDeviceCodeRepo,
  normalizeUserCode,
  hashDeviceCode,
  generateDeviceCode,
  generateUserCode,
  USER_CODE_PATTERN,
  USER_CODE_CHARSET,
  USER_CODE_RAW_LENGTH,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  type IDeviceCodeRepo,
} from './deviceCodes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOPES: Scope[] = ['documents:read'];

function insertInput(over: Partial<Parameters<IDeviceCodeRepo['insert']>[0]> = {}) {
  return {
    deviceCodeHash: hashDeviceCode(generateDeviceCode()),
    userCode: generateUserCode(),
    appId: 'app-1',
    scopes: SCOPES,
    intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    expiresAt: new Date(DEVICE_CODE_TTL_SECONDS * 1000),
    createdAt: new Date(0),
    ...over,
  };
}

describe('PF-123: the user_code is built for a human to read aloud and type', () => {
  it('matches the declared XXXX-XXXX pattern over the ambiguity-free alphabet', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateUserCode()).toMatch(USER_CODE_PATTERN);
    }
  });

  it('excludes every visually ambiguous character, both members of each pair', () => {
    // Dropping only `0` would still leave a user typing `0` when they saw `O`.
    for (const banned of ['B', 'I', 'O', 'S', '0', '1', '5', '8']) {
      expect(USER_CODE_CHARSET).not.toContain(banned);
    }
    expect(USER_CODE_CHARSET).toHaveLength(28);
    expect(USER_CODE_RAW_LENGTH).toBe(8);
  });

  it('records an entropy figure that matches the shipped alphabet and length', () => {
    // PF-123 requires the number to be stated alongside PF-132's throttle,
    // because RFC 8628 §5.1 makes brute-force resistance the PRODUCT of the two.
    // This asserts the figure in `deviceCodes.ts`'s header is arithmetically
    // true of the code that actually ships, rather than a comment that drifted.
    const bits = USER_CODE_RAW_LENGTH * Math.log2(USER_CODE_CHARSET.length);
    expect(bits).toBeGreaterThan(38);
    expect(bits).toBeLessThan(39);
  });

  it('draws uniformly — no character is starved or favoured by modulo bias', () => {
    // 256 % 28 = 4, so a naive `byte % 28` would make the first four characters
    // ~11% more likely. Rejection sampling is what stops that, and this is the
    // assertion that would fail if someone "simplified" it away.
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      for (const ch of generateUserCode().replace('-', '')) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(USER_CODE_CHARSET.length);
    const expected = (20_000 * USER_CODE_RAW_LENGTH) / USER_CODE_CHARSET.length;
    for (const [, n] of counts) {
      // ±8% band. A modulo-biased generator lands ~11% high on four characters
      // and ~3% low on the rest, so it fails this; honest sampling noise at this
      // volume is well under 5%.
      expect(Math.abs(n - expected) / expected).toBeLessThan(0.08);
    }
  });

  it('collides at the birthday rate and no faster across 100 000 generations', async () => {
    // PF-123's headline assertion, corrected twice. Read both notes before
    // changing the bound — the obvious "stricter" version is the broken one.
    //
    // ── 1. It no longer calls expect() 100 000 times ────────────────────────
    // The loop body used to be `expect(seen.has(code)).toBe(false)`, which
    // proves exactly what the assertion after the loop proves and costs the
    // whole test its headroom: measured on this repo, 1061ms with the in-loop
    // expect against 275ms without. Roughly 75% of the runtime was spent inside
    // the assertion library rather than the generator under test, and with
    // vitest's default 5s timeout that was ~5x margin on an idle machine and
    // none on a loaded CI runner. Pipeline 20358 on `main` failed here with
    // "Test timed out in 5000ms" while the same commit passed locally.
    //
    // ── 2. "Zero collisions" was never true ─────────────────────────────────
    // The alphabet is 28 characters and the raw length is 8, so there are
    // 28^8 ≈ 3.78e11 distinct user codes — 38.46 bits, which the entropy test
    // above pins deliberately. Drawing n = 100 000 of them, the birthday model
    // gives expected collisions n²/(2N) ≈ 0.0132 and
    //
    //     P(at least one collision) ≈ 1.31%
    //
    // So a PERFECTLY CORRECT generator fails a zero-collision assertion about
    // one run in seventy-six. That is not a hypothetical either: this test
    // produced `ER66-VTDM` twice on a clean run while this branch was being
    // verified. A test that red-builds 1.3% of the time on correct code teaches
    // people to re-run CI until it is green, which is how the genuinely broken
    // build gets waved through.
    //
    // What a correct generator actually guarantees is that collisions stay AT
    // the birthday rate. Tolerating 3 leaves P(exceeded) ≈ 1.3e-9 while still
    // catching every real defect by orders of magnitude: a modulo-biased draw,
    // a truncated seed, a reused counter or a shortened alphabet all collide
    // hundreds to thousands of times at this volume, not four.
    //
    // Uniformity is a separate property and has its own test above; this one is
    // about entropy actually being spent.
    const MAX_TOLERATED_COLLISIONS = 3;

    const repo = new InMemoryDeviceCodeRepo();
    const seen = new Set<string>();
    const collisions: string[] = [];

    for (let i = 0; i < 100_000; i += 1) {
      const code = generateUserCode();
      if (seen.has(code)) collisions.push(code);
      else seen.add(code);
    }

    expect(
      collisions.length,
      `${collisions.length} duplicate user_code(s) in 100 000 draws (${collisions
        .slice(0, 5)
        .join(', ')}). The birthday expectation at 38.46 bits is 0.013, so more than ` +
        `${MAX_TOLERATED_COLLISIONS} is not bad luck — it is a CSPRNG, alphabet or length ` +
        `defect, and UNIQUE(user_code) turns it into insert failures in production.`,
    ).toBeLessThanOrEqual(MAX_TOLERATED_COLLISIONS);

    expect(seen.size).toBe(100_000 - collisions.length);

    // And the constraint is real: re-inserting one is refused.
    const input = insertInput({ userCode: [...seen][0] as string });
    await repo.insert(input);
    await expect(
      repo.insert(insertInput({ userCode: input.userCode })),
    ).rejects.toThrow(/duplicate user_code/);
  });
});

describe('PF-124: the device_code is a secret and is treated like one', () => {
  it('is at least 32 bytes of entropy, base64url, and distinct every time', () => {
    const a = generateDeviceCode();
    const b = generateDeviceCode();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
  });

  it('never appears in ANY text column of the written row — only its sha256 does', async () => {
    const repo = new InMemoryDeviceCodeRepo();
    const deviceCode = generateDeviceCode();
    const row = await repo.insert(insertInput({ deviceCodeHash: hashDeviceCode(deviceCode) }));

    // Byte-scan every value on the row, exactly as PF-124 specifies, rather
    // than checking the one field we expect to be wrong.
    for (const value of Object.values(row)) {
      expect(JSON.stringify(value ?? '')).not.toContain(deviceCode);
    }
    expect(row.deviceCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.deviceCodeHash).toBe(hashDeviceCode(deviceCode));
  });

  it('keeps the deliberate asymmetry: user_code IS stored in clear', async () => {
    // The counterpart to the assertion above, and it is a POSITIVE assertion on
    // purpose. A reviewer who sees one hashed and one not must find a test
    // saying the second is intentional, not an oversight.
    const repo = new InMemoryDeviceCodeRepo();
    const userCode = generateUserCode();
    const row = await repo.insert(insertInput({ userCode }));
    expect(row.userCode).toBe(userCode);
  });
});

describe('PF-131: code entry is forgiving on input and exact in storage', () => {
  it('resolves eight input variants of one issued code to the same row', async () => {
    const repo = new InMemoryDeviceCodeRepo();
    const row = await repo.insert(insertInput({ userCode: 'ACDE-FGHJ' }));

    const variants = [
      'ACDE-FGHJ', // canonical
      'acde-fghj', // lowercased
      'ACDEFGHJ', // hyphen dropped
      'acdefghj', // both
      '  ACDE-FGHJ  ', // pasted with surrounding whitespace
      'ACDE FGHJ', // hyphen typed as a space
      'AcDe-FgHj', // mixed case
      'ACDE--FGHJ\n', // double hyphen and a trailing newline
    ];
    expect(variants).toHaveLength(8);

    for (const variant of variants) {
      const found = await repo.findByUserCode(normalizeUserCode(variant));
      expect(found, `variant ${JSON.stringify(variant)} should resolve`).not.toBeNull();
      expect(found?.id).toBe(row.id);
    }
  });

  it('stores the CANONICAL hyphenated form, so the portal shows what the terminal printed', async () => {
    const repo = new InMemoryDeviceCodeRepo();
    const generated = generateUserCode();
    const row = await repo.insert(insertInput({ userCode: generated }));
    expect(row.userCode).toMatch(USER_CODE_PATTERN);
    expect(row.userCode).toContain('-');
    expect(row.userCode).toBe(generated);
  });

  it('is ONE exported function — the generator and the lookup cannot drift', () => {
    // The property that matters is singularity, not the transformation. Two
    // normalizers would be invisible until a user typed a code that should have
    // worked, so the definition is greped for rather than described.
    const files = fs
      .readdirSync(HERE)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) =>
        fs.readFileSync(path.join(HERE, f), 'utf8').includes('export function normalizeUserCode'),
      );
    expect(files).toEqual(['deviceCodes.ts']);
  });
});

describe('PF-121 / PF-127: the row, its states, and expiry as a real outcome', () => {
  let repo: InMemoryDeviceCodeRepo;
  let clock: FakeClock;

  beforeEach(() => {
    repo = new InMemoryDeviceCodeRepo();
    clock = new FakeClock(0);
  });

  it('starts pending with no user, no workspace and no poll recorded', async () => {
    const row = await repo.insert(insertInput());
    expect(row.status).toBe('pending');
    expect(row.userId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.lastPolledAt).toBeNull();
    expect(row.consumedAt).toBeNull();
    expect(row.intervalSeconds).toBe(DEVICE_POLL_INTERVAL_SECONDS);
  });

  it('refuses a duplicate device_code_hash — a collision is a CSPRNG failure, not a retry', async () => {
    const hash = hashDeviceCode(generateDeviceCode());
    await repo.insert(insertInput({ deviceCodeHash: hash }));
    await expect(repo.insert(insertInput({ deviceCodeHash: hash }))).rejects.toThrow(
      /duplicate device_code_hash/,
    );
  });

  it('expires 600 seconds after issuance, measured on the injected clock', async () => {
    const now = new Date(clock.nowMs());
    const row = await repo.insert(
      insertInput({
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000),
      }),
    );

    expect(DEVICE_CODE_TTL_SECONDS).toBe(600);

    // One second before expiry: still live.
    clock.advance((DEVICE_CODE_TTL_SECONDS - 1) * 1000);
    expect(row.expiresAt.getTime() > clock.nowMs()).toBe(true);

    // One second after: expired. No sleeping, no wall-clock dependency.
    clock.advance(2000);
    expect(row.expiresAt.getTime() <= clock.nowMs()).toBe(true);
  });

  it('approve() binds the user and the resolved grant, and only from pending', async () => {
    const row = await repo.insert(insertInput());
    const at = new Date(clock.nowMs());

    expect(await repo.approve({ id: row.id, userId: 'u1', workspaceId: 'w1', scopes: SCOPES }, at)).toBe(true);
    const approved = await repo.findByDeviceCodeHash(row.deviceCodeHash);
    expect(approved?.status).toBe('approved');
    expect(approved?.userId).toBe('u1');
    expect(approved?.workspaceId).toBe('w1');
    expect(approved?.scopes).toEqual(SCOPES);

    // A second decision loses. This is the conditional-write contract, and it is
    // what stops two browser tabs both winning.
    expect(await repo.approve({ id: row.id, userId: 'u2', workspaceId: 'w2', scopes: SCOPES }, at)).toBe(false);
    expect(await repo.deny(row.id, at)).toBe(false);
  });

  it('deny() is terminal and blocks a later approval', async () => {
    const row = await repo.insert(insertInput());
    const at = new Date(clock.nowMs());
    expect(await repo.deny(row.id, at)).toBe(true);
    expect((await repo.findByDeviceCodeHash(row.deviceCodeHash))?.status).toBe('denied');
    expect(await repo.approve({ id: row.id, userId: 'u1', workspaceId: 'w1', scopes: SCOPES }, at)).toBe(false);
  });

  it('consume() succeeds exactly once — the single-redemption guarantee', async () => {
    const row = await repo.insert(insertInput());
    const at = new Date(clock.nowMs());
    expect(await repo.consume(row.id, at)).toBe(true);
    expect(await repo.consume(row.id, at)).toBe(false);
  });
});

describe('PF-144: the sweeper runs on an injected clock, never a bare timer', () => {
  it('deletes expired-unconsumed rows and aged-consumed rows on two cut-offs', async () => {
    const repo = new InMemoryDeviceCodeRepo();
    const clock = new FakeClock(0);

    const expired = await repo.insert(
      insertInput({ createdAt: new Date(0), expiresAt: new Date(600_000) }),
    );
    const live = await repo.insert(
      insertInput({ createdAt: new Date(0), expiresAt: new Date(10_000_000) }),
    );
    const consumed = await repo.insert(
      insertInput({ createdAt: new Date(0), expiresAt: new Date(10_000_000) }),
    );
    await repo.consume(consumed.id, new Date(0));

    // Advance past the first row's expiry and past the consumed row's retention.
    clock.advance(700_000);
    let removed = await repo.deleteSwept(new Date(clock.nowMs()), new Date(0));
    expect(removed).toBe(1);
    expect(await repo.findByDeviceCodeHash(expired.deviceCodeHash)).toBeNull();
    expect(await repo.findByDeviceCodeHash(live.deviceCodeHash)).not.toBeNull();
    // Still inside its retention window.
    expect(await repo.findByDeviceCodeHash(consumed.deviceCodeHash)).not.toBeNull();

    clock.advance(3_600_000);
    removed = await repo.deleteSwept(new Date(clock.nowMs()), new Date(clock.nowMs()));
    expect(removed).toBe(1);
    expect(await repo.findByDeviceCodeHash(consumed.deviceCodeHash)).toBeNull();
  });

  it('uses no bare timer anywhere in this lane’s modules (PRD p.11)', () => {
    // p.11 forbids `setTimeout` waits for timing behaviour by name. The sweeper
    // and the throttle are the two places it would be tempting.
    const laneFiles = ['deviceCodes.ts', 'pgDeviceCodeRepo.ts', 'deviceAuthorization.ts'];
    for (const name of laneFiles) {
      const text = fs.readFileSync(path.join(HERE, name), 'utf8');
      expect(text, `${name} must not schedule a bare timer`).not.toMatch(/\bsetTimeout\s*\(/);
      expect(text, `${name} must not read Date.now() directly`).not.toMatch(/\bDate\.now\s*\(/);
    }
  });
});

describe('PF-140: this lane mints nothing — the seam is the whole point', () => {
  it('defines no token generation, hashing or refresh-token construction', () => {
    const laneFiles = [
      'deviceCodes.ts',
      'pgDeviceCodeRepo.ts',
      'deviceAuthorization.ts',
    ];
    for (const name of laneFiles) {
      const text = fs.readFileSync(path.join(HERE, name), 'utf8');
      expect(text, `${name} must not draw random bytes`).not.toContain('randomBytes');
      expect(text, `${name} must not hash`).not.toContain("createHash('sha256')");
      expect(text, `${name} must not construct a token`).not.toMatch(
        /generateAccessToken|generateRefreshToken/,
      );
    }
  });

  it('imports nothing from L07’s ApiError module (L99 U3, PF-142)', () => {
    // `/oauth/*` emits RFC 6749 §5.2 bodies. An ApiError import here is exactly
    // the contract violation U3 predicted, and it is worth failing a PR over.
    const laneFiles = fs
      .readdirSync(HERE)
      .filter((f) => f.startsWith('device') || f.startsWith('pgDevice'))
      .filter((f) => f.endsWith('.ts'));
    expect(laneFiles.length).toBeGreaterThan(0);
    for (const name of laneFiles) {
      const text = fs.readFileSync(path.join(HERE, name), 'utf8');
      // IMPORT statements only. The words `ApiError` and `errors.ts` appear in
      // this lane's prose precisely BECAUSE it explains why it does not import
      // them — an assertion that banned the word would punish the comment that
      // documents the rule and would be silenced by deleting it.
      const imports = [...text.matchAll(/^\s*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map(
        (m) => m[1] as string,
      );
      for (const spec of imports) {
        expect(spec, `${name} must not import from L07's error module`).not.toMatch(
          /api\/v1\/errors|\/errors\.js$/,
        );
      }
    }
  });
});
