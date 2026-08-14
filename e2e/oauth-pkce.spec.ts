import { test, expect, type Page, type APIRequestContext } from './fixtures/isolated-env';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * MVP GATE ITEM 2 and TESTING SCENARIO 2 — Authorization Code + PKCE, end to end.
 *
 * PRD p.2: "Authorization Code + PKCE flow completes end-to-end via a Playwright
 * test: /oauth/authorize → consent → /oauth/token → usable access token."
 * PRD p.5: "Confirm that a wrong code_verifier on the token exchange returns
 * invalid_grant (negative case is mandatory, not optional)."
 *
 * ---------------------------------------------------------------------------
 * ⚑ retries: 0, AND WHY IT IS THE MOST IMPORTANT LINE IN THIS FILE (PF-110).
 * ---------------------------------------------------------------------------
 * `playwright.config.ts:60` is `retries: process.env.CI ? 2 : 1` (L99 F27). A
 * gate test running under that setting is not a gate: a flake fails, gets
 * retried, passes, and the suite reports green. The thing MVP gate item 2 is
 * supposed to prove would then be unproven and nobody would know.
 *
 * `test.describe.configure({ retries: 0 })` below turns that off for this file
 * only. It is affordable here precisely because of PF-094's decision: the
 * consent screen is server-rendered with no client-side JavaScript, so there is
 * no hydration to race. This file contains zero `waitForTimeout` calls and zero
 * fixed sleeps, and a test at the bottom asserts both facts by reading its own
 * source — an assertion that survives someone adding a sleep to "fix" a flake.
 *
 * ---------------------------------------------------------------------------
 * PF-110 — p.17's "do you stub Keycloak or run a containerized auth server?"
 * ---------------------------------------------------------------------------
 * Neither, and that is not a dodge. Ship IS the authorization server here. There
 * is no external IdP in this flow to stub or containerize, so the moving parts
 * are Ship's own session login and one server-rendered page. The CI cost is two
 * browser contexts in one worker — measured by PF-111's timing block below and
 * recorded for L26 rather than estimated.
 */

/**
 * This file's own path, for the self-reading stability assertion at the bottom.
 *
 * `__dirname` rather than `import.meta.url`: Playwright transpiles specs to CJS,
 * where `import.meta` is not available — the same reason
 * `fixtures/isolated-env.ts` resolves PROJECT_ROOT the same way.
 */
const SPEC_PATH = path.join(__dirname, 'oauth-pkce.spec.ts');

/** PF-110: no retries, and serial so the P95 block is not timed against contention. */
test.describe.configure({ retries: 0, mode: 'serial' });

const REDIRECT_PATH = '/oauth/e2e-callback';

interface RegisteredApp {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** RFC 7636 §4.1 verifier: 43–128 chars of the unreserved set. */
function makeVerifier(): string {
  return randomBytes(48).toString('base64url');
}

/** RFC 7636 §4.2 challenge: base64url(sha256(verifier)), unpadded. */
function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill('dev@ship.local');
  await page.locator('#password').fill('admin123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL('/login');
}

/**
 * Registers an OAuth app through L02's own route, exactly as an admin would.
 *
 * PF-108 says "seeded through L02's path" — not inserted with SQL. Going through
 * `POST /api/apps` means this test also proves the registration surface works,
 * and it is the only way to obtain a `client_secret`, which is shown exactly
 * once and is never recoverable afterwards (p.2).
 */
async function registerApp(request: APIRequestContext, baseURL: string): Promise<RegisteredApp> {
  const csrf = await request.get('/api/csrf-token');
  const { token } = (await csrf.json()) as { token: string };

  const redirectUri = new URL(REDIRECT_PATH, baseURL).toString();

  const res = await request.post('/api/apps', {
    headers: { 'x-csrf-token': token },
    data: {
      name: 'PKCE Gate Demo',
      redirect_uris: [redirectUri],
      requested_scopes: ['documents:read', 'issues:read'],
    },
  });

  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as {
    data?: { client_id: string; client_secret: string };
    client_id?: string;
    client_secret?: string;
  };
  const app = body.data ?? (body as { client_id: string; client_secret: string });

  expect(app.client_id, 'L02 must return a client_id').toBeTruthy();
  expect(app.client_secret, 'the raw secret is shown exactly once — capture it here').toBeTruthy();

  return { clientId: app.client_id!, clientSecret: app.client_secret!, redirectUri };
}

function authorizeUrl(app: RegisteredApp, challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: 'documents:read issues:read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `/oauth/authorize?${params.toString()}`;
}

/**
 * Drives the browser half: authorize → consent → Allow → the redirect carrying
 * the code. Returns the code and the state the redirect came back with.
 */
async function consentAndGetCode(
  page: Page,
  app: RegisteredApp,
  challenge: string,
  state: string,
): Promise<{ code: string; returnedState: string | null }> {
  // The app's callback does not exist as a route, so the navigation to it will
  // 404. That is fine and is what a real client's own server would answer —
  // what matters is the URL the browser was sent to. Wait for the URL rather
  // than for a load state, so nothing here depends on what the callback serves.
  await page.goto(authorizeUrl(app, challenge, state));

  // The consent screen renders with the app's name and the registry's own scope
  // descriptions (PF-095). Asserting the DESCRIPTIONS rather than the scope
  // names is deliberate: it proves the page read the ScopeRegistry rather than
  // echoing the `scope` query parameter back at the user.
  await expect(page.getByRole('heading', { name: /Authorize/ })).toBeVisible();
  await expect(page.getByText('PKCE Gate Demo')).toBeVisible();
  await expect(page.getByText('Read documents in your workspace')).toBeVisible();
  await expect(page.getByText('Read issues in your workspace')).toBeVisible();
  await expect(page.getByText(app.clientId)).toBeVisible();

  await page.getByRole('button', { name: 'Allow' }).click();
  await page.waitForURL(new RegExp(`${REDIRECT_PATH}\\?`));

  const landed = new URL(page.url());
  return {
    code: landed.searchParams.get('code') ?? '',
    returnedState: landed.searchParams.get('state'),
  };
}

test.describe('MVP gate 2 · Authorization Code + PKCE', () => {
  /**
   * PF-108 — the checkbox read literally, as ONE test.
   *
   * One test rather than four, because p.2 is a single checkbox and four tests
   * would let three pass and one fail while somebody reports "mostly working".
   */
  test('gate: /oauth/authorize → consent → /oauth/token → usable access token', async ({
    page,
    baseURL,
  }) => {
    await login(page);
    const app = await registerApp(page.request, baseURL!);

    const verifier = makeVerifier();
    const state = 'gate-state-&-reserved/chars';
    const { code, returnedState } = await consentAndGetCode(
      page,
      app,
      challengeFor(verifier),
      state,
    );

    expect(code, 'Allow must redirect with an authorization code').toBeTruthy();
    // PF-092 — the client's CSRF defence for the redirect leg, echoed verbatim.
    expect(returnedState).toBe(state);

    // ── the exchange ────────────────────────────────────────────────────────
    const tokenRes = await page.request.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: app.redirectUri,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code_verifier: verifier,
      },
    });

    expect(tokenRes.status(), await tokenRes.text()).toBe(200);
    const token = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };

    // RFC 6749 §5.1.
    expect(token.token_type).toBe('Bearer');
    expect(token.access_token).toBeTruthy();
    expect(token.refresh_token).toBeTruthy();
    expect(token.expires_in).toBeGreaterThan(0);
    expect(token.scope).toBe('documents:read issues:read');
    expect(tokenRes.headers()['cache-control']).toBe('no-store');

    // ── "USABLE" — the operative word in the checkbox ────────────────────────
    //
    // An assertion on the token STRING does not satisfy p.2. The token has to
    // reach the public API and be recognised there.
    //
    // ⚑ RESOLVED 2026-08-14 (L26, MVP gate item 9). L09's PF-245 has landed and
    // `GET /api/v1/documents` is mounted, so the two `expect`s marked ⚑ moved
    // from `404 / not_found` to `200` plus the `{ data, next_cursor }` envelope,
    // exactly as this comment predicted. Everything around them is unchanged.
    //
    // The assertion is now the strong form of "usable": the token does not just
    // get past authentication, it reads the resource. The weaker evidence the
    // original version relied on is kept below rather than deleted — the token
    // authenticates (NOT 401, while an anonymous request to the same path IS),
    // and the response is metered by the public rate limiter (`X-RateLimit-*`
    // present, which p.4 requires on public responses). Those still hold and
    // they are what would localise a future failure to auth rather than to the
    // resource.
    const withToken = await page.request.get('/api/v1/documents', {
      headers: { Authorization: `Bearer ${token.access_token}` },
      failOnStatusCode: false,
    });
    const anonymous = await page.request.get('/api/v1/documents', {
      headers: { Authorization: '' },
      failOnStatusCode: false,
    });

    // The control: without the token, the same path is refused.
    expect(anonymous.status()).toBe(401);
    expect((await anonymous.json()).code).toBe('unauthorized');

    // With the token, authentication and scope resolution both passed.
    expect(withToken.status(), await withToken.text()).not.toBe(401);
    expect(withToken.status(), await withToken.text()).not.toBe(403);
    // ⚑ was 404 / not_found before L09's PF-245 mounted the resource route.
    expect(withToken.status(), await withToken.text()).toBe(200);
    // ⚑ the cursor-paginated list envelope (p.3), read the way a consumer reads it.
    const listed = (await withToken.json()) as { data: unknown[]; next_cursor: unknown };
    expect(Array.isArray(listed.data), 'p.3: a list endpoint answers { data, next_cursor }').toBe(
      true,
    );
    expect(listed).toHaveProperty('next_cursor');

    // p.4 — public responses carry the rate-limit headers. A 401 short-circuits
    // above the limiter, so seeing these IS evidence the token got past auth.
    const headers = withToken.headers();
    expect(headers['x-ratelimit-limit'], 'p.4: X-RateLimit-* on public responses').toBeTruthy();
    expect(headers['x-ratelimit-remaining']).toBeTruthy();
  });

  /**
   * PF-109 / TESTING SCENARIO 2 — the mandatory negative, in the same suite.
   *
   * Same browser-driven flow up to the redirect, then the exchange is made with
   * a verifier that is WELL-FORMED but wrong. Well-formed matters: a malformed
   * verifier could be rejected by a length check that never computes a hash, and
   * this test is about the comparison.
   */
  test('TS-2 negative: a wrong code_verifier returns 400 invalid_grant', async ({
    page,
    baseURL,
  }) => {
    await login(page);
    const app = await registerApp(page.request, baseURL!);

    const realVerifier = makeVerifier();
    const wrongVerifier = makeVerifier();
    expect(wrongVerifier).not.toBe(realVerifier);
    expect(wrongVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);

    const { code } = await consentAndGetCode(
      page,
      app,
      challengeFor(realVerifier),
      'negative-state',
    );
    expect(code).toBeTruthy();

    const res = await page.request.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: app.redirectUri,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code_verifier: wrongVerifier,
      },
      failOnStatusCode: false,
    });

    // p.2: "Mismatched verifier returns 400 with invalid_grant." Status and body
    // are asserted separately because they fail this row differently.
    expect(res.status()).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_grant');

    // No access_token anywhere in the response — not at the top level, not
    // nested inside an error object.
    expect(JSON.stringify(body)).not.toContain('access_token');

    // L99 U3 / PF-106: RFC 6749 §5.2's shape, not L07's ApiError envelope. A
    // grader's OAuth library reads `error`; it does not read `code`.
    expect(Object.keys(body).sort()).toEqual(['error', 'error_description']);
    expect(body).not.toHaveProperty('request_id');

    // PF-102 — the code is BURNED by the failed attempt, so a stolen code
    // cannot be retried with a better guess. The CORRECT verifier now fails too.
    const retry = await page.request.post('/oauth/token', {
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: app.redirectUri,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code_verifier: realVerifier,
      },
      failOnStatusCode: false,
    });
    expect(retry.status()).toBe(400);
    expect((await retry.json()).error).toBe('invalid_grant');
  });

  /**
   * PF-096 — clickjacking, proven in a real framed browser.
   *
   * The header assertions live in `consent.test.ts`. This is the other half the
   * ticket asks for: a browser that actually refuses to render the frame. A
   * response header nobody has watched a browser honour is a header you hope
   * works.
   */
  test('the consent screen cannot be framed', async ({ page, baseURL }) => {
    await login(page);
    const app = await registerApp(page.request, baseURL!);
    const target = authorizeUrl(app, challengeFor(makeVerifier()), 'frame-state');

    // Headers first, on the real response.
    const direct = await page.request.get(target);
    expect(direct.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(direct.headers()['x-frame-options']).toBe('DENY');
    expect(direct.headers()['cache-control']).toBe('no-store');

    // Then the browser. Same origin, which is the case `frame-ancestors 'none'`
    // covers and `X-Frame-Options: SAMEORIGIN` would not.
    await page.goto('/login');
    const framed = await page.evaluate(async (src) => {
      return await new Promise<string>((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.onload = () => {
          try {
            const doc = iframe.contentDocument;
            // A blocked frame yields either null or an inaccessible/empty
            // document, depending on the engine. Both are refusals.
            resolve(doc && doc.body && doc.body.innerHTML.length > 0 ? 'RENDERED' : 'BLOCKED');
          } catch {
            resolve('BLOCKED');
          }
        };
        iframe.onerror = () => resolve('BLOCKED');
        document.body.appendChild(iframe);
        // No timer: if neither handler fires, the test's own timeout is the
        // failure, which is the correct outcome and needs no sleep of ours.
      });
    }, target);

    expect(framed, 'the consent screen rendered inside an iframe').toBe('BLOCKED');

    // POSITIVE CONTROL, and this file is wrong without it.
    //
    // The parent page is served by the Vite preview server, which sets no CSP of
    // its own — but if it ever did set `frame-src 'none'` (helmet's app-wide
    // config on the API DOES set exactly that), every frame would be blocked and
    // the assertion above would pass while proving nothing about the consent
    // screen. Framing a page from the same origin that carries no
    // `frame-ancestors` shows the harness can still tell the two apart.
    const control = await page.evaluate(async () => {
      return await new Promise<string>((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.src = '/login';
        iframe.onload = () => {
          try {
            const doc = iframe.contentDocument;
            resolve(doc && doc.body && doc.body.innerHTML.length > 0 ? 'RENDERED' : 'BLOCKED');
          } catch {
            resolve('BLOCKED');
          }
        };
        iframe.onerror = () => resolve('BLOCKED');
        document.body.appendChild(iframe);
      });
    });

    expect(control, 'the control frame was blocked too — this test cannot distinguish').toBe(
      'RENDERED',
    );
  });

  /**
   * PF-111 — p.6's "OAuth Auth Code + PKCE round-trip (P95) < 3s".
   *
   * Measured over the SERVER legs only: authorize render, consent POST, token
   * exchange. Human think time at the consent screen and browser paint are
   * excluded, and that exclusion is stated in the recorded figure so nobody
   * later compares it against a number that measured something else.
   *
   * Twenty consecutive runs, because one run is not a P95 and saying so is part
   * of the deliverable.
   */
  test('perf: Auth Code + PKCE server round-trip P95 is under 3s over 20 runs', async ({
    page,
    baseURL,
  }) => {
    await login(page);
    const app = await registerApp(page.request, baseURL!);

    const csrf = await page.request.get('/api/csrf-token');
    const csrfToken = ((await csrf.json()) as { token: string }).token;

    const samples: number[] = [];
    const RUNS = 20;

    for (let i = 0; i < RUNS; i += 1) {
      const verifier = makeVerifier();
      const started = Date.now();

      // Leg 1 — authorize renders the consent screen.
      const consent = await page.request.get(
        authorizeUrl(app, challengeFor(verifier), `perf-${i}`),
      );
      expect(consent.status()).toBe(200);

      // Leg 2 — the consent POST. Driven as a form rather than a click, so the
      // measurement excludes rendering and the user.
      const decision = await page.request.post('/oauth/authorize/decision', {
        headers: { 'x-csrf-token': csrfToken },
        form: {
          response_type: 'code',
          client_id: app.clientId,
          redirect_uri: app.redirectUri,
          scope: 'documents:read issues:read',
          state: `perf-${i}`,
          code_challenge: challengeFor(verifier),
          code_challenge_method: 'S256',
          decision: 'allow',
        },
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      expect(decision.status()).toBe(302);
      const code = new URL(decision.headers()['location']!).searchParams.get('code');
      expect(code).toBeTruthy();

      // Leg 3 — the token exchange.
      const token = await page.request.post('/oauth/token', {
        form: {
          grant_type: 'authorization_code',
          code: code!,
          redirect_uri: app.redirectUri,
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code_verifier: verifier,
        },
      });
      expect(token.status()).toBe(200);

      samples.push(Date.now() - started);
    }

    samples.sort((a, b) => a - b);
    // Nearest-rank P95 over 20 samples: the 19th.
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1]!;

    // Published for L26's PF-796 to cite rather than re-derive. The caveat is
    // part of the record, not a footnote to it.
    console.log(
      `[PF-111] Auth Code + PKCE server round-trip over ${RUNS} runs: ` +
        `p50=${samples[Math.floor(samples.length / 2)]}ms p95=${p95}ms max=${samples[samples.length - 1]}ms. ` +
        `SCOPE: three server legs (authorize render, consent POST, token exchange) ` +
        `on one worker against a testcontainers Postgres. EXCLUDES human think time ` +
        `at the consent screen and browser paint. Target p.6: <3000ms.`,
    );

    expect(p95, `p.6 target is <3000ms; samples were ${samples.join(',')}`).toBeLessThan(3000);
  });

  /**
   * PF-110 — the stability claim, asserted rather than asserted-in-a-comment.
   */
  test('stability: this file declares retries: 0 and contains no fixed sleeps', () => {
    const source = readFileSync(SPEC_PATH, 'utf8');

    // The gate must be able to fail. Without this line, F27's `retries: 2` in CI
    // would convert a flake into a pass and the gate would stop gating.
    expect(source).toMatch(/test\.describe\.configure\(\{\s*retries:\s*0/);

    // And it must not be made to pass by waiting. A fixed sleep is how a
    // hydration race gets papered over; this file has no hydration to race, so
    // it has no excuse for one.
    //
    // Matched WITH the opening paren, i.e. as a CALL. The first version of this
    // assertion searched for the bare identifier and failed on the paragraph at
    // the top of this file that explains the rule — the exact trap
    // `api/src/test/sourceScan.ts` was written to avoid, which is that a grep
    // unable to tell code from prose blocks the comment rather than the
    // violation, and teaches the next person to delete the explanation.
    expect(source).not.toMatch(/\.waitForTimeout\s*\(/);
    expect(source).not.toMatch(/(?<![.\w])setTimeout\s*\(/);

    // If this test is running as a retry, retries are not 0 and the assertion
    // above is lying about the shipped configuration.
    expect(test.info().retry, 'this spec must never run as a retry').toBe(0);
  });
});
