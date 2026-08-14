# L12 · Public Audit Trail

| | |
|---|---|
| **Agent** | `audit-trail` |
| **Tier** | 3 — runs concurrently with L09, L11 |
| **Block** | PF-326–350 (19 allocated, 6 reserved for audit) |
| **Blocks on** | L08 (public router composition order); consumes L07 PF-190/193/194 and L03 PF-067/075 |
| **Unblocks** | L22 (delivery-log + usage views), L23 (Epic 7 proof) |
| **MVP gate** | None — no MVP checkbox and no Testing Scenario names the audit trail. It is graded at Submission: p.13, *"the agent's audit-log rows showing OAuth app"* authentication is the proof for Epic 7 |

**What the PRD actually asks for.** p.4: *"Every public API call recorded"* with timestamp, app
`client_id`, `user_id`, route, scope used, status, latency — *"Queryable in the developer portal."*
p.18 (Pre-Search 3.5) restates the field list for observability and adds one the p.4 row does not
name: *"What metrics do you record per public API call (route, status, latency, scope used, app,
user, request_id)"*. So `request_id` is a PRD field, on p.18. p.12 places this middleware:
*"auth/scope/audit/webhook attaching only"* at the public layer — the internal `/api` surface gets
no audit middleware and writes no rows.

**This lane produces; L22 consumes.** The developer-portal view is L22's. What crosses the seam is
a queryable repository (PF-342), not a React component.

**`request_id` is L07's, and we consume it.** `requestIdMiddleware()` (PF-190) mints one UUID per
request as the first middleware in the v1 stack, and PF-193 declares `res.locals.requestId` the
single origin. This lane reads that value and **mints nothing**. The `?? 'unknown'` fallback in the
current `platform/audit/audit.ts` sketch is a soft edge L07 deliberately left in place; PF-330
asserts it is unreachable rather than deleting it.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-326 | ☑ `PublicApiCallRecord` is exactly the PRD's field set plus `request_id` | The type carries `occurredAt`, `clientId`, `userId`, `method`, `route`, `scopeUsed`, `status`, `latencyMs`, `requestId` — the seven p.4 fields plus the p.18 one. A unit test compares the type's keys against a literal array so an added field is a deliberate edit; `clientId`, `userId` and `scopeUsed` are nullable and every nullable case has a documented meaning | — | p.4, p.18 | PF-001 |
| PF-327 | ☑ **Found in the repo:** `docs/architecture.md` omits `request_id` from the audit field list | Line ~18 describes the `audit/` module's fields as timestamp, app client_id, user_id, route, scope, status, latency (quoting our own doc, not the PRD) — the p.4 list, missing the `request_id` p.18 names. Correct the line to include it, and extend L01's module-layout fitness test (PF-022) so the documented field list is compared against `PublicApiCallRecord`'s keys. A doc that lists six of seven fields is how a field quietly never gets stored | — | p.4, p.12, p.18 | PF-326, PF-022 |
| PF-328 | ☑ `IAuditSink.record()` is fire-and-forget and can never fail a request | A sink whose `record()` throws synchronously, and one that rejects asynchronously, both leave the response status, body and headers identical to the no-sink case; the failure is logged once with the `request_id`. Test drives both against a real route. An audit sink that can 500 a working request is worse than no audit sink | — | p.4 | PF-326 |
| PF-329 | ☑ `InMemoryAuditSink` is the test double wired through `testDeps()` | `testDeps()` returns the in-memory sink; every assertion in this lane reads `sink.records`, never the database. Records expose insertion order so "exactly one row per request" is checkable | — | p.10, p.12 | PF-328, PF-016 |
| PF-330 | ☑ `request_id` is read from `res.locals.requestId` — this lane mints none | Grep proves no `randomUUID`, `crypto.randomBytes` or id generation anywhere under `platform/audit/`. For every request in the fitness run the recorded `requestId` string-equals that response's `X-Request-Id` header, and zero records carry the `'unknown'` fallback — including 401s, 404s and 429s, which is where a second minted id would otherwise appear | — | p.7, p.18 | PF-190, PF-193, PF-326 |
| PF-331 | ☑ `route` is the route template, prefixed — not the raw path | Measured: inside a router mounted at `/api/v1`, `req.path` is `/documents`, so the sketch's fallback records rows with the `/api/v1` prefix missing; and on 401/404 `req.route` is `undefined`, so the fallback records the **raw** path — meaning document UUIDs land in the route column, unbounded cardinality and resource ids in an audit field. Record `req.baseUrl + (req.route?.path ?? '<unmatched>')`. Test: `GET /api/v1/documents/<uuid>` records `/api/v1/documents/:id`; an unrouted path records `<unmatched>`, never the id | — | p.4 | PF-326 |
| PF-332 | ☑ `latency_ms` covers the whole public stack, not just the handler | The timer starts in the first middleware of the v1 stack, so bearer validation, scope check and rate limiting are inside the number; it stops when the response completes. Test: a route with a 50 ms artificial delay records ≥ 50 ms and the value is a positive float, monotone against a `FakeClock`-driven control. A latency that excludes auth is not the latency a P95 target means. Depends on the stack position PF-336 asserts | — | p.4, p.6 | PF-328 |
| PF-333 | ☑ `scope used` is populated by L03, and its `null` has one meaning | `res.locals.scopeUsed` is set by `requireScope` when a scope is checked; the audit row records it verbatim. `null` means "no scope was checked on this request" (unscoped route, or rejected before the scope middleware) and is documented as such — it never means "scope check passed". PF-075's registry-mismatch case is recorded rather than dropped | — | p.3, p.4 | PF-067, PF-075, PF-326 |
| PF-334 | ☑ Failures are audited — 401, 403, 404, 429 and 500 each write exactly one row | Table test over the five failure classes: each produces one record with the correct `status`, a real `requestId`, and `clientId`/`userId` populated where the request authenticated and `null` where it did not. p.4 says *every* public API call; the four failure classes that short-circuit before the handler are precisely the ones a naïve implementation loses. Depends on the stack position PF-336 asserts | — | p.2, p.4 | PF-328 |
| PF-335 | ☑ A 429 is audited — the audit middleware is installed **before** the rate limiter | `rateLimitMiddleware` short-circuits with `next(err)`, so anything registered after it never runs; the current `router.ts` sketch registers audit *after* the limiter, so a rate-limited request writes no row at all. The audit recorder is a `finish` hook, so registering it earlier costs nothing and still reads the final status. Test on the composed router: an exhausted bucket yields exactly one record with `status: 429`. L08 owns the declared order; L11 PF-318 asserts the same invariant from its side | — | p.4, p.12 | PF-336 |
| PF-336 | ☑ Audit is the second middleware in the v1 stack — after `requestId`, before bearer auth | Position asserted by behaviour on the composed router, not by reading the file: a request with **no** `Authorization` header still writes a row (status 401, `clientId: null`, real `requestId`). Any position after bearer auth silently loses every unauthenticated call. p.13's interview question — *"do AuthN, AuthZ, rate-limit, audit, and webhook publication attach? Why is each a separate middleware?"* — is answerable only if the order is a tested property | — | p.12, p.13 | PF-328 |
| PF-337 | ☑ Aborted requests are recorded, not dropped | `res.on('finish')` does not fire when a client disconnects mid-response — `close` does. Listen on `close` with a once-guard (or both events plus the guard) and record the aborted case with the status Express reports. Test: a request aborted after headers are sent still writes exactly one record. Without this, the one class of request most worth investigating is the one class with no row | — | — | PF-338 |
| PF-338 | ☑ Exactly one record per request, proven under nesting and double-mount | A counter test: 100 requests across mounted sub-routers produce exactly 100 records. Mounting the middleware twice is caught by the once-guard rather than doubling every row — duplicate audit rows destroy the Epic 7 count as effectively as missing ones | — | p.4 | PF-328 |
| PF-339 | ☑ Postgres sink + `public_api_calls` table; the internal surface writes nothing | New table (name deliberately not `audit_logs` — that is the existing internal compliance table in `schema.sql` with a different purpose and shape), created by a migration drawn from the block PF-021 reserved; the `audit.ts` sketch guesses `039`, so take the number PF-021 actually assigns. Indexes on `(client_id, occurred_at desc)` and `(request_id)`. **Test: an internal `/api/documents` request writes zero rows** — the audit insert is a per-call query, and the +10% per-route query-count budget is measured on the Part 1 internal routes | MVP-9 | p.2, p.4 | PF-021, PF-328 |
| PF-340 | ☑ No secrets, no bodies, no headers in an audit row | The record type has no field for request/response bodies, headers, or token material, and a test writes a request carrying `Authorization: Bearer <token>` and `?client_secret=…` then asserts neither string appears anywhere in the persisted row. Pre-Search 1.4 (p.15) treats a log line as a leakage path for exactly this reason | — | p.15 | PF-339 |
| PF-341 | ☑ **Decision to be recorded, not invented:** the audit-log retention window | p.10 requires *"plus audit log rows"* in the storage-retention assumption and demands **both** retention windows stated *"and explain why each is set there"*. The number is a judgement call — options: 7 days (demo-sized, cheapest), 30 days (survives the grading window plus a re-review, matches the delivery log if that is also 30), or indefinite-with-monthly-rollup (Epic 7's proof stays queryable forever, storage grows). **Lean: 30 days for rows + an indefinite per-day-per-app rollup**, because the Epic 7 claim must remain provable after raw rows expire. The ticket is done when the chosen number is written in `docs/architecture.md` **and** the cost analysis, with the rationale; pruning is implemented against the recorded number, never ahead of it. L25 PF-753/PF-756 answer the Pre-Search bullets — this lane supplies the number they cite | — | p.10, p.15 | PF-339 |
| PF-342 | ☑ Row-growth arithmetic, so the retention number has a denominator | `docs/` records bytes-per-row (measured from the shipped table, not estimated) × calls/day at the p.9 projection tiers — ~20 000/day at 100 users through ~20 000 000/day at 100 000 users — giving storage per retention window at each tier. A retention window chosen without this arithmetic is a guess, and p.10 asks for the arithmetic explicitly | — | p.9, p.10 | PF-341 |
| PF-343 | ☑ Query surface for the portal — L12 produces, L22 consumes | A repository function `listCalls({clientId, from, to, status, route, cursor})` returning `{data, next_cursor}` using the same opaque base64 cursor contract as the rest of the public API, ordered by `(occurred_at, id)` so pages are stable under insert. Backed by the PF-339 index; a test asserts a full walk over 500 rows visits each row exactly once with no skips across concurrent inserts. p.4 requires it *"Queryable in the developer portal"*; the portal UI is L22's ticket, not this one | — | p.3, p.4 | PF-339 |
| PF-344 | ☑ **Open decision:** how we prove post-demo that the agent went through the public API | Pre-Search 3.5 (p.18) asks how you would tell, post-demo, that *"the agent actually went through the public API for every action"* — the options it names being *"of the audit log, a dashboard panel, or a fitness test that runs the agent and inspects the trail?"* — and p.13 grades Epic 7 on *"the agent's audit-log rows showing OAuth app"* authentication. Three options, real tradeoffs: (a) **grep/SQL query** — cheapest, but proves only that *some* calls went through, not *every* action; (b) **portal dashboard panel** — demo-friendly, but it is a screenshot, not an assertion, and it costs L22 work; (c) **fitness test that drives the agent and inspects the trail** — the only one that proves the "for every action" half and the only one that keeps proving it after the demo, at the cost of a CI test that depends on the agent. **Lean: (c) as the graded artifact with (a) as the demo query** — the PRD's own phrasing is "for every action", which a grep cannot establish. The decision is not this lane's alone to make: L23 owns the rewire and would own the test. Ticket is done when the choice is recorded in `docs/architecture.md` with the rejected options, and the owning lane is named | — | p.13, p.18 | PF-343 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L12-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L12-record-contract` | PF-326–329 | The record shape is the PRD's field set, the sink can never break a request, and the doc that omitted `request_id` is fixed | Key-set test vs. the literal field list; throwing sink leaves the response byte-identical; doc/type comparison |
| S2 | `pf/L12-field-fidelity` | PF-330–334 | Every field is true: consumed `request_id`, templated route, full-stack latency, meaningful `scope used`, failures recorded | No id minted under `audit/`; `/documents/:id` not the uuid; five failure classes each write one correct row |
| S3 | `pf/L12-order-and-durability` | PF-335–339 | Audit sits where it sees everything — 401s, 429s, aborts — exactly once, persisted, and never on the internal surface | Composed-router position tests; 429 → one row; aborted request → one row; internal `/api` → zero rows |
| S4 | `pf/L12-retention` | PF-340–342 | No secrets in rows; the retention window is a recorded decision with arithmetic behind it (p.10) | Token/secret strings absent from persisted rows; both retention windows written with rationale |
| S5 | `pf/L12-query-and-proof` | PF-343–344 | The trail is queryable for L22, and the Epic 7 proof mechanism is chosen rather than assumed | Cursor walk over 500 rows visits each once; decision recorded with rejected options and owning lane |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **`Advances` is `—` for all but one ticket, and that is the honest answer.** The audit trail
  appears in no MVP checkbox and in none of the eight Testing Scenarios. Its graded home is
  Submission Requirements (p.13, Epic 7 proof), which the spine's convention does not treat as an
  acceptance criterion. The one exception is PF-339: the audit insert is a per-call query, and
  asserting it never fires on an internal route is what keeps MVP-9's per-route query-count budget
  true. Do not manufacture MVP links for the rest.
- **The `docs/architecture.md` omission (PF-327) is confirmed, and the citation is p.18.** The
  module line lists the p.4 field set, which genuinely does not include `request_id`; p.18's
  Pre-Search 3.5 bullet is where the PRD names it. Both statements are true — the doc is not
  contradicting p.4, it is incomplete against p.18. Verify with
  `grep -l "per public API call" .claude/prd/page-*.txt` before rewording the ticket.
- **The task brief said Pre-Search 1.1 and 1.4 cover audit-log retention. 1.4 does not.** 1.1 (p.15)
  asks about *delivery-log* row growth and its retention window; 1.4 (p.15) is `client_secret` at
  rest, token lifetimes, webhook payload contents and shown-once UX — no retention question. The
  audit-log retention requirement is in the **Cost Analysis "Include Assumptions" list on p.10**:
  *"plus audit log rows. State both"* retention windows. PF-341 cites p.10 for that reason and
  p.15 only for the leakage angle that PF-340 answers. Re-grep before "fixing" those citations.
- **PF-341 and PF-344 are decisions the board must not invent.** The retention number and the Epic 7
  proof mechanism both have a stated lean and named rejected options, and both are done when the
  choice is *recorded*, not when code lands. PF-344 in particular is cross-lane: L23 owns the agent
  rewire and would own a fitness test that drives the agent, and L22 would own a dashboard panel.
  If the audit finds L23 or L22 assuming a different option, that is a conflict to raise as a `⚑`,
  not to resolve locally.
- **Four sketch bugs, ticketed rather than assumed fixed.** `platform/audit/audit.ts` exists from L01
  scaffolding and looks complete: it has the record type, the interface, an in-memory sink and a
  middleware. It also has `req.route?.path ? … : req.path` — which records `/documents` instead of
  `/api/v1/documents` and raw uuids on unmatched paths (PF-331); a `res.on('finish')` hook that
  misses aborted requests (PF-337); a timer that starts wherever the middleware happens to be
  mounted rather than at the top of the stack (PF-332); and no persistence at all (PF-339). Do not
  close those because the file compiles.
- **Ordering is L08's to declare, ours to assert.** PF-335/PF-336 mount nothing. The current
  `router.ts` sketch orders `requestId → bearerAuth → rateLimit → audit`, which loses the audit row
  for every 401 and every 429 — the two statuses a public API most needs recorded. The fix is one
  line in L08's composition ticket; if L08 ships the sketch order, both tickets fail and the change
  belongs there.
- **Do not reuse the internal `audit_logs` table.** `api/src/db/schema.sql` already has one
  (workspace/actor/action/resource, compliance logging for the internal app). Same word, different
  contract; sharing it would put public-API rows under an internal schema and re-cross the p.12
  boundary this lane exists on the public side of.
- **Not covered here, on purpose:** the portal UI over these rows (L22), the delivery-log table and
  its own retention window (L16 — p.10 asks for *both* windows, and only one of them is ours), the
  `Idempotency-Key` visibility question in Pre-Search 3.5's third bullet (delivery log, L16/L22),
  and the agent's OAuth app seeding that gives the rows a `client_id` to group by (L23). If any of
  those is unowned at audit time it goes to `lane-99-unassigned.md`, not into this file.
