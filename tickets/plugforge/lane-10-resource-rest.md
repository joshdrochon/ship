# L10 · Resources: Issues, Sprints, Me

| | |
|---|---|
| **Agent** | `resource-rest` |
| **Tier** | 4 — runs concurrently with L13, L14 |
| **Block** | PF-271–300 (26 allocated, 4 reserved for audit) |
| **Blocks on** | L09 (PF-241 domain-service seam, PF-248 route metadata, PF-250 public-type policy, PF-251 adjacent Zod, PF-252 response projection, PF-256–259 keyset list) |
| **Unblocks** | L18 (`client.issues` / `client.sprints` need routes to compile against), L20 (TTFE drill), L23 (the agent's scopes are only meaningful once its resources exist) |
| **MVP gate** | Item 8 (p.2) jointly with L17 — *"`new ShipClient({ token }).me()` against a running server returns the typed authenticated user"*: L17 owns the client, this lane owns the endpoint it calls |

## State — 2026-08-12

**S1 shipped on `pf/L10-me` (commit `070c915`). S2–S5 are not built.**

| Slice | Tickets | State |
|---|---|---|
| S1 `pf/L10-me` | PF-271–276 | **Done**, except PF-275 (shipped with `list: false`, see its row) and PF-276 (**blocked on L05** — no device grant exists) |
| S2 `pf/L10-issues` | PF-277–283 | Not started |
| S3 `pf/L10-sprints` | PF-284–289 | Not started |
| S4 `pf/L10-event-callsites` | PF-290–293 | Not started |
| S5 `pf/L10-parity-and-budget` | PF-294–296 | PF-294 **done and asserted** (`me.fitness.test.ts` diffs `platform/openapi/` against the merge base). PF-295/296 not started |

**MVP gate item 8 now closes on the production surface.** `new ShipClient({token}).me()`
against `createApp()` on a real socket returns the typed user — proved in
`sdkGate.test.ts` §1 (which no longer mounts anything itself) and again manually
outside vitest. api suite: **100 files, 1607 passing**, from a 98/1568 baseline.

**No other gate item depends on S2–S5.** MVP-4 reads *"At least one resource
(documents) implements GET list, GET by id, and POST"* and L09 satisfies it; the
`MVP-4` tags on PF-277–279 and PF-284–286 are the second-resource reading the lane
file's own audit notes offer to demote. So the remaining slices are contract
breadth, not gate risk — which is why they were left rather than rushed against
1607 passing tests and Ship's Part 1 internal issues/weeks behaviour.

**The cost that remains, measured.** S2 and S3 are dominated by the domain-service
extraction, not the routes: `api/src/routes/issues.ts` is 1635 lines and
`api/src/routes/weeks.ts` is 3141, against L09's comparable extraction which was
842 insertions for `documents` alone. Budget accordingly, and keep
`list-endpoints-regression.test.ts` and PF-264's query-count assertions green
throughout — they are what stop the extraction changing the internal API.

**Why this lane is tier 4 and not tier 3.** Build Strategy §4 (p.11): *"Get the generator working
end-to-end with one resource (documents) before adding issues, sprints, and me."* Sequencing this
lane after L09 and L13 is not caution, it is the PRD's instruction — and PF-294 turns it into a
proof: these three resources land with **zero** edits to `platform/openapi/`, or the generator was
never generic.

**`/api/v1/me` is load-bearing for two other lanes.** Testing Scenario 3 (p.5) ends with *"confirm
the resulting token works against /api/v1/me"* — it is the device grant's assertion target, so L05's
scenario cannot go green without this route. MVP gate item 8 (p.2) makes it the SDK skeleton's proof.
Six tickets for one endpoint that returns a user object is not over-investment; it is the endpoint two
graded items resolve through.

**The `sprints` naming trap, and where its resolution lives.** Public contract says `sprints` (scopes
`sprints:read`/`sprints:write`, p.3; `client.sprints`, p.4/p.7). Ship's internal HTTP path is
`/api/weeks` (`api/src/app.ts:240`, with `iterationsRoutes` also mounted there at `:241`), while
`document_type` is already `'sprint'` (`api/src/db/schema.sql:100`) — so the split is route-path and
vocabulary, not table. L03 investigated this and placed the map at
`platform/scopes/resource-map.ts` (PF-077/PF-078), with L03 owning it and this lane consuming it.
**This lane does not re-decide the mapping.** PF-287 consumes it and asserts the sprints route module
contains no `'weeks'` literal. Our view on whether `scopes/` is the right home is in the audit notes,
not in a move.

**Five repo facts that shape this lane, all verified by reading the files:**

1. **`/api/auth/me` cannot be reused.** `api/src/routes/auth.ts:296` returns
   `{success: true, data: {user, currentWorkspace, workspaces, pendingAccountabilityItems}}` — a
   success-wrapper envelope with a workspace list attached, resolved from the session. Nothing about
   it matches the public contract, and its 404 branch emits `{success:false, error:{code,message}}`,
   which is not the `ApiError` shape.
2. **There is no internal "list sprints" route.** `GET /api/weeks/` (`api/src/routes/weeks.ts:276`)
   computes the *current* sprint number from `workspace.sprint_start_date` and returns only rows
   matching it (`WHERE … (d.properties->>'sprint_number')::int = $2`, `:352`). A public
   `GET /api/v1/sprints` that lists sprints is new work, not a wrapper.
3. **Sprint dates and status are computed, not stored.** `extractSprintFromRow`
   (`api/src/routes/weeks.ts:185`) is preceded by the comment *"Dates and status are computed on
   frontend from sprint_number + workspace.sprint_start_date"*; the create route says the same
   (`:823–824`). `properties.status` is written by exactly one path — `POST /api/weeks/:id/start`
   sets `status:'active'` at `:1245` — so the stored field is present but mostly absent.
4. **The issues list sorts by two mutable keys.** `ORDER BY CASE priority … , d.updated_at DESC`
   (`api/src/routes/issues.ts:212`). Priority is user-editable and `updated_at` is rewritten on
   every PATCH (`:923`), so keyset pagination over that ordering is less stable than documents'
   `position`, not more.
5. **The issue PATCH already has a single change choke point.** It builds a `changes[]` diff and
   writes each entry through `logDocumentChange(…, client)` inside a transaction
   (`api/src/routes/issues.ts:917`). `issue.assigned` and `issue.status_changed` hang off that loop
   — one call site, two events, no second diff implementation.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-271 | ☑ ⚑ `GET /api/v1/me` declares its authorization explicitly — the seven-scope registry has no scope for it | p.3 registers exactly seven scopes and PF-062 asserts exactly seven; none of them names the authenticated identity. PF-079 fails any v1 route that does not declare a **registered** scope, so `me` cannot simply omit one. **Decision: the route metadata carries `scope: null` as an explicit declared value**, not an absent field, and PF-079 is amended to accept explicit-null while still failing on absent-or-unregistered. Test: `createApp()` boots with `me` registered; a fixture route with an *absent* scope still throws; and a token with an empty scope array reaches `me` and gets 200. Inventing an eighth scope was the alternative and it breaks a graded assertion (MVP-6) to satisfy a fitness test | TS-4 | p.3, p.5 | PF-072, PF-079, PF-248 |
| PF-272 | ☑ The `me` response is a public schema, not `/api/auth/me`'s body | **Verified:** the internal endpoint (`api/src/routes/auth.ts:296`) returns `{success, data:{user:{id,email,name,isSuperAdmin}, currentWorkspace, workspaces[], pendingAccountabilityItems[]}}`. The public body is a flat `{id, email, name, workspace_id}` parsed by an adjacent Zod (PF-251 pattern) — no `success` wrapper (the envelope is HTTP status plus `ApiError` on failure, p.7), no `isSuperAdmin` (an internal privilege flag has no business in a third-party app's view of a user), no workspace list (a token is scoped to one workspace, PF-260). Test asserts the served body deep-equals the schema and that the string `success` appears nowhere in it. MVP gate 8 is a *typed* user — the type is this schema, and L17 imports it from the generated spec | MVP-8 | p.2, p.7 | PF-271, PF-251 |
| PF-273 | ☑ `me` resolves from the bearer token, never from a session cookie | Three assertions: a request carrying a **valid Ship session cookie and no bearer token** returns 401 (the session stack is not in this router at all, PF-211); a valid bearer token returns 200 with the user the token was issued for; and a token issued for user A never returns user B regardless of any `user_id` query parameter. `me`'s whole purpose is to answer "who is this token" — an implementation that reads `req.userId` would answer "who is this browser" and pass a naive test | MVP-3 | p.2, p.3 | PF-272, PF-211 |
| PF-274 | ☑ `me` names the acting app and the granted scopes | p.3's Token Middleware row: *"Bearer validation; populates request with app, user, granted scopes."* All three are on `PlatformAuthContext`, and `me` is the only route that can show a caller what it holds. **Decision: the body carries `{app: {client_id, name}, scopes: string[]}` alongside the user.** Test: the array deep-equals the token's granted scopes and is a subset of `scopeRegistry.list()`; the app object never carries `client_secret` or its hash, asserted by name. This is what makes `ship login` able to print what it was authorized for instead of guessing | CTR:Token Middleware | p.3 | PF-272 |
| PF-275 | ◐ `me` declares ~~`list: 'none'`~~ **`list: false`** and emits no `next_cursor` | **Shipped with the mechanism changed and the observable half intact — see the note in `platform/api/v1/me/routes.ts`.** `'none'` is not available to this route: L08's `assertNoCursorOnFixedList` asserts a `'none'` route's body has an ARRAY at `data`, because `'none'` means *a collection whose cardinality is bounded by code* (`routeMetadata.ts`). `me` returns one object, so declaring `'none'` fails L08's clause — correctly. `false` (*"not a collection at all"*) is what this route is. Both tested acceptance criteria hold: the body carries **no** `next_cursor` key, and `?limit=1` is a 422 (not `page.ts`'s `assertAllowedQueryParams`, which allows `limit` unconditionally — a local reject-everything check). **What did NOT get delivered:** PF-231's negative half still has no non-fixture subject. The routes that would give it one are `/api/v1/scopes` (L03) and `/api/v1/events` (L14). The first real subject for L08's PF-231 negative half — until now every `list:'none'` assertion runs against a fixture. Test: the `me` body has no `next_cursor` key at all (not a null one), and `?limit=1` is rejected by the per-route query allowlist (PF-226) rather than silently ignored. Without a registered `'none'` route in the tree, clause (d) of Testing Scenario 4 passes vacuously on its negative half | TS-4 | p.5, p.16 | PF-228, PF-231, PF-271 |
| PF-276 | ⛔ **BLOCKED on L05 — nothing to test against.** Testing Scenario 3's assertion target works with a device-grant token end-to-end | **Verified 2026-08-12:** there is no device grant. `api/src/platform/oauth/router.ts:188` carries `TODO(L05): urn:ietf:params:oauth:grant-type:device_code — same seam`, and no `device_code` / `user_code` handler exists anywhere under `platform/oauth/`. `tickets/plugforge/lane-05-oauth-device.md` exists but nothing is built. The half this lane owns is done and provable: `me` resolves the user the token was issued for, asserted three ways in `me.routes.test.ts` (PF-273) — including a second harness whose tokens carry a different `userId`, which is the assertion that would catch the identity mis-resolution this ticket is really about. When L05 lands, this becomes one test that drives the device flow to a token and calls `GET /api/v1/me`. Original text: | p.5: *"Run the Device Authorization Grant flow from a test CLI: poll /oauth/token until authorized, verify slow-down responses are honored, confirm the resulting token works against /api/v1/me."* The polling and `slow_down` halves are L05's; **this** is the last clause, and it is the one that fails if `me` mis-resolves identity. Test drives the real device flow to a token and calls `GET /api/v1/me`, asserting 200 and that the returned `id` equals the user who approved the `user_code`. L05's ticket IDs are not cited because that lane's file is not written — re-point the Deps when it lands | TS-3 | p.5 | PF-273 |
| PF-277 | ☐ `GET /api/v1/issues` — list, declaring `issues:read`, cursor-paginated | Follows PF-245 exactly: `requireScope('issues:read')` through the factory, `pageSchema(issueSchema)` body, 200/401/403 matrix with `details.required_scope`. The service call is `issueService.list(ctx, input)` — extracted from `api/src/routes/issues.ts:115` the same way PF-241 extracted the documents list, and the internal route reduced to parse → call → respond with a byte-identical body | MVP-4 | p.2, p.3 | PF-241, PF-245, PF-067 |
| PF-278 | ☐ `GET /api/v1/issues/:id` — by id, declaring `issues:read` | Same scope matrix; UUID-validated path param; the four-way `not_found` matrix from PF-255 (unknown id, other workspace, soft-deleted, wrong `document_type`) applied to issues, where the fourth case now means *a `wiki` id requested through `/issues`*. The internal handler at `api/src/routes/issues.ts:489` is the source of the read logic | MVP-4 | p.2, p.7 | PF-277, PF-255 |
| PF-279 | ☐ `POST /api/v1/issues` — create, declaring `issues:write` | 201 + `Location`; `issueService.create(ctx, input)` wraps the transaction at `api/src/routes/issues.ts:558–650`, including the `ticket_number` allocation and the `belongs_to` association fan-out. The public request schema is `.strict()` and does **not** expose `is_system_generated`, `accountability_target_id` or `accountability_type` (`createIssueSchema`, `api/src/routes/issues.ts:29–44`) — those are Ship's internal accountability machinery and a third-party app minting system-generated action items is a privilege escalation dressed as a field | MVP-4 | p.2, p.3 | PF-277, PF-253 |
| PF-280 | ☐ ⚑ `PATCH /api/v1/issues/:id` — declaring `issues:write` | **Decision: ship it, even though no gate item asks for a PATCH.** Two of the eight registered event types — `issue.assigned` and `issue.status_changed` (p.3) — have no producer without a public update path, and Epic 7's agent (L23) is a state-changing consumer by construction. Acceptance: scope matrix; the request schema accepts only `{title, state, priority, assignee_id, belongs_to}` from `updateIssueSchema` (`api/src/routes/issues.ts:46`) and rejects `claude_metadata` and `confirm_orphan_children`; a no-op PATCH returns 200 and changes nothing. Scope creep risk is real — see audit notes | — | p.3 | PF-279 |
| PF-281 | ☐ The public issues list orders by `(created_at, id)` — not by priority, not by `updated_at` | **Verified:** internal sorts `ORDER BY CASE d.properties->>'priority' … , d.updated_at DESC` (`api/src/routes/issues.ts:212`). Both keys are mutable by any PATCH, so a keyset cursor over them skips and repeats rows under ordinary use — worse than documents' `position` because `updated_at` changes on *every* write, not only on reorder. Consumes PF-219's predicate; ships the `(workspace_id, created_at DESC, id DESC)` partial index for `document_type='issue'` in the same migration as PF-259 and passes `assertKeysetIndexed` (PF-222). Test: PATCH the priority of three rows spanning a page boundary mid-walk; assert no id repeats and none is skipped | TS-4 | p.3, p.6 | PF-219, PF-222, PF-259, PF-277 |
| PF-282 | ☐ `issueSchema` — one projection, with the JSONB properties flattened and named | `state`, `priority`, `assignee_id`, `source` and `rejection_reason` live inside `properties JSONB` (`api/src/db/schema.sql:131`, documented at `:127`) and the internal routes unpack them ad hoc per handler. The public schema declares them as first-class typed fields with the enums from `createIssueSchema` (`api/src/routes/issues.ts:30–31`), so the generated OpenAPI has real enums rather than `object`. `properties` itself is never serialized — a public consumer must not see Ship's internal bag. One schema for list, get, create and patch responses (PF-252's rule applied here) | CTR:Typed SDK Surface | p.4, p.11 | PF-277, PF-252 |
| PF-283 | ☐ Resource/scope isolation is bidirectional and asserted both ways | PF-250 asserts `documents:read` cannot reach issues. This asserts the converse and the sibling cases: an `issues:read` token gets 403 (not 404) on `/api/v1/sprints`; `/api/v1/issues` returns **only** `document_type='issue'` rows, never a `wiki` or a `weekly_plan`; and `/api/v1/sprints` returns only `document_type='sprint'`. In a single-table data model this is the only thing keeping three scope pairs from collapsing into one, and it is invisible to every other test in the suite | CTR:Scope Registry | p.3 | PF-250, PF-277, PF-284 |
| PF-284 | ☐ `GET /api/v1/sprints` — list, declaring `sprints:read`. **No internal equivalent exists** | **Verified:** `GET /api/weeks/` (`api/src/routes/weeks.ts:276`) is not a sprint list — it derives the current sprint number from `workspace.sprint_start_date` and filters `(d.properties->>'sprint_number')::int = $2` (`:352`), returning only that one sprint's rows with computed `days_remaining` and a hard-coded `status:'active'` (`:359`). So `sprintService.list(ctx, input)` is a new query over `document_type='sprint'`, not an extraction. Acceptance: scope matrix, `pageSchema(sprintSchema)`, and a test asserting a workspace with sprints 1–5 returns all five (the internal route returns one) | MVP-4 | p.2, p.3 | PF-241, PF-067, PF-287 |
| PF-285 | ☐ `GET /api/v1/sprints/:id` — by id, declaring `sprints:read` | Extracted from `api/src/routes/weeks.ts:738`; same UUID validation and same four-way `not_found` matrix as PF-278. Note the internal handler returns a heavily denormalised object (issue counts, retro presence, program join, owner join) — the public projection is PF-289's decision, not a pass-through | MVP-4 | p.2, p.7 | PF-284, PF-255 |
| PF-286 | ☐ `POST /api/v1/sprints` — create, declaring `sprints:write` | Extracted from `api/src/routes/weeks.ts:826`. Public request schema is `{sprint_number, title?, owner_id?, program_id?}` per `createSprintSchema` — the route's own comment (`:823–824`) states only `sprint_number` and `owner_id` are stored and everything else is computed, so a public schema accepting `start_date` or `end_date` would accept fields the server ignores, which is a lie in the OpenAPI spec | MVP-4 | p.2, p.3 | PF-284 |
| PF-287 | ☐ The sprints routes resolve their domain module through L03's `resource-map.ts` | PF-078 states the contract: L03 owns the map, L10 consumes it. Acceptance (PF-078's own test, satisfied from this side): `api/src/platform/api/v1/sprints/**` contains **no** `'weeks'` string literal and no import path containing `weeks`; the module resolves its domain service through `platform/scopes/resource-map.ts`. **This lane does not re-decide the mapping** — the investigation is done and repeating it produces a second answer. Our view on the map's *location* is in the audit notes | — | p.3 | PF-077, PF-078 |
| PF-288 | ☐ The public sprints list orders by `(created_at, id)`, not by a JSONB expression | **Verified:** internal orders by `(d.properties->>'sprint_number')::int` (`api/src/routes/weeks.ts:353`, and `DESC` at `:436`) — a computed expression over JSONB with no supporting index, so every list is a sort over a sequential scan and a keyset over it is not expressible as a row comparison at all. Public list uses the same `(created_at, id)` keyset as documents and issues, with the partial index for `document_type='sprint'` in the shared migration. `assertKeysetIndexed` (PF-222) passes. **Consequence stated deliberately:** the public sprint list is in creation order, not sprint order — see audit notes | TS-4 | p.3, p.6 | PF-219, PF-222, PF-284 |
| PF-289 | ☐ `sprintSchema` declares computed fields as read-only, and `status` honestly | **Verified:** `extractSprintFromRow` (`api/src/routes/weeks.ts:185`) carries the comment *"Dates and status are computed on frontend from sprint_number + workspace.sprint_start_date"*, repeated at `:823`. So `start_date`, `end_date` and `status` are **derived**, and `properties.status` is written by exactly one code path (`:1245`, `status:'active'`). Decision: the public schema computes them server-side and marks them `readOnly` in the generated spec, so an SDK consumer cannot send them back; `status` is `'planning' \| 'active' \| 'completed'` derived from the stored value when present and from the calendar otherwise, with the derivation in the service and covered by a table test. A public API that lets the *frontend* compute a status field is not a contract | CTR:Typed SDK Surface | p.4 | PF-284, PF-285 |
| PF-290 | ☐ `sprint.started` publishes from the sprint domain service, at the start transition | **Verified call site:** `POST /api/weeks/:id/start` (`api/src/routes/weeks.ts:1202`) writes `properties.status='active'` at `:1245` via a bare `pool.query` with **no transaction** — it also takes an issue snapshot first (`takeSprintSnapshot`, `:1241`), so the write is not atomic with it. This lane owns the call site being inside `sprintService.start(ctx, id)`; L14 owns the bus and the envelope. Acceptance: the v1 sprints module contains no `.publish(`; the service publishes exactly once on a `planning → active` transition and **zero** times when the sprint is already `active` (re-start is currently permitted and would double-fire) | — | p.3 | PF-403, PF-284 |
| PF-291 | ☐ ⚑ `sprint.completed` — this lane owns whether it has a public producer at all | L99's F9 and L14's PF-407 establish the gap: `'completed'` exists only in `updateSprintSchema`'s enum (`api/src/routes/weeks.ts:174`) and nothing writes it; status is otherwise calendar-derived. L14 proposes an explicit PATCH transition. **The route-layer half is ours, and the honest framing is: if the transition is only ever internal, one of the eight event types can never be triggered by a platform consumer** — which is exactly what a grader running Testing Scenario 6's shape against `sprints` would find. Acceptance: `PATCH /api/v1/sprints/:id` accepting `{status:'completed'}` under `sprints:write`, with a test that **fails** (not skips) if no write path sets the value, so this cannot go quietly green | — | p.3 | PF-407, PF-286 |
| PF-292 | ☐ `issue.created` publishes from `issueService.create`, never from the route | Call site is the extracted service (PF-279), after the `COMMIT` at `api/src/routes/issues.ts:646` — not inside the transaction, and not before the post-commit sprint-accountability block at `:650`. Acceptance for this lane: `api/src/platform/api/v1/issues/**` contains no `.publish(` and imports no events module (grep, naming file and line); the service signature carries the injected bus so PF-406 is an added call rather than a re-plumbing | — | p.3 | PF-403, PF-279 |
| PF-293 | ☐ `issue.assigned` and `issue.status_changed` hang off the existing change-diff loop | **Verified single choke point:** the PATCH handler builds `changes[]` and writes each through `logDocumentChange(id, change.field, change.oldValue, change.newValue, userId, automatedBy, client)` inside a transaction (`api/src/routes/issues.ts:917`). `issue.assigned` fires on `change.field === 'assignee_id'`, `issue.status_changed` on `=== 'state'` — both fields live in `properties` JSONB. Acceptance: a PATCH changing state emits exactly one `issue.status_changed` whose `{from,to}` equal the history row's `old_value`/`new_value`; a PATCH changing both fields emits both events once each; a no-op PATCH emits nothing. Re-implementing the diff in the public route instead of reusing this loop is the failure mode | — | p.3 | PF-292, PF-280, PF-406 |
| PF-294 | ☐ Three resources land with **zero** lines changed under `platform/openapi/` | The pairing PF-363 declares from L13's side. Acceptance: `git diff --stat` for this lane's slices shows no file under `api/src/platform/openapi/`, and the generated spec nonetheless contains every `issues`, `sprints` and `me` operation with its scope, its `ApiError` responses and — for the two list routes — its `limit`/`cursor` parameters and `{data, next_cursor}` envelope. If the generator needs an edit to take a fourth, fifth or sixth resource, Build Strategy §4's *"before adding issues, sprints, and me"* bought nothing | MVP-7 | p.11, p.2 | PF-358, PF-363, PF-277 |
| PF-295 | ☐ Every route in this lane satisfies all four Testing Scenario 4 clauses, non-vacuously | The clauses are already registered by other lanes through `registerRouteAssertion` (PF-202): (a) OpenAPI entry, L13 PF-373; (b) declares a scope, L03 PF-079; (c) `ApiError` on failure, L07 PF-201; (d) cursor pagination if a list endpoint, L08 PF-229–231. This ticket adds no fifth walker — it asserts the enumeration now contains **eight or more** v1 routes (three documents + three issues + three sprints + `me`, minus none) and that the suite still passes, and it converts PF-271's `scope: null` allowance into a case PF-079 explicitly covers rather than silently tolerates | TS-4 | p.5 | PF-202, PF-079, PF-271 |
| PF-296 | ☐ Cross-resource scope matrix and the +10% query budget over all three new lists | Two halves in one fitness pass. (a) A 3×3 matrix: each of `documents:read`, `issues:read`, `sprints:read` against each of the three list routes — the diagonal is 200, every off-diagonal is 403 naming the *required* scope, not the held one. (b) Per-route query counts for the three new lists are recorded against `docs/baseline-part1.json` (PF-020) and the association/user lookups use the batch helpers (`getBelongsToAssociationsBatch`, `getUserInfoBatch`, `api/src/utils/document-crud.ts:148`, `:496`) — the internal issues list already batches to avoid N+1 (`api/src/routes/issues.ts:224`), and a public list that re-introduces the N+1 blows the p.6 budget on the endpoint a grader hits hardest | MVP-9 | p.2, p.6 | PF-283, PF-020, PF-288 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L10-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L10-me` | PF-271–276 | MVP gate 8's server half and Testing Scenario 3's last clause — the endpoint a device-grant token and `ShipClient.me()` both resolve through | Session cookie alone → 401 while a bearer token → 200; body deep-equals the public schema with no `success` wrapper and no `isSuperAdmin`; `me` carries no `next_cursor`; real device-flow token returns the approving user |
| S2 | `pf/L10-issues` | PF-277–283 | The L09 pattern applied to a second resource: three scoped routes, one projection, a keyset that survives a PATCH | 3-route scope matrix with `details.required_scope`; priority PATCH mid-walk loses no rows; `properties` never serialized; `issues:read` cannot reach `/sprints` and `/issues` returns only issues |
| S3 | `pf/L10-sprints` | PF-284–289 | `sprints` as a public contract name over Ship's `weeks` vocabulary, with computed fields declared honestly | Grep finds no `'weeks'` literal under `platform/api/v1/sprints/`; a workspace with five sprints lists five (the internal route returns one); `EXPLAIN` shows no sort over a JSONB expression |
| S4 | `pf/L10-event-callsites` | PF-290–293 | Five of the eight registered event types get their publish call site — in the domain services, never in `api/v1/` | Grep finds no `.publish(` under `platform/api/v1/`; re-start emits zero `sprint.started`; state PATCH emits exactly one `issue.status_changed` matching the history row; `sprint.completed` test fails if nothing writes the value |
| S5 | `pf/L10-parity-and-budget` | PF-294–296 | The generator proves generic, Testing Scenario 4 runs over a real eight-route surface, and the +10% budget holds | `git diff --stat` empty under `platform/openapi/`; enumeration ≥ 8 routes with all four clauses green; 3×3 scope matrix; per-route query counts within baseline |

## Corrections found by building S1

Four claims in this file are wrong, and each was verified against the repo rather
than reasoned about.

1. **`api/src/app.ts:240` is stale — the internal weeks router mounts at `:293`.**
   Cited in the sprints-trap section above. L03's `resource-map.ts` already
   records the corrected line.
2. **The resource map is at `platform/api/v1/resource-map.ts`, not
   `platform/scopes/resource-map.ts`.** L03 created it at the corrected path
   (dispute B7 in its header), so PF-287's citation points at a file that does
   not exist. The map itself is fine and unconsumed so far — S3 is its first
   consumer.
3. **PF-275's `list: 'none'` is not available to `me`.** L08's
   `assertNoCursorOnFixedList` requires a `'none'` route's body to have an array
   at `data`, because `'none'` means *bounded-by-code collection*. `me` returns
   one object. Shipped as `list: false` with both observable criteria intact;
   full reasoning in `platform/api/v1/me/routes.ts`.
4. **F18's "add `issues` and `sprints` to `KEYSET_INDEXED_TABLES`" cannot work.**
   `assertKeysetIndexed` runs `EXPLAIN SELECT … FROM ${table}`, and neither is a
   table — `SELECT tablename FROM pg_tables WHERE tablename IN
   ('issues','sprints','documents')` returns only `documents`. Both are
   `document_type` values in the unified model. The correct artifact is two
   partial tenant-first indexes; the DDL and the reasoning for holding them back
   are recorded in `api/src/db/migrations/RESERVATIONS.md` under L10's block
   068–070.

One further defect, in L13's shipped code rather than in this file:
**`platform/openapi/staticCopy.test.ts` writes to the committed
`docs/openapi.json`** (its idempotence case calls `writePublicSpec()` for real).
A route module absent from that test file's import graph is therefore deleted
from the artifact by running `pnpm test`. `/me` generated correctly via
`pnpm openapi:public` and was silently removed minutes later. Fixed by extending
that file's import list; the durable fix is for the test to write to a temporary
path, which is L13's call.

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **On where the sprints↔weeks map belongs: L03's own doubt is right, and I would move it — to
  `platform/api/v1/`, not to this lane.** L03 placed it in `platform/scopes/resource-map.ts`
  because `docs/architecture.md:12` put the note under `scopes/`, and flagged in its audit notes
  that `scopes/` may be the wrong home. Having now written the consumer, the asymmetry is concrete:
  the map's key is a **URL path segment** (`/api/v1/sprints`) and its value is a **domain module**;
  the scope string `sprints:read` shares only the substring. Nothing in `scopes/` reads the map —
  `requireScope` takes a scope name and never resolves a resource — while L10's routes and L14's
  event publishers (PF-396) both do. A module every consumer imports and its declared owner never
  uses is in the wrong directory. **I am not moving it**, per L03's explicit instruction not to
  split it across lanes: PF-287 consumes it wherever it lives, and the assertion (no `'weeks'`
  literal outside the map) holds under either path. If the audit agrees, the move is L03's to make
  in one commit, and PF-287, PF-396 and PF-078 re-point their import.
- **`document-crud.ts` is not callable from the public layer, because it is not the thing the
  architecture doc says it is.** It exports association and history helpers only — no create, no
  update, no list — and `api/src/routes/documents.ts` does not import it at all. The pieces that
  *do* exist are already context-free (they take ids and a `pool`, not a `req`), so nothing in that
  file blocks the public layer; the problem is that everything the public layer needs is somewhere
  else, inline in the route handlers, tangled with `req.workspaceId`, `req.userId` and
  `requireAuth(req)` (`api/src/middleware/auth.ts:73`). L09's PF-241/PF-242 cut that seam and this
  lane repeats the cut for issues and sprints. Until then the honest answer to "can the public layer
  call the same domain service" is **no, because there is no domain service** — and every ticket in
  this lane that says "extracted from `routes/weeks.ts:NNN`" is carrying that extraction cost.
- **PF-280 (`PATCH /api/v1/issues/:id`) is scope creep by the strict reading, and I shipped it
  anyway.** MVP gate item 4 asks for list/get/create on one resource; nothing in the PRD asks for a
  public update on any resource. The justification is that p.3 registers `issue.assigned` and
  `issue.status_changed` as event types, and without a public write path neither can ever be
  triggered by a platform consumer — which makes two of the eight types decorative for exactly the
  audience the week is about. The counter-argument is fair: they can fire from internal UI traffic,
  Testing Scenario 6 only exercises `document.created`, and PATCH costs a request schema, a
  concurrency story and a test matrix during MVP week. If the audit cuts it, PF-293 loses its
  public producer and should say so explicitly rather than quietly retargeting at internal traffic.
- **PF-288's consequence is a product regression I chose deliberately.** The public sprint list is
  ordered by `created_at`, so sprints come back in the order they were *created*, not sprint
  number. Ship's internal list orders by `(properties->>'sprint_number')::int` and that is
  obviously the order a human wants. I took creation order because p.3 requires cursors *"stable
  across reordering operations"* and `sprint_number` is a mutable JSONB field with no index — a
  keyset over it is neither stable nor expressible as a row comparison. The alternatives, in order
  of cost: expose `?sort=sprint_number` as an offset-paginated non-cursor mode (violates the
  envelope rule), promote `sprint_number` to a real column with an index (a migration on Part 1's
  schema during MVP week), or ship creation order and document it. I shipped the third. It is the
  weakest user-facing decision in this lane.
- **PF-271 changes an assertion L03 owns.** Amending PF-079 to accept an explicit `scope: null` is
  an edit to another lane's fitness test, and under the spine's rules I cannot make it unilaterally.
  The alternatives were worse: an eighth scope breaks PF-062's exactly-seven assertion, which is
  MVP gate item 6's proof, and requiring `documents:read` on `me` means a webhooks-only app cannot
  discover who it is. Flag this as a cross-lane change and let L03 land the amendment; if L03
  refuses, `me` needs a different answer and this is the ticket to reopen.
- **`Advances` distribution, stated plainly.** MVP-4 appears on PF-277/278/279 and
  PF-284/285/286 even though the gate item names *documents* — the gate says "at least one
  resource," and these routes are built to the same criterion, so the tag is honest rather than
  inflationary. If the audit reads MVP-4 as documents-exclusive, demote all six to `—` and the lane
  claims MVP-3, MVP-7, MVP-8, MVP-9, TS-3 and TS-4 only. I would not argue hard. Nine tickets carry
  `—` and none of them is padding: the event call sites and the resource map advance no graded
  checkbox directly and I did not force one.
- **Deps that could not be written.** L05's device-grant tickets (PF-121–150) are the real
  dependency of PF-276 and that file is not written, so the ticket names the scenario in prose and
  cites no ID. L06's bearer middleware (PF-151–185) is the real dependency of PF-273 for the same
  reason. Both cells are under-stated on purpose — re-point them when those lanes land.
- **What I could not ticket.** The PRD never says what `/api/v1/me` should contain beyond *"the
  typed authenticated user"* (p.2) — the app object and scope array in PF-274 are ours. It never
  says whether `sprints` is writable at all; I inferred it from the existence of a `sprints:write`
  scope (p.3), which is the only evidence either way. And it says nothing about `ticket_number` /
  `display_id`, Ship's human-facing issue identifier (`api/src/routes/issues.ts:232`,
  `` display_id: `#${ticket_number}` ``) — I left it out of `issueSchema` rather than invent a
  contract for it, which means a CLI cannot print `#42` for an issue it just created. That is a
  visible gap in the demo story and a good candidate for a PF-297 audit append.
- **Not covered here, on purpose:** the `require(scope)` factory (L03), the bearer middleware and
  its distinct 401 codes (L06), the cursor codec and page envelope (L08), the event bus, envelope
  and registry (L14 — this lane owns only call sites), the OpenAPI operations these routes generate
  (L13), and the SDK's `client.issues` / `client.sprints` (L18). If any is unowned at audit time it
  goes to `lane-99-unassigned.md`, not into this file.
