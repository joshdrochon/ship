/**
 * PF-567 — an expired access token refreshes silently ONCE; a dead one says
 * `ship login` and stops.
 *
 * Two counting claims, and a count needs a request log the test owns — so this
 * runs against `StubShip` rather than a booted instance. The live half (a real
 * expired credential, refreshed against real Ship, with the rotated pair still
 * on disk afterwards) is `tests/server/refresh.test.ts`; neither file is
 * sufficient alone. This one can count and can revoke a family on demand; that
 * one proves the server actually does it.
 *
 * ── Why "exactly one" is the whole ticket ──────────────────────────────────
 * PRD p.3 makes refresh tokens one-time-use with rotation and FAMILY
 * REVOCATION. Two consequences the CLI has to get right, and each is a way to
 * log the user out by trying to be helpful:
 *
 *   - the rotated refresh token must be WRITTEN BACK, or the next command
 *     presents a spent token and the server revokes the family;
 *   - a refresh that failed must not be retried, for the same reason one level
 *     up. One attempt, then `EXIT_CODES.auth` and the words `ship login`.
 *
 * L17's single-flight (PF-509) is what makes the first claim hold under
 * concurrency; this asserts it at the command boundary, where a user can see it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runDocsLs } from '../src/commands/docs.js';
import { contextDefaults } from '../src/context.js';
import { RecordingSink } from '../src/io.js';
import { EXIT_CODES } from '../src/exitCodes.js';
import { StubShip, fakeClock } from './support/stubShip.js';

const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

/** A credential file whose access token expired an hour ago. */
function expiredCredential(nowMs: number): string {
  const home = mkdtempSync(join(tmpdir(), 'l19-refresh-'));
  scratch.push(home);
  const path = join(home, '.ship', 'credentials.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      accessToken: 'access-STALE',
      refreshToken: 'refresh-GEN1',
      expiresAtSeconds: Math.floor(nowMs / 1000) - 3600,
      scopes: ['documents:read'],
    }),
    { mode: 0o600 },
  );
  return path;
}

describe('PF-567 — an expired access token refreshes silently, exactly once', () => {
  it('issues ONE /oauth/token, uses the new access token, and writes the rotation back', async () => {
    const clock = fakeClock();
    const credentialsPath = expiredCredential(clock.now());

    const stub = await StubShip.start((request) => {
      if (request.path === '/oauth/token') {
        // The presented token is the one on disk, and the grant is a refresh.
        if (request.form.get('grant_type') !== 'refresh_token') {
          return { status: 400, body: { error: 'unsupported_grant_type' } };
        }
        if (request.form.get('refresh_token') !== 'refresh-GEN1') {
          return { status: 400, body: { error: 'invalid_grant' } };
        }
        return {
          status: 200,
          body: {
            access_token: 'access-GEN2',
            refresh_token: 'refresh-GEN2',
            expires_in: 3600,
            scope: 'documents:read',
            token_type: 'Bearer',
          },
        };
      }
      if (request.path === '/api/v1/documents') {
        if (request.headers.authorization !== 'Bearer access-GEN2') {
          return {
            status: 401,
            body: {
              error: { type: 'unauthorized', message: 'stale token', request_id: 'stub' },
            },
          };
        }
        return {
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
        };
      }
      return undefined;
    }, clock.now);

    const sink = new RecordingSink();
    try {
      const code = await runDocsLs(
        contextDefaults({
          sink,
          clock,
          json: true,
          baseUrl: stub.baseUrl,
          clientId: 'ship_app_grader_demo',
          env: {},
          settings: null,
          credentialsPath,
        }),
        {},
      );

      expect(code, sink.allText).toBe(EXIT_CODES.success);
      // SILENTLY: the refresh is not something a user has to read about.
      expect(sink.stderrText).not.toMatch(/refresh/i);
      expect(JSON.parse(sink.stdoutText)).toHaveLength(1);

      // EXACTLY ONE. A second exchange presents a token the server has already
      // spent, and p.3's answer to that is to revoke the whole family.
      expect(stub.to('/oauth/token')).toHaveLength(1);
      expect(stub.to('/api/v1/documents')).toHaveLength(1);

      // The rotation is on disk, so the NEXT process is still authenticated.
      const stored = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>;
      expect(stored.refreshToken).toBe('refresh-GEN2');
      expect(stored.accessToken).toBe('access-GEN2');

      // PF-572 holds on this path too.
      expect(sink.allText).not.toContain('refresh-GEN2');
      expect(sink.allText).not.toContain('access-GEN2');
    } finally {
      await stub.stop();
    }
  });

  it('a revoked family: ONE attempt, exit 3, and the message names `ship login`', async () => {
    const clock = fakeClock();
    const credentialsPath = expiredCredential(clock.now());
    const before = readFileSync(credentialsPath, 'utf8');

    const stub = await StubShip.start((request) => {
      if (request.path === '/oauth/token') {
        // What L06 answers once a family has been revoked (p.3).
        return {
          status: 400,
          body: {
            error: 'invalid_grant',
            error_description: 'The refresh token family has been revoked.',
          },
        };
      }
      return undefined;
    }, clock.now);

    const sink = new RecordingSink();
    try {
      const code = await runDocsLs(
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
        {},
      );

      expect(code, sink.allText).toBe(EXIT_CODES.auth);
      expect(sink.stderrText).toContain('ship login');
      // One attempt, and NO request to the resource: a client that hammers a
      // token endpoint which has already said no is how the family got revoked.
      expect(stub.to('/oauth/token')).toHaveLength(1);
      expect(stub.to('/api/v1/documents')).toHaveLength(0);

      // Nothing written back. A credential the server rejected may still be one
      // a human can look at; erasing it is the less recoverable choice.
      expect(readFileSync(credentialsPath, 'utf8')).toBe(before);
    } finally {
      await stub.stop();
    }
  });
});
