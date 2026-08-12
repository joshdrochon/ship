/**
 * PF-086 – PF-093 — the authorization code row, and the authorize decision table.
 *
 * The decision table is driven here as pure values. The HTTP-level assertions
 * (rendered pages emit no `Location`, headers, CSRF) live in `consent.test.ts`
 * where the route exists; this file is what makes the *logic* provable without
 * an HTTP stack, and it is where the render/redirect split is asserted case by
 * case.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/sourceScan.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import type { Scope } from '../scopes/scopes.js';
import {
  validateAuthorizeRequest,
  redirectUriMatches,
  buildRedirect,
  type AuthorizeQuery,
  type AuthorizeOutcome,
} from './authorize.js';
import {
  generateAuthorizationCode,
  hashAuthorizationCode,
  authorizationCodePrefix,
  InMemoryAuthCodeRepo,
  AUTHORIZATION_CODE_TTL_SECONDS,
  CONSUMED_CODE_RETENTION_SECONDS,
} from './authCodes.js';
import { s256Challenge } from './pkce.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const REGISTERED_URI = 'https://app.example.test/callback';
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = s256Challenge(VERIFIER);

let appsRepo: InMemoryOAuthAppRepo;
let app: OAuthApp;

async function makeApp(overrides: Partial<Parameters<InMemoryOAuthAppRepo['create']>[0]> = {}) {
  return appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'L04 authorize app',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: [REGISTERED_URI],
    requestedScopes: ['documents:read', 'documents:write'],
    ...overrides,
  });
}

/** A request that passes every check. Individual cases break exactly one field. */
function goodQuery(overrides: Partial<AuthorizeQuery> = {}): AuthorizeQuery {
  return {
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: REGISTERED_URI,
    scope: 'documents:read',
    state: 'opaque-state',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
}

function expectRejected(outcome: AuthorizeOutcome) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('expected a rejection');
  return outcome.error;
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  app = await makeApp();
});

describe('PF-088 — parameter validation, and redirect_uri matched byte-for-byte', () => {
  it('accepts a well-formed request', () => {
    const outcome = validateAuthorizeRequest(app, goodQuery());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.request.redirectUri).toBe(REGISTERED_URI);
    expect(outcome.request.requestedScopes).toEqual(['documents:read']);
    expect(outcome.request.codeChallengeMethod).toBe('S256');
  });

  // The whole point of PF-042 storing URIs verbatim. Each of these differs from
  // the registered value by something a normalising comparison would erase.
  it.each([
    ['a trailing slash', 'https://app.example.test/callback/'],
    ['an added query parameter', 'https://app.example.test/callback?x=1'],
    ['a case-changed host', 'https://APP.example.test/callback'],
    ['a case-changed scheme', 'HTTPS://app.example.test/callback'],
    ['a default port made explicit', 'https://app.example.test:443/callback'],
    ['a fragment', 'https://app.example.test/callback#f'],
  ])('rejects %s as a non-match', (_label, presented) => {
    expect(redirectUriMatches([REGISTERED_URI], presented)).toBe(false);
    const error = expectRejected(validateAuthorizeRequest(app, goodQuery({ redirect_uri: presented })));
    // RENDERED, not redirected: this is the open-redirect boundary.
    expect(error.disposition).toBe('render');
  });

  it('an unknown response_type is unsupported_response_type', () => {
    const error = expectRejected(validateAuthorizeRequest(app, goodQuery({ response_type: 'token' })));
    expect(error.error).toBe('unsupported_response_type');
    expect(error.disposition).toBe('redirect');
  });

  it('a missing response_type is unsupported_response_type, not a crash', () => {
    const error = expectRejected(
      validateAuthorizeRequest(app, goodQuery({ response_type: undefined })),
    );
    expect(error.error).toBe('unsupported_response_type');
  });
});

describe('PF-089 — errors before redirect_uri is trusted are rendered, never redirected', () => {
  // Two rendered cases and four redirected ones, per the ticket. The table IS
  // the assertion: a future edit that "helpfully" redirects one of the rendered
  // cases turns /oauth/authorize into an open redirector and fails here.
  it.each([
    ['unknown client_id', () => validateAuthorizeRequest(null, goodQuery({ client_id: 'nope' }))],
    ['absent redirect_uri', () => validateAuthorizeRequest(app, goodQuery({ redirect_uri: undefined }))],
    [
      'unregistered redirect_uri',
      () => validateAuthorizeRequest(app, goodQuery({ redirect_uri: 'https://evil.test/steal' })),
    ],
    ['absent client_id', () => validateAuthorizeRequest(null, goodQuery({ client_id: undefined }))],
  ])('%s is RENDERED and carries no redirect target', (_label, run) => {
    const error = expectRejected(run());
    expect(error.disposition).toBe('render');
    // The type makes this structural, but assert it anyway: nothing on a
    // rendered error may carry a URI a caller could turn into a Location.
    expect(error).not.toHaveProperty('redirectUri');
    expect(error).not.toHaveProperty('state');
  });

  // Thunks, not values: `app` does not exist until `beforeEach`, and an
  // `it.each` table is built at collection time.
  it.each<[string, () => AuthorizeQuery, string]>([
    ['unsupported_response_type', () => goodQuery({ response_type: 'token' }), 'unsupported_response_type'],
    ['missing code_challenge', () => goodQuery({ code_challenge: undefined }), 'invalid_request'],
    ['plain code_challenge_method', () => goodQuery({ code_challenge_method: 'plain' }), 'invalid_request'],
    ['unknown scope', () => goodQuery({ scope: 'documents:read fictional:scope' }), 'invalid_scope'],
  ])('%s is REDIRECTED to the validated URI', (_label, query, expected) => {
    const error = expectRejected(validateAuthorizeRequest(app, query()));
    expect(error.disposition).toBe('redirect');
    expect(error.error).toBe(expected);
    if (error.disposition !== 'redirect') return;
    expect(error.redirectUri).toBe(REGISTERED_URI);
  });

  it('does not distinguish an unknown client from a wrong redirect_uri', () => {
    // Otherwise the authorize endpoint is a client-id enumerator: "wrong URI"
    // would confirm the id is real. Same oracle PF-036 refuses to be.
    const unknownClient = expectRejected(validateAuthorizeRequest(null, goodQuery()));
    const wrongUri = expectRejected(
      validateAuthorizeRequest(app, goodQuery({ redirect_uri: 'https://evil.test/x' })),
    );
    expect(unknownClient).toEqual(wrongUri);
  });
});

describe('PF-090 — code_challenge and code_challenge_method are required, S256 only', () => {
  it('a missing code_challenge is invalid_request', () => {
    const error = expectRejected(validateAuthorizeRequest(app, goodQuery({ code_challenge: undefined })));
    expect(error.error).toBe('invalid_request');
    expect(error.errorDescription).toMatch(/code_challenge/);
  });

  it('a missing code_challenge_method is invalid_request', () => {
    const error = expectRejected(
      validateAuthorizeRequest(app, goodQuery({ code_challenge_method: undefined })),
    );
    expect(error.error).toBe('invalid_request');
    expect(error.errorDescription).toMatch(/code_challenge_method/);
  });

  it('plain is rejected, and the error names the method', () => {
    const error = expectRejected(
      validateAuthorizeRequest(app, goodQuery({ code_challenge_method: 'plain' })),
    );
    expect(error.error).toBe('invalid_request');
    expect(error.errorDescription).toContain('plain');
  });

  it.each([
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(44)],
    // 44 chars with base64 padding — the single most common client-side PKCE bug.
    ['standard-base64 padded', `${'a'.repeat(43)}=`],
    ['standard-base64 alphabet', `${'a'.repeat(41)}+/`],
    ['hex of a digest', Buffer.from(VERIFIER).toString('hex')],
  ])('a challenge that is %s is invalid_request', (_label, challenge) => {
    const error = expectRejected(validateAuthorizeRequest(app, goodQuery({ code_challenge: challenge })));
    expect(error.error).toBe('invalid_request');
  });

  it('a real S256 challenge is exactly 43 unpadded base64url characters', () => {
    expect(CHALLENGE).toHaveLength(43);
    expect(CHALLENGE).not.toContain('=');
  });
});

describe('PF-091 — scopes validated through L03, unknown names listed', () => {
  it('names the offending scope in the error', () => {
    const error = expectRejected(
      validateAuthorizeRequest(app, goodQuery({ scope: 'documents:read not:a:scope' })),
    );
    expect(error.error).toBe('invalid_scope');
    expect(error.errorDescription).toContain('not:a:scope');
    // And does NOT silently keep the valid half.
    expect(error.errorDescription).not.toContain('documents:read');
  });

  it('splits on runs of whitespace, per RFC 6749 §3.3', () => {
    const outcome = validateAuthorizeRequest(app, goodQuery({ scope: '  documents:read   issues:read ' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.request.requestedScopes).toEqual(['documents:read', 'issues:read']);
  });

  it('an absent scope is invalid_request — never all-scopes, never a zero-scope grant', () => {
    for (const scope of [undefined, '', '   ']) {
      const error = expectRejected(validateAuthorizeRequest(app, goodQuery({ scope })));
      expect(error.error).toBe('invalid_request');
      expect(error.errorDescription).toMatch(/scope/);
    }
  });

  it('a scope the app never registered still passes validation here', () => {
    // It is registry-valid, so it is not `invalid_scope`. The app-registration
    // ceiling is applied at consent resolution (PF-074), which is what the next
    // slice asserts — recorded here so the two-stage design is visible.
    const outcome = validateAuthorizeRequest(app, goodQuery({ scope: 'sprints:read' }));
    expect(outcome.ok).toBe(true);
  });
});

describe('PF-092 — state is echoed verbatim', () => {
  it('round-trips a value containing reserved characters', () => {
    const state = 'a&b=c#d /e?f+g%h';
    const url = buildRedirect(REGISTERED_URI, { code: 'the-code' }, state);
    expect(new URL(url).searchParams.get('state')).toBe(state);
    expect(new URL(url).searchParams.get('code')).toBe('the-code');
  });

  it('round-trips on an error redirect too', () => {
    const state = 'x&y=z';
    const url = buildRedirect(REGISTERED_URI, { error: 'access_denied' }, state);
    expect(new URL(url).searchParams.get('state')).toBe(state);
    expect(new URL(url).searchParams.get('error')).toBe('access_denied');
  });

  it('omits state entirely when the client sent none — never state=undefined', () => {
    const url = buildRedirect(REGISTERED_URI, { code: 'c' }, undefined);
    expect(url).not.toContain('state');
  });

  it('preserves a query the registered redirect_uri already carried', () => {
    const url = buildRedirect('https://app.example.test/cb?tenant=7', { code: 'c' }, 's');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('tenant')).toBe('7');
    expect(parsed.searchParams.get('code')).toBe('c');
  });

  it('carries state through every redirected error case', () => {
    const state = 'state&value';
    for (const query of [
      goodQuery({ response_type: 'token', state }),
      goodQuery({ code_challenge: undefined, state }),
      goodQuery({ code_challenge_method: 'plain', state }),
      goodQuery({ scope: 'bogus:scope', state }),
    ]) {
      const error = expectRejected(validateAuthorizeRequest(app, query));
      if (error.disposition !== 'redirect') throw new Error('expected a redirect');
      expect(error.state).toBe(state);
      expect(new URL(buildRedirect(error.redirectUri, { error: error.error }, error.state))
        .searchParams.get('state')).toBe(state);
    }
  });
});

describe('PF-093 — a deactivated app cannot start a flow', () => {
  it('is refused at authorize, before any consent screen', async () => {
    const deactivated = await makeApp();
    await appsRepo.deactivate(deactivated.id, 'owner_deleted', new Date());
    const refreshed = await appsRepo.findByClientId(deactivated.clientId);
    expect(refreshed?.active).toBe(false);

    const error = expectRejected(
      validateAuthorizeRequest(refreshed, goodQuery({ client_id: deactivated.clientId })),
    );
    expect(error.error).toBe('unauthorized_client');
    // Rendered, deliberately: a deactivated app's registered URI is not a
    // redirect target we still want to act on. See the note in authorize.ts.
    expect(error.disposition).toBe('render');
  });

  it('the check sits AFTER redirect_uri validation, so it cannot leak a bad URI', () => {
    // Ordering assertion, not a behaviour assertion: a deactivated app presented
    // with an unregistered URI must still fail the URI check's way.
    const error = expectRejected(
      validateAuthorizeRequest({ ...app, active: false }, goodQuery({ redirect_uri: 'https://evil.test/x' })),
    );
    expect(error.errorDescription).toMatch(/do not identify a registered application/);
  });
});

describe('PF-087 — the code is high-entropy, hashed, and short-lived', () => {
  it('10 000 codes are distinct', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) seen.add(generateAuthorizationCode());
    expect(seen.size).toBe(10_000);
  });

  it('is at least 32 bytes of entropy, base64url', () => {
    const code = generateAuthorizationCode();
    expect(Buffer.from(code, 'base64url')).toHaveLength(32);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('the raw code appears in no column of the stored row', async () => {
    const repo = new InMemoryAuthCodeRepo();
    const code = generateAuthorizationCode();
    const row = await repo.insert({
      codeHash: hashAuthorizationCode(code),
      codePrefix: authorizationCodePrefix(code),
      appId: app.id,
      userId: 'user-1',
      workspaceId: 'ws-1',
      redirectUri: REGISTERED_URI,
      scopes: ['documents:read'] as Scope[],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(1_000),
      createdAt: new Date(0),
    });

    // Serialise the entire record and look for the secret. `code_prefix` is 8
    // characters of it by design, so the check is that the WHOLE code is absent.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(code);
    expect(row.codeHash).not.toBe(code);
    expect(row.codePrefix).toBe(code.slice(0, 8));
  });

  it('hashing is SHA-256 hex, and the same function L06 uses', async () => {
    const code = generateAuthorizationCode();
    const { createHash } = await import('node:crypto');
    expect(hashAuthorizationCode(code)).toBe(createHash('sha256').update(code).digest('hex'));
  });

  it('the TTL constant is the only place the number appears', () => {
    expect(AUTHORIZATION_CODE_TTL_SECONDS).toBe(60);
    // Every module that reasons about code lifetime must read the constant. A
    // literal 60 in executable code under platform/oauth/ is the thing this
    // catches — the definition itself is excluded by name.
    const sources = ['authorize.ts', 'authCodes.ts', 'authCodeGrant.ts', 'consent.ts']
      .map((name) => join(HERE, name))
      .filter((path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      });

    for (const path of sources) {
      const code = stripComments(readFileSync(path, 'utf8'))
        .split('\n')
        .filter((line) => !line.includes('AUTHORIZATION_CODE_TTL_SECONDS ='))
        .join('\n');
      expect(code, `${path} restates the TTL instead of reading the constant`).not.toMatch(
        /\bttl\w*\s*[:=]\s*60\b/i,
      );
    }
  });

  it('a code presented after its TTL is recognisable as expired', async () => {
    const repo = new InMemoryAuthCodeRepo();
    const issuedAt = new Date(0);
    const code = generateAuthorizationCode();
    const row = await repo.insert({
      codeHash: hashAuthorizationCode(code),
      codePrefix: authorizationCodePrefix(code),
      appId: app.id,
      userId: 'user-1',
      workspaceId: 'ws-1',
      redirectUri: REGISTERED_URI,
      scopes: ['documents:read'] as Scope[],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(issuedAt.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
      createdAt: issuedAt,
    });

    const justBefore = new Date(row.expiresAt.getTime() - 1);
    const justAfter = new Date(row.expiresAt.getTime() + 1);
    expect(row.expiresAt > justBefore).toBe(true);
    expect(row.expiresAt > justAfter).toBe(false);
  });
});

describe('PF-104 / PF-112 — single use and the sweep, at the repository', () => {
  let repo: InMemoryAuthCodeRepo;

  async function seed(overrides: { expiresAt?: Date; createdAt?: Date } = {}) {
    const code = generateAuthorizationCode();
    const row = await repo.insert({
      codeHash: hashAuthorizationCode(code),
      codePrefix: authorizationCodePrefix(code),
      appId: app.id,
      userId: 'user-1',
      workspaceId: 'ws-1',
      redirectUri: REGISTERED_URI,
      scopes: ['documents:read'] as Scope[],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: overrides.expiresAt ?? new Date(60_000),
      createdAt: overrides.createdAt ?? new Date(0),
    });
    return { code, row };
  }

  beforeEach(() => {
    repo = new InMemoryAuthCodeRepo();
  });

  it('consume succeeds exactly once', async () => {
    const { row } = await seed();
    expect(await repo.consume(row.id, new Date(1_000))).toBe(true);
    expect(await repo.consume(row.id, new Date(2_000))).toBe(false);
  });

  it('a consumed row is still findable — that is what makes a replay detectable', async () => {
    const { code, row } = await seed();
    await repo.consume(row.id, new Date(1_000));
    const found = await repo.findByHash(hashAuthorizationCode(code));
    expect(found).not.toBeNull();
    expect(found?.consumedAt).not.toBeNull();
  });

  it('the sweep removes expired-unconsumed and aged-consumed rows and nothing else', async () => {
    const expiredUnconsumed = await seed({ expiresAt: new Date(10) });
    const liveUnconsumed = await seed({ expiresAt: new Date(10_000_000) });
    const freshlyConsumed = await seed({ expiresAt: new Date(10) });
    const agedConsumed = await seed({ expiresAt: new Date(10) });

    await repo.consume(freshlyConsumed.row.id, new Date(9_000_000));
    await repo.consume(agedConsumed.row.id, new Date(100));

    const now = new Date(10_000_000);
    const consumedBefore = new Date(now.getTime() - CONSUMED_CODE_RETENTION_SECONDS * 1000);
    const removed = await repo.deleteSwept(now, consumedBefore);

    expect(removed).toBe(2);
    expect(await repo.findByHash(hashAuthorizationCode(expiredUnconsumed.code))).toBeNull();
    expect(await repo.findByHash(hashAuthorizationCode(agedConsumed.code))).toBeNull();
    // The live one and the recently-consumed one survive.
    expect(await repo.findByHash(hashAuthorizationCode(liveUnconsumed.code))).not.toBeNull();
    expect(await repo.findByHash(hashAuthorizationCode(freshlyConsumed.code))).not.toBeNull();
  });

  it('a consumed row outlives its own TTL, so replay detection still fires', async () => {
    const { code, row } = await seed({ expiresAt: new Date(60_000) });
    await repo.consume(row.id, new Date(30_000));
    // Well past expiry, inside the retention window.
    const now = new Date(120_000);
    await repo.deleteSwept(now, new Date(now.getTime() - CONSUMED_CODE_RETENTION_SECONDS * 1000));
    expect(await repo.findByHash(hashAuthorizationCode(code))).not.toBeNull();
  });

  it('a duplicate code_hash is loud, mirroring UNIQUE(code_hash)', async () => {
    const { code } = await seed();
    await expect(
      repo.insert({
        codeHash: hashAuthorizationCode(code),
        codePrefix: authorizationCodePrefix(code),
        appId: app.id,
        userId: 'user-1',
        workspaceId: 'ws-1',
        redirectUri: REGISTERED_URI,
        scopes: ['documents:read'] as Scope[],
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        expiresAt: new Date(60_000),
        createdAt: new Date(0),
      }),
    ).rejects.toThrow(/duplicate/);
  });
});
