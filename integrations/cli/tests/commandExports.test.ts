/**
 * PF-581 — every command is an importable function, so L20's drill drives the
 * CLI without scraping a terminal.
 *
 * p.7 puts the example TTFE drill at `integrations/cli/tests/ttfe.drill.ts` —
 * inside this package, but written by L20. If the drill had to re-implement
 * `runLogin` it would be timing a code path the demo does not run, and it would
 * drift the first time this lane changed anything. So the acceptance criterion
 * is structural: five exported functions, typed arguments, an injectable output
 * sink and an injectable clock, and `src/index.ts` reduced to argv parsing and
 * dispatch.
 *
 * Two halves, and both are needed:
 *
 *   1. Every one of the five RUNS here — against a stub Ship, with a recording
 *      sink and a fake clock — with `process.argv` untouched. A function that
 *      only *looks* injectable still fails the drill.
 *   2. No file under `src/commands/`, `src/run.ts` or `src/render/` touches
 *      `process` at all. `src/index.ts` is the one file that may, and that
 *      separation is the whole of the "no business logic in index.ts" clause.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDocsCreate,
  runDocsGet,
  runDocsLs,
  runLogin,
  runWebhooksTail,
  contextDefaults,
  RecordingSink,
  EXIT_CODES,
  type CommandContext,
} from '../src/public.js';
import { StubShip, fakeClock } from './support/stubShip.js';
import { readSources } from './support/source.js';

const DOCUMENT = {
  id: '00000000-0000-4000-8000-000000000001',
  document_type: 'wiki',
  title: 'hello',
  parent_id: null,
  created_at: '2026-08-15T00:00:00.000Z',
  updated_at: '2026-08-15T00:00:00.000Z',
  created_by: null,
};

/** A stub answering everything the five commands ask of a Ship. */
function stubHandler(): Parameters<typeof StubShip.start>[0] {
  return (request) => {
    switch (`${request.method} ${request.path}`) {
      case 'POST /oauth/device/code':
        return {
          status: 200,
          body: {
            device_code: 'device-1',
            user_code: 'WDJB-MJHT',
            verification_uri: 'http://127.0.0.1/oauth/device/verify',
            expires_in: 600,
            interval: 5,
          },
        };
      case 'POST /oauth/token':
        return {
          status: 200,
          body: {
            access_token: 'access-1',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            scope: 'documents:read documents:write webhooks:manage',
            token_type: 'Bearer',
          },
        };
      case 'GET /api/v1/documents':
        return { status: 200, body: { data: [DOCUMENT], next_cursor: null } };
      case 'POST /api/v1/documents':
        return { status: 201, body: DOCUMENT };
      case `GET /api/v1/documents/${DOCUMENT.id}`:
        return { status: 200, body: DOCUMENT };
      case 'GET /api/v1/webhooks':
        return { status: 200, body: { data: [], next_cursor: null } };
      default:
        return undefined;
    }
  };
}

describe('PF-581 — the five commands are functions, and they run with process.argv untouched', () => {
  it('runLogin · runDocsLs · runDocsGet · runDocsCreate · runWebhooksTail', async () => {
    const clock = fakeClock();
    const stub = await StubShip.start(stubHandler(), clock.now);
    const home = mkdtempSync(join(tmpdir(), 'l19-exports-'));

    // The exact argv this process was started with. Not a length check: a
    // command that pushed and popped would pass that.
    const argvBefore = JSON.stringify(process.argv);

    const context = (sink: RecordingSink): CommandContext =>
      contextDefaults({
        sink,
        clock,
        json: true,
        baseUrl: stub.baseUrl,
        clientId: 'ship_app_grader_demo',
        env: {},
        settings: null,
        credentialsPath: join(home, '.ship', 'credentials.json'),
      });

    try {
      const loginSink = new RecordingSink();
      expect(
        await runLogin(context(loginSink), { saveSettings: () => undefined }),
        loginSink.allText,
      ).toBe(EXIT_CODES.success);

      const lsSink = new RecordingSink();
      expect(await runDocsLs(context(lsSink), {}), lsSink.allText).toBe(EXIT_CODES.success);
      expect(JSON.parse(lsSink.stdoutText)).toHaveLength(1);

      const getSink = new RecordingSink();
      expect(await runDocsGet(context(getSink), DOCUMENT.id), getSink.allText).toBe(
        EXIT_CODES.success,
      );

      const createSink = new RecordingSink();
      expect(
        await runDocsCreate(context(createSink), { title: 'hello' }),
        createSink.allText,
      ).toBe(EXIT_CODES.success);

      // `--cleanup` is the one `webhooks tail` mode that terminates on its own;
      // the other two are driven in `tailInvalid.test.ts` and against real Ship.
      const tailSink = new RecordingSink();
      expect(
        await runWebhooksTail(context(tailSink), { cleanup: true }),
        tailSink.allText,
      ).toBe(EXIT_CODES.success);

      expect(JSON.stringify(process.argv), 'a command read or edited process.argv').toBe(
        argvBefore,
      );
    } finally {
      await stub.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('PF-581 — the process belongs to src/index.ts and the sink to src/io.ts', () => {
  it('no command, dispatcher or renderer references `process` at all', () => {
    const offenders = readSources()
      .filter(
        (file) =>
          file.relative.startsWith('src/commands/') ||
          file.relative.startsWith('src/render/') ||
          file.relative === 'src/run.ts',
      )
      .filter((file) => /\bprocess\s*\./.test(file.code))
      .map((file) => file.relative);

    expect(
      offenders,
      'a command that reads the process cannot be driven by L20’s drill',
    ).toEqual([]);
  });

  it('argv and the exit code are read in exactly one file, and it is src/index.ts', () => {
    const offenders = readSources()
      .filter((file) => /process\s*\.\s*(argv|exit)/.test(file.code))
      .map((file) => file.relative);
    expect(offenders).toEqual(['src/index.ts']);
  });

  it('the real stdout and stderr are written in exactly one file, and it is src/io.ts', () => {
    // `processSink` is the ONE place a stream is written. Everything upstream of
    // it holds an `OutputSink`, which is what makes PF-571's stream separation
    // and PF-572's leak assertion in-process assertions rather than
    // subprocess-capture exercises.
    const offenders = readSources()
      .filter((file) => /process\s*\.\s*(stdout|stderr)/.test(file.code))
      .map((file) => file.relative);
    expect(offenders).toEqual(['src/index.ts', 'src/io.ts']);
  });

  it('no command writes to the console', () => {
    const offenders = readSources()
      .filter((file) => /\bconsole\./.test(file.code))
      .map((file) => file.relative);
    expect(offenders).toEqual([]);
  });
});
