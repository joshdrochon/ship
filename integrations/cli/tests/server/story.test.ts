/**
 * PRD p.6's five-line developer story, executed end to end against a booted
 * Ship with a real database.
 *
 *     $ ship login                             # device flow
 *     $ ship docs create --title "hello"
 *     $ ship webhooks tail                     # streams signed deliveries
 *     → document.created arrives, signature verified ✓
 *
 * This file is the reason the lane exists. p.12 makes that story the demo video
 * and p.13 makes the `webhooks tail` terminal the Social Post screenshot, so
 * every claim below is graded — and until this suite ran, all of them were
 * assertions about source code that had never been executed.
 *
 * Requires `SHIP_TEST_BASE_URL` and `DATABASE_URL`; see `vitest.server.config.ts`.
 * Run with `pnpm --filter @ship/cli test:server`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_CLIENT_ID,
  approveDeviceGrant,
  baseUrl,
  login,
  makeHome,
  runShip,
  ShipProcess,
  userCodeFrom,
} from './support/harness.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_COLUMNS } from '../../src/render/delivery.js';
import { EXIT_CODES } from '../../src/exitCodes.js';

let home: string;
let dispose: () => void;

/** Everything the CLI printed, all suite long — PF-572 reads this at the end. */
const everythingPrinted: string[] = [];

beforeAll(async () => {
  const scratch = makeHome();
  home = scratch.home;
  dispose = scratch.dispose;

  const proc = await login(home);
  everythingPrinted.push(proc.all);
}, 120_000);

afterAll(() => dispose?.());

describe('p.6 line 2 — ship login', () => {
  it('PF-562: the device flow completes and writes a credential', () => {
    // `login()` in the harness already asserted the process exited; this pins
    // what it SAID, which is what a viewer of the demo video sees.
    const printed = everythingPrinted.join('\n');
    expect(printed).toContain('ship: authenticated.');
    expect(printed).toContain('credentials.json');
  });

  it('PF-563: the user code is on stderr, verbatim, with its grouping hyphen', () => {
    const printed = everythingPrinted.join('\n');
    const code = userCodeFrom(printed);
    // RFC 8628's grouping hyphen survives — the user pastes this into the
    // browser and the SERVER normalises, not us.
    expect(code).toMatch(/^[A-Z0-9]+-[A-Z0-9]+$/);
    expect(printed).toContain(`      ${code}`);
    expect(printed).toContain('To authorize this device, enter the code:');
  });

  it('PF-566: the credential is at ~/.ship/credentials.json, mode 0600', async () => {
    const { statSync } = await import('node:fs');
    const path = join(home, '.ship', 'credentials.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // PF-504: an access-token-only store makes every command a fresh device
    // flow and fails p.8's Auth drill on its second line.
    expect(Object.keys(stored).join(' ')).toMatch(/refresh/i);
  });
});

describe('p.6 line 3 — ship docs create --title "hello"', () => {
  let createdId: string;

  it('PF-568 / PF-562: a NEW process, no flags and no env, creates the document', async () => {
    // The whole point. `--base-url` and `--client-id` are absent, and
    // `cliEnv()` deletes SHIP_BASE_URL/SHIP_CLIENT_ID, so the only way this can
    // work is the instance persisted at login (PF-559's step 3).
    const result = await runShip(['docs', 'create', '--title', 'hello'], home);
    everythingPrinted.push(result.all);

    expect(result.code, result.all).toBe(EXIT_CODES.success);
    // The id alone on stdout, so `ID=$(ship docs create --title x)` works.
    createdId = result.stdout.trim();
    expect(createdId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.stderr).toContain('ship: created');
  });

  it('PF-568: a missing --title is a usage error, never an "Untitled" document', async () => {
    const result = await runShip(['docs', 'create'], home);
    everythingPrinted.push(result.all);
    expect(result.code).toBe(EXIT_CODES.usage);
    expect(result.stderr).toContain('ship docs create --title "hello"');
    expect(result.stdout).toBe('');
  });

  it('PF-569 / PF-571: docs ls --json puts one parseable value on stdout', async () => {
    const result = await runShip(['docs', 'ls', '--json'], home);
    everythingPrinted.push(result.all);
    expect(result.code, result.all).toBe(EXIT_CODES.success);

    const parsed = JSON.parse(result.stdout) as { id: string }[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((d) => d.id)).toContain(createdId);
    // p.4: "Cursors handled internally; consumer code never sees them."
    expect(result.stdout).not.toMatch(/cursor/i);
  });

  it('PF-570: docs get echoes the document, and an unknown id is not_found', async () => {
    const found = await runShip(['docs', 'get', createdId], home);
    everythingPrinted.push(found.all);
    expect(found.code, found.all).toBe(EXIT_CODES.success);
    expect(found.stdout).toContain('hello');
    // PF-570: no output mode prints `content` — the event payloads do not carry
    // it, so a CLI that printed it would show a developer something the webhook
    // they are about to subscribe to will never contain.
    expect(found.stdout).not.toContain('content');

    const missing = await runShip(
      ['docs', 'get', '00000000-0000-4000-8000-00000000dead'],
      home,
    );
    everythingPrinted.push(missing.all);
    expect(missing.code).not.toBe(EXIT_CODES.success);
    // The id is echoed back rather than an opaque failure, and no stack trace.
    expect(missing.stderr).toContain('00000000-0000-4000-8000-00000000dead');
    expect(missing.stderr).not.toContain('    at ');
  });
});

describe('p.6 lines 4 and 5 — ship webhooks tail, the demo moment', () => {
  it('PF-574 / PF-577: a signed delivery arrives and verifies, and the block fits 80 columns', async () => {
    const tail = new ShipProcess(['webhooks', 'tail'], home);
    try {
      await tail.waitFor(
        (all) => all.includes('waiting for a signed delivery'),
        'binding the loopback listener',
      );
      // PF-575's flag is what makes this line reachable at all: without it the
      // instance rejects a `127.0.0.1` target_url with `validation_failed`.
      expect(tail.stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\/ship-cli-tail/);
      expect(tail.stderr).toContain('subscribed to document.created');

      // The event, published by the same binary through the same public API.
      const created = await runShip(['docs', 'create', '--title', 'hello'], home);
      everythingPrinted.push(created.all);
      expect(created.code, created.all).toBe(EXIT_CODES.success);

      await tail.waitFor((all) => all.includes('signature verified'), 'a verified delivery');

      // p.6's fifth line, character for character.
      expect(tail.stdout).toContain('→ document.created event arrives, signature verified ✓');
      expect(tail.stdout).toContain(created.stdout.trim());
      expect(tail.stdout).toContain('idempotency-key');
      expect(tail.stdout).toMatch(/latency\s+\d+ ms {2}event → arrival/);

      // p.13's screenshot must not wrap.
      for (const line of tail.stdout.split('\n')) {
        expect([...line].length, `over ${MAX_COLUMNS} columns: ${line}`).toBeLessThanOrEqual(
          MAX_COLUMNS,
        );
      }

      everythingPrinted.push(tail.all);
    } finally {
      tail.interrupt();
      await tail.exited();
    }

    // PF-574: the subscription this command created is gone. Asserted through
    // the CLI's own `--cleanup`, which finds nothing left to remove.
    const cleanup = await runShip(['webhooks', 'tail', '--cleanup', '--json'], home);
    everythingPrinted.push(cleanup.all);
    expect(cleanup.code, cleanup.all).toBe(EXIT_CODES.success);
    expect(JSON.parse(cleanup.stdout)).toEqual({ removed: 0 });
  }, 120_000);

  it('PF-573: --listen and --poll are refused together', async () => {
    const result = await runShip(['webhooks', 'tail', '--listen', '--poll'], home);
    everythingPrinted.push(result.all);
    expect(result.code).toBe(EXIT_CODES.usage);
    expect(result.stderr).toContain('two different answers to the same problem');
  });
});

describe('PF-565 — a denied grant writes nothing', () => {
  it('exits with EXIT_CODES.auth and leaves the credential file untouched', async () => {
    const scratch = makeHome();
    try {
      const proc = new ShipProcess(
        ['login', '--base-url', baseUrl(), '--client-id', DEMO_CLIENT_ID],
        scratch.home,
      );
      await proc.waitFor((all) => all.includes('device-code-ready'), 'printing a user code');

      const denied = await approveDeviceGrant(userCodeFrom(proc.all), 'deny');
      expect(denied.code, denied.all).toBe(0);

      const code = await proc.exited();
      everythingPrinted.push(proc.all);

      expect(code).toBe(EXIT_CODES.auth);
      expect(proc.stderr).toContain('authorization was denied');
      expect(proc.stderr).toContain('Nothing was saved');

      const { existsSync } = await import('node:fs');
      expect(
        existsSync(join(scratch.home, '.ship', 'credentials.json')),
        'a refused grant must not leave a partial credential (p.12)',
      ).toBe(false);
    } finally {
      scratch.dispose();
    }
  }, 120_000);
});

describe('PF-572 — no command ever prints a token or a signing secret', () => {
  it('the credential on disk appears nowhere in anything the CLI printed', () => {
    // Every command in this file appended to `everythingPrinted`, so this reads
    // the real captured output of a real session — not a re-run with a mock.
    const stored = JSON.parse(
      readFileSync(join(home, '.ship', 'credentials.json'), 'utf8'),
    ) as Record<string, unknown>;

    const secrets = Object.entries(stored)
      .filter(([key]) => /token|secret/i.test(key))
      .map(([, value]) => value)
      .filter((value): value is string => typeof value === 'string' && value.length > 8);

    expect(secrets.length, 'the store should hold an access AND a refresh token').toBeGreaterThan(
      1,
    );

    const printed = everythingPrinted.join('\n');
    for (const secret of secrets) {
      expect(printed).not.toContain(secret);
    }
    // The PATH may be printed; the contents may not.
    expect(printed).toContain('credentials.json');
  });
});
