/**
 * The Browser SDK Demo — PRD p.8 option 3, and the *registered web app* that
 * Testing Scenario 2 (p.5) presumes exists.
 *
 * PF-733 – PF-738. Four things this file is the only place in the repo to do:
 *
 *   1. run Authorization Code + PKCE from a browser, with the verifier never
 *      leaving it (PF-734, MVP gate item 2);
 *   2. handle the mandatory negative case as UI STATE rather than a swallowed
 *      rejection (PF-735 — p.5 calls the negative case mandatory);
 *   3. be the first consumer anywhere of `LocalStorageTokenStore`, including
 *      its corruption contract (PF-736 — p.4 names the browser store);
 *   4. list documents through `client.documents.iterate()` without the word
 *      `cursor` appearing in this package at all (PF-737 — p.4's "consumer code
 *      never sees them", asserted from the consumer side).
 *
 * ── Imports ────────────────────────────────────────────────────────────────
 * `@ship/sdk` and nothing else from this repo (p.11, PF-716/PF-722). A bundler
 * targeting the browser resolves that specifier through the `browser` condition
 * to `sdk/dist/browser.js`, which by construction contains no `node:` import —
 * that is L17's PF-507, and PF-738's bundle assertion is what proves it held.
 */
import { ShipClient, LocalStorageTokenStore, ShipError } from '@ship/sdk';
import type { ShipDocument, StoredTokens } from '@ship/sdk';
import { loadConfig, type DemoConfig } from './config.js';
import {
  generateCodeVerifier,
  generateState,
  s256Challenge,
  STATE_STORAGE_KEY,
  VERIFIER_STORAGE_KEY,
} from './pkce.js';

const config = loadConfig();
const tokenStore = new LocalStorageTokenStore();

/* ── View ─────────────────────────────────────────────────────────────────── */

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`[@ship/browser-demo] missing element #${id}`);
  return node;
}

type Screen = 'loading' | 'logged-out' | 'logged-in';

function show(screen: Screen): void {
  for (const name of ['loading', 'logged-out', 'logged-in'] as const) {
    el(`screen-${name}`).hidden = name !== screen;
  }
}

/**
 * PF-735 — the error is a VISIBLE UI STATE, not a console line.
 *
 * The ticket's wording is "surfaced as UI state rather than a swallowed
 * rejection", and the distinction has teeth: an `catch { console.error(e) }`
 * leaves the user on a blank page with a spinner, which is indistinguishable
 * from a hang and gives them nothing to retry. `data-testid` is on the element
 * so the Playwright assertion reads the same thing a human does.
 */
function showError(message: string): void {
  const box = el('error');
  box.textContent = message;
  box.hidden = false;
}

function clearError(): void {
  const box = el('error');
  box.textContent = '';
  box.hidden = true;
}

/* ── OAuth: leg 1, the authorization request ──────────────────────────────── */

/**
 * Generates the PKCE pair, stows the verifier, and navigates to Ship.
 *
 * The verifier goes to `sessionStorage`, not `localStorage`: it is valid for
 * exactly one exchange and has no reason to outlive the tab. The URL we
 * navigate to carries the CHALLENGE only — `pkce.ts` explains why that
 * distinction is the entire security of the flow.
 */
async function startAuthorization(cfg: DemoConfig): Promise<void> {
  const verifier = generateCodeVerifier();
  const state = generateState();

  sessionStorage.setItem(VERIFIER_STORAGE_KEY, verifier);
  sessionStorage.setItem(STATE_STORAGE_KEY, state);

  const url = new URL('/oauth/authorize', cfg.baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await s256Challenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');

  window.location.assign(url.toString());
}

/* ── OAuth: leg 2, the token exchange ─────────────────────────────────────── */

interface TokenResponse {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number;
  scope?: string;
  token_type: string;
}

/**
 * `POST /oauth/token` — the ONLY place the verifier is ever transmitted, and it
 * travels in the request BODY.
 *
 * `Content-Type: application/x-www-form-urlencoded` is RFC 6749 §4.1.3, and it
 * is also what Ship's `urlencoded()` parser reads; a JSON body would arrive as
 * an empty `req.body` and be answered `invalid_request` for a reason with no
 * relationship to what the client did wrong.
 *
 * No `client_secret` is sent because there is not one to send. See `config.ts`.
 */
async function exchangeCode(cfg: DemoConfig, code: string, verifier: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
  });

  const response = await fetch(new URL('/oauth/token', cfg.baseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    // Explicit, and deliberate: the exchange must not carry Ship's session
    // cookie. This is a public API call made by a third-party app, and the
    // public CORS policy sends `Allow-Origin: *` precisely because nothing
    // here is cookie-authenticated (see `api/src/platform/publicCors.ts`).
    credentials: 'omit',
  });

  if (!response.ok) {
    // RFC 6749 §5.2's shape — `{error, error_description?}`. NOT L07's ApiError
    // envelope: `/oauth/*` is governed by a different spec and answers in it,
    // which `platform/oauth/router.ts` states at the top of the file.
    const problem = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    throw new OAuthExchangeError(problem.error ?? 'invalid_request', problem.error_description);
  }

  const token = (await response.json()) as TokenResponse;

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAtSeconds:
      typeof token.expires_in === 'number'
        ? Math.floor(Date.now() / 1000) + token.expires_in
        : null,
    scopes: token.scope ? token.scope.split(/\s+/) : cfg.scope.split(/\s+/),
  };
}

class OAuthExchangeError extends Error {
  constructor(
    readonly code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'OAuthExchangeError';
  }
}

/* ── The document list ────────────────────────────────────────────────────── */

/**
 * PF-737 — driven by the async iterator. There is no cursor in this function,
 * in this file, or anywhere under `src/`, and a grep asserts it.
 *
 * The `take` bound is a rendering decision, not a pagination one: the iterator
 * would happily walk every page, and a demo listing ten thousand rows is a
 * demo nobody can read. Breaking out of a `for await` is the supported way to
 * stop — which is itself part of what p.4's contract buys the consumer.
 */
async function renderDocuments(client: ShipClient, take = 25): Promise<void> {
  const list = el('documents');
  list.replaceChildren();

  let count = 0;
  for await (const doc of client.documents.iterate()) {
    appendDocument(list, doc);
    count += 1;
    if (count >= take) break;
  }

  el('doc-count').textContent = String(count);
  if (count === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No documents visible to this token.';
    list.append(empty);
  }
}

function appendDocument(list: HTMLElement, doc: ShipDocument): void {
  const item = document.createElement('li');
  item.className = 'doc';
  item.setAttribute('data-testid', 'document');

  const title = document.createElement('span');
  title.className = 'doc-title';
  // `textContent`, never `innerHTML`: a document title is user-authored content
  // arriving from an API, and this demo is the shape an external developer will
  // copy. Copying an XSS sink is worse than copying nothing.
  title.textContent = doc.title;

  const type = document.createElement('span');
  type.className = 'doc-type';
  type.textContent = doc.document_type;

  item.append(title, type);
  list.append(item);
}

/* ── Session ──────────────────────────────────────────────────────────────── */

function clientFor(tokens: StoredTokens): ShipClient {
  return new ShipClient({
    baseUrl: config.baseUrl,
    tokenStore,
    clientId: config.clientId,
    // No `clientSecret`. A public client has none, and the SDK's refresh path
    // reports an actionable `{kind:'auth'}` rather than inventing one.
    token: tokens.accessToken,
  });
}

async function enterLoggedIn(tokens: StoredTokens): Promise<void> {
  const client = clientFor(tokens);
  await renderDocuments(client);
  el('scopes').textContent = tokens.scopes.join(' ');
  show('logged-in');
}

/**
 * PF-736 — the corruption contract, exercised rather than described.
 *
 * `LocalStorageTokenStore.load()` answers `null` for all three corruption
 * shapes and writes nothing back (the SDK's PF-508). This function's whole
 * contribution is to treat that `null` as LOGGED OUT and stop — no retry loop,
 * no `clear()` (a write the contract forbids), no partial credential written
 * over a file a human might still be able to repair.
 */
async function restoreSession(): Promise<boolean> {
  const tokens = await tokenStore.load();
  if (!tokens) return false;

  try {
    await enterLoggedIn(tokens);
    return true;
  } catch (error) {
    // An expired or revoked token reads as logged out, once. `ShipError`'s
    // discriminated union is what makes this a switch on `kind` rather than a
    // string match on a message (p.4's Typed Error Union).
    if (error instanceof ShipError && error.kind === 'auth') return false;
    throw error;
  }
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */

/**
 * Removes `code`/`state`/`error` from the address bar after the callback.
 *
 * `replaceState` rather than a navigation, so the authorization code does not
 * sit in the browser's history or get re-sent if the user hits reload — a spent
 * code answering `invalid_grant` on refresh is a confusing way to look broken.
 */
function stripCallbackParams(): void {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(key);
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

async function handleCallback(params: URLSearchParams): Promise<void> {
  // The client's own CSRF check for the redirect leg. Ship echoes `state`
  // verbatim (PF-092) precisely so this comparison is possible.
  const expectedState = sessionStorage.getItem(STATE_STORAGE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_STORAGE_KEY);

  // Read once, then gone. A verifier that outlives its exchange is a credential
  // sitting in storage for no reason.
  sessionStorage.removeItem(STATE_STORAGE_KEY);
  sessionStorage.removeItem(VERIFIER_STORAGE_KEY);

  const denied = params.get('error');
  if (denied) {
    stripCallbackParams();
    showError(`Ship declined the authorization: ${denied}. You are not signed in.`);
    show('logged-out');
    return;
  }

  const code = params.get('code');
  if (!code || !verifier) {
    stripCallbackParams();
    showError('That redirect did not carry a usable authorization code. Start again.');
    show('logged-out');
    return;
  }

  if (params.get('state') !== expectedState) {
    stripCallbackParams();
    showError('The redirect did not match the request this tab started. Nothing was exchanged.');
    show('logged-out');
    return;
  }

  try {
    const tokens = await exchangeCode(config, code, verifier);
    // Persisted only AFTER a successful exchange. PF-735 asserts that a failed
    // exchange writes nothing to `localStorage`, and the ordering here is the
    // implementation of that: there is no path that saves a partial credential.
    await tokenStore.save(tokens);
    stripCallbackParams();
    clearError();
    await enterLoggedIn(tokens);
  } catch (error) {
    stripCallbackParams();
    const detail = error instanceof OAuthExchangeError ? error.message : String(error);
    // p.5's mandatory negative case, from the consumer side: `invalid_grant`
    // becomes a visible message and a logged-out screen the user can retry
    // from. L04 owns the server answering it; this owns not stranding the user
    // half-authenticated when it does.
    showError(`Sign-in failed — ${detail}. Nothing was saved; you can try again.`);
    show('logged-out');
  }
}

async function boot(): Promise<void> {
  show('loading');
  el('base-url').textContent = config.baseUrl;
  el('client-id').textContent = config.clientId;

  el('sign-in').addEventListener('click', () => {
    clearError();
    void startAuthorization(config);
  });

  el('sign-out').addEventListener('click', () => {
    void tokenStore.clear().then(() => {
      clearError();
      show('logged-out');
    });
  });

  const params = new URLSearchParams(window.location.search);
  if (params.has('code') || params.has('error')) {
    await handleCallback(params);
    return;
  }

  if (await restoreSession()) return;
  show('logged-out');
}

void boot().catch((error: unknown) => {
  showError(`The demo failed to start: ${String(error)}`);
  show('logged-out');
});
