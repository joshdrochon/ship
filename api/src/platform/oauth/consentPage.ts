/**
 * The consent screen's HTML. PF-094, PF-095 (lane L04, slice S2).
 *
 * ---------------------------------------------------------------------------
 * PF-094 — WHY THIS IS A SERVER-RENDERED TEMPLATE AND NOT A REACT ROUTE.
 * ---------------------------------------------------------------------------
 * PRD p.16 asks it as an open question: "Where does the consent screen live — a
 * route inside Ship's UI, a dedicated endpoint with its own minimal layout, or
 * something else?" The answer is the middle option, and the argument is
 * structural rather than aesthetic:
 *
 *   (a) THE GATE TEST MUST BE ABLE TO FAIL. Ship's UI is a Vite SPA that boots a
 *       router, a query client and an IndexedDB-backed cache
 *       (`web/src/lib/queryClient.ts`). Routing the authorize leg through it
 *       puts MVP gate item 2's own Playwright test behind SPA hydration — and
 *       `playwright.config.ts:60` is `retries: process.env.CI ? 2 : 1` (L99
 *       F27), so hydration flake would be RETRIED INTO GREEN. A gate test that
 *       cannot fail is not a gate. PF-110 pins `retries: 0` on these two tests
 *       as the belt to this braces.
 *   (b) THE HEADERS ARE PER-RESPONSE. This page needs `frame-ancestors 'none'`,
 *       `X-Frame-Options: DENY` and `Cache-Control: no-store` (PF-096), which
 *       the app-wide helmet configuration in `createApp()` does not distinguish
 *       per route and — measured, not assumed — does not set at all.
 *   (c) NO FRONTEND BUILD DEPENDENCY. `/oauth/*` stays one request/response
 *       chain that works against a bare API container with no `web/dist`.
 *
 * COST, STATED: this is the only non-React UI in the repository, and somebody
 * has to keep it looking like Ship. That is a real maintenance cost and it is
 * the reason the CSS below is deliberately about forty lines rather than an
 * attempt to reproduce the design system.
 *
 * It is also a deviation from p.10's "the portal reuses the public API like any
 * other client" — but p.10 says that of the PORTAL, and p.17 places the consent
 * screen ALONGSIDE the portal rather than inside it.
 *
 * REJECTED: a React route, for (a); and a third-party hosted login, because
 * nothing in p.10's stack table permits one and Ship is itself the authorization
 * server (see PF-110 — there is no external IdP here to stub or containerize).
 *
 * ---------------------------------------------------------------------------
 * PF-095 — NO SCOPE LITERAL MAY APPEAR IN THIS FILE.
 * ---------------------------------------------------------------------------
 * Every scope name and every human description is read from L03's
 * `ScopeRegistry` at render time. `consent.test.ts` greps this file and fails if
 * a scope name or a description string appears in it.
 *
 * That assertion mirrors the one L03's PF-070 makes on `require-scope.ts`, and
 * the reason is L03's own OCP claim (PF-066): "adding a scope touches only the
 * registration file" is false the moment a second surface hard-codes the list.
 * A consent screen with a copy of the scope table is the most likely place for
 * that to happen, because writing the descriptions into the HTML is the obvious
 * thing to do.
 */
import type { ScopeDefinition } from '../scopes/registry.js';

/** Everything the page needs. All of it comes from the validated request. */
export interface ConsentPageModel {
  appName: string;
  clientId: string;
  redirectUri: string;
  /** Read from the registry by the caller. Never a literal in this file. */
  scopes: ScopeDefinition<string>[];
  /** Where the decision is POSTed. */
  actionPath: string;
  /** The `csrf-sync` synchroniser token, as a hidden field (PF-097). */
  csrfToken: string;
  /** The authorize parameters, re-submitted and RE-VALIDATED on POST. */
  hidden: Record<string, string>;
  userLabel: string;
}

/**
 * HTML-escapes a value for insertion into element content or a double-quoted
 * attribute.
 *
 * Every interpolation in this file goes through it, without exception. The
 * values are not all attacker-controlled — the app name is set by a registered
 * developer, `redirect_uri` matched a registered value — but `state` and the
 * error description are, and "some of these are safe" is a distinction that
 * decays. Escaping everything makes the rule checkable by reading, which is what
 * a template with no framework needs.
 *
 * `/` is escaped as well as the usual four, so a value cannot close a tag even
 * if it somehow lands in an unquoted position.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#47;');
}

/**
 * Deliberately small, and deliberately containing no `<script>`.
 *
 * The absence of client-side JavaScript is the property PF-110's answer to
 * p.17's Playwright-stability question rests on: with no script there is no
 * hydration to wait for, so the gate test needs no `waitForTimeout`, no network
 * idle heuristic, and no retry to paper over either.
 */
const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 1.5rem;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f4f5f7; color: #16181d;
  }
  main {
    background: #fff; max-width: 30rem; width: 100%; border-radius: 10px;
    border: 1px solid #d8dbe0; padding: 1.75rem;
  }
  h1 { font-size: 1.15rem; margin: 0 0 .35rem; line-height: 1.35; }
  .sub { color: #5a616b; font-size: .875rem; margin: 0 0 1.25rem; }
  ul { list-style: none; padding: 0; margin: 0 0 1.25rem;
       border: 1px solid #e4e6ea; border-radius: 8px; }
  li { padding: .7rem .85rem; border-bottom: 1px solid #e4e6ea; }
  li:last-child { border-bottom: 0; }
  .scope { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
           font-size: .78rem; color: #5a616b; display: block; margin-top: .15rem; }
  dl { margin: 0 0 1.25rem; font-size: .8rem; color: #5a616b; }
  dt { font-weight: 600; color: #16181d; margin-top: .5rem; }
  dd { margin: .1rem 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
       word-break: break-all; }
  .actions { display: flex; gap: .6rem; }
  button { flex: 1; padding: .6rem 1rem; border-radius: 7px; font-size: .9rem;
           font-weight: 600; cursor: pointer; border: 1px solid transparent; }
  .allow { background: #1b5e9c; color: #fff; }
  .deny { background: #fff; color: #16181d; border-color: #c6cad1; }
  .error { border-left: 4px solid #b32d2e; padding-left: .85rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #f1f2f4; }
    main { background: #1f232a; border-color: #343a44; }
    li, ul { border-color: #343a44; }
    .sub, .scope, dl { color: #a4abb6; }
    dt { color: #f1f2f4; }
    .deny { background: #1f232a; color: #f1f2f4; border-color: #495060; }
  }
`;

function document_(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/**
 * PF-095 — the app's name, its client_id, the redirect_uri the grant returns to,
 * and one row per scope carrying the registry's own description.
 *
 * Showing `client_id` and `redirect_uri` is not decoration. A user being
 * phished by an app impersonating another app's NAME can see where the grant
 * will actually be delivered, and the redirect URI is the only field an
 * impersonator cannot forge — it had to be registered.
 */
export function renderConsentPage(model: ConsentPageModel): string {
  const scopeItems = model.scopes
    .map(
      (def) => `      <li>
        ${escapeHtml(def.description)}
        <span class="scope">${escapeHtml(def.scope)}</span>
      </li>`,
    )
    .join('\n');

  const hiddenFields = Object.entries(model.hidden)
    .map(
      ([name, value]) =>
        `      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n');

  return document_(
    `Authorize ${model.appName}`,
    `  <h1>Authorize <strong>${escapeHtml(model.appName)}</strong></h1>
  <p class="sub">Signed in as ${escapeHtml(model.userLabel)}. This application is asking for the following access to your workspace.</p>
  <ul>
${scopeItems}
  </ul>
  <dl>
    <dt>Application ID</dt><dd>${escapeHtml(model.clientId)}</dd>
    <dt>Will return you to</dt><dd>${escapeHtml(model.redirectUri)}</dd>
  </dl>
  <form method="post" action="${escapeHtml(model.actionPath)}">
${hiddenFields}
      <input type="hidden" name="_csrf" value="${escapeHtml(model.csrfToken)}">
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>`,
  );
}

/**
 * PF-089's rendered half: an error on Ship's own origin, with no `Location`.
 *
 * Says what went wrong without telling the visitor how to fix it, because the
 * visitor is not the party who can: an unknown `client_id` or an unregistered
 * `redirect_uri` is the integrating developer's bug, and the human looking at
 * this page is the user they sent here. The `error` code is shown because it is
 * what the developer will ask for.
 */
/**
 * L05 PF-129 — the device verification entry screen.
 *
 * In THIS file rather than a `devicePage.ts` because PF-129 asks for one
 * template family, not two: same `document_`, same `STYLES`, same `escapeHtml`
 * on every interpolation. A second template file is how two consent surfaces end
 * up with two different ideas of what a scope row looks like — and L03's
 * open/closed claim has to survive both of them.
 */
export interface DeviceEntryPageModel {
  /** Pre-filled when the user arrived via `verification_uri_complete`. */
  userCode: string;
  actionPath: string;
  csrfToken: string;
  userLabel: string;
  /** Shown above the form when a previous attempt failed. */
  error?: string;
}

export function renderDeviceEntryPage(model: DeviceEntryPageModel): string {
  const error = model.error
    ? `  <div class="error"><p class="sub">${escapeHtml(model.error)}</p></div>\n`
    : '';

  return document_(
    'Connect a device',
    `${error}  <h1>Connect a device</h1>
  <p class="sub">Signed in as ${escapeHtml(model.userLabel)}. Enter the code shown in your terminal.</p>
  <form method="post" action="${escapeHtml(model.actionPath)}">
      <input type="hidden" name="_csrf" value="${escapeHtml(model.csrfToken)}">
      <label for="user_code" class="sub">Device code</label>
      <input id="user_code" name="user_code" value="${escapeHtml(model.userCode)}"
             autocomplete="off" autocapitalize="characters" spellcheck="false"
             style="width:100%;padding:.6rem .7rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.1rem;letter-spacing:.08em;border:1px solid #c6cad1;border-radius:7px;margin:.3rem 0 1.1rem;">
    <div class="actions">
      <button class="allow" type="submit">Continue</button>
    </div>
  </form>`,
  );
}

/**
 * L05 PF-130 / PF-128 — the device consent screen.
 *
 * ---------------------------------------------------------------------------
 * THE CODE IS RENDERED, AND THE USER IS ASKED TO CONFIRM IT (PF-128).
 * ---------------------------------------------------------------------------
 * This is the load-bearing half of D-PF-128, and it is the half that is easy to
 * drop because the flow "works" without it. `verification_uri_complete` ships a
 * clickable link that carries the code, which is a materially better demo — and
 * a one-click device-phishing primitive if the page simply says "Allow?".
 *
 * RFC 8628 §5.4 names the attack: an attacker starts their OWN device flow,
 * sends the victim the completed URL, and the victim authorizes the ATTACKER's
 * device while believing they are authorizing their own. The only thing standing
 * between the link and a silently authorized attacker device is the user
 * checking that the code on this screen matches the code in front of them.
 *
 * So the code is displayed prominently and the copy asks for the comparison
 * explicitly. `consent.test.ts`'s device half asserts the code appears in the
 * rendered body — an implementation that dropped it would otherwise pass every
 * other assertion in this lane.
 */
export interface DeviceConsentPageModel {
  appName: string;
  clientId: string;
  /** Displayed for the PF-128 confirmation. Canonical hyphenated form. */
  userCode: string;
  /** Read from the registry by the caller. Never a literal in this file. */
  scopes: ScopeDefinition<string>[];
  actionPath: string;
  csrfToken: string;
  userLabel: string;
}

export function renderDeviceConsentPage(model: DeviceConsentPageModel): string {
  const scopeItems = model.scopes
    .map(
      (def) => `      <li>
        ${escapeHtml(def.description)}
        <span class="scope">${escapeHtml(def.scope)}</span>
      </li>`,
    )
    .join('\n');

  return document_(
    `Authorize ${model.appName}`,
    `  <h1>Authorize <strong>${escapeHtml(model.appName)}</strong> on this device</h1>
  <p class="sub">Signed in as ${escapeHtml(model.userLabel)}.</p>
  <dl>
    <dt>Confirm this code matches the one in your terminal</dt>
    <dd style="font-size:1.35rem;letter-spacing:.12em;margin-top:.35rem;">${escapeHtml(model.userCode)}</dd>
  </dl>
  <p class="sub">If this code is not the one displayed on the device you are setting up, press Deny — someone else may be trying to connect their device to your account.</p>
  <ul>
${scopeItems}
  </ul>
  <dl>
    <dt>Application ID</dt><dd>${escapeHtml(model.clientId)}</dd>
  </dl>
  <form method="post" action="${escapeHtml(model.actionPath)}">
      <input type="hidden" name="_csrf" value="${escapeHtml(model.csrfToken)}">
      <input type="hidden" name="user_code" value="${escapeHtml(model.userCode)}">
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>`,
  );
}

/**
 * L05 PF-130 / PF-133 — the terminal states of the verification screen.
 *
 * One renderer for "you are done here", because every one of these outcomes has
 * the same shape: the browser half of the flow is over and the answer is in the
 * terminal. Separate pages would invite one of them to grow a form.
 */
export function renderDeviceResultPage(heading: string, message: string): string {
  return document_(
    heading,
    `  <h1>${escapeHtml(heading)}</h1>
  <p class="sub">${escapeHtml(message)}</p>`,
  );
}

export function renderAuthorizeErrorPage(error: string, description: string): string {
  return document_(
    'Authorization failed',
    `  <div class="error">
    <h1>This application could not be authorized</h1>
    <p class="sub">${escapeHtml(description)}</p>
    <p class="sub">Error code: <code>${escapeHtml(error)}</code></p>
    <p class="sub">Nothing was shared, and no access was granted. If you followed a link from an application, its developer needs to correct the request.</p>
  </div>`,
  );
}
