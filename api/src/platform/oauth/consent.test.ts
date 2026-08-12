/**
 * PF-094 – PF-099 — the consent screen, over real HTTP.
 *
 * The server assembled in `boot()` reproduces the parts of `createApp()` this
 * page actually depends on — `cookieParser`, `express-session` and the SAME
 * `csrf-sync` synchroniser instance — rather than faking them. A fake CSRF
 * middleware here would assert that this lane calls something, which is not the
 * property PF-097 is about; the property is that the real synchroniser rejects a
 * real forged request, and that the bearer skip cannot route around it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type RequestHandler } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { csrfSync } from 'csrf-sync';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, stripComments } from '../../test/sourceScan.js';
import { FakeClock } from '../clock.js';
import { InMemoryOAuthAppRepo, secretMaterial } from '../apps/repo.js';
import { generateClientId, generateClientSecret } from '../apps/secrets.js';
import type { OAuthApp } from '../apps/types.js';
import { ScopeRegistry } from '../scopes/registry.js';
import { SCOPE_DEFINITIONS, scopeRegistry, type Scope } from '../scopes/scopes.js';
import { InMemoryTokenRepo } from './tokenRepo.js';
import { InMemoryAuthCodeRepo } from './authCodes.js';
import { createOAuthRouter } from './router.js';
import { DEFAULT_TOKEN_TTL } from './tokens.js';
import { s256Challenge } from './pkce.js';
import type { BrowserUser } from './consent.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REDIRECT_URI = 'https://app.example.test/callback';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = s256Challenge(VERIFIER);
const LOGIN_PATH = '/login';

let appsRepo: InMemoryOAuthAppRepo;
let authCodeRepo: InMemoryAuthCodeRepo;
let clock: FakeClock;
let app: OAuthApp;
let server: Express;
/** What the injected resolver returns. `null` models an anonymous visitor. */
let currentUser: BrowserUser | null;

function boot(options: { registry?: ScopeRegistry<string> } = {}): Express {
  const { csrfSynchronisedProtection, generateToken } = csrfSync({
    // Byte-for-byte the extractor `api/src/app.ts` configures.
    getTokenFromRequest: (req) => req.headers['x-csrf-token'] as string,
  });

  const sessionMiddleware: RequestHandler[] = [
    cookieParser('test-secret'),
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'strict' },
    }),
  ];

  const server = express();
  server.use(
    '/oauth',
    createOAuthRouter({
      appsRepo,
      tokenRepo: new InMemoryTokenRepo(),
      authCodeRepo,
      clock,
      ttl: DEFAULT_TOKEN_TTL,
      ...(options.registry ? { scopeRegistry: options.registry } : {}),
      browser: {
        sessionMiddleware,
        csrfProtection: csrfSynchronisedProtection,
        generateCsrfToken: (req: Request) => generateToken(req),
        resolveBrowserUser: async () => currentUser,
        loginPath: LOGIN_PATH,
      },
    }),
  );
  return server;
}

function authorizeQuery(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: REDIRECT_URI,
    scope: 'documents:read',
    state: 'st&ate',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) if (v !== undefined) params.set(k, v);
  return params.toString();
}

/**
 * Drives the real flow: GET the consent page, scrape its hidden fields and CSRF
 * token, POST the decision on the same session. Scraping rather than
 * constructing the body is deliberate — it proves the page ships a form that
 * actually works, which is the half a hand-built POST would skip.
 */
async function consentFlow(decision: 'allow' | 'deny', query = authorizeQuery()) {
  const agent = request.agent(server);
  const page = await agent.get(`/oauth/authorize?${query}`);
  expect(page.status, page.text.slice(0, 400)).toBe(200);

  const fields: Record<string, string> = {};
  const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(page.text)) !== null) {
    fields[decodeEntities(match[1]!)] = decodeEntities(match[2]!);
  }

  const post = await agent
    .post('/oauth/authorize/decision')
    .type('form')
    .send({ ...fields, decision });

  return { page, post, fields, agent };
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#47;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

beforeEach(async () => {
  appsRepo = new InMemoryOAuthAppRepo();
  authCodeRepo = new InMemoryAuthCodeRepo();
  clock = new FakeClock(1_700_000_000_000);
  app = await appsRepo.create({
    clientId: generateClientId(),
    ...secretMaterial(generateClientSecret()),
    name: 'Acme Deploy Bot',
    ownerUserId: 'user-1',
    workspaceId: 'ws-1',
    redirectUris: [REDIRECT_URI],
    requestedScopes: ['documents:read', 'documents:write'],
  });
  currentUser = { userId: 'user-1', workspaceId: 'ws-1', label: 'dev@ship.local' };
  server = boot();
});

describe('PF-096 — the consent screen refuses to be framed', () => {
  it('GET carries frame-ancestors none, X-Frame-Options DENY and no-store', async () => {
    const res = await request(server).get(`/oauth/authorize?${authorizeQuery()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('POST carries the same three headers', async () => {
    const { post } = await consentFlow('deny');
    expect(post.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(post.headers['x-frame-options']).toBe('DENY');
    expect(post.headers['cache-control']).toBe('no-store');
  });

  it('sets them even on a request that never reaches a route', async () => {
    // Above the parser and above every route, so a malformed or unknown request
    // is protected too.
    const res = await request(server).get('/oauth/authorize/nothing-here');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('the header is set by this lane, not inherited from helmet', () => {
    // ⚑ The repo fact PF-096's note said it would most expect to have drifted,
    // re-checked here rather than in prose: `createApp()` configures helmet with
    // an explicit directives object that names `frameSrc` and NOT
    // `frameAncestors`. Those are different directives — one controls what this
    // page may embed, the other who may embed this page.
    const appSource = readFileSync(join(HERE, '..', '..', 'app.ts'), 'utf8');
    expect(appSource).toMatch(/frameSrc/);
    expect(appSource).not.toMatch(/frameAncestors/);
    // And this lane sets it explicitly.
    expect(stripComments(readFileSync(join(HERE, 'consent.ts'), 'utf8'))).toContain(
      "frame-ancestors 'none'",
    );
  });
});

describe('PF-097 — the consent POST is session + CSRF, and refuses bearer', () => {
  it('rejects a POST with no CSRF token', async () => {
    const res = await request(server)
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ decision: 'allow', client_id: app.clientId });
    expect(res.status).toBe(403);
    expect(authCodeRepo.size()).toBe(0);
  });

  it('rejects a POST carrying a valid session AND a junk bearer header', async () => {
    // L99 F26: `conditionalCsrf` in app.ts skips CSRF whenever a Bearer header
    // is present. This route must not be reachable that way. The request below
    // is otherwise completely valid — same agent, real CSRF token, real form —
    // so the ONLY thing that can reject it is the bearer refusal.
    const agent = request.agent(server);
    const page = await agent.get(`/oauth/authorize?${authorizeQuery()}`);
    const fields: Record<string, string> = {};
    const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(page.text)) !== null) {
      fields[decodeEntities(match[1]!)] = decodeEntities(match[2]!);
    }

    const res = await agent
      .post('/oauth/authorize/decision')
      .set('Authorization', 'Bearer not-a-real-token')
      .type('form')
      .send({ ...fields, decision: 'allow' });

    expect(res.status).toBe(401);
    expect(res.text).toContain('session authentication only');
    expect(authCodeRepo.size()).toBe(0);
  });

  it('the same request without the bearer header succeeds', async () => {
    // The control. Without it the assertion above could be passing for the
    // wrong reason — a broken form, a missing token, anything.
    const { post } = await consentFlow('allow');
    expect(post.status).toBe(302);
    expect(authCodeRepo.size()).toBe(1);
  });

  it('uses the unconditional synchroniser, never conditionalCsrf', () => {
    const source = stripComments(readFileSync(join(HERE, 'consent.ts'), 'utf8'));
    expect(source).toContain('csrfProtection');
    expect(source).not.toContain('conditionalCsrf');
  });
});

describe('PF-095 — the screen names the app and every scope, from the registry', () => {
  it('renders the app name, client_id, redirect_uri and one row per scope', async () => {
    const res = await request(server).get(
      `/oauth/authorize?${authorizeQuery({ scope: 'documents:read documents:write' })}`,
    );
    expect(res.text).toContain('Acme Deploy Bot');
    expect(res.text).toContain(app.clientId);
    expect(res.text).toContain('https:&#47;&#47;app.example.test&#47;callback');
    expect(res.text).toContain(scopeRegistry.get('documents:read')!.description);
    expect(res.text).toContain(scopeRegistry.get('documents:write')!.description);
  });

  it('reads descriptions at render time — a mutated registry renders the new text', async () => {
    const mutated = new ScopeRegistry<string>();
    for (const def of SCOPE_DEFINITIONS) {
      mutated.register(
        def.scope === 'documents:read'
          ? { ...def, description: 'PEEK AT EVERY DOCUMENT YOU OWN' }
          : { ...def },
      );
    }
    server = boot({ registry: mutated });

    const res = await request(server).get(`/oauth/authorize?${authorizeQuery()}`);
    expect(res.text).toContain('PEEK AT EVERY DOCUMENT YOU OWN');
    expect(res.text).not.toContain(scopeRegistry.get('documents:read')!.description);
  });

  it('no scope name and no description literal exists in the consent template', () => {
    // Mirrors L03's PF-070 assertion on require-scope.ts. L03's OCP claim
    // (PF-066 — adding a scope touches only the registration file) is false the
    // moment a second surface hard-codes the list, and a consent screen is the
    // most likely place for that to happen.
    const template = stripComments(readFileSync(join(HERE, 'consentPage.ts'), 'utf8'));
    for (const def of SCOPE_DEFINITIONS) {
      expect(template, `consentPage.ts hard-codes the scope name ${def.scope}`).not.toContain(
        def.scope,
      );
      expect(template, `consentPage.ts hard-codes a scope description`).not.toContain(
        def.description,
      );
    }
  });

  it('escapes every interpolated value', async () => {
    const hostile = await appsRepo.create({
      clientId: generateClientId(),
      ...secretMaterial(generateClientSecret()),
      name: '<script>alert(1)</script>',
      ownerUserId: 'user-1',
      workspaceId: 'ws-1',
      redirectUris: [REDIRECT_URI],
      requestedScopes: ['documents:read'],
    });
    const res = await request(server).get(
      `/oauth/authorize?${authorizeQuery({ client_id: hostile.clientId })}`,
    );
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('ships no client-side JavaScript — PF-110 rests on this', async () => {
    const res = await request(server).get(`/oauth/authorize?${authorizeQuery()}`);
    expect(res.text).not.toMatch(/<script/i);
  });
});

describe('PF-098 — Deny issues no code, and login-in-the-middle keeps the parameters', () => {
  it('Deny redirects with access_denied, the state, and writes no row', async () => {
    const { post } = await consentFlow('deny');
    expect(post.status).toBe(302);
    const location = new URL(post.headers.location as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('st&ate');
    expect(location.searchParams.get('code')).toBeNull();
    // By ROW COUNT, not by the absence of a `code` parameter: an implementation
    // that wrote the row and declined to return it would pass the weaker check.
    expect(authCodeRepo.size()).toBe(0);
  });

  it('a missing decision field is treated as Deny, never as Allow', async () => {
    const agent = request.agent(server);
    const page = await agent.get(`/oauth/authorize?${authorizeQuery()}`);
    const fields: Record<string, string> = {};
    const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(page.text)) !== null) {
      fields[decodeEntities(match[1]!)] = decodeEntities(match[2]!);
    }
    const res = await agent.post('/oauth/authorize/decision').type('form').send(fields);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('access_denied');
    expect(authCodeRepo.size()).toBe(0);
  });

  it('an anonymous visitor is sent to login with every parameter intact', async () => {
    currentUser = null;
    const query = authorizeQuery();
    const res = await request(server).get(`/oauth/authorize?${query}`);
    expect(res.status).toBe(302);

    const location = res.headers.location as string;
    expect(location.startsWith(`${LOGIN_PATH}?returnTo=`)).toBe(true);

    // The classic bug this test exists for: a code_challenge lost on the login
    // round trip. Decode the returnTo and assert every parameter survived.
    const returnTo = decodeURIComponent(location.slice(`${LOGIN_PATH}?returnTo=`.length));
    const returned = new URL(returnTo, 'http://ship.test');
    expect(returned.pathname).toBe('/oauth/authorize');
    expect(returned.searchParams.get('code_challenge')).toBe(CHALLENGE);
    expect(returned.searchParams.get('code_challenge_method')).toBe('S256');
    expect(returned.searchParams.get('state')).toBe('st&ate');
    expect(returned.searchParams.get('scope')).toBe('documents:read');
    expect(returned.searchParams.get('client_id')).toBe(app.clientId);
    expect(returned.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('and completes normally once the user comes back logged in', async () => {
    currentUser = null;
    const res = await request(server).get(`/oauth/authorize?${authorizeQuery()}`);
    const returnTo = decodeURIComponent(
      (res.headers.location as string).slice(`${LOGIN_PATH}?returnTo=`.length),
    );

    currentUser = { userId: 'user-1', workspaceId: 'ws-1' };
    const resumed = await request(server).get(returnTo);
    expect(resumed.status).toBe(200);
    expect(resumed.text).toContain('Acme Deploy Bot');
  });
});

describe('PF-089 over HTTP — a rendered error emits no Location', () => {
  it.each([
    ['unknown client_id', () => authorizeQuery({ client_id: 'nope' })],
    ['unregistered redirect_uri', () => authorizeQuery({ redirect_uri: 'https://evil.test/x' })],
  ])('%s renders on Ship\'s origin', async (_label, query) => {
    const res = await request(server).get(`/oauth/authorize?${query()}`);
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it.each([
    ['unsupported_response_type', () => authorizeQuery({ response_type: 'token' })],
    ['invalid_request on a missing challenge', () => authorizeQuery({ code_challenge: undefined })],
    ['invalid_request on plain', () => authorizeQuery({ code_challenge_method: 'plain' })],
    ['invalid_scope', () => authorizeQuery({ scope: 'not:a:scope' })],
  ])('%s redirects to the validated URI carrying state', async (_label, query) => {
    const res = await request(server).get(`/oauth/authorize?${query()}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('st&ate');
    expect(location.searchParams.get('error')).toBeTruthy();
  });

  it('a deactivated app is refused before any consent screen (PF-093)', async () => {
    await appsRepo.deactivate(app.id, 'admin_action', new Date());
    const res = await request(server).get(`/oauth/authorize?${authorizeQuery()}`);
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.text).toContain('unauthorized_client');
    expect(res.text).not.toContain('Allow');
  });
});

describe('PF-091 — the app registration is a ceiling the consent payload cannot raise', () => {
  it('a scope the app never registered is absent from the code row', async () => {
    // `sprints:read` is registry-valid but this app never registered it. It must
    // not reach the row even though the authorize URL asked for it and the user
    // clicked Allow.
    const { post } = await consentFlow(
      'allow',
      authorizeQuery({ scope: 'documents:read sprints:read' }),
    );
    expect(post.status).toBe(302);
    const rows = await authCodeRepo.findByHash(
      // Recover the row through the code the redirect carried.
      (await import('./authCodes.js')).hashAuthorizationCode(
        new URL(post.headers.location as string).searchParams.get('code')!,
      ),
    );
    expect(rows!.scopes).toEqual(['documents:read']);
  });

  it('the consent screen does not offer a scope the app never registered', async () => {
    const res = await request(server).get(
      `/oauth/authorize?${authorizeQuery({ scope: 'documents:read sprints:read' })}`,
    );
    // Offering it would be a lie: resolveGrantedScopes strips it at issuance, so
    // the user would be consenting to something the token cannot carry.
    expect(res.text).toContain(scopeRegistry.get('documents:read')!.description);
    expect(res.text).not.toContain(scopeRegistry.get('sprints:read')!.description);
  });

  it('a FORGED consent payload cannot widen the grant', async () => {
    // The hidden fields are input, not evidence. Tamper with the scope field
    // after the page was rendered and assert the server re-derives the grant.
    const agent = request.agent(server);
    const page = await agent.get(`/oauth/authorize?${authorizeQuery()}`);
    const fields: Record<string, string> = {};
    const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(page.text)) !== null) {
      fields[decodeEntities(match[1]!)] = decodeEntities(match[2]!);
    }

    const res = await agent
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ ...fields, scope: 'documents:read sprints:read issues:write', decision: 'allow' });

    expect(res.status).toBe(302);
    const code = new URL(res.headers.location as string).searchParams.get('code')!;
    const row = await authCodeRepo.findByHash(
      (await import('./authCodes.js')).hashAuthorizationCode(code),
    );
    expect(row!.scopes).toEqual(['documents:read']);
  });

  it('a forged redirect_uri on the POST is rejected, not honoured', async () => {
    const agent = request.agent(server);
    const page = await agent.get(`/oauth/authorize?${authorizeQuery()}`);
    const fields: Record<string, string> = {};
    const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(page.text)) !== null) {
      fields[decodeEntities(match[1]!)] = decodeEntities(match[2]!);
    }

    const res = await agent
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ ...fields, redirect_uri: 'https://evil.test/steal', decision: 'allow' });

    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(authCodeRepo.size()).toBe(0);
  });
});

describe('PF-099 — D4: scope upgrade is re-consent with union, and no grant state exists', () => {
  it('the upgrade consent lists BOTH scopes and the code carries both', async () => {
    // First grant: read only.
    const first = await consentFlow('allow', authorizeQuery({ scope: 'documents:read' }));
    const firstCode = new URL(first.post.headers.location as string).searchParams.get('code')!;
    const { hashAuthorizationCode } = await import('./authCodes.js');
    expect((await authCodeRepo.findByHash(hashAuthorizationCode(firstCode)))!.scopes).toEqual([
      'documents:read',
    ]);

    // The upgrade: the client restarts authorize asking for the UNION.
    const page = await request(server).get(
      `/oauth/authorize?${authorizeQuery({ scope: 'documents:read documents:write' })}`,
    );
    expect(page.text).toContain(scopeRegistry.get('documents:read')!.description);
    expect(page.text).toContain(scopeRegistry.get('documents:write')!.description);

    const second = await consentFlow(
      'allow',
      authorizeQuery({ scope: 'documents:read documents:write' }),
    );
    const secondCode = new URL(second.post.headers.location as string).searchParams.get('code')!;
    expect((await authCodeRepo.findByHash(hashAuthorizationCode(secondCode)))!.scopes).toEqual([
      'documents:read',
      'documents:write',
    ]);
  });

  it('nothing in this lane reads or updates a prior grant', () => {
    // The property that makes D4 cheap: there is no grant table and no UPDATE
    // against a previous authorization. `consumed_at` is the ONE update this
    // lane performs and it belongs to single-use redemption, not to a grant
    // record — so it is named and excluded rather than pretended away.
    const files = scanTree(HERE).filter((f) => !f.name.endsWith('pgAuthCodeRepo.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(file.code, `${file.name} references a grant table`).not.toMatch(
        /oauth_grants|grant_records/,
      );
    }
    const pg = stripComments(readFileSync(join(HERE, 'pgAuthCodeRepo.ts'), 'utf8'));
    const updates = pg.match(/UPDATE\s+\w+/gi) ?? [];
    expect(updates).toEqual(['UPDATE oauth_authorization_codes']);
    expect(pg).toContain('consumed_at = $2');
  });
});

describe('tenancy — a session in one workspace cannot authorize another workspace’s app', () => {
  it('is refused, rendered, and writes no row', async () => {
    currentUser = { userId: 'user-9', workspaceId: 'ws-OTHER' };
    const res = await request(server).get(`/oauth/authorize?${authorizeQuery()}`);
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
    expect(authCodeRepo.size()).toBe(0);
  });
});

describe('PF-094 — the consent screen is server-rendered, not a React route', () => {
  it('the decision is recorded without the frontend build existing', async () => {
    // The whole flow above ran against an Express app with no `web/dist`, no
    // Vite and no React. That is the (c) half of PF-094's argument, asserted.
    const { post } = await consentFlow('allow');
    expect(post.status).toBe(302);
    expect(new URL(post.headers.location as string).searchParams.get('code')).toBeTruthy();
  });

  it('the code row records the challenge and method, read back from storage', async () => {
    // p.2: "code_challenge and code_challenge_method recorded at /oauth/authorize".
    // Read from the repository rather than from the response (PF-090).
    const { post } = await consentFlow('allow');
    const code = new URL(post.headers.location as string).searchParams.get('code')!;
    const { hashAuthorizationCode } = await import('./authCodes.js');
    const row = await authCodeRepo.findByHash(hashAuthorizationCode(code));
    expect(row!.codeChallenge).toBe(CHALLENGE);
    expect(row!.codeChallengeMethod).toBe('S256');
    expect(row!.redirectUri).toBe(REDIRECT_URI);
    expect(row!.userId).toBe('user-1');
    // 60-second TTL, from the clock, not the wall clock.
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(60_000);
  });
});
