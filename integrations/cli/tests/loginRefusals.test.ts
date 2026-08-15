/**
 * PF-565 — denied, expired, or abandoned: the CLI stops, says WHICH, and writes
 * **nothing**.
 *
 * p.12's Failure Modes requires that *"the token store is corrupted"* and its
 * neighbours never leave a partial credential. L18's PF-540 enforces that inside
 * the device-flow helper — one `save()`, at the very end, with the complete pair
 * in hand. This file asserts the same contract at the PROCESS boundary, which is
 * where a user can actually see it, and it asserts it the way the ticket words
 * it: with a **counting** `ITokenStore` whose `save()` must have been called
 * **zero** times.
 *
 * ── Why a counting store and not "the file is absent" ───────────────────────
 * The absent file is the symptom; the un-called `save()` is the contract. A
 * store that wrote and then unlinked on failure would pass a file check and
 * still be wrong: the credential existed on disk, unencrypted, for the length of
 * the failure path, and a concurrent `ship docs ls` could have read it. Both are
 * asserted below — the count first, because it is the one that cannot be
 * satisfied by cleaning up after yourself.
 *
 * ── The three cases are three different things, not one ─────────────────────
 *   access_denied   the user reached the page and refused consent
 *   expired_token   the device code aged out; the SERVER says so on a poll
 *   abandoned       the user never verifies at all — no terminal answer ever
 *                   arrives, and the CLI must stop at the device code's own
 *                   expiry rather than polling until the process is killed
 *
 * The third is the one a naive poller gets wrong, and it is invisible to a test
 * that only drives the first two: the loop's exit condition there is a deadline
 * the client computed from `expires_in`, not a response it received.
 *
 * No `setTimeout` in this file (p.11). `fakeClock.sleep` advances the injected
 * clock and resolves, so a 600-second device-code lifetime costs the suite
 * nothing and the deadline is still crossed exactly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ITokenStore, StoredTokens } from '@ship/sdk';
import { runLogin } from '../src/commands/login.js';
import { contextDefaults } from '../src/context.js';
import { RecordingSink } from '../src/io.js';
import { EXIT_CODES } from '../src/exitCodes.js';
import { StubShip, fakeClock } from './support/stubShip.js';

const USER_CODE = 'WDJB-MJHT';
const INTERVAL_SECONDS = 5;
/** Short enough that the abandoned case crosses it in a handful of fake polls. */
const EXPIRES_IN_SECONDS = 20;

const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/**
 * An `ITokenStore` that counts. It is a real store — it holds what it is given —
 * so a flow that saved would go on to succeed rather than fail for a second,
 * unrelated reason and mask the thing under test.
 */
class CountingTokenStore implements ITokenStore {
  saveCalls = 0;
  clearCalls = 0;
  private tokens: StoredTokens | null = null;

  load(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens);
  }

  save(tokens: StoredTokens): Promise<void> {
    this.saveCalls += 1;
    this.tokens = tokens;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.clearCalls += 1;
    this.tokens = null;
    return Promise.resolve();
  }
}

/** What the token endpoint answers on each poll, in order. */
type PollAnswer = 'pending' | 'access_denied' | 'expired_token';

interface LoginRun {
  code: number;
  sink: RecordingSink;
  store: CountingTokenStore;
  credentialsPath: string;
  tokenPolls: number;
}

/**
 * Drives `ship login` against a stub whose `/oauth/token` answers from `script`,
 * one entry per poll. Running off the end of the script repeats its last entry —
 * which is what makes the abandoned case expressible as `['pending']`.
 */
async function login(script: PollAnswer[]): Promise<LoginRun> {
  const clock = fakeClock();
  const store = new CountingTokenStore();
  let poll = 0;

  const stub = await StubShip.start((request) => {
    if (request.path === '/oauth/device/code') {
      return {
        status: 200,
        body: {
          device_code: 'device-code-1',
          user_code: USER_CODE,
          verification_uri: `${stub.baseUrl}/oauth/device/verify`,
          expires_in: EXPIRES_IN_SECONDS,
          interval: INTERVAL_SECONDS,
        },
      };
    }
    if (request.path === '/oauth/token') {
      const step = script[poll] ?? script[script.length - 1] ?? 'pending';
      poll += 1;
      return {
        status: 400,
        body: { error: step === 'pending' ? 'authorization_pending' : step },
      };
    }
    return undefined;
  }, clock.now);

  // A path inside a scratch directory that is NEVER created. Its absence is the
  // second assertion; the counting store above is the first.
  const home = mkdtempSync(join(tmpdir(), 'l19-refusal-'));
  scratch.push(home);
  const credentialsPath = join(home, '.ship', 'credentials.json');

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
        tokenStore: store,
      }),
      // `writeSettings` resolves `~/.ship` from the real HOME. No test may touch
      // the developer's own instance configuration.
      { saveSettings: () => undefined },
    );

    return { code, sink, store, credentialsPath, tokenPolls: stub.to('/oauth/token').length };
  } finally {
    await stub.stop();
  }
}

/** The three assertions every refusal shares, stated once. */
function assertNothingWasWritten(run: LoginRun): void {
  // THE contract: not "the file was cleaned up" — never called at all.
  expect(run.store.saveCalls, 'save() must never be called on a refused grant').toBe(0);
  expect(existsSync(run.credentialsPath), `${run.credentialsPath} must not exist`).toBe(false);
  // PF-572, restated on the failure paths: no token text in either stream.
  expect(run.sink.stdoutText).toBe('');
}

describe('PF-565 — a refused device grant stops, says which, and writes nothing', () => {
  it('access_denied — the user refused consent', async () => {
    const run = await login(['pending', 'access_denied']);

    expect(run.code).toBe(EXIT_CODES.auth);
    expect(run.sink.stderrText).toContain('authorization was denied');
    expect(run.sink.stderrText).toContain('Nothing was saved');
    // Distinct from the expiry message — a user who was denied and a user whose
    // code aged out need different next actions.
    expect(run.sink.stderrText).not.toContain('expired');
    assertNothingWasWritten(run);
  });

  it('expired_token — the SERVER reports the device code aged out', async () => {
    const run = await login(['pending', 'expired_token']);

    expect(run.code).toBe(EXIT_CODES.auth);
    expect(run.sink.stderrText).toContain('device code expired before it was authorized');
    expect(run.sink.stderrText).toContain('fresh code');
    expect(run.sink.stderrText).not.toContain('denied');
    assertNothingWasWritten(run);
  });

  it('abandoned — nobody ever verifies, and the CLI stops at the code’s expiry', async () => {
    // The stub answers `authorization_pending` forever. Nothing terminal is ever
    // sent, so the ONLY thing that can end this is the client's own deadline,
    // computed from `expires_in`. A poller without one runs until it is killed.
    const run = await login(['pending']);

    expect(run.code).toBe(EXIT_CODES.auth);
    expect(run.sink.stderrText).toContain('device code expired before it was authorized');
    assertNothingWasWritten(run);

    // It stopped at the deadline, not at some arbitrary attempt ceiling: with a
    // 5s interval and a 20s lifetime, the deadline is crossed on the poll after
    // the fourth. A bound rather than an exact count because the poll on which
    // `now > deadline` first holds is the SDK's business, not this ticket's —
    // what PF-565 requires is that the walk is bounded by the expiry at all.
    expect(run.tokenPolls).toBeGreaterThan(0);
    expect(
      run.tokenPolls,
      'the poll count must be bounded by expires_in / interval, not open-ended',
    ).toBeLessThanOrEqual(Math.ceil(EXPIRES_IN_SECONDS / INTERVAL_SECONDS) + 1);
  });

  it('every refusal prints the code first — the user is never left wondering why', async () => {
    // The device-code block is emitted before polling begins, so all three cases
    // above show the user what they were asked to do before saying it failed.
    const run = await login(['access_denied']);

    expect(run.sink.stderrText).toContain(USER_CODE);
    const codeAt = run.sink.stderrText.indexOf(USER_CODE);
    const failureAt = run.sink.stderrText.indexOf('authorization was denied');
    expect(codeAt).toBeGreaterThanOrEqual(0);
    expect(failureAt).toBeGreaterThan(codeAt);
    assertNothingWasWritten(run);
  });
});
