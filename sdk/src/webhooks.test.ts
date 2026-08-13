/**
 * TESTING SCENARIO 6's verification half — PF-542 – PF-547.
 *
 * p.4: *"verifyWebhook(headers, rawBody, secret) returns true/false in one call.
 * Tampered bodies fail; expired timestamps fail; missing v1 header fails."*
 * p.8's Verify stage adds *"timestamp older than 5 min fails"* and a < 1 ms
 * target.
 *
 * ── The vectors are L15's, read as DATA ─────────────────────────────────────
 * `api/src/platform/webhooks/__fixtures__/signature-vectors.json` (PF-446) is
 * generated once and committed by the lane that owns the SIGNER. This file reads
 * it by path and never imports server code — which is what makes the contract
 * checkable across the workspace boundary ESLint fence 4 enforces.
 *
 * Keep it JSON. The moment someone "tidies" it into a TypeScript module export,
 * reading it becomes an import and the fence fires — and the alternative,
 * copying the values here, would let the two sides drift into agreeing only with
 * themselves, which is the exact failure the vectors exist to prevent.
 *
 * If the signer and this verifier disagree on separator, encoding, or what
 * precisely is signed, the TTFE drill fails at its LAST step and nowhere
 * earlier. These eight cases are where that disagreement is supposed to surface.
 */
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifyWebhook, SIGNATURE_HEADER, DEFAULT_TOLERANCE_SECONDS } from './webhooks.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** L15's committed vectors. A PATH, not an import — see the header. */
const VECTORS_FILE = resolve(
  HERE,
  '../../api/src/platform/webhooks/__fixtures__/signature-vectors.json',
);

interface Vector {
  name: string;
  note: string;
  secret: string;
  timestamp: number;
  rawBody: string;
  expectedHeader: string;
}

const fixture = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')) as {
  scheme: string;
  vectors: Vector[];
};
const VECTORS = fixture.vectors;

/** A clock pinned to a vector's own timestamp, so tolerance never decides. */
function at(seconds: number): { nowSeconds: () => number } {
  return { nowSeconds: () => seconds };
}

/** The base case, reused by the negative matrix. */
const BASE = VECTORS.find((v) => v.name === 'ordinary-envelope') as Vector;

// ─────────────────────────────────────────────────────────────────────────────

describe('PF-543 · the verifier agrees with L15’s ACTUAL signer', () => {
  it('the fixture really loaded, with the shape the contract promises', () => {
    // Without this, a fixture that failed to parse into an empty array would
    // make every case below vacuous — zero vectors, all passing.
    expect(VECTORS.length, 'PF-446 commits at least six vectors').toBeGreaterThanOrEqual(6);
    expect(fixture.scheme).toContain('HMAC-SHA256');
    for (const vector of VECTORS) {
      expect(vector.expectedHeader, vector.name).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    }
  });

  it('the three cases the contract names by hand are present', () => {
    const names = VECTORS.map((v) => v.name);
    // PF-446 requires a non-ASCII body, an empty body, and a body containing
    // literal `,` and `=`. Asserted by CONTENT rather than by name, so a rename
    // does not quietly drop one.
    expect(VECTORS.some((v) => v.rawBody === ''), `no empty-body vector in ${names.join(', ')}`).toBe(true);
    expect(VECTORS.some((v) => /[^\x20-\x7e]/.test(v.rawBody))).toBe(true);
    expect(VECTORS.some((v) => v.rawBody.includes(',') && v.rawBody.includes('='))).toBe(true);
  });

  for (const vector of VECTORS) {
    it(`${vector.name} — ${vector.note}`, () => {
      const ok = verifyWebhook(
        { [SIGNATURE_HEADER]: vector.expectedHeader },
        vector.rawBody,
        vector.secret,
        DEFAULT_TOLERANCE_SECONDS,
        at(vector.timestamp),
      );
      expect(
        ok,
        `the SDK verifier disagrees with L15's signer on "${vector.name}". The two sides ` +
          `differ on the separator, the encoding, or what exactly is signed — and the TTFE ` +
          `drill would fail at its LAST step with no other symptom. Scheme: ${fixture.scheme}`,
      ).toBe(true);
    });
  }

  it('no vector’s header verifies ANOTHER vector’s body — the vectors discriminate', () => {
    // Eight passing vectors would also be produced by a verifier that returned
    // `true` unconditionally. This is the half that rules that out.
    let crossChecks = 0;
    for (const signed of VECTORS) {
      for (const other of VECTORS) {
        if (signed === other) continue;
        // Two vectors legitimately share bytes AND secret only if they are the
        // same case; `second-secret-same-body` shares the body under a different
        // secret and must NOT verify.
        if (signed.rawBody === other.rawBody && signed.secret === other.secret) continue;
        crossChecks += 1;
        expect(
          verifyWebhook(
            { [SIGNATURE_HEADER]: signed.expectedHeader },
            other.rawBody,
            other.secret,
            DEFAULT_TOLERANCE_SECONDS,
            at(signed.timestamp),
          ),
          `${signed.name}'s signature verified ${other.name}'s body`,
        ).toBe(false);
      }
    }
    expect(crossChecks).toBeGreaterThan(40);
  });

  it('the same body under a DIFFERENT secret produces a different header', () => {
    const a = VECTORS.find((v) => v.name === 'ordinary-envelope') as Vector;
    const b = VECTORS.find((v) => v.name === 'second-secret-same-body') as Vector;
    expect(a.rawBody).toBe(b.rawBody);
    expect(a.secret).not.toBe(b.secret);
    expect(a.expectedHeader).not.toBe(b.expectedHeader);
  });
});

describe('PF-544 · the negative matrix — seven falses and one true', () => {
  const header = BASE.expectedHeader;
  const now = at(BASE.timestamp);

  it('0 · the positive control, so the matrix is not passing by always failing', () => {
    expect(verifyWebhook({ [SIGNATURE_HEADER]: header }, BASE.rawBody, BASE.secret, 300, now)).toBe(
      true,
    );
  });

  it('1 · a byte-flipped body fails', () => {
    // One character, in the middle of a field a subscriber would act on.
    const tampered = BASE.rawBody.replace('Release notes', 'Release notez');
    expect(tampered).not.toBe(BASE.rawBody);
    expect(verifyWebhook({ [SIGNATURE_HEADER]: header }, tampered, BASE.secret, 300, now)).toBe(false);
  });

  it('2 · a timestamp exactly `tolerance + 1` old fails — and `tolerance` exactly still passes', () => {
    const tolerance = 300;
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: header },
        BASE.rawBody,
        BASE.secret,
        tolerance,
        at(BASE.timestamp + tolerance),
      ),
      'the boundary itself must be INSIDE the window',
    ).toBe(true);
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: header },
        BASE.rawBody,
        BASE.secret,
        tolerance,
        at(BASE.timestamp + tolerance + 1),
      ),
    ).toBe(false);
  });

  it('2b · a FUTURE timestamp beyond tolerance also fails — a clock drifts both ways', () => {
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: header },
        BASE.rawBody,
        BASE.secret,
        300,
        at(BASE.timestamp - 301),
      ),
    ).toBe(false);
  });

  it('3 · `t=` only, with no v1, fails', () => {
    expect(
      verifyWebhook({ [SIGNATURE_HEADER]: `t=${BASE.timestamp}` }, BASE.rawBody, BASE.secret, 300, now),
    ).toBe(false);
  });

  it('4 · `v1=` only, with no timestamp, fails', () => {
    const v1 = header.split('v1=')[1] as string;
    expect(verifyWebhook({ [SIGNATURE_HEADER]: `v1=${v1}` }, BASE.rawBody, BASE.secret, 300, now)).toBe(
      false,
    );
  });

  it('5 · the header absent entirely fails', () => {
    expect(verifyWebhook({}, BASE.rawBody, BASE.secret, 300, now)).toBe(false);
    expect(verifyWebhook({ 'content-type': 'application/json' }, BASE.rawBody, BASE.secret, 300, now)).toBe(
      false,
    );
  });

  it('6 · a correct signature under the WRONG secret fails', () => {
    expect(
      verifyWebhook({ [SIGNATURE_HEADER]: header }, BASE.rawBody, `${BASE.secret}x`, 300, now),
    ).toBe(false);
    expect(verifyWebhook({ [SIGNATURE_HEADER]: header }, BASE.rawBody, 'whsec_wrong', 300, now)).toBe(
      false,
    );
  });

  it('7 · a garbage header with no `=` fails', () => {
    for (const garbage of ['garbage', 'not a signature', ';;;', 't1234v1abcd']) {
      expect(verifyWebhook({ [SIGNATURE_HEADER]: garbage }, BASE.rawBody, BASE.secret, 300, now)).toBe(
        false,
      );
    }
  });

  it('7b · a well-formed header with an extra unsigned part still fails if v1 is wrong', () => {
    // `t=…,garbage,v1=…` must not verify by having the parser skip the middle.
    const v1 = header.split('v1=')[1] as string;
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: `t=${BASE.timestamp},garbage,v1=${v1}` },
        BASE.rawBody,
        BASE.secret,
        300,
        now,
      ),
    ).toBe(false);
  });

  it('7c · the DECOY t=/v1= inside a body is not mistaken for the header', () => {
    // `delimiters-in-body` exists for this: a verifier that scanned the body for
    // a signature, or split it on ',', breaks here.
    const decoy = VECTORS.find((v) => v.name === 'delimiters-in-body') as Vector;
    expect(decoy.rawBody).toContain('t=999');
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: decoy.expectedHeader },
        decoy.rawBody,
        decoy.secret,
        300,
        at(decoy.timestamp),
      ),
    ).toBe(true);
  });
});

describe('PF-545 · constant-time comparison, and NO input makes it throw', () => {
  it('an invalid-hex v1 is rejected by PATTERN — Buffer.from does not throw, it truncates', () => {
    // The sketch wrapped `Buffer.from(v1,'hex')` in try/catch and commented that
    // it guarded against a throw. It does not throw: `Buffer.from('zz','hex')`
    // is a ZERO-LENGTH buffer. That code was dead and its comment misleading.
    expect(Buffer.from('zz', 'hex')).toHaveLength(0);
    expect(Buffer.from('abzz', 'hex')).toHaveLength(1);

    for (const v1 of ['zz', 'abzz', 'ABCDEF'.repeat(10), 'abc', '', '0'.repeat(63)]) {
      expect(
        verifyWebhook(
          { [SIGNATURE_HEADER]: `t=${BASE.timestamp},v1=${v1}` },
          BASE.rawBody,
          BASE.secret,
          300,
          at(BASE.timestamp),
        ),
        `v1=${v1} was accepted`,
      ).toBe(false);
    }
  });

  it('an ODD-length v1 yields a short buffer and is rejected rather than compared', () => {
    // `timingSafeEqual` THROWS on a length mismatch — this is the input that
    // would have turned a forged webhook into a subscriber outage.
    const v1 = '0'.repeat(63);
    expect(Buffer.from(v1, 'hex').length).not.toBe(32);
    expect(() =>
      verifyWebhook(
        { [SIGNATURE_HEADER]: `t=${BASE.timestamp},v1=${v1}` },
        BASE.rawBody,
        BASE.secret,
      ),
    ).not.toThrow();
  });

  it('NOTHING throws — hostile headers, hostile bodies, hostile secrets', () => {
    const hostileHeaders: unknown[] = [
      null,
      undefined,
      {},
      { [SIGNATURE_HEADER]: null },
      { [SIGNATURE_HEADER]: undefined },
      { [SIGNATURE_HEADER]: 42 },
      { [SIGNATURE_HEADER]: [] },
      { [SIGNATURE_HEADER]: [BASE.expectedHeader, 'second'] },
      { [SIGNATURE_HEADER]: { nested: true } },
      { get: 'not a function' },
      {
        get() {
          throw new Error('a Headers-like object that rejects');
        },
      },
      Object.create(null) as object,
      'a string, not headers',
      [],
      0,
    ];
    const hostileBodies: unknown[] = ['', BASE.rawBody, new Uint8Array([0, 255, 128]), ' ￿'];
    const hostileSecrets: unknown[] = ['', BASE.secret, 'x'.repeat(10_000)];

    let calls = 0;
    for (const headers of hostileHeaders) {
      for (const body of hostileBodies) {
        for (const secret of hostileSecrets) {
          calls += 1;
          let result: unknown;
          expect(() => {
            result = verifyWebhook(
              headers as never,
              body as never,
              secret as never,
              300,
              at(BASE.timestamp),
            );
          }, `threw on headers=${JSON.stringify(headers)}`).not.toThrow();
          // and the answer is always a boolean, never `undefined`.
          expect(typeof result).toBe('boolean');
        }
      }
    }
    expect(calls).toBe(hostileHeaders.length * hostileBodies.length * hostileSecrets.length);
  });

  it('a hostile toleranceSec cannot widen the window to infinity', () => {
    for (const tolerance of [NaN, Infinity, -1, -Infinity] as number[]) {
      expect(
        verifyWebhook(
          { [SIGNATURE_HEADER]: BASE.expectedHeader },
          BASE.rawBody,
          BASE.secret,
          tolerance,
          at(BASE.timestamp + 100_000),
        ),
        `toleranceSec=${tolerance} accepted a 100000s-old signature`,
      ).toBe(false);
    }
  });

  it('and the comparison really is timingSafeEqual — asserted on the source, not assumed', () => {
    const source = readFileSync(resolve(HERE, 'webhooks.ts'), 'utf8');
    expect(source).toContain('timingSafeEqual');
    // A `===` on the digests would be correct and leak the position of the first
    // differing byte. There is no `expected === presented` anywhere.
    expect(source).not.toMatch(/expected\s*===\s*presented/);
    expect(source).not.toMatch(/\.digest\(['"]hex['"]\)\s*===/);
  });
});

describe('PF-546 · every header shape a real subscriber hands in', () => {
  const cases: [string, () => unknown][] = [
    ['a lowercased plain record (p.7’s type)', () => ({ [SIGNATURE_HEADER]: BASE.expectedHeader })],
    ['Node’s req.headers, mixed case', () => ({ 'Ship-Signature': BASE.expectedHeader })],
    ['SHOUTING case', () => ({ 'SHIP-SIGNATURE': BASE.expectedHeader })],
    ['an array-valued header', () => ({ [SIGNATURE_HEADER]: [BASE.expectedHeader] })],
    ['a WHATWG Headers', () => new Headers({ 'Ship-Signature': BASE.expectedHeader })],
    [
      'a Headers-LIKE object with only .get()',
      () => ({
        get: (name: string) =>
          name.toLowerCase() === SIGNATURE_HEADER ? BASE.expectedHeader : null,
      }),
    ],
  ];

  for (const [label, build] of cases) {
    it(`${label} verifies`, () => {
      expect(
        verifyWebhook(build() as never, BASE.rawBody, BASE.secret, 300, at(BASE.timestamp)),
        `L99 F22: this shape returns FALSE on a VALID signature — a silent false ` +
          `negative, where the subscriber drops a legitimate event and nothing errors.`,
      ).toBe(true);
    });
  }

  it('and a Headers WITHOUT the signature is still false — the shape check is not a bypass', () => {
    expect(
      verifyWebhook(new Headers({ 'content-type': 'application/json' }), BASE.rawBody, BASE.secret),
    ).toBe(false);
  });
});

describe('PF-542 · the fourth argument is POSITIONAL, and defaults to 300', () => {
  it('p.7’s call shape compiles and works with three arguments', () => {
    // `verifyWebhook(headers, rawBody, secret)` — p.4's sentence, verbatim.
    const now = Math.floor(Date.now() / 1000);
    const body = '{"live":true}';
    const secret = 'whsec_positional_default_test';
    const v1 = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
    expect(verifyWebhook({ [SIGNATURE_HEADER]: `t=${now},v1=${v1}` }, body, secret)).toBe(true);
  });

  it('the default really is 300, not merely documented as 300', () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    const anchor = BASE.timestamp;
    // 300 in: passes with the default. 301 out: fails with the default.
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: BASE.expectedHeader },
        BASE.rawBody,
        BASE.secret,
        undefined,
        at(anchor + 300),
      ),
    ).toBe(true);
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: BASE.expectedHeader },
        BASE.rawBody,
        BASE.secret,
        undefined,
        at(anchor + 301),
      ),
    ).toBe(false);
  });

  it('a NUMBER in the fourth position is the tolerance — not an options bag', () => {
    // The regression this ticket exists for: the sketch's fourth parameter was
    // `options: VerifyOptions = {}`, so `verifyWebhook(h, b, s, 60)` silently
    // used the DEFAULT tolerance and a caller's 60 meant nothing.
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: BASE.expectedHeader },
        BASE.rawBody,
        BASE.secret,
        60,
        at(BASE.timestamp + 61),
      ),
      'the fourth argument was ignored — it is being read as an options object',
    ).toBe(false);
    expect(
      verifyWebhook(
        { [SIGNATURE_HEADER]: BASE.expectedHeader },
        BASE.rawBody,
        BASE.secret,
        60,
        at(BASE.timestamp + 59),
      ),
    ).toBe(true);
  });

  it('clock injection lives in the FIFTH argument, and is optional', () => {
    const source = readFileSync(resolve(HERE, 'webhooks.ts'), 'utf8');
    expect(source).toMatch(/toleranceSec: number = DEFAULT_TOLERANCE_SECONDS,\s*\n\s*options/);
  });
});
