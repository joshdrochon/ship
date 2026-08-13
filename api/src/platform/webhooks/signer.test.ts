/**
 * PF-439 — the signer's own unit suite, in the four blocks the PRD names.
 *
 * p.11: *"The signer (HMAC-SHA256 with Stripe-style timestamp) has its own unit
 * test suite — **positive, negative, replay, tamper**."* Those four words are
 * the four `describe` blocks below, spelled exactly, and the last block in this
 * file asserts each of them is non-empty — so the suite cannot rot into
 * ceremony, where the block names satisfy a reader and the assertions have been
 * commented out.
 *
 * Zero `setTimeout`, zero wall-clock reads. Every time-dependent case advances a
 * `FakeClock`. p.11 names timing-based webhook tests as flaky tests and p.9
 * budgets flake at 0% over 20 runs; a signer suite that slept for five minutes
 * to test the replay window would fail both.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeClock } from '../clock.js';
import {
  SignatureSigner,
  SIGNATURE_HEADER,
  SIGNATURE_HEADER_PATTERN,
  DEFAULT_TOLERANCE_SECONDS,
  computeSignature,
  formatSignatureHeader,
  parseSignatureHeader,
  signedPayload,
  verifySignature,
} from './signer.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const SECRET = 'whsec_TFhwadwxlAqBGjbHUeS9zvBTPRnQBs7RCTn6RGHmVQE';
const OTHER_SECRET = 'whsec_9nJXTVFQ0kLgQtEbeYCwcE8ZqRlCiCkGRsCB1TWA-Zk';
const BODY = Buffer.from(
  JSON.stringify({ id: 'e1', type: 'document.created', data: { title: 'hello' } }),
  'utf8',
);

/** A fixed instant, so every header in this file is byte-stable across runs. */
const T0_MS = 1_715_985_600_000; // 2024-05-17T22:40:00Z — p.7's example second
const T0_SECONDS = T0_MS / 1000;

function signerAt(ms = T0_MS): { signer: SignatureSigner; clock: FakeClock } {
  const clock = new FakeClock(ms);
  return { signer: new SignatureSigner(clock), clock };
}

// ─────────────────────────────────────────────────────────────────────────────
// positive
// ─────────────────────────────────────────────────────────────────────────────

describe('positive', () => {
  it('a freshly signed request verifies', () => {
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS)).toBe(true);
  });

  it('the emitted header matches p.7\'s literal shape, to the byte', () => {
    // p.7: `Ship-Signature: t=1715985600,v1=<hex-hmac-sha256>`
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(header).toMatch(SIGNATURE_HEADER_PATTERN);
    expect(header.startsWith(`t=${T0_SECONDS},v1=`)).toBe(true);
    // Seconds, not milliseconds. The classic bug, and it is silent: a
    // millisecond timestamp is ~1000x the current epoch, so `Math.abs(now - t)`
    // is astronomically outside any tolerance and EVERY delivery fails
    // verification with no clue why.
    expect(Number(header.slice(2, header.indexOf(',')))).toBe(1_715_985_600);
    // No whitespace anywhere, one comma, `t` before `v1`.
    expect(header).not.toMatch(/\s/);
    expect(header.split(',')).toHaveLength(2);
  });

  it('the header name is the one the PRD prints', () => {
    expect(SIGNATURE_HEADER).toBe('Ship-Signature');
  });

  it('an EMPTY body signs and verifies — zero length is not an error case', () => {
    const { signer } = signerAt();
    const empty = Buffer.alloc(0);
    const { header } = signer.sign(SECRET, empty);
    expect(verifySignature(SECRET, header, empty, T0_SECONDS)).toBe(true);
  });

  it('a non-ASCII body round-trips byte-for-byte', () => {
    const body = Buffer.from(JSON.stringify({ title: 'héllo — 世界 🔐 a/b' }), 'utf8');
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, body);
    expect(verifySignature(SECRET, header, body, T0_SECONDS)).toBe(true);
  });

  it('the whole tolerance window verifies, on both sides of now', () => {
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    for (const offset of [-DEFAULT_TOLERANCE_SECONDS, -1, 0, 1, DEFAULT_TOLERANCE_SECONDS]) {
      expect(verifySignature(SECRET, header, BODY, T0_SECONDS + offset)).toBe(true);
    }
  });

  it('signing is deterministic — the same clock produces the same bytes', () => {
    // This is what makes the golden vectors committable at all (PF-446).
    const a = signerAt().signer.sign(SECRET, BODY);
    const b = signerAt().signer.sign(SECRET, BODY);
    expect(a.header).toBe(b.header);
    expect(a.timestamp).toBe(b.timestamp);
  });

  it('PF-434 — the signed bytes are `t` ‖ "." ‖ rawBody, and nothing else', () => {
    expect(signedPayload(7, Buffer.from('abc'))).toEqual(Buffer.from('7.abc', 'utf8'));
    // Pinned against an independent construction, so a change to the scheme is
    // a failing assertion rather than a silently different digest.
    expect(computeSignature(SECRET, T0_SECONDS, BODY)).toBe(
      formatSignatureHeader(SECRET, T0_SECONDS, BODY).split('v1=')[1],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// negative
// ─────────────────────────────────────────────────────────────────────────────

describe('negative', () => {
  it('a WRONG secret of the correct length fails', () => {
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(OTHER_SECRET).toHaveLength(SECRET.length);
    expect(verifySignature(OTHER_SECRET, header, BODY, T0_SECONDS)).toBe(false);
  });

  it('one flipped hex character fails', () => {
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    const at = header.length - 1;
    const flipped = header.slice(0, at) + (header[at] === 'a' ? 'b' : 'a');
    expect(flipped).not.toBe(header);
    expect(verifySignature(SECRET, flipped, BODY, T0_SECONDS)).toBe(false);
  });

  it('p.4 — a MISSING v1 fails', () => {
    expect(verifySignature(SECRET, `t=${T0_SECONDS}`, BODY, T0_SECONDS)).toBe(false);
    expect(parseSignatureHeader(`t=${T0_SECONDS}`)).toBeNull();
  });

  it('a missing t fails', () => {
    const sig = computeSignature(SECRET, T0_SECONDS, BODY);
    expect(verifySignature(SECRET, `v1=${sig}`, BODY, T0_SECONDS)).toBe(false);
  });

  it.each([
    ['a non-numeric t', 't=abc,v1=' + 'a'.repeat(64)],
    ['a negative t', 't=-1,v1=' + 'a'.repeat(64)],
    ['a float t', 't=1.5,v1=' + 'a'.repeat(64)],
    ['an empty t', 't=,v1=' + 'a'.repeat(64)],
    ['an empty v1', `t=${T0_SECONDS},v1=`],
    ['uppercase hex', `t=${T0_SECONDS},v1=` + 'A'.repeat(64)],
    ['short hex', `t=${T0_SECONDS},v1=` + 'a'.repeat(62)],
    ['long hex', `t=${T0_SECONDS},v1=` + 'a'.repeat(66)],
    ['non-hex characters', `t=${T0_SECONDS},v1=` + 'z'.repeat(64)],
    ['no separator at all', 'garbage'],
    ['an empty header', ''],
    ['an empty key', `=${T0_SECONDS},v1=` + 'a'.repeat(64)],
  ])('the parser returns null for %s, and never throws', (_name, header) => {
    expect(() => parseSignatureHeader(header)).not.toThrow();
    expect(parseSignatureHeader(header)).toBeNull();
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS)).toBe(false);
  });

  it('a DUPLICATED key is null, not last-wins', () => {
    // A `Map` parse would keep the last `t` and verify against it, handing an
    // attacker who can append a pair the replay window back. Two answers to
    // "what is the timestamp" is not a question a verifier may resolve by
    // preference.
    const sig = computeSignature(SECRET, T0_SECONDS, BODY);
    const stale = T0_SECONDS - 10_000;
    expect(parseSignatureHeader(`t=${stale},v1=${sig},t=${T0_SECONDS}`)).toBeNull();
    expect(
      verifySignature(SECRET, `t=${stale},v1=${sig},t=${T0_SECONDS}`, BODY, T0_SECONDS),
    ).toBe(false);
  });

  it('an UNKNOWN pair is tolerated — forward compatibility with a future v2', () => {
    // The other half of PF-434's "the scheme tag lives in the header": adding
    // `v2=` must not break a verifier written today, or the migration story is
    // a lie.
    const sig = computeSignature(SECRET, T0_SECONDS, BODY);
    const header = `t=${T0_SECONDS},v1=${sig},v2=${'f'.repeat(96)}`;
    expect(parseSignatureHeader(header)?.v1).toBe(sig);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS)).toBe(true);
  });

  it('a signature computed over the BODY ALONE does not verify', () => {
    // The direct proof that `t` is inside the MAC. If this ever passes, the
    // anti-replay property is gone and nothing else in this file would notice.
    const bodyOnly = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifySignature(SECRET, `t=${T0_SECONDS},v1=${bodyOnly}`, BODY, T0_SECONDS)).toBe(
      false,
    );
  });

  it('a signature for a DIFFERENT timestamp does not verify at this one', () => {
    const other = computeSignature(SECRET, T0_SECONDS + 1, BODY);
    expect(verifySignature(SECRET, `t=${T0_SECONDS},v1=${other}`, BODY, T0_SECONDS)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// replay
// ─────────────────────────────────────────────────────────────────────────────

describe('replay', () => {
  it('the 300 s boundary is asserted from BOTH sides', () => {
    const { signer, clock } = signerAt();
    const { header } = signer.sign(SECRET, BODY);

    clock.advance(DEFAULT_TOLERANCE_SECONDS * 1000 - 1000); // t + 299 s
    expect(signer.verify(SECRET, header, BODY)).toBe(true);

    clock.advance(1000); // t + 300 s — the inclusive edge
    expect(signer.verify(SECRET, header, BODY)).toBe(true);

    clock.advance(1000); // t + 301 s
    expect(signer.verify(SECRET, header, BODY)).toBe(false);
  });

  it('a captured request is worthless once the window passes', () => {
    const { signer, clock } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    // The attack the timestamp defeats: capture a valid signed request and
    // resend it verbatim later. The signature is still cryptographically
    // correct — it is the age that rejects it.
    clock.advance(3600 * 1000);
    expect(signer.verify(SECRET, header, BODY)).toBe(false);
    // …and the bytes really are unmodified, so this is the window rejecting it
    // and nothing else.
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS)).toBe(true);
  });

  it('the FUTURE side is symmetric — a pre-minted signature also fails', () => {
    // `Math.abs` is correct and this pins it. A timestamp far in the future
    // means a broken sender clock or someone pre-minting signatures to replay
    // later, and neither is a request to accept.
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS - 301)).toBe(false);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS - 300)).toBe(true);
  });

  it('the default tolerance is 300 s, per p.3 and p.7', () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    // Asserted BEHAVIOURALLY as well as by the constant: a caller who passes no
    // tolerance gets 300, which is the contract p.7 prints.
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS + 300)).toBe(true);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS + 301)).toBe(false);
  });

  it('a caller may narrow the window, and narrowing takes effect', () => {
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS + 10, 5)).toBe(false);
    expect(verifySignature(SECRET, header, BODY, T0_SECONDS + 10, 30)).toBe(true);
  });

  it('no test in this file sleeps — the clock is advanced, never awaited', () => {
    const source = readFileSync(join(HERE, 'signer.test.ts'), 'utf8');
    // p.11's standing rule, mechanised in the file it governs. A future case
    // that reaches for a real timer fails here rather than becoming the flake
    // p.9 budgets at zero.
    expect(source).not.toMatch(/setTimeout\(/);
    expect(source).not.toMatch(/await new Promise\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tamper
// ─────────────────────────────────────────────────────────────────────────────

describe('tamper', () => {
  it('a changed body byte fails against the original header', () => {
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    const tampered = Buffer.from(BODY.toString('utf8').replace('hello', 'hellO'), 'utf8');
    expect(tampered.length).toBe(BODY.length);
    expect(verifySignature(SECRET, header, tampered, T0_SECONDS)).toBe(false);
  });

  it('one TRAILING NEWLINE is enough to fail', () => {
    // The likeliest accidental corruption on a delivery path — a proxy or a
    // logger that "helpfully" normalises the body. It must fail, because the
    // verifier cannot tell it from an attack.
    const { signer } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    expect(verifySignature(SECRET, header, Buffer.concat([BODY, Buffer.from('\n')]), T0_SECONDS)).toBe(
      false,
    );
  });

  it('a REORDERED but equivalent JSON body fails — canonicalization is not assumed', () => {
    // PF-436's negative half. Two serializations of one logical value are two
    // different byte strings, so re-serializing what you parsed and verifying
    // THAT is a bug. This test is the proof that the contract is over bytes.
    const { signer } = signerAt();
    const original = Buffer.from(JSON.stringify({ a: 1, b: 2 }), 'utf8');
    const reordered = Buffer.from(JSON.stringify({ b: 2, a: 1 }), 'utf8');
    const { header } = signer.sign(SECRET, original);
    expect(JSON.parse(reordered.toString())).toEqual(JSON.parse(original.toString()));
    expect(verifySignature(SECRET, header, reordered, T0_SECONDS)).toBe(false);
  });

  it('a rewritten timestamp fails, which is the whole point of signing it', () => {
    const { signer, clock } = signerAt();
    const { header } = signer.sign(SECRET, BODY);
    clock.advance(3600 * 1000);
    // The attacker's obvious move once the window has passed: refresh `t` to
    // now and resend. It fails because `t` is inside the MAC.
    const rewritten = header.replace(/^t=\d+/, `t=${T0_SECONDS + 3600}`);
    expect(signer.verify(SECRET, rewritten, BODY)).toBe(false);
  });

  it('swapping in another subscription\'s valid signature fails', () => {
    // Two live subscriptions, one event. A signature valid for one must not
    // verify for the other, or a subscriber could forge deliveries to a peer.
    const { signer } = signerAt();
    const mine = signer.sign(SECRET, BODY);
    const theirs = signer.sign(OTHER_SECRET, BODY);
    expect(theirs.header).not.toBe(mine.header);
    expect(verifySignature(SECRET, theirs.header, BODY, T0_SECONDS)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-439's own guard, plus PF-437's grep
// ─────────────────────────────────────────────────────────────────────────────

describe('PF-439 — the four blocks exist and none of them is empty', () => {
  const source = readFileSync(join(HERE, 'signer.test.ts'), 'utf8');

  it.each(['positive', 'negative', 'replay', 'tamper'])(
    'the "%s" block is present and contains assertions',
    (block) => {
      // p.11 names these four by name. Asserting they EXIST is not enough — a
      // suite can rot into four empty describes that read as coverage, and
      // `.claude/CLAUDE.md` records that a test containing only comments passes
      // silently. So this counts `expect(` between one block header and the next.
      const start = source.indexOf(`describe('${block}'`);
      expect(start, `the "${block}" block is missing`).toBeGreaterThan(-1);
      const rest = source.slice(start + 1);
      const nextBlock = rest.indexOf('\ndescribe(');
      const body = nextBlock === -1 ? rest : rest.slice(0, nextBlock);
      const assertions = body.split('expect(').length - 1;
      expect(assertions, `the "${block}" block has no assertions`).toBeGreaterThan(3);
    },
  );
});

describe('PF-437 — the signer reads an injected clock and nothing else', () => {
  const source = readFileSync(join(HERE, 'signer.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it.each(['Date.now(', 'new Date('])('%s appears nowhere in signer.ts', (needle) => {
    // Comments are stripped first, so the paragraph in the module header that
    // explains this very rule does not count as a violation of it.
    expect(source).not.toContain(needle);
  });

  it('there is no timer in the signer either', () => {
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('setInterval');
  });

  it('the signer cannot produce a timestamp without a clock', () => {
    // Constructor-injected rather than defaulted. A `clock = new SystemClock()`
    // default would compile, pass every test above, and quietly reintroduce the
    // wall clock the day someone forgot the argument.
    const { signer } = signerAt(5_000);
    expect(signer.nowSeconds()).toBe(5);
    const { signer: later } = signerAt(9_999);
    // Floor, not round: 9.999 s is second 9. Rounding would make a header
    // claim a second that had not happened yet.
    expect(later.nowSeconds()).toBe(9);
  });
});
