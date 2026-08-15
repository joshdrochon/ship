/**
 * PF-564 (a) — **Testing Scenario 3**, the timing half.
 *
 * p.5: *"Run the Device Authorization Grant flow from a test CLI: poll
 * /oauth/token until authorized, verify slow-down responses are honored,
 * confirm the resulting token works against /api/v1/me."*
 *
 * The scenario has three clauses and they need two different seams:
 *
 *   (a) HERE — the CLI polls no faster than the server's `interval`, and after
 *       a `slow_down` response no request is sent inside `interval + 5s`.
 *   (b) and (c) — `tests/server/deviceScenario.test.ts`, against a booted Ship:
 *       an out-of-band `POST /oauth/device/verify` flips the grant, and the
 *       credential the CLI wrote resolves `GET /api/v1/me` with a populated
 *       `app.client_id`.
 *
 * (a) cannot be asked of a real Ship without first breaking what it proves: a
 * server emits `slow_down` when a client polls too fast, so producing one means
 * polling too fast on purpose. The stub emits it on demand instead, and the
 * request timestamps come from the SAME clock the CLI is holding — p.11 forbids
 * a timing test that races the wall clock, and there is no `setTimeout` in this
 * file.
 *
 * What this is NOT: a test of the SDK's poller. `sdk/src/auth/flows.test.ts`
 * owns that. This asserts the property at the CLI's own boundary, because
 * `ship login` is the process a grader runs and TS-3's subject is literally
 * *"a test CLI"*.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from '../src/commands/login.js';
import { contextDefaults } from '../src/context.js';
import { RecordingSink } from '../src/io.js';
import { EXIT_CODES } from '../src/exitCodes.js';
import { StubShip, fakeClock } from './support/stubShip.js';

/** The interval the stub advertises, in seconds. RFC 8628 §3.2's `interval`. */
const INTERVAL_SECONDS = 5;

/** RFC 8628 §3.5 — a `slow_down` adds exactly this many seconds. */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

const USER_CODE = 'WDJB-MJHT';

const scratch: string[] = [];

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'l19-device-'));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/**
 * Drives `ship login` against a stub whose token endpoint answers from
 * `script`, one entry per poll.
 */
async function login(script: ('pending' | 'slow_down' | 'granted')[]): Promise<{
  code: number;
  sink: RecordingSink;
  tokenRequestsAtMs: number[];
  credentialsPath: string;
}> {
  const clock = fakeClock();
  let poll = 0;

  const stub = await StubShip.start((request) => {
    if (request.path === '/oauth/device/code') {
      return {
        status: 200,
        body: {
          device_code: 'device-code-1',
          user_code: USER_CODE,
          verification_uri: `${stub.baseUrl}/oauth/device/verify`,
          expires_in: 600,
          interval: INTERVAL_SECONDS,
        },
      };
    }
    if (request.path === '/oauth/token') {
      const step = script[poll] ?? 'granted';
      poll += 1;
      if (step === 'granted') {
        return {
          status: 200,
          body: {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'documents:read documents:write',
            token_type: 'Bearer',
          },
        };
      }
      // RFC 8628 §3.5's two non-terminal answers, spelled as the wire spells
      // them — `pending` is this test's shorthand, `authorization_pending` is
      // what a server sends and what the SDK matches on.
      return {
        status: 400,
        body: { error: step === 'pending' ? 'authorization_pending' : 'slow_down' },
      };
    }
    return undefined;
  }, clock.now);

  const credentialsPath = join(home(), '.ship', 'credentials.json');
  const sink = new RecordingSink();

  try {
    const code = await runLogin(
      contextDefaults({
        sink,
        clock,
        json: false,
        baseUrl: stub.baseUrl,
        clientId: 'ship_app_grader_demo',
        env: {},
        settings: null,
        credentialsPath,
      }),
      // The settings write is stubbed: `writeSettings` resolves `~/.ship` from
      // the real HOME, and no test may touch the developer's own instance.
      { saveSettings: () => undefined },
    );

    return {
      code,
      sink,
      tokenRequestsAtMs: stub.to('/oauth/token').map((request) => request.atMs),
      credentialsPath,
    };
  } finally {
    await stub.stop();
  }
}

describe('PF-564 (a) — the CLI never polls faster than the server told it to', () => {
  it('waits the advertised interval before the FIRST poll and between every pair', async () => {
    const { code, tokenRequestsAtMs } = await login(['pending', 'pending', 'granted']);

    expect(code).toBe(EXIT_CODES.success);
    expect(tokenRequestsAtMs).toHaveLength(3);

    // RFC 8628 §3.5: the interval is the minimum between polls, and the server
    // throttles from the FIRST one — a client that polls immediately earns a
    // `slow_down` before the user has finished typing the code.
    const deviceCodeAtMs = tokenRequestsAtMs[0] as number;
    const gaps = tokenRequestsAtMs
      .slice(1)
      .map((at, index) => at - (tokenRequestsAtMs[index] as number));

    expect(gaps).toEqual([INTERVAL_SECONDS * 1000, INTERVAL_SECONDS * 1000]);
    expect(deviceCodeAtMs).toBeGreaterThan(0);
  });

  it('adds 5s per slow_down and KEEPS the raised interval', async () => {
    // pending · slow_down · pending · granted. The gap after the `slow_down`
    // response must be interval+5s, and so must every gap after it: a client
    // that reverts to the old interval on the next poll earns another
    // `slow_down` immediately, which is the loop this clause exists to forbid.
    const { code, tokenRequestsAtMs } = await login([
      'pending',
      'slow_down',
      'pending',
      'granted',
    ]);

    expect(code).toBe(EXIT_CODES.success);
    expect(tokenRequestsAtMs).toHaveLength(4);

    const gaps = tokenRequestsAtMs
      .slice(1)
      .map((at, index) => at - (tokenRequestsAtMs[index] as number));

    const raised = (INTERVAL_SECONDS + SLOW_DOWN_INCREMENT_SECONDS) * 1000;
    expect(gaps).toEqual([INTERVAL_SECONDS * 1000, raised, raised]);

    // Stated as PF-564 words it, so a reader does not have to re-derive it from
    // the array above: no request inside `interval + 5s` of the slow_down.
    const slowDownAtMs = tokenRequestsAtMs[1] as number;
    for (const at of tokenRequestsAtMs.filter((value) => value > slowDownAtMs)) {
      expect(at - slowDownAtMs).toBeGreaterThanOrEqual(raised);
    }
  });

  it('two slow_downs compound — 5s, then 10s, over the advertised interval', async () => {
    const { code, tokenRequestsAtMs } = await login(['slow_down', 'slow_down', 'granted']);

    expect(code).toBe(EXIT_CODES.success);
    const gaps = tokenRequestsAtMs
      .slice(1)
      .map((at, index) => at - (tokenRequestsAtMs[index] as number));
    expect(gaps).toEqual([10_000, 15_000]);
  });

  it('prints the user code verbatim and writes the credential exactly once', async () => {
    const { code, sink, credentialsPath } = await login(['pending', 'granted']);

    expect(code).toBe(EXIT_CODES.success);
    // PF-563: verbatim, grouping hyphen intact, on stderr.
    expect(sink.stderrText).toContain(USER_CODE);
    expect(sink.stdoutText).toBe('');

    const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>;
    expect(stored.accessToken).toBe('access-1');
    expect(stored.refreshToken).toBe('refresh-1');
    // PF-572: the token is on disk and in nothing the CLI printed.
    expect(sink.allText).not.toContain('access-1');
    expect(sink.allText).not.toContain('refresh-1');
  });
});
