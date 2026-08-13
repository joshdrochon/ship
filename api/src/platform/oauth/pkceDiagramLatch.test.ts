/**
 * PF-113 — the ★ PKCE marker in `docs/architecture.md` is kept true by a test,
 * not by review.
 *
 * PRD p.12 requires the architecture document to carry sequence diagrams for
 * Authorization Code + PKCE and the Device Grant, and to "mark where PKCE
 * verifier is validated and where refresh-token rotation happens". Both marks
 * exist. L06's `architectureDoc.test.ts` latches the ROTATION mark; this file
 * latches the PKCE one, and the two are deliberately separate so a failure names
 * which lane's commitment broke.
 *
 * The marker is a graded deliverable. A diagram that says the verifier is
 * checked at `/oauth/token` while the code checks it somewhere else — or checks
 * it nowhere — is worse than no diagram, because it is evidence that reads as
 * true. So the claim is asserted in three directions: the sentence is still in
 * the document, the route it names is really mounted, and the comparison really
 * happens in the module that route calls.
 *
 * Content, not line numbers — for the reason `architectureDoc.test.ts` sets out
 * at length: the lane file's "line 115" is already stale, and a line-number
 * assertion fails for unrelated edits and passes when the sentence is deleted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { scanTree } from '../../test/sourceScan.js';
import { createApp } from '../../app.js';
import { testDeps } from '../../deps.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const ARCHITECTURE = join(REPO_ROOT, 'docs', 'architecture.md');

function doc(): string {
  return readFileSync(ARCHITECTURE, 'utf8');
}

/**
 * Every `METHOD /path` the shipped app answers under `/oauth`, walked from the
 * live Express stack.
 *
 * Reading the router's own stack rather than a hand-kept list is the point: a
 * list would be a second place to update, and the one nobody updates is the one
 * the test trusts.
 */
function oauthRoutes(app: Express): string[] {
  const stack = (app as unknown as {
    _router: { stack: { regexp: RegExp; handle?: { stack?: unknown[] } }[] };
  })._router.stack;

  const mount = stack.find((l) => String(l.regexp).includes('oauth'));
  const inner = (mount?.handle as { stack?: RouteLayer[] } | undefined)?.stack ?? [];

  const out: string[] = [];
  for (const layer of inner) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods ?? {})) {
      out.push(`${method.toUpperCase()} /oauth${layer.route.path}`);
    }
  }
  return out;
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

let app: Express;

beforeAll(() => {
  app = createApp(testDeps());
});

describe('PF-113 — the ★ PKCE marker still describes the shipped code', () => {
  it('the marker is in the document, on the /oauth/token participant', () => {
    const text = doc();
    expect(text).toContain('★ PKCE validated HERE');
    expect(text).toContain('S256(verifier) ≟ stored challenge');
    expect(text).toContain('400 invalid_grant');
    expect(text).toContain('mandatory negative Playwright test');

    // The marker sits inside the Auth Code diagram, whose participants are the
    // two endpoints below. If someone moves the Note to the device-grant
    // diagram, the participants around it change and this fails.
    const authCodeDiagram = text.split('## OAuth Flows')[1]!.split('```')[1]!;
    expect(authCodeDiagram).toContain('participant AZ as /oauth/authorize');
    expect(authCodeDiagram).toContain('participant TK as /oauth/token');
    expect(authCodeDiagram).toContain('★ PKCE validated HERE');
  });

  it("the diagram's participant names resolve to really-mounted paths", () => {
    // A renamed endpoint must fail the suite rather than silently make a graded
    // deliverable wrong.
    const routes = oauthRoutes(app);
    expect(routes).toContain('GET /oauth/authorize');
    expect(routes).toContain('POST /oauth/token');
  });

  it('the consent step the diagram shows is a real route too', () => {
    // "B->>AZ: login + consent screen" is a claim about a screen that posts
    // somewhere. PF-094 decided where.
    expect(doc()).toContain('login + consent screen');
    expect(oauthRoutes(app)).toContain('POST /oauth/authorize/decision');
  });

  it('the PKCE comparison lives in the module the token handler calls', () => {
    const files = scanTree(HERE);

    // One definition, in pkce.ts.
    const definitions = files
      .filter((f) => /export function verifyPkce\b/.test(f.code))
      .map((f) => f.name);
    expect(definitions).toEqual(['pkce.ts']);

    // One caller, and it is the authorization_code grant handler — the module
    // POST /oauth/token dispatches to. That is what makes the ★'s POSITION on
    // the diagram (the token participant, not the authorize participant) a true
    // statement about the code.
    const callers = files
      .filter((f) => f.name !== 'pkce.ts' && /\bverifyPkce\s*\(/.test(f.code))
      .map((f) => f.name);
    expect(callers).toEqual(['authCodeGrant.ts']);

    // And the grant handler is reachable from the token route's dispatcher.
    const router = files.find((f) => f.name === 'router.ts')!;
    expect(router.code).toContain('authorizationCodeGrant');
    expect(router.code).toContain("router.post('/token'");
  });

  it('the mismatch really produces the 400 the marker promises', () => {
    // The behavioural half is asserted in `authCodeGrant.test.ts` and in the
    // Playwright suite. What is asserted HERE is that the code the marker names
    // is the code the handler emits — so changing `invalid_grant` to something
    // else fails next to the sentence that promises it.
    const grant = scanTree(HERE).find((f) => f.name === 'authCodeGrant.ts')!;
    expect(grant.code).toContain("error: 'invalid_grant'");
    expect(grant.code).toContain('status: 400');
  });
});

describe('PF-113 — the write-ups this lane owes are present', () => {
  it('records the consent-screen decision and BOTH rejections (PF-094)', () => {
    const text = doc();
    expect(text).toContain('### The consent screen: a server-rendered endpoint, same origin, own layout');
    expect(text).toContain('**Rejected:**');
    expect(text).toContain('a React route');
    expect(text).toContain('third-party hosted login');
    // The cost, stated rather than elided.
    expect(text).toContain('**Cost, stated:**');
  });

  it('records the clickjacking answer as headers, and names the helmet fact', () => {
    const text = doc();
    expect(text).toContain("frame-ancestors 'none'");
    expect(text).toContain('X-Frame-Options: DENY');
    expect(text).toContain('sets `frame-src` and **not** `frame-ancestors`');
  });

  it('records U3 — the /oauth error surface is not the ApiError envelope (PF-106)', () => {
    const text = doc();
    expect(text).toContain('### The `/oauth` error surface is deliberately **not** the `ApiError` envelope');
    expect(text).toContain('oauthErrorBodySchema');
    // And the audit consequence PF-107 asks to be stated rather than discovered.
    expect(text).toContain('no `public_api_calls` row will ever record one');
  });

  it('records D4’s authorize half as the ABSENCE of grant state (PF-099)', () => {
    const text = doc();
    expect(text).toContain('There is no grant table, no lookup of a prior grant and no `UPDATE` against one');
    expect(text).toContain('The absence of grant state is what makes the decision cheap');
  });
});
