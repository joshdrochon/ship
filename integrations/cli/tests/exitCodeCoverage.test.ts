/**
 * PF-561 — one test per exit code, each driving a REAL failure and asserting
 * the code the process would exit with.
 *
 * The table in `src/exitCodes.ts` is a published contract: L20's TTFE drill and
 * any CI harness branch on these numbers rather than on `!== 0`, because
 * `!== 0` cannot tell "run `ship login`" from "the signature did not verify"
 * and those two want opposite responses from a harness.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * A frozen table is only a contract if every entry in it is produced by some
 * code path a test drives. Two of the six were not: `unexpected` (1) and
 * `rateLimited` (4) appeared in no test in the package, so nothing would have
 * caught a renderer that quietly returned `usage` for a 429 — and a harness
 * branching on 4 would have waited for a reset window that the CLI never
 * reported. Both are driven below, against a stub that answers with the real
 * statuses.
 *
 * ── The last assertion is the one that keeps this honest ────────────────────
 * `EXIT_CODE_NAMES` is enumerated and every entry must be accounted for. A
 * seventh code added to the table without a test fails THIS test, by name,
 * rather than sitting untested until a harness branches on it. `signature` is
 * the one code driven elsewhere — `tests/tailInvalid.test.ts` needs a forged
 * HMAC and a loopback listener to produce it — so it is declared here as
 * covered-elsewhere rather than silently skipped.
 *
 * No `setTimeout` in this file (p.11): the retry ladder's waits are taken on the
 * injected clock, whose `sleep` advances time and resolves immediately.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDocsLs } from '../src/commands/docs.js';
import { run } from '../src/run.js';
import { contextDefaults } from '../src/context.js';
import { RecordingSink } from '../src/io.js';
import { EXIT_CODES, EXIT_CODE_NAMES, type ExitCodeName } from '../src/exitCodes.js';
import { StubShip, fakeClock, type StubReply } from './support/stubShip.js';

const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/**
 * A credential that is valid and NOT near expiry.
 *
 * `refreshToken: null` deliberately: with one present, the transport answers a
 * 401 by refreshing once and retrying (PF-509), which is a different ticket's
 * behaviour and would turn the `auth` case below into a test of refresh. A
 * public client with no refresh token is also the honest shape for the case
 * being driven — there is nothing left to try, so `ship login` is the remedy.
 */
function credential(nowMs: number): string {
  const home = mkdtempSync(join(tmpdir(), 'l19-exitcodes-'));
  scratch.push(home);
  const path = join(home, '.ship', 'credentials.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      accessToken: 'access-VALID',
      refreshToken: null,
      expiresAtSeconds: Math.floor(nowMs / 1000) + 3600,
      scopes: ['documents:read'],
    }),
    { mode: 0o600 },
  );
  return path;
}

/** Runs `ship docs ls` against a stub that answers `/api/v1/documents` with `reply`. */
async function docsLsAgainst(reply: StubReply): Promise<{ code: number; sink: RecordingSink }> {
  const clock = fakeClock();
  const credentialsPath = credential(clock.now());
  const stub = await StubShip.start(
    (request) => (request.path === '/api/v1/documents' ? reply : undefined),
    clock.now,
  );
  const sink = new RecordingSink();
  try {
    const code = await runDocsLs(
      contextDefaults({
        sink,
        clock,
        json: false,
        baseUrl: stub.baseUrl,
        env: {},
        settings: null,
        credentialsPath,
      }),
    );
    return { code, sink };
  } finally {
    await stub.stop();
  }
}

/** Every code this file drove, so the closing assertion can enumerate them. */
const observed = new Map<ExitCodeName, number>();

describe('PF-561 — every exit code in the frozen table is produced by a real failure', () => {
  it('success (0) — the command did what it was asked', async () => {
    const { code, sink } = await docsLsAgainst({
      status: 200,
      body: {
        data: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            document_type: 'wiki',
            title: 'hello',
            parent_id: null,
            created_at: '2026-08-15T00:00:00.000Z',
            updated_at: '2026-08-15T00:00:00.000Z',
            created_by: null,
          },
        ],
        next_cursor: null,
      },
    });

    expect(code).toBe(EXIT_CODES.success);
    expect(sink.stdoutText).toContain('hello');
    observed.set('success', code);
  });

  it('unexpected (1) — a 500 is the CLI’s own "we did not anticipate this"', async () => {
    // p.4's `server` kind. PF-560 says the block prints the `request_id` and
    // NOTHING else: a 500's message is the server's internal wording, and the id
    // is the only thing that makes a support conversation possible.
    const { code, sink } = await docsLsAgainst({
      status: 500,
      // L07's ApiError envelope is FLAT — `{code, message, request_id, details}`.
      // The SDK's `parseErrorBody` requires a top-level `code` and `message` and
      // returns null for anything else, falling back to status-only mapping. A
      // nested `{error: {...}}` here would still exit 1 and would prove nothing
      // about whether the request_id survived the transport (PF-502).
      body: {
        code: 'internal_error',
        message: 'boom',
        request_id: 'req_pf561_server',
      },
    });

    expect(code).toBe(EXIT_CODES.unexpected);
    expect(sink.stderrText).toContain('request_id: req_pf561_server');
    // Never a stack trace in a screenshot deliverable (p.13).
    expect(sink.stderrText).not.toContain('    at ');
    observed.set('unexpected', code);
  });

  it('usage (2) — an unknown command, with usage on STDERR so stdout stays clean', async () => {
    const sink = new RecordingSink();
    const code = await run(['nosuchcommand'], { sink });

    expect(code).toBe(EXIT_CODES.usage);
    expect(sink.stderrText).toContain('unknown command');
    // PF-556: stdout carries nothing, so `--json` consumers never parse usage.
    expect(sink.stdoutText).toBe('');
    observed.set('usage', code);
  });

  it('auth (3) — a 401 says exactly what to run next', async () => {
    const { code, sink } = await docsLsAgainst({
      status: 401,
      body: {
        error: { type: 'unauthorized', message: 'token expired', request_id: 'req_pf561_auth' },
      },
    });

    expect(code).toBe(EXIT_CODES.auth);
    expect(sink.stderrText).toContain('ship login');
    observed.set('auth', code);
  });

  it('rateLimited (4) — a 429 is its own class, not a generic failure', async () => {
    // The distinction the whole table exists for: a harness that sees 4 waits
    // for the reset window, and one that sees 1 or 3 does the wrong thing.
    const resetAtSeconds = Math.floor(fakeClock().now() / 1000) + 42;
    const { code, sink } = await docsLsAgainst({
      status: 429,
      headers: {
        'retry-after': '42',
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetAtSeconds),
      },
      body: {
        error: { type: 'rate_limited', message: 'slow down', request_id: 'req_pf561_429' },
      },
    });

    expect(code).toBe(EXIT_CODES.rateLimited);
    expect(sink.stderrText).toContain('rate limited');
    // The reset is rendered as something a person reads without doing arithmetic.
    expect(sink.stderrText).toContain('Retry-After: 42s.');
    observed.set('rateLimited', code);
  });

  it('accounts for EVERY name in the frozen table — a seventh code fails here', () => {
    // `signature` (5) needs a forged HMAC delivered over a loopback listener, so
    // it is driven in `tests/tailInvalid.test.ts` rather than duplicated here.
    // Naming it is the point: an unaccounted-for code is a failure, not a gap
    // this test quietly tolerates.
    const coveredElsewhere: ExitCodeName[] = ['signature'];

    const unaccounted = EXIT_CODE_NAMES.filter(
      (name) => !observed.has(name) && !coveredElsewhere.includes(name),
    );
    expect(
      unaccounted,
      `exit codes with no test driving them: ${unaccounted.join(', ')}. ` +
        'Add one above, or record where it is driven.',
    ).toEqual([]);

    // And the codes this file drove are the numbers the table publishes — not
    // merely non-zero, which is the assertion PF-561 exists to replace.
    for (const [name, code] of observed) expect(code).toBe(EXIT_CODES[name]);

    // Six distinct numbers, one per failure class. Two entries collapsing onto
    // one number would make the table useless to a harness without breaking any
    // assertion above.
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(EXIT_CODE_NAMES.length);
  });
});
