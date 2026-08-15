/**
 * PF-578 — a delivery that fails verification is VISIBLY a failure, and can
 * fail the process.
 *
 * p.4 requires that *"Tampered bodies fail; expired timestamps fail; missing v1
 * header fails"*, and p.13 grades a screenshot of this exact terminal. A tail
 * that swallowed a forged delivery into the same green output as a real one
 * would turn the graded artifact into a lie — so all three failures are driven
 * through the real renderer here, with real HMACs, and the process-level clause
 * (`--exit-on-invalid` exits `EXIT_CODES.signature`) is driven through the real
 * `--listen` path against a stub Ship.
 *
 * A stub and not the booted instance, deliberately: a correct deliverer never
 * sends a tampered body, so the only way to observe this against real Ship
 * would be to break the signer. `tests/server/` proves the VALID path arrives
 * and verifies; this proves the invalid ones cannot masquerade as it.
 *
 * No `setTimeout` anywhere in this file (p.11): the tolerance window is crossed
 * by moving the injected clock, not by waiting.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DEFAULT_TOLERANCE_SECONDS, SIGNATURE_HEADER } from '@ship/sdk';
import {
  MAX_COLUMNS,
  renderDeliveryBlock,
  verifyDelivery,
  type EventEnvelope,
} from '../src/render/delivery.js';
import { runWebhooksTail } from '../src/commands/webhooksTail.js';
import { contextDefaults } from '../src/context.js';
import { EXIT_CODES } from '../src/exitCodes.js';
import type { OutputSink } from '../src/io.js';
import { StubShip, fakeClock } from './support/stubShip.js';

const SECRET = 'whsec_l19_test_secret_value_0123456789';

const EVENT: EventEnvelope = {
  id: 'evt_0000000000000001',
  type: 'document.created',
  created_at: '2026-08-15T00:00:00.000Z',
  data: { id: '00000000-0000-4000-8000-000000000001', title: 'hello' },
};

const BODY = JSON.stringify(EVENT);

/** The header a correct deliverer sends: `t=<unix seconds>,v1=<hex>`. */
function sign(body: string, secret: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestampSeconds}.`, 'utf8'), Buffer.from(body, 'utf8')]))
    .digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

function block(headers: Record<string, string>, rawBody: string, nowMs: number): string[] {
  return renderDeliveryBlock({
    event: JSON.parse(rawBody) as EventEnvelope,
    idempotencyKey: 'evt_0000000000000001',
    verification: verifyDelivery(headers, rawBody, SECRET, nowMs),
    arrivedAtMs: nowMs,
    offsetMinutes: 0,
  });
}

const NOW_SECONDS = Math.floor(Date.parse(EVENT.created_at) / 1000);
const NOW_MS = NOW_SECONDS * 1000;

describe('PF-578 — the three failures p.4 names, each visibly a failure', () => {
  it('a TAMPERED body: INVALID, and the check that failed is named', () => {
    // Signed correctly over one body, delivered with another. This is the
    // forgery the signature exists to catch.
    const header = sign(BODY, SECRET, NOW_SECONDS);
    const tampered = BODY.replace('hello', 'goodbye');
    const lines = block({ [SIGNATURE_HEADER]: header }, tampered, NOW_MS);

    expect(lines.join('\n')).toContain('signature INVALID ✗');
    expect(lines.join('\n')).toContain('body does not match the signature');
    expect(lines.join('\n')).not.toContain('verified ✓');
  });

  it('a STALE timestamp: INVALID, and the tolerance is named', () => {
    const staleSeconds = NOW_SECONDS - (DEFAULT_TOLERANCE_SECONDS + 60);
    const header = sign(BODY, SECRET, staleSeconds);
    const lines = block({ [SIGNATURE_HEADER]: header }, BODY, NOW_MS);

    expect(lines.join('\n')).toContain('signature INVALID ✗');
    expect(lines.join('\n')).toContain(`${DEFAULT_TOLERANCE_SECONDS}s tolerance`);
    expect(lines.join('\n')).not.toContain('verified ✓');
  });

  it('a header with NO v1: INVALID, and says the digest is missing', () => {
    const lines = block({ [SIGNATURE_HEADER]: `t=${NOW_SECONDS}` }, BODY, NOW_MS);

    expect(lines.join('\n')).toContain('signature INVALID ✗');
    expect(lines.join('\n')).toContain('no v1= digest');
    expect(lines.join('\n')).not.toContain('verified ✓');
  });

  it('no signature header at all: INVALID, not "verified by omission"', () => {
    const lines = block({}, BODY, NOW_MS);
    expect(lines.join('\n')).toContain('signature INVALID ✗');
    expect(lines.join('\n')).toContain(`no ${SIGNATURE_HEADER} header`);
  });

  it('an invalid block is a DIFFERENT SHAPE from a valid one, and still fits 80 columns', () => {
    const good = block({ [SIGNATURE_HEADER]: sign(BODY, SECRET, NOW_SECONDS) }, BODY, NOW_MS);
    const bad = block({ [SIGNATURE_HEADER]: sign(BODY, 'wrong-secret', NOW_SECONDS) }, BODY, NOW_MS);

    // A screenshot is often greyscale and often cropped, so the difference is
    // structural rather than a colour: `═` and `✗` survive both.
    expect(good[0]).toMatch(/^─+$/);
    expect(bad[0]).toMatch(/^═+$/);
    expect(good.join('\n')).toContain('signature verified ✓');

    for (const line of [...good, ...bad]) {
      expect([...line].length, `over ${MAX_COLUMNS} columns: ${line}`).toBeLessThanOrEqual(
        MAX_COLUMNS,
      );
    }
  });
});

describe('PF-578 — --exit-on-invalid fails the process, so a CI harness can assert on it', () => {
  it('exits EXIT_CODES.signature on the first forged delivery, and still cleans up', async () => {
    const clock = fakeClock(NOW_MS);
    const deleted: string[] = [];

    const stub = await StubShip.start((request) => {
      if (request.path === '/api/v1/webhooks' && request.method === 'POST') {
        return {
          status: 201,
          body: {
            id: 'sub_l19_invalid',
            event: 'document.created',
            target_url: (JSON.parse(request.body) as { target_url: string }).target_url,
            active: true,
            created_at: EVENT.created_at,
            signing_secret: SECRET,
          },
        };
      }
      if (request.path === '/api/v1/webhooks/sub_l19_invalid' && request.method === 'DELETE') {
        deleted.push('sub_l19_invalid');
        return {
          status: 200,
          body: {
            id: 'sub_l19_invalid',
            event: 'document.created',
            target_url: 'http://127.0.0.1:1/ship-cli-tail',
            active: false,
            created_at: EVENT.created_at,
          },
        };
      }
      return undefined;
    }, clock.now);

    // The listener's URL is only knowable from what the command prints, so the
    // sink is the seam: the forged POST is sent the moment `tail` says it is
    // listening. That is also PF-579's ordering property, asserted here in
    // process rather than across a pipe.
    const lines: string[] = [];
    let listening: (url: string) => void = () => undefined;
    const targetUrl = new Promise<string>((resolve) => {
      listening = resolve;
    });
    const sink: OutputSink = {
      out: (line) => lines.push(line),
      err: (line) => {
        lines.push(line);
        const match = line.match(/listening on (http:\/\/127\.0\.0\.1:\d+\/\S+)/);
        if (match?.[1] !== undefined) listening(match[1]);
      },
    };

    try {
      const tail = runWebhooksTail(
        contextDefaults({
          sink,
          clock,
          json: false,
          baseUrl: stub.baseUrl,
          clientId: 'ship_app_grader_demo',
          env: {},
          settings: null,
          credentialsPath: '/nonexistent/.ship/credentials.json',
          tokenStore: {
            load: () =>
              Promise.resolve({
                accessToken: 'access-1',
                refreshToken: null,
                expiresAtSeconds: null,
                scopes: ['webhooks:manage'],
              }),
            save: () => Promise.resolve(),
            clear: () => Promise.resolve(),
          },
        }),
        { listen: true, exitOnInvalid: true, offsetMinutes: 0 },
      );

      const url = await targetUrl;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'evt_0000000000000001',
          // Signed with a secret that is not the subscription's — a forgery.
          [SIGNATURE_HEADER]: sign(BODY, 'not-the-signing-secret', NOW_SECONDS),
        },
        body: BODY,
      });
      expect(response.status).toBe(200);

      const code = await tail;
      expect(code, lines.join('\n')).toBe(EXIT_CODES.signature);
      expect(lines.join('\n')).toContain('signature INVALID ✗');
      // PF-574's cleanup runs on the failure path too — an aborted tail must
      // not leave the subscription it created behind.
      expect(deleted).toEqual(['sub_l19_invalid']);
    } finally {
      await stub.stop();
    }
  });
});
