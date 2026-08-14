# L17 · SDK Core: Client, Errors, Token Store

| | |
|---|---|
| **Agent** | `sdk-core` |
| **Tier** | 5 — runs concurrently with L15 |
| **Block** | PF-491–520 (25 allocated, 5 reserved for audit) |
| **Blocks on** | L13 (PF-351–378 — the generated spec the SDK's types answer to); transitively L01 (PF-003 workspace registration, PF-004 package manifest, PF-006 strict tsconfig, PF-008 type-check), L07 (PF-186 code union, PF-189 kind mapping), L08 (PF-223/PF-224 page envelope) |
| **Unblocks** | L18 (resource clients, auth helpers, verifier) — and through it L19 CLI, L23 agent rewire, L24 integrations |
| **MVP gate** | Item 8 (p.2) — *"SDK skeleton exists in a pnpm workspace package; `new ShipClient({ token }).me()` against a running server returns the typed authenticated user"* |

**What this lane owns and where it stops.** The `@ship/sdk` package foundation: the client, the
transport, the typed error union, the pluggable `ITokenStore`, client-side retry/backoff, rate-limit
header parsing, and the install-footprint budget. Resource clients beyond the transport seam, the
OAuth helper flows, async-iterator pagination on every resource and `verifyWebhook` are **L18's** —
this lane ships the one surface MVP gate item 8 names and the machinery every later surface hangs on.

**Three facts about the package that shape every ticket:**

1. **`sdk/` has no `dependencies` key at all today** (`sdk/package.json`) — only devDependencies
   (`typescript`, `vitest`, `@types/node`, `@vitest/coverage-v8`). Zero production deps is the
   starting position, and p.9's *"SDK install size (production deps only)"* target of *"< 250 KB minified +
   gzipped"* is trivially met **until the first `dependencies` entry lands**. The budget ticket
   exists to make that entry a deliberate, measured act rather than an accident.
2. **No lint rule keeps `api/src/` out of `sdk/`.** `eslint.config.js` has three boundary blocks —
   `api/src/platform/**` may not import internal routes (line 130), `platform/**` may not import
   internal middleware (line 144), `integrations/**` may import only `@ship/sdk` (line 157). None
   of them names `sdk/`. The package a stranger installs is the one package with no import fence
   around it, and a single `import { ... } from '../../api/src/...'` makes it unpublishable.
3. **`sdk/` is not in CI.** `.github/workflows/ci.yml` runs vitest for `@ship/api`, `@ship/web` and
   `@ship/agent`. There is no `@ship/sdk` step, so every test this lane writes runs on a laptop and
   nowhere else until PF-515 lands.

**The sketches are spikes.** `sdk/src/{client,errors,pagination,webhooks}.ts`, `auth/tokenStore.ts`,
`auth/flows.ts` and `resources/documents.ts` exist and compile. They are the shape of the answer, not
the answer — `flows.ts` is a `export {}` with a TODO block, `client.ts` has `TODO(josh): wire
refresh`, `errors.ts` carries a comment that is factually wrong (PF-499), and `client.ts`'s options
type does not admit the MVP gate's own example (PF-491). Do not mark anything done because a file
exists.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-491 | ☑ `new ShipClient({ token })` compiles with **no** `baseUrl` — the gate's literal example | ⚑ **Verified defect:** `ShipClientOptions.baseUrl` is `string` (required) in `sdk/src/client.ts:13`, so the MVP gate's own expression `new ShipClient({ token })` is a type error today. Make `baseUrl` optional with a documented default resolution order (explicit option → `SHIP_BASE_URL` env → the published instance URL) and ship a `@ts-expect-error`-free fixture that constructs the client exactly as p.2 writes it. A gate item that does not typecheck fails on a screenshot | MVP-8 | p.2 | PF-004 |
| PF-492 | ☑ `.me()` against a **running server** returns the typed authenticated user | The gate is an integration assertion, not a unit test: boot the app, mint a token for a registered app, `await new ShipClient({ token, baseUrl }).me()`, and assert the resolved value's `app.client_id`, `user` and `scopes` are populated — with the call site typed such that `me.app.client_id` compiles and `me.app.nonexistent` does not. A mocked `fetch` cannot satisfy this ticket **Verified 2026-08-13:** Proved by sdkOAuthFlows.test.ts against a genuinely listening server (server.listen, real device-flow token): me.app.client_id, me.user.id and me.scopes all asserted, plus a @ts-expect-error proving me.app.nonexistent does not compile. | MVP-8 | p.2 | PF-491, PF-493 |
| PF-493 | ☒ `Me` is the shape `/api/v1/me` actually returns, asserted against the spec | `Me` (`client.ts:21`) is hand-declared: `{app:{client_id,name}, user:{id,name}\|null, scopes:string[]}`. A test asserts it against the served spec's `me` response schema rather than against another hand-written literal. ⚑ **Sequencing:** `/api/v1/me` is **L10's** route and L13 ships `documents` only (PF-363 asserts `/me` is *absent* from the spec) — so this assertion has nothing to run against until L10 lands. See audit notes; this is a real hole in the spine's dependency row for this lane | MVP-8 | p.2, p.5 | PF-492, PF-378 |
| PF-494 | ☑ Base-URL joining preserves a path prefix on the instance URL | `new URL('/api/v1' + path, baseUrl)` (`client.ts:46`) resolves an **absolute** path against the origin, so `baseUrl: 'https://host/ship'` silently becomes `https://host/api/v1/...` and every call 404s. Table test: bare origin, origin with a trailing slash, origin with a path prefix, and a prefix without a trailing slash all produce the same, correct four URLs. A grader deploying behind a path prefix hits this before anything else | MVP-8 | p.2 | PF-491 |
| PF-495 | ☑ One transport — exactly one place in `sdk/` calls `fetch`, sets `Authorization`, and reads the error body | Grep assertion over `sdk/src/**`: the literal `fetch(` appears in one module; every resource client receives the injected `Transport` (`resources/documents.ts:22`) and constructs no request of its own. Second assertion: no code path stringifies a token into a log, an error message, or a thrown `Error.stack`. This is the seam L18's four resource clients and both auth helpers plug into — two transports means two auth behaviours and two retry policies | — | p.10, p.12 | PF-491 |
| PF-496 | ☑ Zero-polyfill runtime — global `fetch`, declared engines, no `node-fetch` | `package.json` declares `engines.node` at a version with global `fetch` (≥18), the browser build uses the same global, and a test asserts `dependencies` contains no HTTP client. Drill stage 1's expected outcome (p.8) is *"Workspace package resolves; types load in editor"* plus no *"peer-dependency errors"* — a polyfill dependency is the cheapest way to fail all three and the fastest way to spend the p.9 size budget | TS-9 | p.8, p.9 | PF-495 |
| PF-497 | ☑ `ShipErrorKind` is exactly five members and an exhaustive `switch` compiles without a default | Exported union `'auth' \| 'rate_limit' \| 'not_found' \| 'validation' \| 'server'` (p.4). Fixture: a `switch (err.kind)` covering five cases assigned to `never` in the unreachable branch typechecks; deleting one case fails `pnpm type-check`. p.4 requires *"Consumers can switch on kind exhaustively"* — that is a compile-time property, so the proof has to be a compile-time proof, not a runtime test | CTR:Typed Error Union | p.4 | PF-186 |
| PF-498 | ☑ The code→kind mapping is **6→5** data with an exhaustiveness test in both directions | Server ships six `ApiErrorCode`s (p.7: `unauthorized`, `forbidden`, `not_found`, `validation_failed`, `rate_limited`, `server_error`); the SDK ships five `kind`s. `unauthorized` **and** `forbidden` both map to `auth`. Test asserts (a) every one of the six codes maps to exactly one kind, (b) every one of the five kinds is reachable from at least one code, (c) the SDK's key set string-equals L07's `API_ERROR_CODES` (PF-186). Adding a seventh server code fails the SDK suite by name | CTR:Typed Error Union | p.4, p.7 | PF-497, PF-189, PF-186 |
| PF-499 | ☑ Delete the "Maps 1:1" comment — it is false and it is load-bearing | `sdk/src/errors.ts:4` states *"Maps 1:1 from the server's ApiError envelope codes."* The map three lines below it (`KIND_BY_CODE`, lines 41–48) is 6→5. Same defect L07 records as its `errors.ts` sketch finding and L99 files as **F6**. The comment is what makes a reader believe `kind` can be used where the server's `code` is meant — the exact mistake PF-500 exists to prevent. Acceptance: the comment states the collapse and names the two codes | — | p.4, p.7 | PF-498 |
| PF-500 | ☑ `ShipError` preserves the server `code`, so `kind: 'auth'` still splits into refresh vs. re-consent | Collapsing `unauthorized` and `forbidden` into one kind destroys the distinction L03 calls *"what tells an SDK to refresh a token vs. re-consent"* (PF-071). `ShipError` therefore carries the raw `code` alongside `kind`, plus `details.required_scope` for the 403 case (PF-069's machine-readable field). Test: a 403 from a scope-gated route yields `kind:'auth'`, `code:'forbidden'`, and a `required_scope` a caller can pass straight into a re-consent flow. Without this, L18's auth helpers cannot tell the two apart and would retry a 403 forever | CTR:Typed Error Union | p.3, p.4 | PF-498, PF-069, PF-071 |
| PF-501 | ☑ Kind derivation when the body is missing, truncated, or not JSON — table-tested | `errorFromResponse` (`errors.ts:50`) falls back to status when `body.code` is unknown, and its fallback chain ends at `'server'` for anything unmatched — so a 400 with a proxy's HTML body becomes `kind:'server'`. Table: 401/403/404/422/429/500/502 × {valid envelope, `null` body, HTML body, JSON with an unknown `code`}. Every cell asserts a kind, and 4xx-with-no-envelope must **not** land on `'server'`. A reverse proxy between the SDK and Ship is the normal case, not the exotic one | CTR:Typed Error Union | p.4, p.7 | PF-497 |
| PF-502 | ☑ `request_id` and `details` survive onto the thrown error, and `ShipError.message` is usable unmodified | Every `ShipError` from a Ship response carries `requestId` (p.7's `request_id`, which L07's PF-191 guarantees on *every* failure) and the server's `message`. Test asserts a support-shaped path end-to-end: force a `server_error`, catch, and assert the caught error's `requestId` string-equals the `X-Request-Id` response header. An SDK that swallows the request id makes every support ticket unanswerable | CTR:Typed Error Union | p.4, p.7 | PF-501, PF-191 |
| PF-503 | ☑ `ITokenStore` is three methods, documented where a consumer will find it | `load(): Promise<StoredTokens \| null>` / `save(tokens): Promise<void>` / `clear(): Promise<void>` (`auth/tokenStore.ts:18`), exported from the package barrel with the contract stated in the doc comment **and** in `docs/architecture.md`'s SDK Surface section — Pre-Search 2.4 (p.17) asks *"Where does ITokenStore's contract live"* and the answer must be a location, not a shrug. Test asserts the interface is exported from the package root and that a third-party class implementing exactly those three methods satisfies it structurally | CTR:OAuth Helpers | p.4, p.17 | PF-004 |
| PF-504 | ☑ **Decision:** `StoredTokens` persists the refresh token, not only the access token | Pre-Search 2.4 (p.17): *"does it persist refresh tokens too, or only access tokens?"* Answer here is **both** — `{accessToken, refreshToken \| null, expiresAtSeconds \| null, scopes[]}`, which is what the sketch already declares. Rationale: p.3 mandates one-time-use refresh tokens with rotation and family revocation, and the drill's stage-2 outcome — the token *"persists in configured store"* (p.8) — is measured across process restarts; an access-token-only store makes `ship login` a per-invocation device flow, which fails TTFE on the second command. Cost, stated in the doc: the file store now holds a credential whose theft is worth more, hence PF-506's 0600. **This is L99's decision D8 first half — answered, and flagged there** | CTR:OAuth Helpers | p.3, p.8, p.17 | PF-503 |
| PF-505 | ☑ `InMemoryTokenStore` is the default and the test double | Default when no store is supplied; `load` after `save` round-trips, `clear` empties, and two client instances sharing one store see each other's writes. p.10 requires *"in-memory test doubles for every"* interface — this is `ITokenStore`'s, and every retry/refresh test in this lane and L18 injects it rather than touching disk | CTR:OAuth Helpers | p.4, p.10 | PF-503 |
| PF-506 | ☑ `FileTokenStore` — `~/.ship/credentials.json`, mode 0600, atomic write | Path is configurable; the file and its parent directory are created with owner-only permissions and a test asserts the mode on POSIX; a write is atomic (temp file + rename) so a crash mid-save cannot leave a half-written credential — that is the *"no partial credential is ever written back"* half of the Failure Modes contract (p.12), enforced rather than asserted. This is the store `ship login` writes through (p.6's five-line story) | CTR:OAuth Helpers | p.4, p.12 | PF-503 |
| PF-507 | ☑ `LocalStorageTokenStore` — and the browser entry point that can actually load it | p.4 names browser localStorage as a required store. ⚑ **Blocker in the current package shape:** the barrel (`sdk/src/index.ts:12`) re-exports `verifyWebhook`, whose module imports `node:crypto` at the top level, so any bundler resolving `@ship/sdk` for the browser pulls a Node built-in and fails. Ship a conditional `exports` map (`browser`/`node`) or move the Node-only verifier behind a subpath, and prove it: a test bundles the browser entry with `platform: 'browser'` and asserts the build succeeds and contains no `node:` specifier | CTR:OAuth Helpers | p.4 | PF-503, PF-004 |
| PF-508 | ☑ Corrupted store read = logged out. Never a retry loop. Never a partial write-back | Four cases: unreadable file (EACCES), invalid JSON, valid JSON of the wrong shape, and a `load()` that rejects. Each yields exactly **one** outbound request attempt at most and a thrown `{ kind: 'auth' }`; a counter on the injected store asserts `load()` was called once and `save()` **zero** times. `client.ts:75` already swallows the rejection — this ticket makes the swallow a tested contract and settles the open question the sketch leaves: whether a corrupt read also calls `clear()`. **Decision: it does not** — `clear()` is a write, the contract forbids writing back, and a store the SDK cannot parse may still be a store a human can repair | — | p.12 | PF-505, PF-497 |
| PF-509 | ☑ **Decision:** refresh is single-flight per token store, and a losing caller waits rather than refreshing again | Pre-Search 2.4 (p.17): *"What is the threading model for refresh under concurrent calls?"* Answer: one in-flight refresh promise keyed by the store instance; concurrent 401s await it and retry once with the resulting token. Test: ten concurrent `client.documents.list()` calls against a server whose access token has expired produce **exactly one** `/oauth/token` refresh request and ten successful responses. This is not a nicety — p.3's refresh tokens are one-time-use with family revocation, so two parallel refreshes present the same refresh token twice and the second one **revokes the family**, logging the user out. **L99 decision D8 second half — answered here, and flagged there** | CTR:OAuth Helpers | p.3, p.17 | PF-504, PF-508 |
| PF-510 | ☑ Retry policy is data: which statuses retry, which never, and how many times | Exported `RETRY_POLICY` naming the retryable set (429, 502/503/504, network/DNS/socket errors) and the never-retry set (every other 4xx, including 400/401/403/404/422). Max attempts is one exported constant. Test drives one request per status class and asserts the attempt count. **Decision: 5xx that is not 502/503/504 — a bare 500 — does not retry**, because a Ship 500 is a bug in a handler and retrying it turns one alert into four. The PRD's 1s/4s/16s ladder (p.4) is the **server's** webhook schedule, not this one; conflating them is the mistake this ticket names | — | p.4 | PF-495 |
| PF-511 | ☑ `Retry-After` from a 429 wins over the computed backoff, with a ceiling | p.4 requires 429 responses to carry `Retry-After`. When present and parseable (delta-seconds **and** HTTP-date forms), the SDK waits that long; when absent, exponential backoff with jitter; both capped by an exported `MAX_RETRY_DELAY_MS` so a hostile or mis-set header cannot park a CLI for an hour. Test covers: numeric header honored, HTTP-date header honored, absent header falls back, absurd header clamped | — | p.4 | PF-510 |
| PF-512 | ☑ Rate-limit headers are parsed once and surfaced on both the success and the error path | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (p.4) are parsed into a typed `RateLimitStatus` exposed on the client after any call **and** attached to a `kind:'rate_limit'` error, so a consumer can back off before being told to. Test asserts the values round-trip from a live 200 and a live 429; asserts missing headers yield `null`, never `NaN` or `0` — a `0` remaining that means "unknown" is worse than no value | — | p.4 | PF-511 |
| PF-513 | ☑ No wall-clock sleeping anywhere in the retry path or its tests | Backoff waits through an injected `sleep`/clock, defaulted to the real one, so every retry test in this lane and L18 runs deterministically. Grep assertion: `setTimeout` appears in no `sdk/**/*.test.ts`. p.11 is explicit that the real deliverer is *"tested with deterministic clock injection — never with `setTimeout` waits in tests"* and that timing-based webhook tests *"are flaky tests"*; the same reasoning applies to the client's own ladder, and L01's `FakeClock` (PF-017) is the precedent | — | p.11 | PF-510 |
| PF-514 | ☑ Install footprint: zero production dependencies, measured at **< 250 KB min+gzip** | p.9 sets the target: *"SDK install size (production deps only)"* at *"< 250 KB minified + gzipped"*. A committed script measures the packed tarball's production closure (bundle `dist` + every transitive `dependencies` entry, minify, gzip, sum) and writes the number to a report. Acceptance: `dependencies` is empty **and** the measured number is recorded — the empty-deps assertion is the mechanism, the byte count is the proof. Deliberately measures the closure and not just `dist`, so adding one 400 KB dependency fails even though `dist` did not grow | PERF:SDK install size < 250 KB | p.9, p.15 | PF-496 |
| PF-515 | ☑ CI runs the SDK suite and fails the build over the size budget | Two gaps closed at once: `.github/workflows/ci.yml` runs vitest for `@ship/api`, `@ship/web` and `@ship/agent` and **not** `@ship/sdk`, and `eslint.config.js` fences `platform/**` and `integrations/**` but **not** `sdk/**`. Ship (a) an `@ship/sdk` test step, (b) a blocking size-check step running PF-514's script against the exported budget constant, and (c) a `no-restricted-imports` rule forbidding `api/src/**` from `sdk/**` with a negative fixture proving it fires. Answers Pre-Search 1.2 (p.15) — *"how will you enforce it (bundle analyzer, CI size check)"* — with the CI-size-check option, chosen because a bundle analyzer reports and a check refuses | — | p.15, p.18 | PF-514, PF-013 |

## Build status — 23 done · 1 partial · 1 blocked

Legend: ☑ done · ◐ partial, and why · ☒ blocked on another lane.

Verified on `pf/L17-footprint` (the stack tip): `pnpm type-check` clean across all
seven packages · `pnpm lint` 0 errors · `pnpm lint:boundary` 4 fences green including
`F24 sdk → workspace` · `pnpm --filter @ship/sdk test` 161 passing · api suite 1489
passing.

**◐ PF-492 — the gate runs against a genuinely running server, but not against the
production `/me`.** `api/src/platform/api/v1/sdkGate.test.ts` boots real Express on a
real port with real `createPublicRouter` and real `bearerTokenMiddleware`, mints a
real token, and calls `new ShipClient({ token, baseUrl }).me()` over a socket. §2
resolves a typed `Me` with `app.client_id`, `user` and `scopes` populated. What it
cannot do is call the route in the composition root, because there isn't one.

**☒ PF-493 — `GET /api/v1/me` does not exist, and its absence is PINNED.** The audit
note in this file said the route was L10's and unbuilt. It is worse than unbuilt: two
tests already on `pf/integration` assert it is ABSENT —
`documents/documents.regression.test.ts` asserts the mounted v1 route set is exactly
the three `documents` routes, and `__tests__/scope-fitness.test.ts` asserts no path
starting `/me` is mounted. So adding it is a **three-lane change** (L10 ships it, L13
regenerates the spec, L09's regression assertion is updated) plus the spine edit this
file already called for (`Blocks on: L13, L10`). It is not a local edit, and it was
not made. PF-493's assertion has nothing to run against until then.

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L17-<slug>`; the PR body names the
acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L17-client-transport` | PF-491–496 | **MVP gate item 8** — `new ShipClient({ token }).me()` compiles as written and returns the typed user off a live server | Gate expression typechecks with no `baseUrl`; live `.me()` populates `app`/`user`/`scopes`; base-URL table test covers a path prefix; exactly one `fetch(` in `sdk/src` |
| S2 | `pf/L17-error-union` | PF-497–502 | p.4's Typed Error Union — five kinds, exhaustively switchable, with the 6→5 collapse stated as data | Exhaustive `switch` fails `type-check` when a case is deleted; code↔kind map exhaustive both directions and key-equal to L07's `API_ERROR_CODES`; 403 yields `code:'forbidden'` + `required_scope`; `requestId` equals `X-Request-Id` |
| S3 | `pf/L17-token-store` | PF-503–509 | p.4's Pluggable `ITokenStore` (in-memory, file, browser localStorage) and the Failure Modes corruption contract (p.12); answers Pre-Search 2.4's two `ITokenStore` questions | Third-party implementation satisfies the interface structurally; file store is 0600 and writes atomically; browser entry bundles with zero `node:` specifiers; four corruption cases each give one attempt, `{kind:'auth'}`, zero `save()`; ten concurrent expired calls produce **one** refresh |
| S4 | `pf/L17-retry-and-limits` | PF-510–513 | Client-side resilience against p.4's rate-limit contract, without importing the server's webhook retry ladder by mistake | Per-status attempt counts match `RETRY_POLICY`; `Retry-After` honored in both header forms and clamped; rate-limit triple round-trips from a live 200 and 429; no `setTimeout` in any SDK test |
| S5 | `pf/L17-footprint` | PF-514–515 | p.9's < 250 KB min+gzip budget, enforced in CI rather than asserted in a doc; Pre-Search 1.2 answered | `dependencies` empty; measured production closure recorded and under budget; CI runs the SDK suite; boundary-lint fixture importing `api/src/` fails the build |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **PF-493 exposes a real hole in the spine, not a ticket problem.** MVP gate item 8 requires
  `.me()` to work against a running server. `/api/v1/me` is **L10's** route ("Resources: Issues,
  Sprints, Me"), and L13 ships `documents` only — its PF-363 actively asserts `/me` is *absent* from
  the generated spec. The spine's `Blocks on` for L17 says L13 and nothing else. So this lane's one
  gate item cannot be demonstrated until L10 lands, and L10 is not in L17's dependency row. The fix
  is one word in the spine (`Blocks on: L13, L10`), not a change here. I did not put L10 ticket IDs
  in any `Deps` cell because `tickets/plugforge/lane-10-*.md` does not exist yet; re-point PF-492
  and PF-493 when it does. Same under-statement applies to PF-500's `PF-069`/`PF-071` neighbours in
  L03, which *do* exist and are cited.
- **PF-498 contradicts L07's PF-189 on one word, and I think L07 is wrong.** PF-189 says *"L17
  imports this, does not restate it."* The SDK cannot import from `api/src/` — that is the entire
  point of PF-515's new lint rule, and an `@ship/api` dependency would blow the p.9 footprint budget
  and make the package unpublishable. What the SDK can do is keep its own five-kind map and let a
  **test** (which ships in neither package's `dist`) import both and assert key-equality. That is
  what PF-498 specifies. If the audit prefers a genuinely shared source, the only clean home is
  `shared/` — which today is a types package both `api` and `web` depend on, and adding `sdk` to
  that list is a bigger call than this lane should make alone. Flag it; do not quietly make the SDK
  import the API.
- **Two decisions I made rather than surfaced**, both recoverable, both written into the ticket:
  - PF-508 — a corrupt store read does **not** call `clear()`. The Failure Modes paragraph forbids
    writing partial credentials back and says nothing about erasing; erasing is the friendlier UX
    and the less recoverable one. If the audit prefers self-healing, flip it and say so in
    `architecture.md`, because that paragraph is a graded deliverable.
  - PF-510 — a bare `500` does not retry, only `502`/`503`/`504` and transport errors do. The common
    industry choice is "all 5xx retry." I chose narrower because a Ship 500 is a handler bug and
    four attempts turn one alert into four. This one is genuinely arguable.
- **PF-504 and PF-509 answer L99's open decision D8, which was filed as "awaiting L17."** Both halves
  are answered in-ticket with the reasoning; the register should be updated to reflect that rather
  than left open. The refresh half (PF-509) is the one with teeth: p.3 mandates one-time-use refresh
  tokens with family revocation, so a naive concurrent refresh does not merely waste a round-trip,
  it **revokes the user's token family** and logs them out mid-drill. If the audit disagrees with
  single-flight, the alternative is serializing all requests behind one mutex, which is worse for
  the same guarantee.
- **PF-491 and PF-494 are defects in code already on disk, found by reading it.** `baseUrl` is
  required at `sdk/src/client.ts:13` while the gate's example omits it; `new URL('/api/v1' + path,
  baseUrl)` at line 46 discards any path prefix on the base URL. Re-verify both line numbers at
  audit — `client.ts` is 81 lines and will move under this lane's own edits.
- **PF-507's blocker is structural and it is easy to miss.** `sdk/src/index.ts` re-exports
  `verifyWebhook`, and `webhooks.ts:13` imports `node:crypto` at module top level. Any browser
  bundle of `@ship/sdk` therefore fails to resolve — which means p.4's *"browser localStorage"*
  store and p.8's Browser SDK Demo integration are both dead until the exports map is conditional.
  The verifier itself is **L18's** ticket; the packaging that lets it coexist with a browser build is
  this lane's. If L18 changes the verifier's module layout, PF-507 needs re-checking, not rewriting.
- **The Failure Modes corruption contract is ours, not the PRD's — verified.** p.12 asks the
  question (*"What happens when: the token store is corrupted…"*) as a **required section of the
  architecture document** and prescribes no answer. `docs/architecture.md` already commits to one:
  logged-out, never a retry loop, `{ kind: 'auth' }`, no partial write-back. PF-508 implements the
  committed answer. Changing it means editing a graded deliverable, so it is worth re-litigating
  now or not at all.
- **`Advances: —` on six tickets is deliberate**, matching the rule L13 applied: the p.9 install-size
  target and the p.15 Pre-Search enforcement question are graded, but neither is an MVP checkbox,
  a Testing Scenario, a Core Technical Requirements row (those are p.2–5), nor a Submission
  Requirements deliverable. PF-495, PF-499, PF-508, PF-510–513, PF-514 and PF-515 therefore cite `—`
  rather than a manufactured match. If the audit thinks the p.6/p.9 Performance Targets tables
  deserve their own citation namespace (`PERF:<row>` would be the obvious shape), that is a **spine**
  change — raise it in `TICKETS-PLUGFORGE.md`, not here.
- **What I could not ticket.** The PRD never states the SDK's timeout default, its retry count, its
  `User-Agent` string, or whether the client is meant to be constructible without a token at all
  (for the pre-auth device-flow moment — L18's `deviceLogin` is `static` in p.7's interface sketch,
  which sidesteps it). I picked none of those out of thin air except where a ticket names the choice
  explicitly (PF-510's attempt count, PF-511's ceiling), and each says it is ours.
- **Not covered here, on purpose:** the four resource clients and their spec-parity fitness test,
  async-iterator pagination beyond the transport it rides on, `authorizationCodeFlow()` /
  `deviceLogin()`, `verifyWebhook`, and the stable-vs-pre-1.0 marking of the published surface — all
  **L18**. The `/api/v1/me` route itself (L10), the server's rate-limit headers (L11), and the CLI
  that consumes this package (L19). If any of those is unowned at audit time it goes to
  `lane-99-unassigned.md`, not into this file.
</content>
</invoke>
