/**
 * PF-721 — the shared listener, tested for the two properties every consumer
 * depends on and neither can check for itself: the bytes are the bytes, and the
 * wait is event-driven.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { SIGNATURE_HEADER } from '@ship/sdk';
import { createTestListener, signatureGate, SIGNATURE_REJECTED_STATUS } from '../src/index.js';
import type { TestListener } from '../src/index.js';

let listener: TestListener | null = null;

afterEach(async () => {
  await listener?.close();
  listener = null;
});

/** Builds the header a real Ship deliverer sends: `t=<unix-seconds>,v1=<hex>`. */
function sign(secret: string, body: Buffer, timestampSeconds: number): string {
  const signed = Buffer.concat([Buffer.from(`${timestampSeconds}.`, 'utf8'), body]);
  const v1 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

describe('PF-721 — raw body capture', () => {
  it('captures the bytes that arrived, not a re-serialisation of them', async () => {
    listener = await createTestListener();

    // Deliberately hostile to a parse-then-re-serialise listener: keys out of
    // alphabetical order, a non-ASCII character, and an escaped one that
    // JSON.stringify would emit differently from how it arrived.
    const wire = '{"z":1,"a":"caf\\u00e9 é","n":1.0}';
    const bytes = Buffer.from(wire, 'utf8');

    const response = await fetch(listener.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-1' },
      body: bytes,
    });
    expect(response.status).toBe(200);

    await listener.waitFor((r) => r.length === 1, { what: 'the first delivery' });
    const [received] = listener.requests;

    expect(received?.rawBody.equals(bytes)).toBe(true);
    expect(received?.rawBody.toString('utf8')).toBe(wire);
    // The anti-vacuity half: a re-serialisation really would differ, so the
    // assertion above is not true by accident.
    expect(JSON.stringify(received?.json())).not.toBe(wire);
    expect(received?.idempotencyKey).toBe('key-1');
  });

  it('a request that arrived before waitFor was called still satisfies it', async () => {
    listener = await createTestListener();
    await fetch(listener.url, { method: 'POST', body: '{}' });
    // Not a race: `waitFor` evaluates the predicate over what has ALREADY been
    // received before it ever registers a waiter. A listener that only reacted
    // to future events would hang here forever.
    await listener.waitFor((r) => r.length >= 1, { timeoutMs: 5_000, what: 'a past delivery' });
    expect(listener.requests).toHaveLength(1);
  });

  it('a wait that will never be satisfied fails NAMING what it wanted', async () => {
    listener = await createTestListener();
    await expect(
      listener.waitFor((r) => r.length === 9, { timeoutMs: 150, what: 'nine deliveries' }),
    ).rejects.toThrow(/nine deliveries/);
  });
});

describe('PF-721 — the reply is programmable, which is what the retry drill needs', () => {
  it('answers 500 three times and 200 on the fourth', async () => {
    listener = await createTestListener();
    listener.respondWith((request) => ({ status: request.sequence <= 3 ? 500 : 200 }));

    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await fetch(listener.url, { method: 'POST', body: '{}' });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([500, 500, 500, 200]);
  });

  it('a handler that throws answers 500 rather than silently accepting', async () => {
    listener = await createTestListener(() => {
      throw new Error('subscriber blew up');
    });
    const res = await fetch(listener.url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
  });
});

describe('PF-741 / PF-728 — the signature gate, over the raw body', () => {
  const SECRET = 'whsec_test_secret_value';

  it('verifies a genuine signature, and REJECTS the same body with one byte changed', async () => {
    const body = Buffer.from('{"event":"document.created","id":"doc_1"}', 'utf8');
    const now = Math.floor(Date.now() / 1000);
    const headers = { [SIGNATURE_HEADER]: sign(SECRET, body, now) };

    expect(signatureGate(headers, body, { secret: SECRET })).toMatchObject({ verified: true });

    const tampered = Buffer.from('{"event":"document.created","id":"doc_2"}', 'utf8');
    const rejected = signatureGate(headers, tampered, { secret: SECRET });
    expect(rejected.verified).toBe(false);
    expect(rejected.status).toBe(SIGNATURE_REJECTED_STATUS);
    // 4xx, so L16 dead-letters instead of retrying a secret that will not change.
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(rejected.status).toBeLessThan(500);
  });

  it('rejects a six-minute-old timestamp — with an injected clock, not a wait', async () => {
    const body = Buffer.from('{"event":"document.created"}', 'utf8');
    const signedAt = 1_700_000_000;
    const headers = { [SIGNATURE_HEADER]: sign(SECRET, body, signedAt) };

    // Same bytes, same secret, same signature. Only the observer's clock moved.
    expect(signatureGate(headers, body, { secret: SECRET, nowSeconds: signedAt })).toMatchObject({
      verified: true,
    });
    expect(
      signatureGate(headers, body, { secret: SECRET, nowSeconds: signedAt + 6 * 60 }),
    ).toMatchObject({ verified: false, status: SIGNATURE_REJECTED_STATUS });
  });

  it('rejects a missing header and the wrong secret', async () => {
    const body = Buffer.from('{}', 'utf8');
    const now = Math.floor(Date.now() / 1000);
    expect(signatureGate({}, body, { secret: SECRET }).verified).toBe(false);
    expect(
      signatureGate({ [SIGNATURE_HEADER]: sign('another_secret', body, now) }, body, {
        secret: SECRET,
      }).verified,
    ).toBe(false);
  });
});
