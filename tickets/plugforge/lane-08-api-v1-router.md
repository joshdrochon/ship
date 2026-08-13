# L08 · Public Router & Cursor Pagination

| | |
|---|---|
| **Agent** | `api-v1-router` |
| **Tier** | 2 — runs concurrently with L04, L05, L06 |
| **Block** | PF-211–240 (24 allocated, 6 reserved for audit) |
| **Blocks on** | L01 (PF-001 module tree, PF-009/PF-010 boundary lint, PF-014 `createApp(deps)`), L07 (PF-190 `requestIdMiddleware`, PF-194 `apiErrorMiddleware`, PF-199 `apiErrorBodySchema`, PF-200 enumerator, PF-202 assertion seam) |
| **Unblocks** | L09, L11, L12 |
| **MVP gate** | Item 3 (p.2) — *"Bearer token middleware validates tokens on every /api/v1/* route"* — L08 owns the **stack** the middleware is mounted in; L06 owns the middleware itself |

**Why this lane is the composition point.** PRD Build Strategy §2 (p.11): *"Create /api/v1/ as a fresh
router that does NOT share middleware with the internal API."* Everything the platform attaches —
bearer → scope → rate-limit → audit → error — attaches *here* and nowhere else, which is exactly the
interview question on p.13 (*"Where exactly do AuthN, AuthZ, rate-limit, audit, and webhook
publication attach? Why is each a separate middleware?"*). Two lanes downstream (L11 rate limit, L12
audit) do not choose their own position in the stack; they slot into the order this lane declares as
data. The second half of the lane is Cursor Pagination (p.3): *"Opaque base64 cursors over
{ id, timestamp }. List responses always return { data, next_cursor }. Cursors are stable across
reordering operations."* — plus clause (d) of Testing Scenario 4 (p.5), which asserts it over every
enumerated route.

**Three repo facts that shape this lane, verified by reading `api/src/app.ts`:**

1. `app.use('/api/', apiLimiter)` (`api/src/app.ts:168`) is a **path-prefix** mount, so the internal
   `express-rate-limit` already throttles `/api/v1/*` and answers with the internal body
   `{ error: 'Too many requests. Please slow down.' }` — not the `ApiError` envelope. Mounting the
   public router without addressing this ships an MVP-5 violation on day one.
2. `app.use(express.json({ limit: '10mb' }))` (`api/src/app.ts:173`) runs app-wide **before** any
   router, so the `json({ limit: '1mb' })` inside the `router.ts` sketch is dead code — the body is
   already parsed by the time the v1 router sees it.
3. The internal documents list sorts by `ORDER BY position ASC, created_at DESC`
   (`api/src/routes/documents.ts:120`) over a **mutable** `position INTEGER` column
   (`api/src/db/schema.sql:120`). Keyset pagination over that column cannot be stable across
   reordering. There is also no `(created_at, id)` index on `documents` — `schema.sql:354–371`
   lists eleven indexes and none covers the keyset.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-211 | ☑ `createPublicRouter(deps)` is a fresh `Router()` sharing zero middleware with internal `/api` | A request to any `/api/v1` path carrying a **valid Ship session cookie and no bearer token** returns 401 — proving the session/CSRF stack is not in this stack; a second test asserts `csrfSynchronisedProtection` is absent from the v1 `router.stack` by name. The import half is PF-009/PF-010's lint rule; this is the runtime half, and the lint rule cannot catch a middleware passed in as a dep | MVP-3 | p.11, p.3 | PF-001, PF-014, PF-194 |
| PF-212 | ☑ `V1_MIDDLEWARE_ORDER` — the stack order is exported data, not a reading of `router.ts` | Exported const lists the stack in order: `request_id`, `body_parser`, `audit`, `bearer_auth`, `rate_limit`, `[per-route] require_scope`, `handler`, `not_found`, `error_handler`. A test introspects the mounted router's layer names and asserts the sequence **equals** the constant — inserting middleware without editing the constant fails the test. This is the artifact L11 and L12 attach to | MVP-3 | p.13, p.12 | PF-211 |
| PF-213 | ☑ Audit is mounted **before** bearer auth and before the rate limiter, so 401s and 429s are recorded | ⚑ **This reverses the order in the `router.ts` sketch** (`bearerAuth → rateLimit → audit`). `publicAuditMiddleware` records on `res.on('finish')`, so any middleware that terminates the request before audit runs produces an unaudited response. Three assertions: an unauthenticated request, a request with a bad token, and a request that exhausts the bucket each produce exactly one audit record with the right status (401/401/429). Also what makes L07's PF-193 true — `requestId` is never the `'unknown'` fallback | — | p.4 | PF-212, PF-193 |
| PF-214 | ☑ The internal `apiLimiter` must not also throttle `/api/v1/*` | `app.use('/api/', apiLimiter)` at `api/src/app.ts:168` matches `/api/v1/...` by prefix. Test: drive `/api/v1/*` past the internal ceiling (`API_RATE_LIMIT_MAX=1`) and assert no response body ever equals `{ error: 'Too many requests. Please slow down.' }` and no response carries the internal limiter's headers without the platform's. Fix is a narrowed internal path or an ordered mount — either is fine, the assertion is the ticket | MVP-5 | p.3 | PF-211 |
| PF-215 | ☑ The public 1 MB body limit is actually enforced, not shadowed by the app-wide 10 MB parser | `express.json({ limit: '10mb' })` at `api/src/app.ts:173` runs first, so the router-level `json({ limit: '1mb' })` never sees an unparsed body. Test: `POST /api/v1/documents` with a 2 MB JSON body returns the `ApiError` envelope (not 201, not the internal HTML error page); the same 2 MB body on internal `POST /api/documents` still succeeds — the internal limit is unchanged | — | p.3 | PF-211 |
| PF-216 | ☑ `/api/v1/openapi.json` is reachable with **no** Authorization header | `deps.bearerAuth` is a `router.use`, so anything mounted inside 401s by default. Declare `V1_UNAUTHENTICATED_PATHS` as data and mount the spec route through it. Test: `GET /api/v1/openapi.json` with no header returns 200 + `content-type: application/json`; `GET /api/v1/documents` with no header returns 401. Mounting the spec *outside* the v1 router is explicitly rejected — it would skip `request_id` and the audit row | MVP-7 | p.2, p.3 | PF-212 |
| PF-217 | ☑ `encodeCursor` / `decodeCursor` — opaque base64url over `{ id, timestamp }` | 1000 fuzzed payloads round-trip to deep-equality; every encoded string matches `/^[A-Za-z0-9_-]+$/` so it needs no percent-encoding in a query string (the sketch already uses `base64url` — assert it, don't assume it). The payload field is named per the PRD's `{ id, timestamp }`; the sketch's `ts` is renamed. Opacity is documented: no consumer-facing doc describes the payload | TS-4, CTR:Cursor Pagination | p.3 | PF-001 |
| PF-218 | ☑ A malformed, empty, or foreign cursor returns `validation_failed`, never 500 and never a silent page 1 | Four cases, four assertions: `?cursor=not-base64`, `?cursor=` (empty), a base64 of `{}`, and a **valid cursor minted for a different resource**. Each returns the envelope with `code:'validation_failed'` and `details.fields[0].field === 'cursor'`. The foreign-cursor case is the one that matters: a cursor whose `id` is a real UUID from another table decodes fine and would otherwise return a wrong-but-plausible page | MVP-5 | p.3, p.7 | PF-217, PF-198 |
| PF-219 | ☑ Keyset predicate, not `OFFSET` — `(created_at, id) < (cursor.timestamp, cursor.id)` as a row comparison | 50 rows, page size 10: walking all pages yields exactly the 50 ids, no duplicate, no omission. Then delete one row from page 1 mid-walk and re-walk pages 2..n — assert nothing is skipped and nothing repeats. An `OFFSET` implementation fails the second half, which is the point of the test | TS-4 | p.3 | PF-217 |
| PF-220 | ☑ The sort key is immutable — the public list never orders by `documents.position` | `position INTEGER` (`api/src/db/schema.sql:120`) is what the internal list sorts on (`api/src/routes/documents.ts:120`, `ORDER BY position ASC, created_at DESC`) and it is rewritten by drag-reorder. Test: fetch page 1, mutate `position` on three rows spanning the page boundary, fetch page 2 with the returned cursor — assert no id appears twice and no id is skipped. A grep assertion proves the string `position` appears in no `platform/api/v1/` query builder | TS-4 | p.3 | PF-219 |
| PF-221 | ☑ `id` tie-break makes the ordering total | 20 rows written with an **identical** `created_at` paginate at page size 5 into exactly 4 disjoint pages covering all 20 once. `created_at` alone is not unique in this schema (bulk seed and bulk import both produce ties), so without the tie-break the walk both repeats and drops rows | TS-4 | p.3 | PF-219 |
| PF-222 | ☑ Keyset index contract — `assertKeysetIndexed(table)` + the `documents(created_at, id)` migration | Helper runs `EXPLAIN` on the generated page query and fails if the plan contains a `Seq Scan` on the target table or a `Sort` node over the keyset columns. `documents` has no covering index today (`schema.sql:354–371`), so this ticket ships `NNN_keyset_indexes.sql` from the block PF-021 reserved. Per-resource indexes for later tables are named in the helper's failure message, so L10 gets told rather than guessing | — | p.6 | PF-219, PF-021 |
| PF-223 | ☑ `Page<T> = { data, next_cursor }` is the only list response shape, enforced by a Zod `.strict()` schema | One exported `pageSchema(itemSchema)`; the serializer and the fitness test import the **same** schema (grep proves one definition, same discipline as PF-199). A handler returning a bare array, or `{ data, next_cursor, total }`, fails. `data` is always an array — never `null`, never absent, `[]` on an empty result | TS-4 | p.3 | PF-217, PF-199 |
| PF-224 | ☑ `next_cursor` is present-and-`null` on the last page, never omitted | Assertion is `'next_cursor' in body && body.next_cursor === null`, not `body.next_cursor == null` — an omitted key and an explicit null are different to a typed SDK consumer. Boundary case: exactly 25 rows at page size 25 returns `next_cursor: null` in **one** request, no phantom empty final page. Implementation fetches `limit + 1` to decide | TS-4, CTR:Cursor Pagination | p.3 | PF-223 |
| PF-225 | ☑ `limit` — default 25, max 100, invalid values rejected rather than clamped | `?limit=0`, `?limit=-1`, `?limit=101`, `?limit=abc`, `?limit=1.5` each return `validation_failed` naming `limit`; absent `limit` returns 25 rows. **Decision: reject, don't clamp** — a clamped `?limit=500` silently returns 100 and a consumer paginating by `data.length === limit` loops forever. `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` are the single source (`pagination.ts`); the numbers are ours, the PRD names none | — | p.3 | PF-223 |
| PF-226 | ☑ Strict query-param allowlist per route — `offset`, `page`, `fields` fail loudly | One allowlist mechanism answers three Pre-Search 2.2 questions at once. `?offset=10` and `?page=2` return `validation_failed` listing the unknown param, so a consumer porting from an offset API breaks instead of silently reading page 1. `?fields=title` and `Prefer:` do the same — **decision: sparse fieldsets are out of scope for the week**, and the allowlist is the proof they are not half-implemented rather than a note in a doc nobody reads | — | p.16 | PF-225 |
| PF-227 | ☑ Where the pagination line falls — Pre-Search 2.2 answered and written down | **Decision: any collection endpoint backed by a database table paginates; fixed-cardinality registry endpoints (`/api/v1/scopes`, `/api/v1/events`) return `{ data }` with no `next_cursor`.** The rule is cardinality-bounded-by-code vs. bounded-by-data, not "small vs. large" — a list whose length is a compile-time constant cannot grow into a pagination bug. Written into `platform/README.md` and `docs/architecture.md`; PF-228 makes it machine-readable and PF-231 enforces the negative half | TS-4 | p.16, p.5 | PF-223 |
| PF-228 | ☑ Route metadata carries `list: 'cursor' \| 'none' \| false` — required, no default | Registered on the same route-metadata record as L03's scope field (PF-072), so there is one metadata object per route and not two. A route registered without the field fails at **wiring** time (`createApp()` throws naming `METHOD /path`), not at test time — the same discipline as PF-068. This is the field that makes Testing Scenario 4's *"if it's a list endpoint"* decidable instead of a heuristic over the path string | TS-4 | p.5 | PF-227, PF-072 |
| PF-229 | ☑ Clause (d) registers through L07's `registerRouteAssertion`, not a second enumerator | The pagination clause is added via `registerRouteAssertion('cursor-pagination', fn)` (PF-202) and its failures appear in the same report as clause (c). Grep assertion: exactly one route-walking implementation exists in the repo — `enumerateV1Routes` (PF-200). Three enumerators would mean three different answers to *"every route"*, which is how Testing Scenario 4 goes quietly green | TS-4 | p.5 | PF-202, PF-228 |
| PF-230 | ☑ Clause (d) positive: every `list: 'cursor'` route paginates for real, over live requests | For each enumerated route with `list: 'cursor'`: a live request returns a body passing `pageSchema`, and a second live request carrying the returned `next_cursor` returns a page **disjoint** from the first. Not a metadata-only check — a route can declare `'cursor'` and return a bare array. The test **fails** (does not skip) when zero list routes are enumerated | TS-4 | p.5 | PF-229, PF-223 |
| PF-231 | ☑ Clause (d) negative: a `list: 'none'` route must not emit `next_cursor` | Without this the flag is a rubber stamp — every route could self-declare `'none'` and clause (d) would pass vacuously. Assertion: a `'none'` route's body has no `next_cursor` key at all, and its `data` length is not affected by a `?limit=1` that the allowlist (PF-226) should have rejected | TS-4 | p.5, p.16 | PF-229, PF-227 |
| PF-232 | ☑ Anti-vacuity proof: a new list route that forgets pagination fails CI unaided | Fixture test mounts a throwaway route declaring `list: 'cursor'` whose handler returns a bare array, runs the real fitness test against it, and asserts the test **fails** with a message naming `METHOD /path` and the missing key. Mirrors PF-200's stale-enumerator proof: the harness is only worth having if a test proves it fires | TS-4 | p.5, p.11 | PF-230, PF-231 |
| PF-233 | ☑ Server-side contract for the SDK's async iterator is pinned by a consumer-shaped test | A test walks three pages using **only** `{ data, next_cursor }` over HTTP — it never imports `decodeCursor`, never inspects the payload, never counts rows server-side. This is the exact contract `client.documents.iterate()` compiles against (p.4, *"Cursors handled internally; consumer code never sees them"*), so L17/L18 inherit a proven surface rather than discovering it. If this test needs server internals to pass, the cursor is not opaque | — | p.4 | PF-224 |
| PF-234 | ☑ Versioning policy past `/api/v1/` — decided, documented, and structurally enforced | **Decision: additive-only within v1; a breaking change goes to `/api/v2/`; no deprecation/sunset headers this week.** Pre-Search 2.2 (p.16) asks the question and offers three answers; this picks one and says why (deprecation headers need a lifecycle we will not have consumers for by Sunday). Written into `docs/architecture.md`. Enforced structurally: a test asserts the public router is mounted at exactly one version prefix and that no registered route path contains a second version segment | — | p.16 | PF-211 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L08-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L08-fresh-router` | PF-211–216 | MVP gate 3 — a fresh `/api/v1` stack with a declared, machine-checked middleware order that L11/L12 attach to | Layer-order test equals `V1_MIDDLEWARE_ORDER`; session cookie alone → 401; 401/429 both produce an audit row; internal limiter body never reaches a v1 caller |
| S2 | `pf/L08-cursor-codec` | PF-217–222 | Cursor Pagination (p.3): opaque base64 over `{id, timestamp}`, keyset, stable across reordering | Round-trip fuzz + URL-safe charset; mid-walk delete loses nothing; `position` mutation does not shift pages; `EXPLAIN` shows no `Seq Scan` |
| S3 | `pf/L08-page-envelope` | PF-223–226 | List responses **always** return `{data, next_cursor}` (p.3); Pre-Search 2.2's shape questions answered | `pageSchema.strict()` rejects a bare array and an extra key; `next_cursor` present-and-null on the last page; `limit`/`offset`/`fields` validation matrix |
| S4 | `pf/L08-pagination-line` | PF-227–228 | Testing Scenario 4's *"if it's a list endpoint"* is decidable from metadata, not guessed from the path | `createApp()` throws on a route registered without `list`; registry endpoints declare `'none'` explicitly |
| S5 | `pf/L08-fitness-clause-d` | PF-229–232 | Testing Scenario 4 clause (d) over every enumerated route, non-vacuously | Clause registered through PF-202's seam; positive walk is disjoint; `'none'` routes carry no cursor; fixture route with a bare array fails the suite |
| S6 | `pf/L08-consumer-contract` | PF-233–234 | The pagination surface L17/L18 build on, plus a versioning policy in the docs by Sunday | Consumer-shaped three-page walk using only public HTTP; single-version-prefix assertion |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **PF-213 reverses the sketch's middleware order and I am fairly confident it is right.** The
  `router.ts` sketch mounts `bearerAuth → rateLimit → audit`, and its own header comment states that
  order. But `publicAuditMiddleware` records on `res.on('finish')`, and a middleware that terminates
  the request before the audit layer runs never registers that hook — so under the sketch's order a
  401 and a 429 are both invisible to the audit trail. That directly contradicts L07's PF-193 ("never
  the `'unknown'` fallback … including 401s and 500s") and the spine's own sequencing risk row. Moving
  audit to position 3 fixes both. The cost: an audit row now exists for unauthenticated traffic, so
  `clientId`/`userId` are legitimately `null` on those rows and L12's schema must allow it. If the
  audit pass thinks unauthenticated requests should *not* be recorded, that is a policy call and it
  belongs to L12 — flag it, don't quietly re-reverse the order.
- **PF-214 and PF-215 are repo bugs, not PRD requirements.** Both come from reading `api/src/app.ts`:
  the internal `apiLimiter` is mounted at the `/api/` prefix (line 168) and therefore already covers
  `/api/v1/*`, and the app-wide `express.json({limit:'10mb'})` (line 173) parses the body before any
  router-level parser can. The `p.3` citation on each is the Public API Boundary row, which is the
  requirement they violate — it is not a citation for the bug itself. Re-verify both line numbers at
  audit; `app.ts` is 327 lines and moves.
- **`Advances: TS-4` is carrying twelve of twenty-four tickets.** That is honest — clause (d) of
  Testing Scenario 4 *is* "supports cursor pagination if it's a list endpoint," so cursor correctness
  tickets genuinely advance it — but it is also the kind of concentration that makes a traceability
  matrix look better than the work is. If the audit thinks PF-217/219/221 are plumbing that only
  advances TS-4 transitively, demoting them to `—` is defensible and I would not argue hard.
- **Three decisions I made rather than surfaced**, each recoverable:
  - PF-225 **reject** over **clamp** for an out-of-range `limit`. Clamping is the more common
    industry choice (GitHub clamps). I chose reject because a clamp breaks the naive
    `while (data.length === limit)` loop, which is exactly what a CLI author writes.
  - PF-226 **strict query-param allowlist**. This is a strong policy: it means any future optional
    param is a breaking change for callers who were already sending it. It is also the only cheap
    way to make "sparse fieldsets are not implemented" verifiable rather than asserted.
  - PF-234 **additive-only within v1, breaking → `/v2/`, no sunset headers**. p.16 offers three
    options and does not choose; deprecation headers need a deprecation lifecycle we have no
    consumers for by Sunday.
- **PF-228 depends on PF-072, which lives in L03 — and the spine says L08 blocks only on L01 and
  L07.** Chronologically this is fine (L03 is tier 1, L08 is tier 2), but the `Blocks on` row in
  `TICKETS-PLUGFORGE.md` is incomplete for this lane. Either the spine gains L03, or route metadata
  splits into two records, which I think is worse. Flag it; the fix is one word in the spine.
- **What I could not ticket.** The PRD never states a default or maximum page size, never names the
  pagination query parameter (`limit` vs `per_page` vs `page_size`), and never says whether a list
  is ordered newest-first or oldest-first. All three are ours. I picked `limit`, 25/100, and
  newest-first (`created_at DESC, id DESC`, matching the internal list's tiebreak direction), and
  cited `—` on PF-225 rather than manufacturing a page reference. If the OpenAPI spec (L13) or the
  SDK (L17) has already assumed different names, they win and these change — the cost is one
  rename, not a redesign.
- **The sketches in `api/src/platform/api/v1/` are spikes, not done work.** `pagination.ts` covers
  roughly PF-217's codec (with the field named `ts`, not `timestamp`) and declares
  `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE`, but has no query builder, no keyset predicate, no `Page`
  schema, no validation, and no index. `router.ts` covers roughly PF-211's shape and PF-197's 404
  fallback, but its middleware order is the one PF-213 corrects, its `json({limit:'1mb'})` is dead
  code (PF-215), and every resource mount is a `TODO`. Do not mark PF-211/213/217 done because the
  files exist.
- **Not covered here, on purpose:** the rate limiter's behavior and its `X-RateLimit-*` headers
  (L11 — this lane owns only its *position* in the stack), the audit sink's schema and its portal
  query (L12), the bearer middleware and its three distinct 401 codes (L06), the `documents` list
  handler that consumes the pagination helper (L09), and the OpenAPI `Page` component (L13). If any
  of those is unowned at audit time it goes to `lane-99-unassigned.md`, not into this file.
