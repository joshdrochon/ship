# L18 · SDK Resources, Auth Helpers & Verifier

| | |
|---|---|
| **Agent** | `sdk-surface` |
| **Tier** | 6 — runs concurrently with L16 |
| **Block** | PF-521–555 (28 allocated, 7 reserved for audit) |
| **Blocks on** | L17 (PF-491–515 — client, transport, error union, token store, retry), L15 (PF-434/435 signed-payload + header grammar, PF-438 reference verifier, PF-446 golden vectors); transitively L03 (PF-077/078 resource map), L13 (PF-364 `operationId`, PF-378 `listSpecOperations`), L10 (`/api/v1/me`, `/issues`, `/sprints` — **not in the spine's row for this lane**, see audit notes) |
| **Unblocks** | L19 (CLI — the must-ship reference integration), L23 (agent rewire), L24 (secondary integrations) |
| **Testing Scenarios** | **TS-5** second half (p.5) — *"walk every spec method and assert the SDK exposes a typed call for it"*; **TS-6** (p.5) — subscribe via SDK → create doc → verify signature → tamper → reject |

**What this lane owns.** The surface an external developer actually touches: four resource clients
(`client.documents`, `client.issues`, `client.sprints`, `client.webhooks`), the fitness test that
keeps their signatures pinned to the OpenAPI spec, async-iterator pagination, the two OAuth helper
flows, `verifyWebhook`, and the stable-vs-pre-1.0 marking of the published barrel. L17 built the
transport, the error union and the token store; this lane spends them.

**The split with L13 on Testing Scenario 5 is deliberate — do not re-implement its half.** L13's
PF-378 exports `listSpecOperations(spec) → {operationId, method, path}[]` and its own audit notes say
so in as many words: *"Scenario 5's second half is L18's, deliberately… If L18's file, when written,
contains its own spec parser, that is duplication to flag — not a second opinion."* PF-528 consumes
that exporter. A second spec parser in `sdk/` would mean two definitions of "every spec method" and
Scenario 5 would be measuring the agreement of two parsers rather than the agreement of a spec and
an SDK.

**The `sprints` naming trap.** The public contract is `client.sprints` and `/api/v1/sprints` (p.4,
p.7, and p.3's `sprints:read` / `sprints:write` scopes). Ship's internal HTTP path is `/api/weeks`
(`api/src/app.ts:240`) even though `document_type` is already `'sprint'`
(`api/src/db/schema.sql:100`) — the split is route-path and vocabulary, not table. L03 owns the one
place that mapping is allowed to live: `platform/scopes/resource-map.ts` (PF-077), with a fitness
test asserting the literal `'weeks'` appears in no other platform file (PF-078). **The SDK is on the
far side of that map and must never know it exists** — it is an external package that cannot import
`api/src/` at all (L17's PF-515 lint rule). PF-523 asserts the negative: the string `weeks` appears
nowhere under `sdk/`.

**The sketches are spikes.** `resources/documents.ts` is one resource client of four and ends in a
`TODO(josh): issues.ts, sprints.ts, webhooks.ts`. `auth/flows.ts` is `export {}` under a TODO block —
neither helper exists. `webhooks.ts` has a real implementation whose **signature does not match the
PRD's** (PF-542) and `pagination.ts` has a termination bug (PF-535). Do not mark anything done
because a file exists.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-521 | ☐ All four resource clients hang off `ShipClient` as `readonly` fields | p.7's interface sketch is literal: `readonly documents: DocumentsClient; readonly issues: IssuesClient; readonly sprints: SprintsClient; readonly webhooks: WebhooksClient`. Test asserts all four are present on a constructed client, are non-writable, and that each is its own class — not one god object with a namespace object per resource. p.12's ISP paragraph names this exact structure as the SDK's Interface-Segregation evidence, so the shape is a graded claim, not a preference | CTR:Typed SDK Surface | p.4, p.7 | PF-491, PF-495 |
| PF-522 | ☐ `client.issues` — list / get / create, typed, off the shared transport | Mirrors `DocumentsClient` exactly: `list({cursor?, limit?}) → Page<ShipIssue>`, `get(id)`, `create(input)`, all through the injected `Transport` with no `fetch` of its own (L17's PF-495 grep assertion must still pass after this ticket). Test drives all three against the booted app and asserts the returned object typechecks field-by-field against the spec's issue schema | CTR:Typed SDK Surface | p.4 | PF-521, PF-495 |
| PF-523 | ☐ `client.sprints` targets `/api/v1/sprints`, and the literal `weeks` appears nowhere in `sdk/` | The public contract name is `sprints` (p.3's scopes, p.4's client list, p.7's interface). Ship's internal path is `/api/weeks` and L03's `resource-map.ts` is the **only** place that translation may live (PF-077/PF-078). Two assertions: a live `client.sprints.list()` resolves against `/api/v1/sprints`, and a grep over `sdk/src/**` finds no occurrence of `weeks`. A leaked internal noun in a published package is a contract bug that cannot be taken back | CTR:Typed SDK Surface | p.3, p.4 | PF-521, PF-077, PF-078 |
| PF-524 | ☐ `client.webhooks` — subscription CRUD, gated by `webhooks:manage` | p.3: *"Per-app per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via /api/v1/webhooks (gated by webhooks:manage scope)."* Client exposes create / list / get / update / delete over that resource. Test asserts a token **without** `webhooks:manage` produces `kind:'auth'` with `code:'forbidden'` and a `required_scope` of `webhooks:manage` (L17's PF-500 carries the fields) — the SDK must surface the scope failure, not flatten it | CTR:Typed SDK Surface | p.3, p.4 | PF-521, PF-500 |
| PF-525 | ☐ `create()` returns the signing secret **once**, and the type says so | p.8's Subscribe stage: *"Subscription persisted; signing secret returned once"*, and the subscription *"appears in dev portal"*. p.7's drill code reads `sub.signing_secret` straight off the create response and passes it into `verifyWebhook`. So `create()`'s return type carries `signing_secret: string` while `list()`/`get()`'s does **not** — two types, not one optional field, so a consumer that tries to read the secret off a listed subscription fails to compile rather than at 3am | CTR:Typed SDK Surface | p.4, p.7, p.8 | PF-524 |
| PF-526 | ☐ `client.webhooks.deliveries` + `replay(id)` — the portal's operation, available to any consumer | p.4: *"/api/v1/webhooks/deliveries/:id/replay re-emits a logged event. Idempotency-Key header passed through so subscribers can dedupe."* The delivery log is *"Queryable per app"* (p.4), so the SDK exposes both the query and the replay. Test asserts a replay call returns the delivery record and that the SDK does **not** mint its own `Idempotency-Key` — the key originates server-side at the event's first delivery and is carried unchanged (`docs/architecture.md`, Webhook Pipeline); an SDK-minted key would silently break subscriber dedupe | CTR:Typed SDK Surface | p.4 | PF-524 |
| PF-527 | ☐ Resource input/output types are derived from the spec, not restated by hand | `ShipDocument` (`resources/documents.ts:8`) is a hand-written interface today. Each resource's request/response types come from one generated or spec-checked source, and a test asserts a field added to a spec schema without a corresponding SDK type change fails `pnpm type-check`. p.16 asks the generated-vs-hand-written question and p.10 settles it — *"SDK hand-written in TypeScript for quality, fitness-tested against the spec for parity"* — so this ticket is the parity half of that settlement applied to **types**, where PF-528–531 apply it to **method signatures** | TS-5 | p.5, p.10, p.16 | PF-522, PF-378 |
| PF-528 | ☐ TS-5 second half: every spec operation has a typed SDK call — through L13's exporter, not a second parser | Consumes `listSpecOperations(spec)` (PF-378) and asserts each returned `operationId` resolves to a callable SDK method. ⚑ Grep assertion: `sdk/**` and the fitness test contain **no** independent OpenAPI parsing — exactly one implementation of "every spec method" exists in the repo, and it is L13's. Failure message names the unmatched `operationId` and its `METHOD /path`. This is the clause the PRD writes as *"walk every spec method and assert the SDK exposes a typed call for it"* | TS-5 | p.5 | PF-378, PF-364 |
| PF-529 | ☐ The operation→method binding is exported data, and a missing binding fails by name | One exported table mapping `operationId → 'documents.list'`-style method paths. A new spec operation with no entry fails the fitness test naming the `operationId`; a table entry pointing at a method that does not exist fails `pnpm type-check`. Deriving the binding from a path-string heuristic instead is rejected on purpose — a heuristic that guesses `documents.list` from `/documents` also silently "matches" a route the SDK never implemented | TS-5 | p.5 | PF-528 |
| PF-530 | ☐ Parity checks the **signature**, not just that a method exists | p.4 is explicit: *"Method signatures match OpenAPI spec; drift fails CI via a fitness test."* For each bound operation, assert the SDK method's parameters cover every required spec parameter, that no SDK parameter is absent from the spec, and that the declared return type matches the operation's success response schema. Existence-only parity passes for a method that takes `any` and returns `any`, which is precisely the SDK a drift test is supposed to catch | TS-5 | p.4, p.5 | PF-529, PF-527 |
| PF-531 | ☐ Reverse parity — an SDK method with no spec operation fails, naming it | The forward walk cannot catch a method the SDK invented: a `client.documents.archive()` calling a route that does not exist ships happily and only a consumer finds out. Assert every public method on all four resource clients appears in the binding table and resolves to a spec operation. Mirrors L13's PF-375 on the spec↔route axis; this is the same direction one layer out | TS-5 | p.4, p.5 | PF-529 |
| PF-532 | ☐ Parity fails loudly in CI, and cannot pass vacuously | Two guards before comparing: `listSpecOperations(spec).length > 0` **and** the binding table is non-empty, each with its own failure message. Wired as a blocking CI step alongside L17's `@ship/sdk` suite (PF-515), and proven to fire: a fixture PR adding a spec operation with no SDK binding is confirmed red. p.4 requires drift to fail CI; p.6 sets spec parity at 100%, and 0-of-0 is 100% | TS-5 | p.4, p.5, p.6 | PF-528, PF-531, PF-515 |
| PF-533 | ☐ `iterate()` on every list-capable resource client, one shared implementation | `for await (const doc of client.documents.iterate())` (p.4) exists identically on `documents`, `issues`, `sprints` and the webhooks delivery log — all four delegating to the single `paginate()` generator (`sdk/src/pagination.ts:12`), not four hand-rolled loops. Test walks three pages on each and asserts the yielded set equals the concatenated pages. p.13 lists *"async-iterator pagination as a developer-experience pattern"* among the Three Discoveries, so this is a graded write-up subject as well as a feature | CTR:Async-Iterator Pagination | p.4, p.13 | PF-522, PF-523 |
| PF-534 | ☐ Consumers never see a cursor — asserted on the type, not just in prose | p.4: *"Cursors handled internally; consumer code never sees them."* `iterate()`'s parameter type admits no `cursor` field (a `@ts-expect-error` fixture proves passing one fails to compile), and the yielded item type contains no cursor. L08's PF-233 already pins the server side of this contract with a consumer-shaped three-page walk that never imports `decodeCursor`; this is the same contract expressed in the SDK's types | CTR:Async-Iterator Pagination | p.3, p.4 | PF-533 |
| PF-535 | ☐ Termination: absent `next_cursor`, repeated cursor, and empty pages all end the walk | ⚑ **Verified defect:** `paginate` loops `while (cursor !== null)` (`pagination.ts:20`). A response that **omits** `next_cursor` sets `cursor = undefined`, and `undefined !== null` is true — the SDK re-requests page 1 forever. L08's PF-224 requires the server to send present-and-`null`, but a published SDK must not hang because a proxy stripped a key. Four cases: `next_cursor` null → stops; key absent → stops; empty `data` with a cursor → stops rather than spinning; the same cursor returned twice → throws a named error rather than looping. Each asserts a bounded request count | CTR:Async-Iterator Pagination | p.3, p.4 | PF-533 |
| PF-536 | ☐ **Decision:** expose both `list()` (raw page) and `iterate()`, and say why in the docs | Pre-Search 2.4 (p.17) asks: *"return raw cursors and let consumers loop, return async iterators only, or both? Async-iterators-only is cleanest; both is more flexible."* Answer: **both**, because the developer portal (L22) and the CLI's `--limit` flag need one page without draining the collection, and an iterators-only surface forces both to re-implement paging outside the SDK. The cost — a consumer *can* hold a raw cursor — is bounded by PF-534: nothing in `iterate()`'s path exposes one. Written into `docs/architecture.md`'s SDK Surface section | CTR:Async-Iterator Pagination | p.4, p.17 | PF-534 |
| PF-537 | ☐ `ShipClient.deviceLogin()` — p.7's exact static signature, returning a ready client | p.7 writes it as `static async deviceLogin(opts: { onUserCode: (code: string, verifyUrl: string) => void; tokenStore?: ITokenStore }): Promise<ShipClient>`. Ship that signature: static (there is no authenticated client yet to call it on), `onUserCode` receiving **both** the user code and the verification URL, optional store defaulting to L17's in-memory one. Test: a scripted device flow against the booted app resolves to a client whose `.me()` succeeds. This is `ship login` (p.6's five-line story) | CTR:OAuth Helpers | p.4, p.6, p.7 | PF-503, PF-505 |
| PF-538 | ☐ Device polling honors the server's `interval` and backs off on `slow_down` | p.3: *"the client polls /oauth/token until authorized. Slow-down responses honored."* The helper waits the server-supplied `interval`, adds 5s on each `slow_down`, stops on `expired_token` / `access_denied` with a typed error, and never polls faster than told. Tested through L17's injected clock (PF-513) with **zero** `setTimeout` in the test — p.11 is categorical that timing-based tests are flaky tests. A helper that ignores `slow_down` is the one thing Testing Scenario 3 explicitly checks for on the server side | CTR:OAuth Helpers | p.3, p.5, p.11 | PF-537, PF-513 |
| PF-539 | ☐ `ShipClient.authorizationCodeFlow()` — PKCE generated client-side, S256, verifier never leaves the process until exchange | p.4 names the helper; p.2 makes the flow an MVP gate item and p.11 puts it on Day 1. SDK side: generate a cryptographically random `code_verifier`, derive the S256 `code_challenge`, build the `/oauth/authorize` URL, and exchange the code with the verifier at `/oauth/token`. Test asserts the challenge is the SHA-256/base64url of the verifier (not `plain`), that `state` is generated and checked on return, and that a **wrong** verifier surfaces the server's `invalid_grant` as a typed error rather than an unhandled rejection | CTR:OAuth Helpers | p.2, p.4 | PF-537 |
| PF-540 | ☐ Both helpers persist through `ITokenStore` — and write nothing on a failed flow | On success the helper `save()`s the full `StoredTokens` (access + refresh + expiry + granted scopes, L17's PF-504). On any failure — denied consent, expired device code, network error mid-exchange — `save()` is called **zero** times, asserted with a counting store. This is the *"no partial credential is ever written back"* clause of the Failure Modes contract (p.12) applied at the only point in the system that writes credentials | CTR:OAuth Helpers | p.4, p.12 | PF-537, PF-539, PF-504 |
| PF-541 | ☐ A helper-issued client refreshes once on 401 and re-authenticates cleanly — it does not loop | The Failure Modes contract (p.12, `docs/architecture.md`) is that a corrupt or dead credential surfaces `{ kind: 'auth' }` and *"the helper flows re-authenticate cleanly"*. Concretely: one 401 → one refresh attempt through L17's single-flight path (PF-509) → one retry. A second 401 after refresh throws `kind:'auth'` and stops. Test asserts exact request counts on both paths; a refresh loop is the failure mode this ticket exists to make impossible, and p.3's one-time-use refresh tokens mean a loop also revokes the token family | CTR:OAuth Helpers | p.3, p.12 | PF-540, PF-509 |
| PF-542 | ☐ `verifyWebhook(headers, rawBody, secret, toleranceSec = 300)` — the **positional** fourth argument the PRD specifies | ⚑ **Verified mismatch:** the sketch's fourth parameter is an options object (`sdk/src/webhooks.ts:27`, `options: VerifyOptions = {}`). p.7 declares `toleranceSec?: number, // default 300` positionally and `docs/architecture.md`'s SDK Surface repeats it as `verifyWebhook(headers, rawBody, secret, toleranceSec = 300)`. Two graded artifacts agree against the code. Ship the positional form; keep clock injection for tests as a fifth optional argument or a separate test-only export, never by displacing the documented one | CTR:Webhook Verifier | p.4, p.7 | PF-491 |
| PF-543 | ☐ The verifier agrees with **L15's actual signer**, proven against L15's committed golden vectors | Consumes `platform/webhooks/__fixtures__/signature-vectors.json` (L15's PF-446 — ≥6 records of `{secret, timestamp, rawBody, expectedHeader}` including a non-ASCII body, an empty body, and a body containing literal `,` and `=`) and asserts the SDK verifier returns `true` for every one. Reads the fixture as **data**: no import of server code, which is what makes the contract checkable across the workspace boundary L17's PF-515 lint rule enforces. L15 pins the bytes this must match — PF-434 signs `` `${t}.${rawBody}` ``, PF-435 fixes the grammar at `/^t=\d+,v1=[0-9a-f]{64}$/` (seconds not milliseconds, lowercase hex, comma with no space). If the two sides disagree on separator, encoding, or what exactly is signed, the TTFE drill fails at its last step and nowhere earlier | TS-6 | p.3, p.5, p.7 | PF-542, PF-446, PF-438 |
| PF-544 | ☐ Negative matrix: tampered body, expired timestamp, missing `v1`, wrong secret, malformed header | p.4: *"Tampered bodies fail; expired timestamps fail; missing v1 header fails."* p.8's Verify stage adds *"timestamp older than 5 min fails."* Seven cases, each asserting `false`: byte-flipped body, timestamp `tolerance + 1` old, header with `t=` only, header with `v1=` only, header absent entirely, correct signature under the wrong secret, and a garbage header with no `=`. Plus one positive. **Future timestamps beyond tolerance also fail** — the sketch's `Math.abs` already does this and the test pins it, because a subscriber's clock can drift either way | TS-6 | p.4, p.5, p.8 | PF-542 |
| PF-545 | ☐ Constant-time comparison, and no input can make the verifier **throw** | Comparison is `timingSafeEqual` after a length check (`webhooks.ts:58`) — asserted, not assumed. Every malformed input returns `false`: `Buffer.from(v1, 'hex')` does **not** throw on invalid hex (it truncates silently, so the sketch's `try/catch` at lines 53–57 is dead code and its comment is misleading), a `v1` of odd length yields a short buffer, and a `null`/`undefined`/array-valued header must not crash. A verifier that throws on hostile input turns a forged webhook into a subscriber outage | TS-6 | p.4 | PF-544 |
| PF-546 | ☐ Header lookup is case-insensitive and accepts a `Headers` object, not only a lowercased record | p.7 types the parameter `Record<string, string>`; the sketch widens it to Node's `IncomingHttpHeaders` and looks up exactly two spellings (`webhooks.ts:32`). Neither covers a WHATWG `Headers` instance (a `fetch`-based listener, an edge runtime, or Hono), where property access returns `undefined` and the verifier returns `false` on a **valid** signature — a silent false-negative, the worst outcome available. Accept a plain record or a `Headers`-like object with `.get()`, match the header name case-insensitively, and test all three shapes | CTR:Webhook Verifier | p.4, p.7 | PF-545 |
| PF-547 | ☐ `verifyWebhook` measured at **< 1 ms per call** | p.8's Signature Challenge performance table sets the target. Benchmark over ≥1000 iterations on a realistic payload records the per-call figure into the same report as L17's size budget, so both SDK numbers land in one artifact for the submission. Guard rail: the number must be measured, not asserted — the ticket is satisfied by a recorded figure, and a figure over budget is a failure with a name, not a rounding conversation | — | p.8 | PF-543 |
| PF-548 | ☐ Stable vs. pre-1.0 is marked on the barrel **and** in `docs/architecture.md`, and the two cannot drift | p.12's Required Documentation, SDK Surface row: *"Public surface of @ship/sdk: resource clients, auth helpers, async iterators, error union, webhook verifier. Mark which surfaces are stable and which are pre-1.0."* The architecture doc already commits: **stable for the week** = `ShipClient` + the four resource clients, `authorizationCodeFlow()`, `deviceLogin()`, async-iterator pagination, `verifyWebhook`, the `kind` union; **pre-1.0 (may move)** = `ITokenStore` implementations beyond in-memory/file, OAuth helper option bags, CLI internals. Ship the same split as a machine-readable annotation on `sdk/src/index.ts` and a test asserting every export in the barrel appears in exactly one of the two lists — an unlisted new export fails the suite | SUB:Architecture Document | p.12, p.13 | PF-521, PF-537, PF-542 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L18-<slug>`; the PR body names the
acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L18-resource-clients` | PF-521–527 | p.4's Typed SDK Surface — four resource-segregated clients on one transport, with `sprints` as a contract name that never leaks `weeks` | All four clients present and `readonly`; live list/get/create per resource; grep finds no `weeks` under `sdk/`; secret-once type split compiles the safe way and fails the unsafe one; still exactly one `fetch(` in `sdk/src` |
| S2 | `pf/L18-spec-parity` | PF-528–532 | **Testing Scenario 5's second half** — every spec method has a typed SDK call, both directions, failing CI on drift | Forward walk through L13's `listSpecOperations` with zero SDK-side parsing; signature-level comparison, not existence; reverse walk names an invented method; non-empty guards on both sides; fixture PR with an unbound operation is red |
| S3 | `pf/L18-pagination` | PF-533–536 | p.4's Async-Iterator Pagination — `for await` over every collection, cursors invisible, and a walk that provably terminates | Three-page walk per resource equals the concatenated pages; `@ts-expect-error` fixture proves `cursor` is not accepted; absent/repeated cursor and empty page each terminate with a bounded request count |
| S4 | `pf/L18-oauth-helpers` | PF-537–541 | p.4's OAuth Helpers — both flows end-to-end in one call, persisting through `ITokenStore`, re-authenticating without looping | Scripted device flow yields a client whose `.me()` succeeds; `slow_down` adds 5s with no `setTimeout` in the test; S256 challenge derives from the verifier and a wrong verifier surfaces `invalid_grant`; failed flows call `save()` zero times; one 401 → one refresh → one retry, then stop |
| S5 | `pf/L18-verifier` | PF-542–547 | **Testing Scenario 6's verification half** and p.4's Webhook Verifier — one call, boolean, agreeing byte-for-byte with L15's signer | Positional `toleranceSec = 300` signature matches p.7 and the architecture doc; golden vectors from the server signer pass; seven-case negative matrix all `false`; no input throws; plain record, lowercased record and `Headers` all verify; < 1 ms per call recorded |
| S6 | `pf/L18-surface-stability` | PF-548 | p.12's Required Documentation SDK Surface row — the published surface marked stable vs. pre-1.0, and kept honest | Every barrel export appears in exactly one of the two lists; adding an export without listing it fails the suite; the lists match `docs/architecture.md` |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **PF-543's coupling to L15 landed mid-authoring and the two lanes agree — verify that it stays
  true.** `lane-15-webhooks-signing.md` appeared while this file was being written, and it was
  designed for this handshake from the other side: PF-446 commits the golden vectors *"the contract
  L18 verifies against"* and says in as many words that the SDK verifier *"must not import server
  code."* PF-434 settles the signed payload as `` `${t}.${rawBody}` ``, PF-435 pins the header
  grammar to the byte, PF-438 ships a server-side `verifySignature` explicitly described as the
  reference implementation of p.7's `verifyWebhook`. One thing to re-check at audit: the fixture
  lives under `api/src/platform/webhooks/__fixtures__/`, so the SDK test reads a JSON file by path
  across a package boundary. That is data, not an import, and it does not trip L17's PF-515 rule —
  but if anyone "tidies" it into a TypeScript module export, it becomes an import and the rule
  fires. Keep it JSON.
- **PF-542 is a three-way conflict and I ruled for the graded artifacts — L15 independently agrees.**
  The sketch takes an options object; p.7's interface definition, `docs/architecture.md`'s SDK
  Surface line, and now L15's PF-438 all declare a positional `toleranceSec` defaulting to 300. The
  options bag is the nicer TypeScript and the positional form is what a grader will paste. Three
  sources to one, so positional wins and clock injection moves to a fifth argument. If the audit
  prefers the options bag, `architecture.md` has to change too — it is a Required Documentation
  deliverable, so this is not a code-only edit.
- **PF-546 is the highest-value ticket in the verifier slice and the easiest to skip.** A WHATWG
  `Headers` object returns `undefined` for property access, so the current lookup returns `false` on
  a perfectly valid signature. That is a false **negative** — the subscriber drops a legitimate
  event and nothing errors. Any subscriber written against `fetch`, an edge runtime, or Hono hits
  it. The PRD types the parameter as a plain `Record<string, string>` (p.7) and so does not require
  this; I am widening beyond the spec deliberately and the ticket says so.
- **PF-536 answers Pre-Search 2.4's pagination question with "both," against the PRD's own hint.**
  p.17 says *"Async-iterators-only is cleanest; both is more flexible."* I chose flexible because
  the portal (L22) and the CLI's `--limit` both need a single page, and an iterators-only surface
  pushes paging logic back out into two consumers. This is a defensible call in either direction and
  I would not argue hard — but if it flips, PF-534's "consumers never see a cursor" assertion gets
  *stronger*, not weaker, so the flip is cheap.
- **The spine's `Blocks on` for this lane is incomplete in the same way L17's is.** It lists L17 and
  L15. `client.issues` and `client.sprints` need **L10's** routes; `client.webhooks` needs L15's
  subscription routes; PF-527/528 need L13's spec to cover more than `documents` (PF-363 asserts it
  covers *only* documents). So S1 and S2 cannot go green on a `documents`-only spec no matter how
  well they are written. Chronologically the tiers work out — L10 and L13 are tier 4, this is tier 6
  — but the dependency row should say so. One word in the spine, same fix L17 needs.
- **PF-528's "no second parser" clause is the whole point of the L13/L18 split.** L13's audit notes
  ask the next reader to flag exactly this. If the shipped fitness test imports a YAML/JSON schema
  walker, or re-reads `docs/openapi.json` itself instead of calling `listSpecOperations`, that is
  duplication to flag — Scenario 5 would then be comparing two parsers rather than a spec and an
  SDK.
- **`Advances: —` appears exactly once (PF-547), and that is deliberate.** The < 1 ms verification
  target lives in p.8's Signature Challenge performance table, which is graded but is not an MVP
  checkbox, a Testing Scenario, a Core Technical Requirements row (p.2–5), or a Submission
  Requirements deliverable. Same call L13 made for its p.13 static-spec tickets and L17 made for the
  p.9 size budget. If the audit wants a `PERF:<row>` namespace for the p.6 and p.8 target tables,
  that is a **spine** change — raise it in `TICKETS-PLUGFORGE.md`, not here.
- **`CTR:Typed SDK Surface` carries seven tickets and `CTR:OAuth Helpers` five.** That concentration
  is honest — p.4's rows genuinely are what those tickets build — but it is worth a second opinion on
  whether PF-525 and PF-526 are really advancing the SDK-surface row or are plumbing that should
  read `—`. I would not fight hard for either.
- **What I could not ticket.** The PRD never names the SDK's subscription update semantics (PATCH vs
  PUT), never says whether `client.webhooks.list()` is per-app or global, never specifies what
  `iterate()` should do about a page-size argument, and never states whether `authorizationCodeFlow()`
  is expected to open a browser or return a URL for the caller to open (p.7's sketch shows only
  `deviceLogin`, and the sketch comment in `auth/flows.ts` invents an `openBrowser` option that has
  no PRD basis). PF-539 deliberately specifies only the parts the PRD and RFC 7636 pin down.
- **Not covered here, on purpose:** the server-side signer and subscription routes (L15), the retry
  ladder / DLQ / replay mechanism behind PF-526's client call (L16), the `/api/v1/me`, `/issues` and
  `/sprints` routes themselves (L10), the developer portal that consumes this SDK (L22), the CLI
  that is the must-ship reference integration (L19), and the TTFE drill that times the whole loop
  (L20). If any of those is unowned at audit time it goes to `lane-99-unassigned.md`, not into this
  file.
</content>
</invoke>
