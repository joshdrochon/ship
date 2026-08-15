/**
 * **Testing Scenario 3** (PRD p.5), against a booted Ship, with the real binary.
 *
 *   *"Run the Device Authorization Grant flow from a test CLI: poll
 *   /oauth/token until authorized, verify slow-down responses are honored,
 *   confirm the resulting token works against /api/v1/me."*
 *
 * PF-564 splits into three clauses and this file owns two of them:
 *
 *   (b) an out-of-band `POST /oauth/device/verify` with the printed `user_code`
 *       flips a grant that was pending, and the CLI's NEXT poll succeeds;
 *   (c) the credential the CLI wrote resolves `GET /api/v1/me` with a populated
 *       `app.client_id`.
 *
 * (a) — the interval and `slow_down` timing — is `tests/deviceGrantTiming.test.ts`,
 * because a real server only emits `slow_down` when a client polls too fast, so
 * producing one here would mean first breaking the property under test.
 *
 * PF-567's live half is here too: a credential whose access token has expired
 * is refreshed against the real `/oauth/token`, and the rotated pair is on disk
 * afterwards. The counting claims ("exactly one") are `tests/refresh.test.ts`.
 *
 * The verification is genuinely OUT OF BAND: `scripts/l19-device-approve.ts`
 * runs as a subprocess with its own module graph, drives the two consent POSTs
 * a browser would send, and never touches `oauth_device_codes` directly —
 * flipping that row would make this file green while proving nothing about
 * `/oauth/device/verify`, which is what TS-3 is actually about.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileTokenStore, ShipClient } from '@ship/sdk';
import {
  DEMO_CLIENT_ID,
  approveDeviceGrant,
  baseUrl,
  makeHome,
  runShip,
  ShipProcess,
  userCodeFrom,
} from './support/harness.js';
import { EXIT_CODES } from '../../src/exitCodes.js';

let home: string;
let dispose: () => void;
let credentialsPath: string;

beforeAll(() => {
  const scratch = makeHome();
  home = scratch.home;
  dispose = scratch.dispose;
  credentialsPath = join(home, '.ship', 'credentials.json');
});

afterAll(() => dispose?.());

describe('PF-564 (b) — the grant is pending until a human verifies it', () => {
  it('the CLI waits, /oauth/device/verify flips it, and the next poll succeeds', async () => {
    const proc = new ShipProcess(
      ['login', '--base-url', baseUrl(), '--client-id', DEMO_CLIENT_ID],
      home,
    );

    await proc.waitFor((all) => all.includes('device-code-ready'), 'printing a user code');

    // Still polling: the credential does not exist yet, and the process has not
    // exited. Both halves matter — a CLI that exited 0 here having written
    // nothing is exactly the F121 failure this lane already had once.
    expect(proc.all).not.toContain('ship: authenticated.');

    const userCode = userCodeFrom(proc.all);
    const approved = await approveDeviceGrant(userCode, 'allow');
    expect(approved.code, approved.all).toBe(0);

    const code = await proc.exited();
    expect(code, proc.all).toBe(EXIT_CODES.success);
    expect(proc.stderr).toContain('ship: authenticated.');

    // The token endpoint was polled until it stopped saying pending — the
    // credential is the proof the last poll returned a pair.
    const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
      accessToken: string;
      refreshToken: string | null;
      scopes: string[];
    };
    expect(stored.accessToken).not.toBe('');
    expect(stored.refreshToken).not.toBeNull();
    expect(stored.scopes.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('PF-564 (c) — the resulting token works against /api/v1/me', () => {
  it('resolves /api/v1/me with a populated app.client_id', async () => {
    // Read through the SDK, from the file the CLI wrote. `@ship/sdk` is the
    // only import this package is allowed (p.11) and it is also the honest one:
    // this is exactly what a third-party consumer holding that credential does.
    const client = new ShipClient({
      baseUrl: baseUrl(),
      clientId: DEMO_CLIENT_ID,
      tokenStore: new FileTokenStore({ path: credentialsPath }),
    });

    const me = await client.me();
    expect(me.app.client_id).toBe(DEMO_CLIENT_ID);
    expect(me.app.name).not.toBe('');
    expect(Array.isArray(me.scopes)).toBe(true);
  }, 60_000);
});

describe('PF-567 — an expired access token refreshes silently, against real Ship', () => {
  it('ship docs ls succeeds and the rotated refresh token is written back', async () => {
    const before = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
      accessToken: string;
      refreshToken: string;
      expiresAtSeconds: number;
      scopes: string[];
    };

    // Age the credential rather than waiting an hour for it: the SDK refreshes
    // proactively on `expiresAtSeconds`, so this is the same code path a user
    // hits the morning after logging in.
    writeFileSync(
      credentialsPath,
      JSON.stringify({ ...before, expiresAtSeconds: Math.floor(Date.now() / 1000) - 3600 }),
      { mode: 0o600 },
    );

    const result = await runShip(['docs', 'ls', '--json'], home);
    expect(result.code, result.all).toBe(EXIT_CODES.success);
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true);
    // Silently: nothing about a refresh reaches the terminal...
    expect(result.stderr).not.toMatch(/refresh/i);

    const after = JSON.parse(readFileSync(credentialsPath, 'utf8')) as {
      accessToken: string;
      refreshToken: string;
      expiresAtSeconds: number;
    };

    // ...and the rotation IS on disk. p.3 makes refresh tokens one-time-use, so
    // a CLI that refreshed without persisting the new one logs the user out on
    // the NEXT command — and worse, presents a spent token, which revokes the
    // family.
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.expiresAtSeconds).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // ...and the NEXT process is authenticated from it, with no flags and no env.
    const next = await runShip(['docs', 'ls', '--json'], home);
    expect(next.code, next.all).toBe(EXIT_CODES.success);
    // PF-572 holds across the refresh: neither generation is ever printed.
    const printed = `${result.all}\n${next.all}`;
    for (const secret of [before.refreshToken, after.refreshToken, after.accessToken]) {
      expect(printed).not.toContain(secret);
    }
  }, 120_000);

  it('a dead credential says `ship login` and exits 3', async () => {
    // A refresh token the server has never issued: the same answer a revoked
    // family gets, which is the state p.3's rotation produces on reuse.
    const current = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        ...current,
        accessToken: 'access-that-was-never-issued',
        refreshToken: 'refresh-that-was-never-issued',
        expiresAtSeconds: Math.floor(Date.now() / 1000) - 3600,
      }),
      { mode: 0o600 },
    );

    const result = await runShip(['docs', 'ls'], home);
    expect(result.code, result.all).toBe(EXIT_CODES.auth);
    expect(result.stderr).toContain('ship login');
    expect(result.stderr).not.toContain('    at ');
  }, 60_000);
});
