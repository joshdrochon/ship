/**
 * PF-446 — the golden vectors, and what they are for.
 *
 * `__fixtures__/signature-vectors.json` is the contract between two
 * implementations that must never see each other's code: this server signer,
 * and L18's SDK `verifyWebhook`. L01's lint fence forbids `sdk/**` from
 * importing anything in this repository, so the SDK cannot be tested against
 * `signer.ts` — it can only be tested against a FILE.
 *
 * That is the point. Two implementations tested only against each other's
 * output agree with each other by construction; two implementations tested
 * against the same committed bytes agree with the *specification*. If a change
 * to `signer.ts` alters a digest, this file goes red before anyone notices that
 * every subscriber in the world now rejects our deliveries.
 *
 * **The vectors are generated once and committed. Regenerating them is a
 * deliberate act with a diff, never a silent refresh** — the moment this test
 * recomputes what it is checking, it is asserting that the code equals itself.
 *
 * L18: import this same file. Do not copy the values.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSignatureHeader, verifySignature, SIGNATURE_HEADER_PATTERN } from './signer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'signature-vectors.json');

interface Vector {
  name: string;
  note: string;
  secret: string;
  timestamp: number;
  rawBody: string;
  expectedHeader: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  scheme: string;
  vectors: Vector[];
};

describe('PF-446 — the committed vectors reproduce byte-for-byte', () => {
  it('there are at least six of them', () => {
    // The ticket's floor. Asserted so that "the vectors pass" cannot become
    // true by the file being emptied.
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(6);
  });

  it.each(fixture.vectors)('$name — $note', (vector) => {
    const body = Buffer.from(vector.rawBody, 'utf8');
    expect(formatSignatureHeader(vector.secret, vector.timestamp, body)).toBe(
      vector.expectedHeader,
    );
    expect(vector.expectedHeader).toMatch(SIGNATURE_HEADER_PATTERN);
    // And the round trip: what the signer produced, the verifier accepts.
    expect(verifySignature(vector.secret, vector.expectedHeader, body, vector.timestamp)).toBe(
      true,
    );
  });

  it('covers the three shapes the ticket names', () => {
    const bodies = fixture.vectors.map((v) => v.rawBody);
    // A non-ASCII body — a verifier hashing over a JS string rather than bytes
    // diverges here and nowhere else.
    expect(bodies.some((b) => /[^\x00-\x7F]/.test(b))).toBe(true);
    // An EMPTY body — zero length is not an error case.
    expect(bodies).toContain('');
    // A body containing the header's own delimiters, `,` and `=`, including a
    // decoy `t=`/`v1=` pair. An implementation that scanned the body for the
    // signature, or split it on a comma, breaks on this one.
    expect(bodies.some((b) => b.includes(',') && b.includes('=') && b.includes('t='))).toBe(true);
  });

  it('two secrets over IDENTICAL bytes produce different headers', () => {
    // The fanout property the matcher depends on: one event, N subscriptions,
    // N distinct signatures. If these collided, one subscriber's secret would
    // verify another's delivery.
    const same = fixture.vectors.filter((v) => v.rawBody === fixture.vectors[0]!.rawBody);
    expect(same.length).toBeGreaterThanOrEqual(2);
    expect(new Set(same.map((v) => v.expectedHeader)).size).toBe(same.length);
    expect(new Set(same.map((v) => v.secret)).size).toBe(same.length);
  });

  it('each vector fails under a DIFFERENT secret — the file is not self-satisfying', () => {
    // Without this, a broken `verifySignature` that returned `true`
    // unconditionally would pass every assertion above.
    for (const vector of fixture.vectors) {
      const body = Buffer.from(vector.rawBody, 'utf8');
      expect(
        verifySignature('whsec_definitely-not-the-key', vector.expectedHeader, body, vector.timestamp),
      ).toBe(false);
    }
  });

  it('the file states the scheme it encodes, for a reimplementer', () => {
    // The vectors are useless to someone writing a verifier in another language
    // unless the file says what it is vectors OF.
    expect(fixture.scheme).toMatch(/HMAC-SHA256/);
    expect(fixture.scheme).toMatch(/timestamp/);
  });
});
