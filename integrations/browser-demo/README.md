# `@ship/browser-demo` — Authorization Code + PKCE in a real SPA

PRD p.8, option 3 (Browser SDK Demo). The **registered web app** that Testing
Scenario 2 (p.5) presumes exists, and the artifact MVP gate item 2 is proven
against.

Tickets: **PF-733 – PF-738** (lane L24, slice S4).

## What it is

A static single-page app. It signs a user in through Ship's own OAuth
authorization endpoint, exchanges the code with a PKCE verifier that never
leaves the browser, and lists that user's documents through `@ship/sdk`.

It has **no backend**. `vite build` produces `dist/`; anything that can serve
files can serve it.

## What it is not

- It has **no client secret**, and it authenticates as an RFC 6749 §2.1 *public
  client*. A single-page app cannot keep a secret — `view-source` is the whole
  attack — so it does not have one to keep.
- It has **no dev proxy**. It calls Ship cross-origin, which is what a third
  party's app actually does, and is why the public API needed its own CORS
  policy (L99 F38).
- It imports **only `@ship/sdk`** from this repository, per PRD p.11.

## Running it

```bash
# once, from the repo root
pnpm build:shared && pnpm --filter @ship/agent build && pnpm --filter @ship/sdk build

# a Ship to talk to, with a seeded user and a registered public app
pnpm db:migrate && pnpm db:seed

# the whole flow, in a browser, asserted
cd integrations/browser-demo
pnpm exec playwright test -c playwright.config.ts     # 7 tests: the flow
pnpm exec vitest run                                  # 5 tests: bundle + cursor
```

The Playwright config boots Ship and the static server itself and registers the
demo's OAuth app in `globalSetup`. `retries` is **0**, deliberately: a retry
turns a flaky drill into a green one (L99 F27), and the PKCE round trip is
either deterministic or it is broken.

## Build-time configuration

Vite inlines these; there is no runtime config fetch.

| Variable | Meaning |
|---|---|
| `VITE_SHIP_BASE_URL` | Origin of the Ship instance, e.g. `http://localhost:3124` |
| `VITE_SHIP_CLIENT_ID` | The **public** app registration. Not a secret. |
| `VITE_REDIRECT_URI` | Must match a registered redirect URI **byte for byte** |
| `VITE_SHIP_SCOPES` | Space-delimited. Defaults to `documents:read`. |

A missing one fails the build naming the variable, rather than failing at the
first click.

## Failure modes this demo documents (PRD p.12)

| Failure | What the user sees |
|---|---|
| Wrong `code_verifier` on the exchange | A visible error naming `invalid_grant`. Nothing is written to `localStorage`; the user is signed out and can retry. |
| Corrupted `localStorage` credential | Signed out, once. No retry loop, and the unparseable value is **left alone** — `clear()` is a write, and a value the SDK cannot read may still be one a human can repair. |
| `state` mismatch on the redirect | Nothing is exchanged; a visible error says the redirect did not match the request this tab started. |
| User clicks Deny | A visible message; signed out; retryable. |

## Where the size number lives

`test-results/bundle-size.json`, written by `tests/bundle.test.ts` on every run.
This package is the **only** place in the repository where `@ship/sdk` goes
through a real browser bundler, which is what makes it the detector for L99 F14
(a `node:crypto` import reachable from the package barrel).

Last measured: **6 798 B min+gzip**, against a 250 KB budget (p.9).
