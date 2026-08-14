# L24 · Secondary Integrations (5-of-7)

| | |
|---|---|
| **Agent** | `integrations-extra` |
| **Tier** | 8 — runs concurrently with L20, L23 |
| **Block** | PF-716–750 (29 used: PF-716–744; PF-745–750 reserved for audit and for a swap-in) |
| **Blocks on** | L18 (SDK resources, auth helpers, verifier — PF-521–555, not yet written); transitively L15/L16 (subscriptions, signing, retry, DLQ, replay), L06 (refresh rotation + family revocation) |
| **Unblocks** | nothing — this lane is a consumer, by construction |
| **PRD anchor** | p.8, *"Implement at Least 5 of the Following Integrations / Flows"* — seven options, five required |

**This lane ships four integrations, not five.** The fifth is the CLI, which is option 1 on p.8,
is marked `must-ship`, and is **L19's entire lane**. It counts toward the five and this file
tickets **nothing** for it. If you read this board looking for `ship login` / `ship docs` /
`ship webhooks tail`, they are in `lane-19-cli-integration.md` and they are not missing here.

**Everything under `integrations/` imports only `@ship/sdk`.** Critical Guidance, p.11:
*"External integrations live in integrations/ and import only @ship/sdk — never api/src/. Enforced
by a workspace dependency rule. This is what makes 'the agent is a platform citizen' true rather
than aspirational."* L01's PF-011 is the ESLint half and this lane depends on it; PF-717 below adds
the workspace-dependency half, which p.11 names separately and which the lint rule does not cover.

## The five — a recommendation, not a finding

The PRD names seven and requires five. It marks the CLI `must-ship` and Slack `should-ship`; the
other five it ranks not at all. **Everything below the first two rows is a judgement call and the
user can overrule any of it.** The board is structured so overruling is cheap: each integration owns
one contiguous ID range and one slice, so a swap is "delete slice S*n*, write a new one in
PF-745–750," not a re-plan.

| # | Option (p.8) | Verdict | Why |
|---|---|---|---|
| 1 | CLI tool with device flow | **ship — L19** | `must-ship` in the PRD's own marking; the demo video (p.12) and the TTFE drill (p.5, Scenario 9) are both this. Counted here, ticketed there. |
| 5 | Refresh-token rotation drill | **ship — S2** | Cheapest on the board. L06 builds rotation and family revocation because p.3 requires them regardless; this is test-authoring over machinery that must exist anyway, and it converts a checkbox into a proof. |
| 6 | Idempotency-Key end-to-end | **ship — S3** | Second cheapest, same reason: L15/L16 build replay and key pass-through for Scenario 8. What is missing is a **subscriber** that dedupes, and p.16 explicitly asks for the documented subscriber contract. Nothing else in the spine produces one. |
| 3 | Browser SDK demo | **ship — S4** | Buys three things nothing else does: the *registered web app* Testing Scenario 2 (p.5) presumes, the only consumer of the browser `ITokenStore` p.4 requires, and the only place the < 250 KB budget (p.9) is measured against a real bundler. See PF-738 — it will fail on first run, and that is the point. |
| 2 | Slack integration | **ship — S5** | The PRD's only `should-ship` after the CLI (p.8), named in the stack table (p.10), offered as the visual alternative in Pre-Search 1.3 (p.15), and baked into an interview question graders will ask (p.13). Most expensive of the four; also the only one that proves a genuinely external process consuming signed deliveries. |
| 4 | GitHub integration | **cut** | Most expensive, least graded. Needs a GitHub App (private key, installation tokens, an org to install into), plus an issue↔PR link model that does not exist in Ship's document schema. p.10 already marks the Octokit path `(stretch)`. |
| 7 | In-process plugin runtime | **cut** | p.8 marks it stretch and *explicitly experimental*. It also needs a `document.beforeCreate` hook that does not exist and cannot be added cheaply — L14 publishes **after commit** by design (PF-404), so a synchronous pre-write hook is a new seam in someone else's lane at tier 8. And `isolated-vm` is a native addon: if it ever landed in `@ship/sdk` it would blow the < 250 KB production-dependency budget (p.9) by itself. It must not. |

**Swap-in cost, if the user overrules.** GitHub in place of Slack: drop S5, keep PF-741's
signature-verification pattern, add ~6 tickets in PF-745–750 — but the GitHub App registration is
a real-world dependency this lane cannot satisfy from a keyboard. Plugin runtime in place of the
browser demo: same ID range, but it needs an L14 ticket for the pre-write hook first, and that is a
spine change. Dropping to four shipped integrations fails p.8 outright.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-716 | ☑ One workspace package per integration, each declaring `@ship/sdk` as its only Ship dependency | Every directory under `integrations/` carries a `package.json` whose `dependencies` include `"@ship/sdk": "workspace:*"` and **no other** `workspace:` entry. Third-party runtime deps are fine (`@slack/bolt`, `express`); Ship-internal packages are not. `integrations/cli` already satisfies this and is the template. A script parses each manifest and fails naming the offending package and the offending key | CTR:Public API Boundary | p.11, p.18 | PF-005, PF-011 |
| PF-717 | ☑ The **workspace dependency rule** is a real check, not the ESLint rule wearing a second hat | p.11 names a workspace dependency rule *and* p.18 names the lint rule; they catch different things. This ships the dependency-graph half as a blocking CI job that runs **before** lint, asserting PF-716's invariant. A fixture package declaring `"@ship/api": "workspace:*"` turns it red. Lint cannot catch that — a dependency can be declared, installed, and hoisted before a single `import` statement is written | CTR:Public API Boundary | p.11, p.18 | PF-716, PF-013 |
| PF-718 | ☑ A negative import fixture inside **each** new integration package, not one shared fixture | PF-012 ships one fixture per rule; this ships one per package, because the rule is keyed on the `integrations/**` glob and a file the glob does not reach escapes silently — a nested build output, a `.mts` extension, a `tsconfig` path alias resolving `@internal/*` to `api/src/*`. Acceptance: `pnpm lint` fails with the boundary message for a fixture in each of `slack`, `browser-demo`, `drills/refresh-rotation`, `drills/idempotency` | CTR:Public API Boundary | p.11, p.18 | PF-011, PF-012 |
| PF-719 | ☑ `integrations/README.md` is the 5-of-7 ledger, and it is machine-checked | Lists all seven options from p.8 with status `shipped` or `cut` plus one line of rationale each. A test asserts every `shipped` row names a directory that exists under `integrations/` **and** contains at least one test file, and that `shipped` rows number at least five. Without it, "at least 5" is a sentence in a PR description that nobody can falsify | — | p.8 | PF-716 |
| PF-720 | ☑ Every integration runs in CI behind a zero-tests-ran guard | One blocking job per integration package. Deleting every test from a package must turn its job **red**, not green — enforced by wrapping the run in `scripts/assert-tests-ran.sh <n>`, the guard this repo already applies to the agent and E2E suites. Silent empty suites are a live footgun here; `scripts/check-empty-tests.sh` exists in this repo for exactly that reason | — | p.18 | PF-719, PF-013 |
| PF-721 | ☑ One shared signed-delivery listener fixture, imported by every webhook-receiving integration | Exported `createTestListener()` captures **raw** body bytes plus headers and exposes `waitFor(predicate, { timeoutMs })` — the shape p.7's own drill example already assumes. A grep assertion proves exactly one implementation exists across `integrations/**`; the Slack tests and the idempotency drill import that one. Two listeners means two definitions of "the delivery arrived," and they diverge on raw-body handling first | — | p.7, p.6 | PF-716 |
| PF-722 | ☑ No integration holds a credential an external developer could not hold | Grep across `integrations/**` returns zero matches for `pg`, `DATABASE_URL`, `SESSION_SECRET`, and `api/src`. Each integration authenticates only with an OAuth `client_id`/`client_secret` or a token loaded through `ITokenStore`. The import rule stops compile-time cheating; this stops runtime cheating, and it is the half that makes *platform citizen* checkable rather than asserted | CTR:Public API Boundary | p.11, p.3 | PF-716 |
| PF-723 | ☑ `integrations/drills/refresh-rotation` gets its first token pair from a real flow, never a fixture | The drill authenticates through a genuine OAuth exchange against a booted Ship (device grant is cheapest from a headless drill) and asserts the access token answers 200 on `/api/v1/me` **before** any rotation assertion runs. No row inserted into a token table, no helper that mints a signed token; grep proves the package imports only `@ship/sdk`. A drill seeded with hand-made tokens measures the drill, not the platform | CTR:Refresh Tokens | p.3, p.8 | PF-722, PF-011 |
| PF-724 | ☑ Rotation is observable from the client: a presented refresh token is dead after one use | Exchange `R1` → receive `{A2, R2}`. Assert `R2 !== R1`; assert `A2` answers 200 on `/api/v1/me`; assert a second exchange presenting `R1` fails. All three go over HTTP through the SDK — the drill never inspects a database row. This is the one-time-use half only. A platform can pass this ticket and still fail PF-725, which is the clause that actually matters | CTR:Refresh Tokens | p.3, p.15 | PF-723 |
| PF-725 | ☑ The theft scenario: replaying a spent refresh token invalidates the **whole family** | Rotate three times (`R1`→`R2`→`R3`), then replay the long-spent `R1`. Assert afterwards that `R3` no longer exchanges **and** that `A3` — the access token issued alongside it, never itself stolen — returns 401 on `/api/v1/me`. A drill that only asserts `R1` now fails proves nothing beyond PF-724. p.3's Refresh Tokens row and p.15's Pre-Search 1.4 both state the guarantee as family-wide, and the access-token assertion is the only part of it a subscriber can see | CTR:Refresh Tokens | p.3, p.15 | PF-724 |
| PF-726 | ☑ The three failure shapes are distinguishable at the SDK boundary, and the drill prints them | Reused-family token, expired refresh token, and a syntactically valid but unknown token each produce a recorded outcome; the drill logs the SDK error and the raw response body for each so a CI reader can tell them apart. **We assert they are distinguishable, not what the codes are.** p.2 names distinct 401 codes for *bearer* tokens and RFC 6749's `invalid_grant` for the token endpoint; it specifies no code set for refresh failures, and inventing one here would bind L06 to a contract it never agreed to | — | p.2, p.15 | PF-725, PF-189 |
| PF-727 | ☑ `pnpm drill:refresh` is one command, sleeps for nothing, and goes red against a permissive server | Runs headless as a blocking CI job. Token expiry is produced by configuring a short TTL at boot, never by waiting — p.11 rules out `setTimeout` waits in tests by name and p.9 sets drill flake at zero over twenty consecutive runs. Anti-vacuity assertion: pointed at a stub token endpoint that cheerfully accepts a reused refresh token, the drill **fails**. A drill that cannot fail is a screenshot | — | p.11, p.9 | PF-725, PF-017 |
| PF-728 | ☑ `integrations/drills/idempotency` subscribes and receives the way a stranger would | Subscription created through `client.webhooks.create`; deliveries land at PF-721's listener over real HTTP. Grep proves no `pg` import and no read of `webhook_deliveries`. Every assertion in this slice is made from the **subscriber's** side, on purpose — the delivery log is the platform's own account of what it believes it sent, and this drill exists to check that account | CTR:Replay | p.4, p.11 | PF-721, PF-722 |
| PF-729 | ☑ The subscriber implements the dedupe contract, and the contract is written down | Listener keys on the inbound `Idempotency-Key` header, records seen keys, and on a repeat returns 200 **without** repeating its side effect. Test: two POSTs with one key → one side effect, two 200s. The contract — header name, key lifetime, expected response on a duplicate — is documented in `integrations/drills/idempotency/README.md`. Pre-Search 2.3 (p.16) asks for that document by name and no platform lane produces it | CTR:Replay | p.4, p.16 | PF-728 |
| PF-730 | ☑ Replay carries the **original** key, proven at the subscriber rather than in the portal | Deliver once; drive the delivery to the dead-letter queue; replay it through `/api/v1/webhooks/deliveries/:id/replay`; assert the replayed request's `Idempotency-Key` string-equals the first delivery's and the subscriber's side-effect count is still 1. Testing Scenario 8 asserts this from the developer portal — this asserts it at the far end of the wire, which is where the guarantee has to hold for it to mean anything | TS-8 | p.5, p.4 | PF-729 |
| PF-731 | ☑ Retries of one delivery share one key — a retry is not a new event | Subscriber returns 500 on three attempts and 200 on the fourth. Assert the four received requests carry four **identical** `Idempotency-Key` values and the side effect ran exactly once. Without this, a platform minting a fresh key per attempt still passes PF-729 and PF-730, and every subscriber that 5xx's once double-processes forever. Same fixture shape as Testing Scenario 7, asserted on the key rather than on the schedule | CTR:Replay | p.4, p.5 | PF-729 |
| PF-732 | ☑ Distinct events never share a key — the anti-vacuity direction | Create two documents; assert the two deliveries carry **different** keys and the subscriber performed two side effects. A platform emitting a constant key passes PF-729, PF-730 and PF-731 and fails only here. Pairs with L14's rule that `event.id` is the sole idempotency basis, so the key's provenance is one hop rather than a coincidence; p.18's Pre-Search 3.5 asks how reuse versus fresh keys shows up at all | CTR:Replay | p.4, p.18 | PF-731, PF-394 |
| PF-733 | ☑ `integrations/browser-demo` is a real bundled SPA served as static files | `pnpm -F @ship/browser-demo build` emits a static bundle; served against a booted Ship, the page lists the signed-in user's documents. No server process of its own beyond a static file server and no dev proxy that could smuggle in a server-side call — a demo with a backend is not a browser demo. The bundler is a devDependency; `@ship/sdk` is the only runtime Ship dependency | — | p.8, p.11 | PF-716, PF-722 |
| PF-734 | ☑ Authorization Code + PKCE runs in the browser and the verifier never leaves it | Playwright drives the demo: `/oauth/authorize` → consent → redirect back → token exchange → documents rendered. Network assertions: `code_verifier` appears **only** in the `/oauth/token` request body, never in a URL, query string, or `Referer`; a grep over the built assets finds no `client_secret`. This is the *registered web app* Testing Scenario 2 presumes — without it, L04's Playwright test drives a fixture page that ships to nobody | MVP-2, TS-2 | p.2, p.5 | PF-733 |
| PF-735 | ☑ The mandatory negative case, surfaced as UI state rather than a swallowed rejection | Playwright forces a wrong `code_verifier` on the exchange. Assert the demo renders a visible error, writes **nothing** to `localStorage`, and leaves the user logged out and able to retry. p.5 calls the negative case mandatory rather than optional. L04 owns the server returning `invalid_grant`; this owns a consumer that handles it without stranding the user half-authenticated | TS-2 | p.5, p.2 | PF-734 |
| PF-736 | ☑ The browser `ITokenStore` finally has a consumer, and its corruption contract holds | The demo persists through the SDK's `localStorage` store — the third implementation p.4 names alongside in-memory and file, and the only one with no consumer anywhere in the plan. Test: write garbage into the storage key, reload; the demo shows logged-out, performs no retry loop, and does not write a partial credential back. `sdk/src/auth/tokenStore.ts` already states that contract in a comment; nothing in the repo exercises it, and p.12 requires the corrupted-token-store failure mode to be documented | CTR:OAuth Helpers | p.4, p.12 | PF-734 |
| PF-737 | ☑ The document list is driven by the async iterator; the demo never sees a cursor | List rendered by `for await (const doc of client.documents.iterate())`; grep over `integrations/browser-demo/src/**` returns zero matches for `cursor` and `next_cursor`. Consumer-side mirror of L08's PF-233, which pins the same contract from the server side. If either side needs the other's internals to pass, the cursor is not opaque and p.4's "consumer code never sees them" is false | CTR:Async-Iterator Pagination | p.4 | PF-733, PF-233 |
| PF-738 | ☑ The demo's bundle is where the SDK install-footprint budget gets measured — and it fails on the first run | CI measures the `@ship/sdk` share of the demo's production bundle (minified + gzipped), fails above 250 KB, and publishes the number as a build artifact. Second assertion, and the reason this ticket exists: **`sdk/src/index.ts` re-exports `verifyWebhook` from `sdk/src/webhooks.ts`, which top-level-imports `node:crypto`** — a browser bundler either errors or silently polyfills a crypto shim into every consumer's bundle. Test asserts no such polyfill appears in the built output. The fix belongs to the SDK lanes; the browser demo is the only artifact in the repo capable of detecting it | — | p.9, p.15 | PF-733 |
| PF-739 | ☑ `integrations/slack` is an Express + `@slack/bolt` listener with `@ship/sdk` as its only Ship dependency | The stack p.10 names for this integration. Boots from `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, a Ship OAuth `client_id`/`client_secret`, and the subscription signing secret — nothing else. A missing variable fails at boot naming the variable, never at first delivery, because a listener that boots and then silently drops signed deliveries is the worst failure available during a graded demo. The package's own lint fixture (PF-718) proves an `api/src` import is a build failure | CTR:Public API Boundary | p.10, p.11 | PF-718, PF-722 |
| PF-740 | ☑ Slack OAuth install, so posting is authorized by a workspace rather than a pasted token | Install URL → Slack consent → `/slack/oauth/callback` → bot token persisted per workspace → `chat.postMessage` succeeds into a channel the bot has joined. A `SLACK_BOT_TOKEN` environment shortcut is explicitly out of bounds: p.8 names Slack OAuth as part of what this integration *is*, and a pasted token proves neither the install flow nor the multi-workspace shape | — | p.8 | PF-739 |
| PF-741 | ☑ The Ship signature is verified before anything else happens, over the **raw** body | The handler is gated by `verifyWebhook(headers, rawBody, secret)`. Three cases, three assertions: a tampered body → 4xx and no Slack message; a `t` six minutes old → 4xx and no Slack message; a valid delivery → message posted. Route-level raw-body capture is mandatory and is the classic bug in this integration — an app-wide JSON parser re-serializes the exact bytes the HMAC covers, after which the verifier rejects every legitimate delivery and the integration looks broken end to end | CTR:Webhook Verifier | p.4, p.7 | PF-739, PF-721 |
| PF-742 | ☑ Exactly two event types post, and a third arriving posts nothing | Subscriptions created through the SDK for `document.created` and `issue.assigned` only — the two p.8 names. A `document.updated` delivery reaching the listener produces zero Slack API calls. The message renders the id, a link back to Ship, and the `title` **only when the payload carries one**: L14's payload rule is identifiers plus title with title suppressed on private documents, so the renderer must degrade to id-and-link rather than fetching content it was deliberately not sent | — | p.8, p.3 | PF-741, PF-408, PF-410 |
| PF-743 | ☑ The whole path, UI to Slack channel, is one executable test that names every boundary it crosses | A document created through Ship's **internal** UI path — not `/api/v1` — lands as a message at a stubbed Slack API. The test asserts each hop in order: domain service → `IEventBus` → subscription matcher → signer → deliverer → this listener → Slack Web API. p.13's interview question asks for exactly this walk, and a test answers it with a run rather than a whiteboard. Doubles as the cross-surface proof for L14's one-publish-both-surfaces rule, from the far side | — | p.13, p.12 | PF-742, PF-405 |
| PF-744 | ☑ Slack being down must not corrupt Ship's retry semantics | With the Slack API returning 500, the listener returns 5xx so Ship retries on schedule. With Slack returning `channel_not_found`, the listener returns 4xx so the delivery dead-letters immediately instead of burning six attempts on a channel that no longer exists. **Decision, ours:** the subscriber classifies its own upstream, because only the subscriber can distinguish a transient Slack outage from a permanent misconfiguration. Pre-Search 2.3 (p.16) asks this question from the platform's side; this is the subscriber's side of the same answer, and it is the only place in the plan where a real subscriber makes the call | — | p.4, p.16 | PF-741 |


## Landed — S4 `pf/L24-browser-pkce` (2026-08-13)

**PF-733 – PF-738 are ☑.** Every number below was produced by a run, on this branch,
against a really booted Ship (`api/src/index.ts`, port 3124) and the lane database
`ship_l24` on 5432. Nothing here is a reading of the source.

| Ticket | Evidence |
|---|---|
| PF-733 | `pnpm -F @ship/browser-demo build` emits `dist/` (one HTML + one JS chunk). Served by `vite preview` on `:4173` — a static file server with **no** proxy configured, cross-origin from Ship. `@ship/sdk` is the only runtime dependency; `vite`, `typescript`, `vitest`, `@playwright/test` are dev. |
| **PF-734** | `tests/pkce.spec.ts` — 4 tests, all passing. Full round trip `/oauth/authorize` → consent → `Allow` → redirect → `POST /oauth/token` → documents rendered. Network assertion over **every** recorded request: the verifier this run generated appears in no URL, no `Referer`, and in exactly one body — the token request's. Positive half asserted too (`code_challenge_method=S256`, 43-char challenge ≠ verifier) so the negatives cannot pass vacuously. |
| PF-735 | 1 test. Verifier corrupted between the legs via an `addInitScript` on the demo's origin — no `fetch` patch, no second app. Asserts: visible error containing `invalid_grant`, **HTTP 400 on the wire**, `localStorage` still `null`, logged-out screen, sign-in re-enabled. |
| PF-736 | 2 tests. Garbage written into `ship.sdk.credentials` → reload → logged out, and the garbage is **still there** (no write-back, per the SDK's PF-508 contract). Anti-vacuity twin: an intact credential survives a reload with no second trip through `/oauth/authorize`. |
| PF-737 | `tests/bundle.test.ts` — zero matches for `cursor`/`next_cursor` across `src/` (comments stripped, see L99 F72), plus the anti-vacuity assertion that `for await (const doc of client.documents.iterate())` is actually the list driver. |
| PF-738 | Measured against a real bundler: **6 798 B min+gzip** against the 250 KB budget (p.9) — 249 202 B of headroom. Published to `test-results/bundle-size.json`. No `node:crypto`, no crypto polyfill, no `Buffer` shim, and `verifyWebhook` absent from the browser build. **L17's PF-507 held; L99 F14 stays closed.** |

**Totals: 7 Playwright + 5 vitest = 12 passing, 0 failing, 0 skipped.**

```
integrations/browser-demo $ pnpm exec playwright test -c playwright.config.ts   →  7 passed (8.8s)
integrations/browser-demo $ pnpm exec vitest run                                →  5 passed
api                       $ vitest run src/platform/oauth/publicClient.test.ts  → 10 passed
```

### What had to be unblocked first, and it was not in this lane

PF-734 was **unreachable as written** on `pf/integration`. Two server-side defects, both
already recorded against other lanes, both still open when this slice started:

- **L99 F27 / F50** — `/oauth/token` refused any client that presented no `client_secret`,
  so a browser SPA could only pass by publishing a secret in its bundle. Closed by
  migration **074** (`oauth_apps.is_public`) plus a narrow change to `authenticateClient`.
  See L99 **F70** for the four-way test and the no-downgrade property.
- **L99 F38** — `/api/v1` served no CORS headers, so a cross-origin browser consumer could
  not read a response at all. Closed by `api/src/platform/publicCors.ts`. See L99 **F71**.

Both are flagged for their owner lanes to adopt. The internal middleware stack is unchanged
— PF-018's snapshot excludes the `/api/v1` and `/oauth` mounts, so nothing moved.

### Not done in this slice

PF-716 – PF-722 (S1, the boundary harness), PF-723 – PF-732 (S2/S3 drills) and
PF-739 – PF-744 (S5, Slack) are untouched. PF-719's 5-of-7 ledger is deliberately **not**
written yet: it asserts at least five `shipped` rows naming directories that exist, and
today `integrations/` holds two (`cli`, `browser-demo`). Writing the ledger now would mean
writing a claim that is false.

## Landed — S1, S2, S3, S5 and the ledger (2026-08-14)

**PF-716 – PF-744 are ☑. The lane is complete.** Every number below came from a
run on these branches, against a really booted Ship and the lane database
`ship_l24b` on 5432. Nothing here is a reading of the source.

| Slice | Branch | Evidence |
|---|---|---|
| S1 | `pf/L24-integration-boundary` | `pnpm lint:boundary` → **10 fences**, positive control clean · `pnpm check:integration-deps` → 3 negative fixtures rejected, 1 `ok-*` control accepted · `pnpm check:integration-credentials` → 30 integration + 30 harness files, all four patterns caught their fixture · `@ship/integration-testkit` **11 passed** |
| S2 | `pf/L24-refresh-rotation-drill` | `pnpm drill:refresh` → **21 passed**, 0 failed, 16 s, against two booted Ships |
| S3 | `pf/L24-idempotency-drill` | `pnpm drill:idempotency` → **14 passed**, 0 failed, 26 s |
| S5 | `pf/L24-slack-listener` | `pnpm --filter @ship/slack test` → **17 passed** · `pnpm slack:live` → **5 passed** (PF-743's seven-hop walk) |
| ledger | `pf/L24-five-of-seven-ledger` | `@ship/integration-testkit` → **19 passed** (8 of them the ledger); anti-vacuity probe: pointing one row at a directory that does not exist turns 3 of them red |

**Totals across the lane: 12 (S4, already landed) + 11 + 21 + 14 + 22 + 8 = 88 passing, 0 failing, 0 skipped.**

### PF-719 can now honestly assert five

`integrations/` holds `cli`, `browser-demo`, `slack`, `drills/refresh-rotation`
and `drills/idempotency` — five integrations, each with at least one test file,
each named by a `shipped` row. `testkit` is the sixth package and is **not** a
ledger row: it is PF-721's shared fixture, a `devDependency` of its consumers and
a runtime dependency of none, and the ledger test names that exception explicitly
so a *second* unlisted package fails.

The ledger test also checks the direction PF-719 does not ask for: all seven of
p.8's options appear exactly once. Dropping a row would otherwise let the table
claim "five of five" while the PRD asked for five of seven.

### Decisions taken in these slices, and the ones that are not the PRD's

- **PF-722's literal criterion is wrong, and the shipped check is split by role.**
  Run as written — zero matches for `pg`, `DATABASE_URL`, `SESSION_SECRET`,
  `api/src` across `integrations/**` — it fails **seven** times on this tree and
  not one is a violation: an honest test naming `api/src`, and two harnesses
  forwarding an operator's `DATABASE_URL` to an operator's subprocess. The
  integration itself gets all four patterns and no exceptions; tests and runner
  configs keep `pg` and `SESSION_SECRET` absolutely. The load-bearing half
  survives — a package that never imports `pg` cannot open a connection. **F150.**
- **PF-739's `@slack/bolt` is not what shipped.** `@slack/web-api` is, and the
  reason was measured rather than argued. **F153.**
- **A new boot knob in `api/src/deps.ts`.** `SHIP_ACCESS_TOKEN_TTL_SECONDS` /
  `SHIP_REFRESH_TOKEN_TTL_SECONDS`, default-off. The `TokenTtlConfig` seam
  already existed and its own comment said it was there "so a drill can boot with
  a 2-second access TTL" — nothing wired it to a boot value, so the only way in
  was `testDeps`, which is in-process and useless to a drill that talks HTTP.
  **L06's file; please adopt. F154.**
- **One devDependency exception to the one-element `ALLOWED_INTEGRATION_DEPS`
  set.** `@ship/integration-testkit`, and in `devDependencies` only. PF-721 wants
  exactly one listener shared by two packages, which is a workspace dependency by
  construction; the front-door claim is about what an integration's *process*
  depends on, so the runtime allowlist is untouched and `integrations/cli` still
  declares `@ship/sdk` alone.

### Two defects found by running, not by reading

- **The shared listener's waiter drain was an infinite loop.** `while
  (waiters.length > 0) waiters.pop()()` — a waiter whose predicate is still false
  re-registers itself, so the loop never empties. It hung the idempotency drill
  for twelve minutes at 98% CPU. It could not have been caught by the testkit's
  own suite, where every predicate is satisfied by the first request. **F151.**
- **`type-check` is `tsc -b`, which EMITS.** So `integrations/testkit/dist` can be
  stale-but-present, and a consumer resolving the package through its `exports`
  map runs old code while the source looks right. That is what made the bug above
  survive its own fix for one run. `pnpm drill:*` and the CI matrix now build the
  testkit first. **F152.**

### Still not proven, and it is the same gap the lane file predicted

**No integration here has been verified against a deployed Ship reaching a
deployed listener.** Every webhook-receiving test targets `127.0.0.1` behind
`SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS`, and that variable is set on no deployed
instance. That is L99 **U6**, unchanged, and it is a hosting question owned by
L21/L26.

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L24-<slug>`; the PR body names the
acceptance criterion each slice advances and confirms its fitness test passed. **S2–S5 are one
integration each and are independent of one another** — that is what makes the 5-of-7 recommendation
cheap to overrule: dropping an integration is dropping one slice and one contiguous ID range.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L24-integration-boundary` | PF-716–722 | p.11's Critical Guidance made mechanical: integrations import only `@ship/sdk`, hold no privileged credential, and the 5-of-7 claim is checkable | Fixture package declaring `@ship/api` fails CI before lint runs; per-package import fixtures each fail `pnpm lint`; grep finds zero `pg`/`DATABASE_URL`/`api/src` under `integrations/`; deleting a package's tests turns its job red |
| S2 | `pf/L24-refresh-rotation-drill` | PF-723–727 | Option 5 (p.8) and the Refresh Tokens row (p.3): one-time-use rotation, and reuse invalidating the family | `R1` replay kills `R3` **and** `A3`; three failure shapes distinguishable; drill fails against a stub that accepts a reused token; no `setTimeout` anywhere in the drill |
| S3 | `pf/L24-idempotency-drill` | PF-728–732 | Option 6 (p.8) and the Replay row (p.4): a real subscriber that dedupes, asserted at the subscriber | Duplicate key → one side effect; replay carries the original key; four retry attempts share one key; two events carry two keys |
| S4 | `pf/L24-browser-pkce-demo` | PF-733–738 | Option 3 (p.8): the registered web app Scenario 2 presumes, the browser token store p.4 requires, and the only real measurement of the p.9 size budget | Verifier appears only in the token request body; wrong verifier renders an error and writes no tokens; corrupted `localStorage` reads as logged out; no `cursor` in demo source; bundle under 250 KB with no `node:crypto` polyfill |
| S5 | `pf/L24-slack-listener` | PF-739–744 | Option 2 (p.8), `should-ship`: an external process that installs via Slack OAuth, verifies Ship signatures, and posts two event types | Tampered body and stale timestamp both post nothing; `document.updated` posts nothing; internal-UI document creation reaches a stubbed Slack API through every named hop; Slack 500 → 5xx, `channel_not_found` → 4xx |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **The five is a recommendation and the whole board says so.** The PRD ranks only two of the seven
  (CLI `must-ship`, Slack `should-ship`, both p.8). Everything else in the table at the top of this
  file is judgement. If the user prefers GitHub over Slack, or the plugin runtime over the browser
  demo, delete the slice and write the replacement in PF-745–750; nothing outside that slice moves.
  The one substitution I would argue against is dropping the browser demo, because PF-734 is
  carrying `MVP-2`/`TS-2` weight that no other ticket in this lane carries.
- **Why GitHub is cut, in one line each.** It needs a GitHub App — a private key, installation
  tokens, and an organization to install into — which is an external registration this lane cannot
  complete from a keyboard on a Sunday deadline. It also needs an issue↔PR link model that Ship's
  document schema does not have, so it is not only an integration but a schema change in L09/L10's
  territory. p.10 already marks the Octokit route `(stretch)`.
- **Why the plugin runtime is cut, and the part that is not a judgement call.** p.8 marks it stretch
  and *explicitly experimental*, which is the soft half. The hard half: it wants a
  `document.beforeCreate` hook, and L14 (PF-404) publishes **after commit** by design. A synchronous
  pre-write hook is a new seam in the domain layer, owned by another lane, at tier 8, with the MVP
  gate already behind us. Separately, `isolated-vm` is a native addon — if it were ever pulled into
  `@ship/sdk` it would exceed the < 250 KB production-dependency budget (p.9) on its own. It belongs
  in `api/src/platform/`, never in the SDK, and this lane would not be its owner either way.
- **PF-738 is a real, verified repo finding and its fix is not mine.** `sdk/src/index.ts` re-exports
  `verifyWebhook` from `sdk/src/webhooks.ts`, and that module has `import { createHmac,
  timingSafeEqual } from 'node:crypto'` at the top level. A browser bundler consuming the package
  barrel will either fail to resolve it or inject a crypto polyfill into every consumer's bundle,
  against a 250 KB budget. The source comment in `webhooks.ts` already says the browser demo should
  use a server-side endpoint, which acknowledges the constraint without solving the barrel problem.
  **L17 found this independently** — its PF-507 (`LocalStorageTokenStore` + a browser entry point)
  carries a `⚑` on the same barrel problem, and PF-514 owns the size budget. So PF-738 is not the
  discovery, it is the *detector*: L17 owns the packaging fix, and the browser demo's real bundle is
  the only artifact in the repo that proves the fix worked. Sequence PF-738 after PF-507 or it fails
  for a reason nobody in this lane can fix. No L99 entry needed.
- **PF-721's listener fixture will collide with L20.** The TTFE drill (p.7's example code) needs the
  same `testListener` shape. One implementation, imported by both, is correct; two is duplication
  that will diverge on raw-body handling first, and raw-body handling is what PF-741 exists to
  protect. L20 is unwritten, so this is prose here rather than a Dep. If L20's file, when it lands,
  declares its own listener, that is the thing to flag.
- **`Advances` on PF-730 overlaps L16 and L22 on `TS-8`, deliberately.** Scenario 8 has a portal half
  (DLQ visible, click Replay) and a wire half (the replayed delivery carries the original key). L16
  and L22 own the first; PF-730 owns the second and asserts it at the subscriber rather than in the
  delivery log. If the audit reads the overlap as double-counting, demoting PF-730 to `CTR:Replay`
  is defensible and costs nothing.
- **Deps cells stop at L01/L03/L07/L08/L13/L14 on instruction, and are therefore under-stated.**
  L15–L18 landed while this file was being written; their real, verified IDs are named here in prose
  so the board can be re-pointed in one pass rather than re-derived. PF-723/724/725 need L06's
  rotation (unwritten). PF-728 needs L18's `client.webhooks` (PF-524) and L16's key derivation
  (PF-469). PF-730 needs L16's replay endpoint and original-key link (PF-476, PF-477) and is the
  subscriber-side twin of L16's PF-481. PF-731's fixture is L16's PF-451 ladder. PF-734/735 need
  L18's `authorizationCodeFlow()` (PF-539). PF-736 needs L17's `LocalStorageTokenStore` (PF-507).
  PF-737 needs L18's `iterate()` (PF-533). PF-738 needs L17's PF-507 and PF-514. PF-741 needs L18's
  `verifyWebhook` signature (PF-542) and L15's golden vectors (via PF-543).
- **PF-726 refuses to assert error codes on purpose.** p.2 specifies distinct 401 codes for *bearer*
  tokens and `invalid_grant` for a mismatched PKCE verifier. It says nothing about what a reused or
  expired **refresh** token returns. The ticket asserts the three cases are distinguishable and
  prints them; it does not name codes, because naming them here would silently write L06's contract
  from a consumer lane. L99's U3 already flags that OAuth-endpoint errors have no slot in the
  `ApiError` union — same seam, different symptom.
- **PF-744 is a decision, not a requirement.** Pre-Search 2.3 (p.16) asks whether 4xx is always
  permanent or whether the answer is more nuanced, and offers the 410-permanent / 429-transient
  example. L99's D9 has it open and awaiting L16. PF-744 answers only the **subscriber's** half —
  the Slack listener maps its own upstream failures onto Ship's transient/permanent contract — and
  it stays correct under either resolution of D9, because it is choosing which status *to return*,
  not how to interpret one. If L16 lands a nuanced classifier, PF-744's assertions hold unchanged.
- **The Slack MCP tooling in this environment is a red herring and I checked.** `.mcp.json` in this
  repo configures exactly one server, `playwright`. The `slack:*` skills and the `plugin_slack_*`
  tools come from a user-level Claude Code plugin operating on the developer's own Slack workspace;
  they are authoring tooling, they cannot receive an HTTP webhook, and they have no bearing on
  `integrations/slack`. Do not let their presence suggest any of PF-739–744 is already half-built.
- **What I could not ticket.** The PRD never says what a Slack message should contain, never sets a
  retention or replay window for the idempotency drill's key store, and never specifies which OAuth
  flow the browser demo's app registration uses beyond "Authorization Code + PKCE." Message contents
  (PF-742) and the dedupe key contract (PF-729) are ours and are marked as such rather than given a
  manufactured citation. I also could not ticket anything that verifies the deployed Slack listener
  is reachable from the deployed Ship instance — that is a hosting question belonging to L21/L26,
  and it is the single largest execution risk in S5: the listener needs a public URL before any of
  PF-741–744 can run against the graded environment rather than against localhost.
- **Not covered here, on purpose:** the CLI (L19, option 1 — counted toward the five, ticketed
  there); refresh rotation and family revocation themselves (L06 — this lane only drills them);
  replay, the DLQ, and `Idempotency-Key` minting (L15/L16 — same); the browser `localStorage`
  `ITokenStore` implementation (L17/L18 — PF-736 is its first consumer, not its author); the agent
  rewire, which is the other consumer of the same boundary (L23); and the portal-side answer to
  p.18's *"Could you tell whether a subscriber's dedupe is working from your portal alone?"* (L22).
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
