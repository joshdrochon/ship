# L22 · Developer Portal

| | |
|---|---|
| **Agent** | `dev-portal` |
| **Tier** | 7 — runs with L19 (CLI) |
| **Block** | PF-651–685 (30 allocated, 5 reserved for audit) |
| **Blocks on** | L16 (`GET /api/v1/webhooks/deliveries` PF-464, replay PF-476), L12 (`listCalls` PF-343). Consumes L15 PF-429–433, L17 PF-491/495/505, L11 PF-306/311, L03 PF-062/072 |
| **MVP gate** | None. p.11 item 8 puts the portal last and calls it *"should-ship and short"*. Its graded homes are **TS-8** (p.5, the Replay click), **TS-9** (p.8, *"appears in dev portal"*), the **Demo Video** (p.12) and **Deployed Application** (p.13, *"Dev portal reachable"*) |

**The PRD asks for a kill criterion and this file is shaped around it.** Pre-Search 1.3 (p.15):
*"What is your kill criterion for the developer portal? If E5 is taking too long, is read-only
delivery-log-viewer the minimum viable portal?"* Slice S1 is that floor and every later slice is
strictly additive — no S2–S5 ticket edits an S1 file's contract, only adds routes and panels beside
it.

**One correction to the PRD's own suggested floor, and it is the most important sentence here.**
Read-only is *one button* short of what the PRD grades. Testing Scenario 8 (p.5) is *"Verify the
delivery lands in the dead-letter queue and is visible in the developer portal. Click "Replay"
against a now-healthy subscriber"*, and the Demo Video script (p.12) ends *"Then switch to the dev
portal and replay one delivery."* A read-only viewer satisfies "visible" and fails "Click Replay"
and fails the demo's closing shot. **S1 is therefore the viewer plus the Replay button**, and
PF-661 is deliberately the last ticket in the slice so the cut line is visible: everything above it
is the PRD's stated floor, and cutting PF-661/PF-662 forfeits half of a graded Testing Scenario and
the last ten seconds of the demo video. Do not cut below PF-661 to save an hour.

**The dog-food question has a structural answer, not a preference.** p.10 says the portal *"reuses
the public API like any other client (eat the dog food)"*; Pre-Search 2.5 (p.17) asks whether it
will, *"or will it have a privileged internal endpoint for admin operations"*. Three facts settle
most of it before taste enters:

1. **Bootstrap.** You cannot register your first OAuth app through an API that requires an OAuth
   token. p.2 says *"admin can create an app"* — an admin, not an app.
2. **No scope exists to gate it.** p.3's Scope Registry is seven scopes and none of them is
   `apps:*` or `audit:*`. L03 makes that a hard edge, not a soft one: PF-062 registers exactly the
   seven, PF-065 fails a duplicate registration at module load, and PF-068 throws at **wiring**
   time on an unregistered scope. Putting app CRUD on `/api/v1` means inventing an eighth scope the
   PRD does not name.
3. **Different principal.** The public API scopes deliveries to the *calling app* — L16's PF-463
   joins `webhook_deliveries → webhook_subscriptions → oauth_apps`, and PF-478 returns `not_found`
   for another app's delivery id. A portal is a *human who owns several apps*. A single portal
   OAuth app would see only its own deliveries, which is none.

So the split is forced, and the escape hatch is exactly **one** endpoint (PF-652): the owner proves
ownership with their Ship session and mints a short-lived access token **for the app they own**.
Every read and write *about that app* then goes over `/api/v1` with that app's own bearer token —
the same calls a third-party developer makes, through L17's `ShipClient` (PF-653). What stays on
the internal session surface is what the public contract has no route and no scope for: the app
list, the register form, secret rotation, and the audit-call view. p.4 itself distinguishes these —
it gives Replay a path (`/api/v1/webhooks/deliveries/:id/replay`) and gives the audit trail only
*"Queryable in the developer portal."*

**The bearer/cookie seam is real and it is where the CSRF question lands.** Ship's React UI
authenticates by session cookie (`sameSite: 'strict'`, 15-minute idle) and `/api/v1` takes bearer
tokens. Measured in the repo: `api/src/app.ts:73` `conditionalCsrf` skips CSRF whenever an
`Authorization: Bearer` header is present, and `api/src/middleware/auth.ts:135` **does not fall
back to session auth** when a bearer token is present and invalid — it 401s. So the bypass is not a
hole today, and PF-665 pins that with a test rather than leaving it as a reading of two files.
That is also why Pre-Search 3.1 (p.17) asks about CSRF on *"the portal's app-form and rotate-secret
endpoints"* specifically and not on the delivery log: those two are the cookie-authenticated half.

**Nothing in this lane re-decides D3 or D7.** `client_secret` rotation grace period is **D3**
(L99, owned by L02, unresolved, lean *instant*) and webhook payload contents are **D7** (L99, L14
PF-408, marked re-litigate). PF-670 renders whichever rotation model D3 lands on from a
`rotation_policy` value the API returns, so a flip is a data change and not a UI rewrite; PF-659
puts payloads behind click-to-reveal *regardless* of D7's outcome, so a flip does not touch the
portal either.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-651 | ☐ **Decision:** how the portal authenticates against `/api/v1` — Pre-Search 2.5's first bullet, answered | p.17 asks whether the portal *"will reuse the public API like any other client, or will it have a privileged internal endpoint for admin operations"*, noting *"Eating the dog food is more rigorous; an internal escape hatch is more pragmatic."* **Decision: dog food for everything the public contract covers; exactly one ownership-gated escape hatch to obtain the token.** Rejected and recorded: (a) *portal is one first-party OAuth app doing PKCE* — purest, but its token sees only its own deliveries because PF-478 404s another app's id, so it renders an empty log; (b) *privileged internal routes for everything* — cheapest, but then TS-8's *"visible in the developer portal"* proves nothing about `/api/v1` and the portal exercises no public contract; (c) *invent `apps:manage` and put app CRUD on `/api/v1`* — blocked by the bootstrap paradox (no token exists before the first app) and by p.3's seven-scope registry, which L03 PF-068 makes a wiring-time throw. Done when the choice, the three rejections and the principal argument (an app acts for itself; a portal user acts for many apps they own) are written into `docs/architecture.md` and the Pre-Search answer | `SUB:Pre-Search Document` | p.17, p.10, p.3 | — |
| PF-652 | ☑ The single escape hatch: `POST /api/apps/:id/portal-token`, ownership-gated, short-lived, memory-only | Session-authenticated (not bearer), returns a token for an app **the session user owns**; another owner's app id returns the same not-found body as a nonexistent id, so the endpoint is not an ownership oracle. TTL ≤ 15 minutes so it cannot outlive the session that authorized it, and the response carries no refresh token. Three assertions: an unauthenticated call 401s; a call for someone else's app and a call for a nonexistent app return byte-identical bodies; the minted token carries only scopes the app itself was granted, never a superset. This endpoint is the **whole** privileged surface — a fitness test greps the portal module and fails on any second internal route that returns webhook, delivery or subscription data | — | p.17, p.10 | PF-651 |
| PF-653 | ☑ The portal's `/api/v1` transport is L17's `ShipClient` — no second fetch wrapper, no `LocalStorageTokenStore` | Every public-API call the portal makes goes through `new ShipClient({ token })` (PF-491) over PF-495's single transport, with `InMemoryTokenStore` (PF-505) and explicitly **not** `LocalStorageTokenStore` (PF-507) — a portal token in `localStorage` is XSS-reachable and survives the tab, which is the opposite of PF-652's memory-only intent. A fitness test asserts zero direct `fetch('/api/v1` calls under the portal module. This is what makes *"reuses the public API like any other client"* (p.10) literally true: the portal compiles against the same package a stranger installs | `CTR:Developer Portal` | p.10, p.4 | PF-491, PF-495, PF-505, PF-652 |
| PF-654 | ☑ Portal route and shell integration — `/portal`, a rail icon, and the 4-panel layout honored rather than excepted | New page under `AppLayout`, reached from a rail icon; `Mode` in `web/src/pages/App.tsx:43` gains `'portal'` and `getActiveMode()` matches `/portal`. **All four panels are populated**: icon rail (existing), contextual sidebar = the app list (PF-655), main content = the delivery log (PF-656), properties sidebar = the delivery detail, rendered into the existing `<aside id="properties-portal">` via `createPortal` exactly as `Editor` does. Test asserts all four regions are non-empty on `/portal` with seeded data. `docs/document-model-conventions.md:494` scopes the always-visible rule to *"when viewing/editing a document"*, so the portal did not have to fit — it fits anyway, and PF-678 records that as a deliberate finding rather than an accident | `CTR:Developer Portal` | p.4, p.10 | PF-653 |
| PF-655 | ☑ App selector — the contextual sidebar lists the session user's own apps, read-only in this slice | Server returns only apps owned by the session user; a second owner's app is **absent from the list**, not present-and-403. Selecting an app is what triggers PF-652's token mint, and the selection is the scope of every panel to its right. Read-only here on purpose: registration is PF-664 and is not needed to view a delivery log. Empty state names the next action rather than rendering a blank pane. Test seeds two owners and asserts each sees exactly their own apps | `CTR:Developer Portal` | p.4 | PF-652 |
| PF-656 | ☑ Delivery log list — consumes PF-464, server-side cursor pagination, `SelectableList`, no client-side lying | Renders `GET /api/v1/webhooks/deliveries` through `ShipClient`, using the canonical `SelectableList` component (`web/src/components/SelectableList.tsx`) rather than a bespoke table — Ship has exactly four collection patterns and a new one is a philosophy violation PF-678 would have to file. Paging is `next_cursor` only: no `?offset`, no page numbers, and **no client-side sort or filter over the loaded page**, because sorting 25 loaded rows while claiming to sort thousands is a lie the user cannot see. `next_cursor: null` disables Next (PF-224). Test: a log of 60 deliveries walks in three pages and every row is visited exactly once | `CTR:Delivery Log` | p.4, p.3 | PF-464, PF-224, PF-654 |
| PF-657 | ☑ Filters map 1:1 onto PF-464's allowlist — and `status=dead_lettered` is the DLQ view TS-8 needs | Three filters and no more: status, subscription, event type — exactly the params PF-464 puts on L08's strict allowlist (PF-226). The portal sends no param the route does not declare, so a typo surfaces as `validation_failed` and not as a silently unfiltered page. `status=dead_lettered` is a first-class view with its own entry point, because p.4 requires the DLQ *"visible in the developer portal"* and p.5 has a grader looking for it under time pressure. Test: the DLQ view over seeded data shows every `dead_lettered` row and nothing else | `CTR:Dead-Letter Queue` | p.4, p.5 | PF-656, PF-226 |
| PF-658 | ☑ Delivery detail panel — every column p.4 names, plus the four that make a failure diagnosable | Properties panel for the selected delivery shows `attempt_number`, `response_status`, `latency_ms` and `response_excerpt` (the p.4 list) plus `status`, `dlq_reason`, `idempotency_key` and `replay_of_delivery_id` — L16 added those four (PF-458) precisely so an operator can tell *"this subscriber has been down for six minutes"* from *"this subscriber returned 410 and is never coming back"* (PF-474), and a panel that omits `dlq_reason` throws that away. `replay_of_delivery_id` renders as a link to the ancestor row. A `null` `response_status` renders as "no response" and never as blank or `0` — null means the request never got an answer | `CTR:Delivery Log` | p.4 | PF-656, PF-458 |
| PF-659 | ☑ Payloads and response excerpts are collapsed by default, click-to-reveal, and D7-proof | Pre-Search 2.5 (p.17) asks whether the portal shows payloads *"in full, redacted, or behind a click-to-reveal"* and says to *"Defend the choice"* against 1.4's leakage concerns (p.15). **Decision: click-to-reveal, collapsed by default, for the request payload (PF-475's stored `rawBody`) and for `response_excerpt` alike.** Defense: the portal is the one screen where a screenshot or a screen-share captures *many* payloads at once, and `response_excerpt` is a third party's response body that we never controlled. Deliberately **independent of D7** (L99, webhook payload contents, L14 PF-408, marked re-litigate): if D7 lands on ids-only the reveal is harmless and costs one click; if it keeps `title` the default-collapsed state is the difference between a leak and a click. Either way the portal does not change. Test: the payload string is absent from the DOM until the control is activated | `CTR:Developer Portal` | p.17, p.15 | PF-658, PF-475 |
| PF-660 | ◐ Empty, error, 401 and 429 states are rendered states — the portal never spins or blanks | Four cases, each asserted: zero deliveries renders an explanatory empty state naming what would produce one; a `ShipError` renders `message` and `request_id` (PF-502) so a user can quote it in a bug report; `kind: 'auth'` (an expired PF-652 token) silently re-mints once and retries, and only surfaces after a second failure; a 429 renders the wait derived from `Retry-After` (PF-306) and disables the control until it elapses rather than letting the user hammer a limited endpoint. The 429 case is not hypothetical — the portal's reads spend the same per-app bucket the developer's own integration spends (PF-304), and a portal that spins during the demo is a worse look than one that says "rate limited, 12s" | — | p.4, p.7 | PF-653, PF-306, PF-311, PF-502 |
| PF-661 | ☑ **The Replay button** — the cut line for this lane, and a submission artifact | `POST /api/v1/webhooks/deliveries/:id/replay` (PF-476) from the delivery row and the detail panel, enabled on any terminal status (PF-476 decided replay is not DLQ-only) and disabled on `in_flight` with the reason shown. On success the new record appears in the list with its `replay_of_delivery_id` link and the original row is left untouched — PF-477 keeps the DLQ's history rather than mutating it into a success, and a UI that swapped the row in place would hide exactly that. Double-click is safe by construction (PF-479: two records, one idempotency key) so the button is **not** disabled after the first click; it is idempotent at the subscriber, and disabling it would break the legitimate re-replay after a second fix. This is the last ten seconds of p.12's demo — *"Then switch to the dev portal and replay one delivery"* | `CTR:Replay` | p.4, p.12 | PF-476, PF-477, PF-479, PF-658 |
| PF-662 | ☐ **Testing Scenario 8, portal half** — end to end in Playwright, through the rendered UI | p.5, asserted whole and through the browser rather than the API: seed six consecutive failures so L16 dead-letters the delivery (PF-481 owns the mechanics), open `/portal`, select the app, open the DLQ view, and assert the row is **visible** with `dlq_reason = 'max_attempts_exhausted'`. Point the subscriber at a healthy target, **click Replay in the UI**, and assert the new delivery reaches `delivered` and its `Idempotency-Key` is byte-identical to the original's. Recorded as one test so a partial pass cannot be reported as a pass. The API half is PF-481's; this is the half the PRD's word *"Click"* requires and no API test can cover | `TS-8` | p.5, p.4 | PF-661, PF-481, PF-657 |
| PF-663 | ☑ App list gains the owner's full app record — `client_id`, scopes, redirect URIs, created-at | The read side of *"listing apps"* (p.4). Shows `client_id` in full (it is not a secret and a developer needs to copy it), the granted scope list rendered from `ScopeRegistry` descriptions (PF-070 already reads the registry for the 403 body — same source, so a scope's description is written once), redirect URIs, and creation time. The hashed `client_secret` is **never** in the response payload at all, not merely hidden in the UI — asserted by scanning the response body for any field whose name contains `secret` | `CTR:Developer Portal` | p.4, p.3 | PF-655, PF-062, PF-070 |
| PF-664 | ☑ Register-app form — *"registering apps"*, with `requested_scopes` driven by the registry | Form collects name, redirect URIs and requested scopes; the scope checkboxes are generated from `ScopeRegistry` (PF-062/PF-072), never a hard-coded list, so L03's OCP claim (PF-066 — a new scope touches only the registration file) survives contact with the UI. Server-side validation failures render field-level, and an unknown scope is rejected by `validateRequestedScopes` (PF-073) rather than by the form. On success the flow lands on PF-666's shown-once display and **cannot** be re-entered. Test: submitting an unregistered scope fails with the scope named | `CTR:OAuth App Model` | p.4, p.2, p.3 | PF-663, PF-072, PF-073 |
| PF-665 | ☑ CSRF on the app-form and rotate-secret endpoints — Pre-Search 3.1 answered against the code that exists | p.17: *"What is your CSRF protection on the developer portal's app-form and rotate-secret endpoints, given they sit alongside the OAuth consent screen?"* Answer, measured rather than proposed: these two are the **session-cookie** half, so they reuse the shipped `csrf-sync` synchroniser token (`api/src/app.ts:67`, header `x-csrf-token`, minted at `GET /api/csrf-token`) plus `sameSite: 'strict'` session cookies. Three tests: (a) a POST without the header is rejected; (b) **the bearer bypass cannot be turned into a CSRF bypass** — a request carrying a valid `session_id` cookie *and* a junk `Authorization: Bearer x` skips `conditionalCsrf` (`app.ts:73`) but 401s at `authMiddleware` (`middleware/auth.ts:135`), which does not fall back to the session; (c) `/api/v1` routes need no CSRF token, because the browser never attaches a bearer header on its own. Written up next to the consent screen's clickjacking answer (p.16, L04's), since p.17 raises them as one adjacency | `CTR:Developer Portal` | p.17 | PF-664 |
| PF-666 | ☑ Shown-once secret display — masked by default, reveal is deliberate, copy never renders | p.2 requires the raw secret *"shown exactly once on creation"* and p.15 asks how the display is protected *"from accidental leakage via screenshot"*. **Honest framing: a screenshot cannot be prevented; what is controlled is what a screenshot captures.** So: masked (`••••`) by default with an explicit Reveal, auto-remask on blur and after 30 s, a Copy control that writes to the clipboard **without ever rendering the plaintext**, and a dismiss gated on an "I have stored it" acknowledgement. Not an `<input>` — a password manager must not offer to save it. One component, reused by rotation (PF-670) and by subscription secrets (PF-672); a second implementation is a philosophy violation and a second place to leak. Test: the secret string is absent from the DOM before Reveal and absent again after remask | `CTR:OAuth App Model` | p.2, p.15 | PF-664 |
| PF-667 | ☑ The raw secret never reaches persisted client state — asserted against IndexedDB, not assumed | **Measured repo hazard:** `web/src/lib/queryClient.ts` persists the TanStack query cache to IndexedDB (`createStore('ship-query-cache','queries')`, key `tanstack-query`) via `PersistQueryClientProvider`, and that store survives reload and logout. A `client_secret` that lands in *query* state is therefore written to disk. Fix: the create and rotate calls are mutations whose response is held in component state only — never `setQueryData`, never a query key. Test: register an app, then read the persisted client out of IndexedDB and assert the secret string does not appear anywhere in it; repeat after `queryClient.clear()` to prove no residue. p.15 names *"log line"* as a leakage path and a cache written to disk is a log line with extra steps | — | p.15 | PF-666 |
| PF-668 | ☑ The Back button cannot re-show the secret — the second vector p.15 names | The secret is never in a URL, never in `history.state`, and never behind a route of its own: the shown-once display is a modal over the app list, so a Back navigation remounts it empty. Playwright: create an app, dismiss, navigate away, press Back, and assert the value is gone and the screen says the secret is no longer retrievable and names rotation as the only recovery — which is p.2's *"never recoverable thereafter"* stated to the user rather than discovered by them. Also asserted after a full reload | — | p.15, p.2 | PF-666 |
| PF-669 | ☑ No log line carries the secret — the third vector, enforced by grep and by a clean console | p.15's third named path. A fitness test greps the portal module for `console.`/logger calls on any code path that touches the create or rotate response and fails naming file and line; a Playwright run of create-app and rotate-secret asserts the browser console contains no message matching the secret. Server-side non-logging is L02's, and the split is stated so neither side assumes the other covered it. This file's own code is the reason the test exists rather than a convention: `queryClient.ts` already logs freely at module scope, so "we do not log secrets" is not a property of this codebase's habits | — | p.15 | PF-666 |
| PF-670 | ☑ Rotate secret — confirmation is destructive-grade, and the copy is driven by **D3**, not hard-coded | *"viewing/rotating client_secret (shown once)"* (p.4). Rotation requires typing the app name to confirm, because under D3's current lean the old secret dies instantly and every live integration breaks at that click. **This ticket does not decide D3** (L99, owned by L02, unresolved: instant vs. a Stripe-style grace period). It renders whichever model ships from a `rotation_policy` field the API returns: `instant` shows "any integration using the old secret will start failing now"; `grace` shows the old secret's prefix and its expiry alongside the new one. A test drives both values against the same component. If the portal hard-codes the instant copy and D3 flips, the UI lies about the security model — which is worse than either model | `CTR:OAuth App Model` | p.4, p.2 | PF-666, PF-663 |
| PF-671 | ☐ Subscription list for the selected app — *"managing subscriptions"*, read half | Renders `GET /api/v1/webhooks` (PF-430) through `ShipClient`, cursor-paginated in `SelectableList`, scoped to the selected app by that app's own token. Shows target URL, event type, `secret_prefix` (PF-423 — the clear-text identifier, never the secret) and `active`. `active: false` renders as a distinct state, not as absence, because PF-426 makes deactivation a matcher input rather than a delete and a UI that hides inactive rows makes a deactivated subscription look destroyed | `CTR:Webhook Subscriptions` | p.4, p.3 | PF-430, PF-423, PF-653 |
| PF-672 | ☐ Create subscription — target URL, event type from the registry, signing secret shown once | `POST /api/v1/webhooks` (PF-429). Event type is a select generated from `EVENT_TYPES` (PF-391), never a free-text field, so an unregistered type is impossible from the UI as well as rejected by the server (PF-397). `target_url` validation errors from PF-425 (absolute `https`, not pointed at us) render on the field. The returned signing secret goes through **PF-666's component unchanged** — same masking, same copy-without-render, same acknowledgement — because it is the same class of value and a second shown-once implementation is a second place to leak it | `CTR:Webhook Subscriptions` | p.3, p.4 | PF-671, PF-429, PF-391, PF-666 |
| PF-673 | ☐ Deactivate and delete are different actions and the UI says which | `PATCH /:id` toggles `active`, `DELETE /:id` removes (PF-431). Deactivation is presented as reversible and states that pending retries are cancelled (PF-457 closes them as `cancelled`, a terminal state distinct from `dead_lettered`); deletion is presented as permanent and states that the subscription's delivery rows go with it — PF-458's FK is `ON DELETE CASCADE`, so deleting a subscription destroys the delivery history the portal exists to show. A user who wanted "stop sending for now" and got "history erased" was failed by the UI, not by the API. Test: both paths, and the warning text asserted | `CTR:Webhook Subscriptions` | p.3 | PF-671, PF-431 |
| PF-674 | ☐ The TTFE drill's portal assertion — *"subscription appears in dev portal"* is checked, not assumed | p.8's Signature Challenge evaluation table has a row whose expected outcome is *"Subscription persisted; signing secret returned once; subscription appears in dev portal."* Today nothing would fail if it did not appear. Acceptance: the drill (L20's harness) creates a subscription through the SDK and this lane supplies the assertion that it is rendered in the portal's subscription list for that app within the drill's budget. Kept to an assertion the drill calls, not a second Playwright suite, so the drill stays under p.6's < 60 s CI target | `TS-9` | p.8, p.5 | PF-671 |
| PF-675 | ☐ **Decision:** where the audit-trail view's HTTP surface lives — L12 ships a repository function, not a route | p.4 requires the public audit trail *"Queryable in the developer portal"*, and L12's PF-343 delivers `listCalls({clientId, from, to, status, route, cursor})` — a repository function. React cannot call a repository function, so a route is missing and neither lane has it. **Lean: an owner-scoped route on the internal session surface, gated by app ownership.** Reasons: p.3's seven scopes contain nothing that would gate an audit route on `/api/v1`, and inventing one repeats PF-651's rejected option (c); and p.4 gives Replay an explicit `/api/v1` path while giving the audit trail only *"in the developer portal"*, so the PRD itself does not put it on the public contract. Rejected: an eighth scope plus `/api/v1/audit/calls` (defensible, but it is a PRD extension); reading `public_api_calls` directly from the React page (no). Done when the choice is recorded and the owning lane is named — if L12's audit prefers to own the route, that is a `⚑`, not a local fix | `CTR:Public Audit Trail` | p.4, p.3 | PF-343 |
| PF-676 | ☐ Audit-call view renders L12's full field set, `request_id` included, and discloses its own traffic | Columns are exactly `PublicApiCallRecord` (PF-326): timestamp, `client_id`, `user_id`, route, scope used, status, latency, **`request_id`** — the field p.18 names and that `docs/architecture.md` omitted until PF-327. Cursor-paginated over PF-343's stable `(occurred_at, id)` ordering, filterable by status and route. A `null` `scope used` renders as "no scope checked" and never as "passed" (PF-333 fixed that meaning; the UI must not re-break it). **Honest disclosure:** the portal's own `/api/v1` reads authenticate as the app being inspected, so they appear as rows in the trail the developer is reading. The view says so and offers a route filter, rather than letting a developer conclude their integration is making calls it never made | `CTR:Public Audit Trail` | p.4, p.18 | PF-675, PF-326, PF-343 |
| PF-677 | ☐ **The scale answer** — build-cheap vs. rebuild-cheap, decided with the reasoning the question asks for | p.17: *"How will the delivery-log view scale visually when an app has thousands of deliveries — server-side pagination, virtualized list, time-bucket filters? Which is build-cheap and which is rebuild-cheap later?"* The three are not alternatives; they cost differently in both directions. **Server-side pagination is both build-cheap and correct** — PF-464 already returns `{data, next_cursor}` and p.3 mandates that shape, so the portal's cost is consuming it (PF-656), and it is the only one of the three that bounds transfer as well as DOM. **Virtualization is the rebuild-cheap one** — purely client-side, drops into `SelectableList` later without touching the data contract, and is therefore deliberately *not* built now; it only helps once a page holds thousands of rows, which cursor pagination prevents. **Time-bucket filters are the expensive one and the least rebuild-cheap**: they are new server params on PF-226's strict allowlist *plus* an index — PF-463 ships `(subscription_id, attempted_at DESC, id)`, which does not cover a time-range scan across all of an app's subscriptions. Done when this is written into the Pre-Search answer with the index named, and when the deferral of virtualization is recorded as a decision rather than an omission | `SUB:Pre-Search Document` | p.17, p.3 | PF-656, PF-463 |
| PF-678 | ☐ Philosophy audit — the portal is a document-model exception and a 4-panel conformer, both on the record | Run `/ship-philosophy-reviewer` over the lane and record the result, because the portal trips two of its proactive triggers (new components, new routes) and one of its smell tests (new tables). Findings to confirm, not rediscover: (a) **"Everything is a document" does not apply** — `oauth_apps` (p.2), `webhook_subscriptions` (p.3) and `webhook_deliveries` (p.4) are named as tables by the PRD, are credentials and operational records rather than user content, have no title/body, and `docs/document-model-conventions.md` already excludes *"User identity/auth"* from the document model. A hashed `client_secret` inside a Yjs-synced document is a security defect, not a purity win; (b) **the 4-panel layout is honored, not excepted** (PF-654) even though `document-model-conventions.md:494` scopes the rule to documents; (c) **no new collection pattern** — both lists are `SelectableList`. Done when all three are written into the audit notes with the reviewer's verdict attached | — | p.2, p.3, p.4 | PF-654, PF-656 |
| PF-679 | ◐ The demo's portal path is a rehearsed artifact, not a live improvisation | p.12's script ends *"Then switch to the dev portal and replay one delivery."* Acceptance: from a cold browser, the path login → `/portal` → select app → DLQ view → Replay → visible success is **four clicks or fewer** and is scripted in the demo runbook with the seeded dead-lettered delivery named. The seed is deterministic (a subscriber that 500s six times, created by the demo fixture), so the DLQ is never empty at recording time — the single most likely way this shot fails is an empty DLQ and a presenter waiting six minutes on camera | `SUB:Demo Video` | p.12 | PF-662 |
| PF-680 | ◐ The deployed portal is reachable and the grader's pre-registered app is visible in it | p.13's Deployed Application row requires *"Dev portal reachable"* alongside a resolvable spec and a pre-registered read-only OAuth app. Acceptance: on the deployed instance, `/portal` loads for the grader credentials in the README, the pre-registered app appears in the app list, and its subscription and delivery log render — with no `client_secret` exposed anywhere, since the grader's app was registered before they arrived and its secret is long since unrecoverable (p.2). A smoke check runs post-deploy and fails the deploy on a blank portal, because a portal that 500s for the grader is indistinguishable from one that was never built | `SUB:Deployed Application` | p.13, p.2 | PF-654, PF-663, PF-671 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L22-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms the fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L22-viewer-floor` | PF-651–662 | **The kill-criterion floor** (p.15): a read-only delivery-log viewer *plus* the Replay click, which is what TS-8 (p.5) and the demo (p.12) actually require. Everything after this slice is additive | PF-662 runs TS-8's portal half through the browser: DLQ row visible → click Replay → original idempotency key intact. PF-653 grep finds zero direct `fetch('/api/v1` under the portal module |
| S2 | `pf/L22-apps-and-secrets` | PF-663–670 | *"listing apps, registering apps, viewing/rotating client_secret (shown once)"* (p.4), with all three of p.15's named leakage vectors closed | PF-667 asserts the secret is absent from the persisted IndexedDB cache; PF-668 Back-button and reload both show it gone; PF-665 a session cookie plus a junk bearer header cannot mutate |
| S3 | `pf/L22-subscriptions` | PF-671–674 | *"managing subscriptions"* (p.4) over `/api/v1/webhooks` with the app's own token, and p.8's *"subscription appears in dev portal"* drill row asserted | PF-672 an unregistered event type is unreachable from the UI and rejected by the server; PF-674 the drill's portal assertion passes inside the CI budget |
| S4 | `pf/L22-audit-view` | PF-675–676 | *"Every public API call recorded … Queryable in the developer portal"* (p.4), including the `request_id` field p.18 names | PF-676 columns compared against `PublicApiCallRecord`'s key set; a cursor walk over 500 rows visits each once |
| S5 | `pf/L22-scale-and-submission` | PF-677–680 | The Pre-Search scale answer (p.17), the philosophy verdict, and the two submission artifacts the portal owns (p.12, p.13) | PF-677 written with the uncovered index named; PF-679 the demo path is ≤ 4 clicks from a cold browser; PF-680 post-deploy smoke fails on a blank portal |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **The kill criterion, and the one place I overrode the PRD's own suggestion.** Pre-Search 1.3
  (p.15) proposes *"read-only delivery-log-viewer"* as the minimum viable portal. I made S1 that
  viewer **plus the Replay button** (PF-661/PF-662), because Testing Scenario 8 (p.5) says
  *"Click "Replay""* and the Demo Video script (p.12) ends on that click. Read-only is one button
  short of a graded requirement. If the audit prefers the literal 1.3 floor, the change is to move
  PF-661/PF-662 into S2 — but the PR that does it should say out loud that it forfeits TS-8's
  second half and the demo's closing shot, because that is what it costs. I do not think it is
  defensible; I am flagging it rather than hiding it.
- **PF-651 is the load-bearing decision and it is not a preference — challenge the reasoning, not
  the taste.** Three facts force the split: (1) bootstrap — you cannot register your first OAuth
  app through an API that requires an OAuth token, and p.2 says *"admin can create an app"*;
  (2) p.3's scope registry is seven scopes with nothing for apps or audit, and L03's PF-068 throws
  at wiring time on an unregistered scope, so "just add a scope" is a PRD extension and not a fix;
  (3) PF-478 returns `not_found` for another app's delivery id, so a single portal OAuth app would
  render an empty delivery log — the public API is built for an app acting on its own behalf and a
  portal is a human acting for many apps they own. The residual is PF-652, one ownership-gated
  token-mint endpoint. **If the audit finds a fourth option I missed, this is the ticket to
  reopen.** The one I considered and rejected without ticketing: Client Credentials for the portal,
  which is D5's territory (agent grant type, unresolved in L99) and would make the portal depend on
  a decision it does not own.
- **I did not re-decide D3 or D7 and both are load-bearing here.** D3 (`client_secret` rotation,
  L02, lean *instant*) drives PF-670's confirmation copy, which is why that copy comes from an API
  field rather than a constant — a flip to a grace period is then a data change. D7 (webhook
  payload contents, L14 PF-408, marked *re-litigate*) drives what is inside the payloads PF-659
  renders, which is why PF-659 collapses them by default under **either** outcome. If either
  decision lands while this lane is in flight, nothing in these tickets needs rewriting; that was
  the point of shaping them this way. Verify that claim rather than trusting it.
- **PF-675 is a real hole between L12 and this lane, and I could not close it alone.** p.4 requires
  the audit trail *"Queryable in the developer portal"*; L12's PF-343 ships `listCalls(...)`, a
  repository function with no HTTP surface, and its own note says *"the portal UI is L22's ticket,
  not this one."* Neither lane ships a route. My lean is an owner-scoped internal route (p.4 gives
  Replay a `/api/v1` path and gives the audit trail no path at all, which I read as deliberate),
  but L12 may reasonably claim it. **Raise it as a `⚑` and settle it between the lanes** — if it
  is still unowned at audit time it belongs in `lane-99-unassigned.md`, not resolved here.
- **Three repo facts I measured rather than assumed; re-measure them before trusting this file.**
  (a) `web/src/lib/queryClient.ts` persists the TanStack cache to **IndexedDB** (`ship-query-cache`
  / `tanstack-query`) and it survives reload and logout — that is why PF-667 exists and why it
  asserts against the store rather than against a code review. (b) `api/src/app.ts:73`
  `conditionalCsrf` skips CSRF whenever an `Authorization: Bearer` header is present, and
  `api/src/middleware/auth.ts:135` does **not** fall back to session auth when that token is
  invalid — so the bypass is safe today, and PF-665 pins it. If a future change makes
  `authMiddleware` fall back, PF-665 fails and it should. (c) `web/src/pages/App.tsx` renders
  `<aside id="properties-portal">` for every page under `AppLayout`, not only for documents, so
  PF-654's fourth panel is a `createPortal` target that already exists. None of these is in
  `docs/`; all three came from reading the code.
- **The philosophy verdict, stated so PF-678 confirms rather than rediscovers.** *Everything is a
  document* does **not** apply to the portal's data: `oauth_apps` (p.2), `webhook_subscriptions`
  (p.3) and `webhook_deliveries` (p.4) are tables the PRD names, holding credentials and
  operational records with no title and no body, and `docs/document-model-conventions.md` already
  puts *"User identity/auth"* on the "stays as configuration" side. The 4-panel layout, by
  contrast, **is** honored — and note the drift the audit should record as a finding:
  `docs/document-model-conventions.md:494` scopes always-visible to *"when viewing/editing a
  document"*, while `.claude/skills/ship-philosophy-reviewer/SKILL.md` states it unconditionally
  as *"All panels always visible."* The repo already contradicts the unconditional reading —
  `/settings`, `/my-week` and `/team/status` render no properties panel. The portal fits anyway,
  so this lane does not depend on which reading wins, but the two documents should be reconciled.
- **`Advances` distribution, and why there is no `MVP-N` and no `PERF:`.** `CTR:*` on fourteen
  tickets (Developer Portal ×5, OAuth App Model ×3, Webhook Subscriptions ×3, Delivery Log ×2,
  Public Audit Trail ×2, Dead-Letter Queue ×1, Replay ×1), `SUB:*` on four, `TS-8` on one, `TS-9`
  on one, `—` on five. **No `MVP-N` anywhere and that is correct** — p.11 item 8 places the portal
  last and calls it *"should-ship"*, and no p.2 gate checkbox mentions it; MVP-1's shown-once
  requirement is satisfied by L02's endpoint, not by this UI. **No `PERF:` either** — p.6's targets
  are TTFE, OAuth round-trip, spec parity, webhook latency, retry success, rate-limit headers and
  the regression budget, and the portal moves none of them. I did not stretch a prefix to avoid a
  blank column.
- **What this lane does not own, on purpose:** the delivery-log endpoint, the DLQ status, replay
  mechanics and the idempotency key (L16 — this lane clicks the button and renders the rows);
  `oauth_apps`, secret hashing, secret rotation semantics and the shown-once *endpoint* (L02 —
  this lane owns the shown-once *display*); the subscription table, signing and the secret's
  encryption at rest (L15); `listCalls` and the audit record shape (L12); the TTFE drill harness
  (L20); the consent screen and its clickjacking defense (L04, p.16 — adjacent to PF-665 because
  p.17 raises them together, but not mine). L18's SDK resource clients are what PF-653's
  `ShipClient` will call for webhooks; L18 was in flight while this file was written so its ids
  are referenced in prose only and the audit should wire them into `Deps` for PF-653, PF-671 and
  PF-672.
- **Two things I could not ticket.** First, **`/api/v1` has no route the portal can use to browse
  the audit trail**, for the scope reason in PF-675 — the honest consequence is that the portal is
  *not* a pure `/api/v1` client and PF-651 says so rather than claiming otherwise. Second, **a
  portal-minted token's traffic is indistinguishable from the developer's own integration traffic
  in the audit trail**, because L12's `PublicApiCallRecord` (PF-326) is a closed key set asserted
  against a literal array and adding a "this call came from the portal" field is a cross-lane
  change to a ticket that exists to prevent exactly that. PF-676 discloses the pollution in the UI
  and offers a route filter instead. If the audit thinks the field is worth the cross-lane edit,
  that is a finding for `lane-99-unassigned.md`, not a change to make here.
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.

## Landed — slice S1 (`pf/L22-viewer-floor`), 2026-08-13

Recorded here rather than in a report file, because the next person reads this board.

| Ticket | State | Evidence |
|---|---|---|
| PF-652 | ☑ | `api/src/routes/portal.ts` + `portal.test.ts` — 15 tests. Byte-identical 404 for foreign/absent/malformed id; bearer rejected; no-CSRF rejected; **no `refresh_token` key in the body** and the refresh half revoked in the DB before the handler returns; TTL 900 s; scope set equals the app's own |
| PF-653 | ☑ | `web/src/lib/portalClient.ts` is the ONLY `new ShipClient(...)` site; `portalTransport.test.ts` — 6 tests — greps every portal file for a `/api/v1` string literal, any `fetch(`, and `LocalStorageTokenStore`. All zero |
| PF-654 | ☑ | `/portal` + `/portal/:appId`, rail icon, `Mode` gains `'portal'`. **All four panels rendered in a real browser** — rail, app-list sidebar, delivery-log main, properties panel via `createPortal`, populated even with no app selected |
| PF-655 | ☑ | `PortalAppsSidebar` over `GET /api/apps` (owner-scoped at the repository, PF-044). Rendered |
| PF-656 | ☑ | `usePortalDeliveries` → `client.webhooks.deliveries.list`. `SelectableList`, no bespoke table. Cursor-only paging, `next_cursor: null` disables Next. **Seven rows rendered in the browser** |
| PF-657 | ☑ | Three filters, exactly PF-464's allowlist. DLQ view measured in the browser: **1 row, the `dead_lettered` one, and nothing else** |
| PF-658 | ☑ | Detail panel read out of the live DOM: `dlq_reason = max_attempts_exhausted`, `attempt_number 6`, `idempotency_key`, `replay_of_delivery_id`. `response_status: null` renders "no response", never `0` |
| PF-659 | ☑ | `RevealPanel`. Measured in the browser: the excerpt string `upstream unavailable` is **absent from the DOM** before Reveal |
| PF-661 | ☑ | **Replay clicked in the rendered UI.** Returned a new attempt carrying the ORIGINAL idempotency key `477a152f…`, byte-identical. Original dead-lettered row untouched, still in the DLQ view. Button not disabled after the click (PF-479); disabled only on `in_flight`, with the reason shown |
| PF-660 | ◐ | All four states are WRITTEN (empty, error with `request_id`, silent single re-mint on `kind: 'auth'`, 429 with the `Retry-After` wait and a disabled control). Only the empty state was rendered; the other three have **no automated test** |
| PF-679/680 | ◐ | `api/src/db/scripts/seedPortalDemo.ts` — the deterministic DLQ fixture (six 500s, one delivered row) and p.13's pre-registered read-only app. Idempotent. Not yet wired into deploy or a runbook |

**Not started at the end of S1: PF-651 (write-up), PF-662 (Playwright spec), PF-663–678, S2–S5.**

## Landed — slice S2, the write surface (`pf/L22-portal-write-surface`), 2026-08-15

What S1 shipped was a read-only portal: it rendered a delivery log and could Replay, but there
was **no way to create an app and no way to rotate its secret** — p.4's *"registering apps"* and
*"viewing/rotating client_secret (shown once)"* had no UI at all. Verified before building, not
assumed: `PortalAppsSidebar` carried no form, and `grep` over `web/src` found no caller of
`POST /api/apps` or `/rotate-secret`. The server side already existed (L02's `apps.ts`), so this
slice is one new read route and the four components that consume the write routes L02 shipped.

**Re-runnable evidence.** Three suites, all green on this branch:

```
api  : npx vitest run src/routes/portalWriteSurface.test.ts     13/13 passed
web  : npx vitest run src/components/portal/ src/pages/portal/  34/34 passed (4 files)
e2e  : npx playwright test e2e/portal-write-surface.spec.ts       6/6 passed (29.5s, 1 worker)
```

| Ticket | State | Evidence |
|---|---|---|
| PF-663 | ☑ | `AppRecordPanel.tsx`. **Read out of a real browser** (`portal-write-surface.spec.ts`, "PF-663"): `client_id` in full, `documents:read` + `webhooks:manage` with the description *"Read documents"* rendered from `ScopeRegistry` (same source PF-070's 403 body reads), the redirect URI byte-for-byte, `created_at` non-empty. `portalWriteSurface.test.ts` asserts the response body's secret-ish keys are **exactly** `['secret_prefix','secret_version']` and that the raw secret appears nowhere in it as a value |
| PF-664 | ☑ | `RegisterAppDialog.tsx` + new `GET /api/apps/registry` (`apps.ts`, registered **before** `/:id` — below it the path parses as an app id and 404s). Checkboxes are generated: the component test serves a registry of `mercury:read`/`mercury:write`, which a hard-coded list could not render, and the Playwright test asserts the form offers **exactly** what the live registry serves, no more. `portalWriteSurface.test.ts`: every scope the endpoint offers is accepted by `POST /api/apps`, and `apps:manage` is rejected **by the server** with the name echoed into `details.fieldErrors.requested_scopes`, which is the path the form renders under the field. Negative case driven through the browser: `http://not-loopback.example/cb` fails with the https message under the redirect field, form values intact |
| PF-665 | ☑ | `portalWriteSurface.test.ts` → "PF-665 — CSRF on the app-form and rotate-secret endpoints", 4 tests. (a) `POST /api/apps` and `POST /api/apps/:id/rotate-secret` with a valid session and no `x-csrf-token` are **403**, and the rotate case asserts `secret_prefix` unchanged — a rejected CSRF must not half-rotate. (b) F26's coupling pinned: session cookie + junk bearer + no CSRF token is **401** on both. (c) `/api/v1` needs no token — a bearer POST fails at authentication, and the body contains no `csrf`. Written up next to L04's clickjacking answer at `PRESEARCH-PLUGFORGE.md` Q46, which had said "L22 PF-665 adds the regression test" and now names the file |
| PF-666 | ☑ | `SecretOnceDialog.tsx`, one component reused by registration and rotation. `portalSecret.test.tsx` — 17 tests: the secret string is **absent from `document.body.textContent`** before Reveal (absence, not `display:none`), present after, absent after Hide, absent after `advanceTimersByTime(30_000)`, absent after `fireEvent.blur(window)`. Copy calls `clipboard.writeText` with the value while the DOM still does not contain it. The node is a `<code>`, and there is no `input[type=password]` for a password manager to grab. Done is disabled until the acknowledgement is ticked. Same behaviour confirmed in the browser |
| PF-667 | ☑ | Asserted against **IndexedDB itself**, not against the hook's source: `portal-write-surface.spec.ts` opens `ship-query-cache` / `queries` via `page.evaluate` after registering and again after rotating, and neither raw secret appears. `portalSecretHygiene.test.ts` adds the static half — no portal module calls `useQuery`/`useMutation`/`setQueryData`, or touches `localStorage`/`sessionStorage`/`indexedDB`, so nothing the portal holds *can* reach the persisted cache. **Deviation, stated:** the ticket's `queryClient.clear()` repeat was not written; the grep that no portal module uses query state at all is the stronger form of the same claim, and it fails at build time rather than only when a test drives the path |
| PF-668 | ☑ | The shown-once display is a modal over the app list rendered by `PortalAppsSidebar` — no route, no query param, nothing in `history.state`. `portal-write-surface.spec.ts` ("PF-668"): register, dismiss, navigate to `/documents`, **`goBack()`**, and the secret is absent from the body and the dialog has count 0; then a full **`reload()`**, still absent, and the URL never contains it. The screen names the only recovery — the record panel's secret line asserts `/rotate/i`. `portalSecret.test.tsx` adds the unmount case and asserts the value is in neither `location.href` nor `history.state` |
| PF-669 | ☑ | Two halves, because a grep and a console prove different things. `portalSecretHygiene.test.ts` fails on **any** `console.*` call anywhere in the portal module, naming file and line — deliberately the whole module rather than "the secret path", since the secret is a prop passed down a tree and tracing who can receive it is the judgement call the test exists to remove. `portal-write-surface.spec.ts` collects `page.on('console')` across **both** create and rotate and asserts no line contains the issued secret |
| PF-670 | ☑ | `RotateSecretDialog.tsx`. Rotate stays disabled until the app name is typed **exactly** — the browser test proves a lower-cased near-miss does not pass. Copy is data: `GET /api/apps/registry` and the rotate response both carry `rotation_policy`, and `portalWriteSurface.test.ts` asserts the two agree with the shipped `ROTATION_POLICY` constant, so a D3 flip changes one constant and not the UI. `portalSecret.test.tsx` drives **both** `instant` and `grace` against the same components, plus a `null` case that says "the server did not report a policy" rather than assuming the reassuring answer. The dialog also states what rotation does **not** do — it does not revoke tokens already issued |

**Deliberately still open.** PF-662 (Testing Scenario 8's portal half) is **not** closed by this
slice: it needs L16's ladder driven to six failures against a controllable subscriber and then a
Replay click, and this fixture does not stand that up. `portal-write-surface.spec.ts` says so in
its header rather than letting the file's name imply coverage it does not have. PF-671–678 and
S3–S5 are untouched.
