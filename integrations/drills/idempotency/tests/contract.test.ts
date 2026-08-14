/**
 * The half of this drill that needs no server: the dedupe contract's own rules,
 * and PF-728's claim that the drill reads nothing but the wire.
 *
 * Kept separate from `idempotency.test.ts` because these are properties of the
 * SUBSCRIBER rather than of the platform, and a subscriber whose dedupe rule is
 * only tested through a live delivery is a rule nobody can debug.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNATURE_HEADER } from '@ship/sdk';
import { createDedupeSubscriber, IDEMPOTENCY_HEADER } from '../src/subscriber.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET = 'whsec_drill_secret';

function delivery(key: string, body = '{"id":"evt_1","type":"document.created"}', secret = SECRET) {
  const raw = Buffer.from(body, 'utf8');
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]))
    .digest('hex');
  return {
    headers: { [SIGNATURE_HEADER]: `t=${t},v1=${v1}`, [IDEMPOTENCY_HEADER]: key },
    rawBody: raw,
  };
}

describe('PF-729 — the dedupe contract', () => {
  it('two deliveries with one key: one side effect, two 200s', () => {
    const subscriber = createDedupeSubscriber({ secret: SECRET });
    const first = subscriber.handle(delivery('evt_1:sub_1'));
    const second = subscriber.handle(delivery('evt_1:sub_1'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(subscriber.sideEffects).toHaveLength(1);
  });

  it('a duplicate answers 200 and NOT 409 — a 409 would dead-letter a success', () => {
    const subscriber = createDedupeSubscriber({ secret: SECRET });
    subscriber.handle(delivery('evt_2:sub_1'));
    const duplicate = subscriber.handle(delivery('evt_2:sub_1'));
    // L16 classifies 4xx as permanent (D9), so a 409 here would record a
    // delivery FAILURE for the one case where the subscriber did everything
    // right. The status has to mean "you can stop now".
    expect(duplicate.status).toBeGreaterThanOrEqual(200);
    expect(duplicate.status).toBeLessThan(300);
  });

  it('verification happens BEFORE dedupe, so a forgery cannot poison the key store', () => {
    const subscriber = createDedupeSubscriber({ secret: SECRET });

    // A forged delivery carrying a key the attacker guessed.
    const forged = subscriber.handle(delivery('evt_3:sub_1', undefined, 'the_wrong_secret'));
    expect(forged.verified).toBe(false);
    expect(forged.status).toBe(401);
    expect(subscriber.keysSeen).toHaveLength(0);

    // The genuine delivery that follows still runs. A subscriber that deduped
    // first would swallow it as a duplicate of the forgery — silently, forever.
    const genuine = subscriber.handle(delivery('evt_3:sub_1'));
    expect(genuine.deduped).toBe(false);
    expect(subscriber.sideEffects).toHaveLength(1);
  });

  it('a 5xx does NOT commit the key, so the retry is not a no-op', () => {
    // The ordering that separates deduping from dropping. If a failed attempt
    // recorded its key, the retry Ship is about to send would be answered "seen
    // that" and the work would never happen.
    const subscriber = createDedupeSubscriber({
      secret: SECRET,
      answer: (attempt) => (attempt <= 2 ? 500 : 200),
    });
    subscriber.handle(delivery('evt_4:sub_1'));
    subscriber.handle(delivery('evt_4:sub_1'));
    const third = subscriber.handle(delivery('evt_4:sub_1'));

    expect(third.status).toBe(200);
    expect(third.deduped).toBe(false);
    expect(subscriber.sideEffects).toHaveLength(1);
  });

  it('a delivery with no key is refused rather than processed blind', () => {
    const subscriber = createDedupeSubscriber({ secret: SECRET });
    const raw = delivery('unused');
    const headers = { ...raw.headers };
    delete headers[IDEMPOTENCY_HEADER];
    expect(subscriber.handle({ headers, rawBody: raw.rawBody }).status).toBe(400);
    expect(subscriber.sideEffects).toHaveLength(0);
  });

  it('the README documents the three things the contract has to say', () => {
    const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8');
    // Pre-Search 2.3 (p.16) asks for this document by name, and a contract that
    // exists only in code is one no subscriber author will ever read.
    expect(readme).toContain('Idempotency-Key');
    expect(readme).toMatch(/lifetime/i);
    expect(readme).toMatch(/duplicate/i);
  });
});

describe('PF-728 — every assertion is made from the wire, and the tree proves it', () => {
  const SKIP = new Set(['node_modules', 'dist', 'test-results']);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(join(dir, entry.name));
      } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  if (statSync(PACKAGE_ROOT).isDirectory()) walk(PACKAGE_ROOT);

  it('reads source files at all, so the greps below are not vacuous', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('never reads the delivery log table', () => {
    // `client.webhooks.deliveries` — the PUBLIC route — is used, and that is the
    // point: the drill reads the platform's account through the same door a
    // stranger has. What it must never do is go behind that door.
    const offenders = files.filter((f) => /\bwebhook_deliveries\b/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(PACKAGE_ROOT, f))).toEqual([]);
  });

  it('imports nothing but @ship/sdk, the testkit fixture, and node builtins', () => {
    const bad: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = match[1] ?? '';
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        if (spec === '@ship/sdk' || spec === '@ship/integration-testkit') continue;
        if (spec === 'vitest' || spec === 'vitest/config') continue;
        bad.push(`${relative(PACKAGE_ROOT, file)} → ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
