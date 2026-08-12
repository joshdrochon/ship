# L09 · Resource: Documents

| | |
|---|---|
| **Agent** | `resource-documents` |
| **Tier** | 3 — runs concurrently with L11, L12 |
| **Block** | PF-241–270 (25 allocated, 5 reserved for audit) |
| **Blocks on** | L06 (bearer middleware + `PlatformAuthContext` — file not written, referenced in prose only), L08 (PF-211 `createPublicRouter`, PF-219 keyset predicate, PF-222 keyset index helper, PF-223 `pageSchema`, PF-228 `list` route metadata) |
| **Unblocks** | L10 (issues/sprints/me follow this pattern), L13 (the generator proves out on this resource alone), L14 (`document.created` fires through this write path) |
| **MVP gate** | Item 4 (p.2) — *"At least one resource (documents) implements GET list, GET by id, and POST. Each route declares its required scope via a require(scope) middleware factory."* Jointly with L03, which owns the factory itself |

**Why this resource carries more than its own weight.** Build Strategy §4 (p.11): *"Get the generator
working end-to-end with one resource (documents) before adding issues, sprints, and me."* L13 ships
against `documents` only (PF-363), so the shape this lane gives a route — where its Zod lives, what
metadata it registers, what its response projection is — is the shape the OpenAPI generator is built
to walk. Get it wrong here and L10's three resources and L13's generator both inherit it. Testing
Scenario 6 (p.5) also triggers through this exact write: *"create a document; verify a signed POST
arrives at the target URL within 2s."*

**The domain service this lane is supposed to call does not exist.** `docs/architecture.md`'s
Public/Internal Boundary diagram — the deliverable p.12 requires, *"how /api/v1/ routes call the same
domain services as internal routes"* — names `documentService (utils/document-crud.ts)`. Verified:
that file is 619 lines of association and history helpers (`logDocumentChange`,
`getBelongsToAssociations`, `syncBelongsToAssociations`, `getUserInfoBatch`, …) with **no
create/update/delete/list**, and `api/src/routes/documents.ts` does not import it at all. The write
SQL is inline in the route — `INSERT INTO documents …` at `api/src/routes/documents.ts:565`, inside
`router.post('/')` at `:536` — and the list query is a module-level prepared-statement builder at
`:113–145`. So "call the same domain service" is not a call this lane can make; it is a seam this
lane has to cut first (PF-241). This is L99's F8, and L14's PF-403 claims the same extraction — see
audit notes.

**Four more repo facts that shape this lane, all verified by reading the files:**

1. **`documents` is not a document type — it is every document type.** The table's enum
   (`api/src/db/schema.sql:100`) is `wiki, issue, program, project, sprint, person, weekly_plan,
   weekly_retro, standup, weekly_review`, and internal `GET /api/documents` applies a
   `document_type` filter only when `?type=` is present (`api/src/routes/documents.ts:146`). A
   naive public `/api/v1/documents` therefore serves issues and sprints under `documents:read`,
   which makes `issues:read` and `sprints:read` decorative. PF-250.
2. **The internal create returns `RETURNING *`** (`api/src/routes/documents.ts:565`), i.e. every
   column: `content` JSONB, `yjs_state` BYTEA, `deleted_at`, `converted_from_id`, `position`,
   `conversion_count`. Passing that through as a public response body publishes Ship's internal
   schema as the public contract. PF-252.
3. **`documents.created_at` is nullable** — `created_at TIMESTAMPTZ DEFAULT now()`, no `NOT NULL`
   (`api/src/db/schema.sql:153`). A row-comparison keyset predicate `(created_at, id) < ($1, $2)`
   evaluates to `NULL` against a `NULL` timestamp, so such a row is silently absent from every
   page — not misordered, *invisible*. L08's PF-222 ships the index; it does not ship the
   constraint. PF-259.
4. **The internal list sorts by mutable `position`** — `ORDER BY position ASC, created_at DESC`
   (`api/src/routes/documents.ts:120`) over `position INTEGER DEFAULT 0`
   (`api/src/db/schema.sql:120`), rewritten by drag-reorder. L08 ticketed the predicate (PF-219/220)
   and the index (PF-222); this lane owns the live route actually using them (PF-256, PF-258).

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-241 | ☐ Cut the `documentService` seam — `list` / `get` / `create` as real functions | **Verified gap, not a refactor of an existing service:** `api/src/utils/document-crud.ts` exports no create/update/delete/list and `documents.ts` never imports it. This ticket moves the create SQL (`api/src/routes/documents.ts:565`, inside `router.post('/')` at `:536`) and the list query builder (`:113–145`) behind `documentService.{list,get,create}(ctx, input)` in `api/src/services/documents.ts`. Acceptance: the three functions exist, the route file contains no `INSERT INTO documents` and no `SELECT … FROM documents` for these three operations, and `api/src/routes/documents.test.ts` passes untouched | SUB:Architecture Document | p.12, p.11 | PF-001 |
| PF-242 | ☐ The service is callable with **no** Express request in scope | `documentService.create(ctx, input)` takes a plain `DomainContext = {workspaceId, userId, db}` — never `req`, never `res.locals`, never `requireAuth(req)` (`api/src/middleware/auth.ts:73`, which throws `MissingAuthContextError` off `req.userId`). Proof: a unit test imports the service in a bare Node context with no HTTP stack, no session, no cookie, and creates a document. A grep assertion proves `api/src/services/documents.ts` imports nothing from `express` or `../middleware/`. This is the ticket that makes the p.12 boundary diagram true rather than drawn | SUB:Architecture Document | p.12 | PF-241 |
| PF-243 | ☐ Internal `POST/GET /api/documents` reduced to parse → call → respond, byte-for-byte identical | The internal handlers keep their own Zod (`createDocumentSchema`, `api/src/routes/documents.ts:35`), their own `{error, details}` failure shape, and their own response body — only the data access moves. Acceptance: a golden-body test captures the internal 201 payload before the extraction and asserts equality after, including the `broadcastToUser('accountability:updated', …)` side effect at `:610` for `weekly_plan`. Both surfaces now provably call one function, which is what `docs/architecture.md:98` claims and nothing currently proves | SUB:Architecture Document | p.12 | PF-241 |
| PF-244 | ☐ Boundary fitness: the v1 documents module holds no SQL and no internal-route import | Grep fitness test over `api/src/platform/api/v1/documents/**`: zero occurrences of `pool.query`, `client.query`, `INSERT INTO`, `SELECT `, and zero imports from `api/src/routes/**` or `api/src/middleware/**`. The ESLint rule (PF-009/PF-010) catches the import half at build time; this catches the copy-paste half, which lint cannot see — a handler that re-implements the query rather than importing it satisfies every lint rule and still breaks p.3's boundary | CTR:Public API Boundary | p.3, p.11 | PF-241, PF-009 |
| PF-245 | ☐ `GET /api/v1/documents` — list, declaring `documents:read` through the factory | Route is registered with `requireScope('documents:read')` (PF-067), not an inline check. Three assertions: a token carrying `documents:read` gets 200 and a `pageSchema`-valid body; a token with no scopes gets 403 whose `details.required_scope === 'documents:read'`; no token gets 401. The scope is declared on the route-metadata record (PF-248), so the fitness test can read it without parsing source | MVP-4 | p.2, p.3 | PF-067, PF-211, PF-241 |
| PF-246 | ☐ `GET /api/v1/documents/:id` — by id, declaring `documents:read` | Same three scope assertions as PF-245. Additionally: the id path parameter is validated as a UUID by the adjacent Zod (PF-251), so `/api/v1/documents/not-a-uuid` is `validation_failed`, never a Postgres `invalid input syntax for type uuid` surfacing as `server_error`. The internal equivalent has no such guard — `canAccessDocument` (`api/src/routes/documents.ts:14`) passes `$1` straight through | MVP-4 | p.2, p.3 | PF-245, PF-251 |
| PF-247 | ☐ `POST /api/v1/documents` — create, declaring `documents:write` | 201 with the created document in the response projection (PF-252) and a `Location` header pointing at the PF-246 route. Scope assertions: `documents:write` → 201; a `documents:read`-only token → 403 naming `documents:write`; no token → 401. Together with PF-245 and PF-246 this closes MVP gate item 4's three-route requirement | MVP-4 | p.2, p.3 | PF-245, PF-241 |
| PF-248 | ☐ One route-metadata record per route — `{method, path, scope, list, request, response}` | The three routes register through a single call carrying L03's `scope` field (PF-072) and L08's `list` field (PF-228) on the **same** object, so there is one metadata record per route and not three. `createApp()` throws at wiring time naming `METHOD /path` if any field is absent. This is the record L13's `defineRoute` (PF-358) extends into a spec entry and L07's enumerator (PF-200) walks — three lanes read it, so it is declared once here | TS-4 | p.5 | PF-072, PF-228 |
| PF-249 | ☐ Scope negative matrix over the three live routes | Four cases: (a) `documents:read` token on `POST` → 403, `details.required_scope === 'documents:write'`; (b) `issues:write` token on `POST /api/v1/documents` → 403 naming `documents:write`, proving the check is not "has any scope"; (c) token with an empty scope array → 403, not 500; (d) a token whose granted scope was deregistered since issuance → 403 naming it (PF-075). L03's PF-080 asserts this against a fixture router; this asserts it against the routes a grader actually calls | MVP-6 | p.2, p.3 | PF-069, PF-080, PF-247 |
| PF-250 | ☐ ⚑ `PUBLIC_DOCUMENT_TYPES` — `/api/v1/documents` must not serve issues and sprints | **Verified leak:** the enum at `api/src/db/schema.sql:100` holds ten types and the internal list filters on `document_type` only when `?type=` is supplied (`api/src/routes/documents.ts:146`), so an unfiltered public list returns issues and sprints under `documents:read` — and `POST` accepts `document_type:'issue'` (`createDocumentSchema`, `:36`), letting `documents:write` mint issues. **Decision: `PUBLIC_DOCUMENT_TYPES = ['wiki','weekly_plan','weekly_retro','standup','weekly_review']`** — `issue` and `sprint` belong to their own scoped resources (L10), and `program`/`project`/`person` are not on the public surface at all because p.3 registers no scope that would name them. Enforced as data: list filters on the constant, `POST` rejects any type outside it with `validation_failed`, and a test asserts a seeded issue and a seeded sprint are absent from `/api/v1/documents` and unreachable by id | CTR:Scope Registry | p.3 | PF-245, PF-247, PF-062 |
| PF-251 | ☐ Request and response Zod live **adjacent to the handler**, never in the internal schema tree | Schemas are defined in the route module or a sibling `documents.schema.ts` in the same directory, per p.11 — *"Every public route's request/response schema lives in Zod adjacent to the handler; the generator walks them."* Grep fitness test: no file under `api/src/platform/api/v1/` imports `api/src/openapi/schemas/` (22 files, ~130 detached `registerPath()` calls — the hand-written-spec failure mode L13 is built to keep out). This is the shape PF-351–378 is written against; changing it later is a change to the generator, not to a route | MVP-7 | p.11 | PF-241, PF-009 |
| PF-252 | ☐ One `documentSchema` projection, shared by all three responses — never `RETURNING *` | **Verified:** the internal create returns every column (`api/src/routes/documents.ts:565`), including `content` JSONB, `yjs_state` BYTEA, `position`, `deleted_at`, `converted_from_id`, `conversion_count`. The public schema is an explicit allowlist — `{id, document_type, title, parent_id, created_at, updated_at, created_by}` — and the **same** schema object serializes the list item, the by-id body and the create body, so `client.documents.create()` and `client.documents.iterate()` yield one type in the SDK (p.4). Test: a new column added to `documents` appears in no v1 response; `yjs_state` appears in no response body under any request | CTR:Public API Boundary | p.3, p.4 | PF-251 |
| PF-253 | ☐ Request schemas are `.strict()`; internal-only fields are not writable from the public surface | `position`, `workspace_id`, `created_by`, `yjs_state`, `ticket_number`, `converted_to_id` and `deleted_at` are rejected with `validation_failed` naming the field — not silently ignored, which is how a caller comes to believe it set them. `belongs_to` and `parent_id` remain accepted (they are the association surface the internal route already exposes). Title default stays `'Untitled'` per repo convention, asserted so the public API cannot introduce a second default | — | p.3 | PF-251 |
| PF-254 | ☐ This resource is the live producer of `validation_failed` for L07's six-code table | L07's PF-203 marks `validation_failed` as `test.todo` naming this lane. Acceptance: `POST /api/v1/documents` with `{title: ''}` returns the envelope with `code:'validation_failed'`, `details.fields[0].field === 'title'`, and passes `apiErrorBodySchema` (PF-199) — with the Zod issue path mapped into `details.fields[]` per the PF-198 policy, not passed through as raw `z.ZodError.errors` (which is what the internal route does at `api/src/routes/documents.ts:540`). PF-203's todo is converted to a live case in the same PR | MVP-5 | p.2, p.7 | PF-199, PF-203, PF-247 |
| PF-255 | ☐ `not_found` matrix on GET by id — four ways to miss, one envelope | (a) a well-formed UUID that matches no row; (b) a UUID belonging to **another workspace**; (c) a soft-deleted row (`deleted_at IS NOT NULL`, `api/src/db/schema.sql`); (d) a row whose `document_type` is outside `PUBLIC_DOCUMENT_TYPES`. All four return `code:'not_found'`, status 404, identical body shape and **no `details`** (PF-198). (b) and (d) must not return 403 — a 403 confirms the id exists, which is a cross-tenant existence oracle | MVP-5 | p.7, p.18 | PF-246, PF-250, PF-198 |
| PF-256 | ☐ The list orders by `(created_at DESC, id DESC)` — `position` appears in no v1 query | Consumes L08's keyset predicate (PF-219) rather than restating it. Grep assertion: the string `position` occurs in no query built under `api/src/platform/api/v1/documents/`. The internal list keeps `ORDER BY position ASC, created_at DESC` (`api/src/routes/documents.ts:120`) unchanged — the public sort is a different sort, not a migration of the internal one, and a test asserts the internal list's row order is unchanged after this lane lands | TS-4 | p.3 | PF-219, PF-220, PF-241 |
| PF-257 | ☐ The live list returns `{data, next_cursor}` and nothing else | Body parses against `pageSchema(documentSchema)` (PF-223, `.strict()`); `data` is `[]` (never `null`, never absent) for an empty workspace; `next_cursor` is present-and-`null` on the last page (PF-224). Walking every page of 50 seeded documents at `?limit=10` yields exactly the 50 ids, no duplicate, no omission — over HTTP, without importing `decodeCursor`. This is the first route where L08's envelope meets real rows, and clause (d) of Testing Scenario 4 has a real subject | TS-4 | p.3, p.5 | PF-223, PF-224, PF-245 |
| PF-258 | ☐ Reorder stability, proven against the live endpoint and a real drag-reorder | Fetch page 1 of `/api/v1/documents`; drive `PATCH /api/documents/:id` with a new `position` on three rows spanning the page boundary (the internal update accepts `position`, `api/src/routes/documents.ts:41`); fetch page 2 with the returned `next_cursor`. Assert no id repeats and no id is skipped. PF-220 asserts this at the query-builder level; this asserts it end-to-end through the two surfaces that actually collide, which is the literal reading of p.3's *"Cursors are stable across reordering operations"* | TS-4 | p.3 | PF-220, PF-257 |
| PF-259 | ☐ The keyset index covers the **public** predicate, and `created_at` is made `NOT NULL` | Two halves, one migration. (a) `assertKeysetIndexed('documents')` (PF-222) runs `EXPLAIN` on this route's real query — which filters `workspace_id`, `document_type IN (…)`, `archived_at IS NULL`, `deleted_at IS NULL` **and** the visibility predicate — and fails on a `Seq Scan` or a `Sort` over the keyset columns; a bare `(created_at, id)` index does not cover it, so the migration ships `(workspace_id, created_at DESC, id DESC)`. (b) **Verified hazard:** `created_at TIMESTAMPTZ DEFAULT now()` is nullable (`api/src/db/schema.sql:153`), and `(created_at, id) < ($1, $2)` against a NULL evaluates to NULL — the row is invisible on every page, not merely misordered. Migration backfills and adds `NOT NULL`; a test inserts a NULL-timestamp row directly and asserts the insert now fails | — | p.6 | PF-222, PF-021, PF-256 |
| PF-260 | ☐ Every query is scoped to the token's workspace — no cross-tenant read or write | `DomainContext.workspaceId` comes from the bearer token's `PlatformAuthContext`, never from a request body, query param or header. Tests: a token for workspace A gets 404 (not 403, per PF-255) on a document in workspace B; `POST` with an explicit `workspace_id` in the body is `validation_failed` (PF-253); a list under token A returns zero rows from B even at `?limit=100` with a cursor minted under B. p.18's 3.4 asks how a grader gets a pre-registered app *"without exposing your tenant's data"* — this is the answer, asserted rather than assumed | CTR:Token Middleware | p.3, p.18 | PF-242, PF-245 |
| PF-261 | ☐ Private documents stay private to a public caller — same filter, applied in the service | The internal list applies `visibility = 'workspace' OR created_by = $user OR admin` (`api/src/routes/documents.ts:113–120`; `visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (…)` at `api/src/db/schema.sql:158`). The public list applies the **same** predicate from the same service function — a token acts for a user, so it sees exactly what that user sees, never the app's own view. Test: user A's private document is absent from user B's token's list and 404s by id; and the page walk stays gapless with private rows interleaved, which is the case a `LIMIT`-then-filter implementation gets wrong | — | p.15 | PF-241, PF-257 |
| PF-262 | ☐ The service accepts an injected `IEventBus`; the v1 route publishes nothing | `documentService.create(ctx, input)` is constructed with the bus from `createApp(deps)` (PF-014/PF-015), so L14 wires `document.created` (PF-404) inside the service without touching a route file. Acceptance for **this** lane: the v1 documents module imports no events module and contains no `.publish(` — a grep assertion naming file and line — and the service's signature already carries the bus, so PF-404 is an added call, not a re-plumbing. p.3: *"Domain layer publishes on writes — never the route layer"* | — | p.3 | PF-241, PF-398, PF-014 |
| PF-263 | ☐ TS-6 substrate: the event's id resolves through the public read path | Round trip — `POST /api/v1/documents` with a bearer token, capture the `document.created` envelope from the recording bus (`testDeps()`, PF-016), and assert `GET /api/v1/documents/{envelope.data.id}` returns 200 with the same `id`. p.8's drill table requires *"Document created; document.created event published on the bus; subscribers receive POST"*; a subscriber that cannot then fetch the document has an event pointing at nothing. Distinct from PF-412, which asserts the publish happened — this asserts the payload is resolvable through the contract a subscriber has | TS-6 | p.5, p.8 | PF-404, PF-246 |
| PF-264 | ☐ Regression: internal surface and its query budget unchanged after the extraction | `api/src/routes/documents.ts` is the most-exercised write path in Ship and PF-241 moves its SQL. Acceptance: `api/src/routes/documents.test.ts`, `documents-visibility.test.ts`, `list-endpoints-regression.test.ts` and the Playwright suite pass with **no test edits**; and the per-route query count for internal `GET/POST /api/documents` is unchanged against `docs/baseline-part1.json` (PF-020) — the list's named prepared statements and its folded-in admin subquery (`api/src/routes/documents.ts:96–112`) are a deliberate optimisation that a naive service extraction un-does by re-issuing `isWorkspaceAdmin()` per request | MVP-9 | p.2, p.6 | PF-243, PF-019, PF-020 |
| PF-265 | ☐ `documents` is the only resource mounted — `/issues`, `/sprints`, `/me` are provably absent | Test asserts `enumerateV1Routes()` (PF-200) on this lane's branch returns exactly the three documents routes plus `openapi.json`, and that no route path matches `/issues`, `/sprints` or `/me`. Build Strategy §4 (p.11) sequences it deliberately: the generator proves out on one resource first, and PF-363 asserts the same thing from L13's side. When L10 lands, the diff touches its own route modules and the generated spec and **zero lines** of `platform/openapi/` — that pairing is the proof the pattern this lane sets is generic | — | p.11 | PF-200, PF-248 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L09-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L09-domain-seam` | PF-241–244 | The p.12 Public/Internal Boundary claim becomes true: one domain service, callable without an Express request, called by both surfaces | Service creates a document in a bare Node context with no HTTP stack; internal 201 body byte-identical to the golden capture; grep finds no SQL and no internal import under `platform/api/v1/documents/` |
| S2 | `pf/L09-routes-and-scopes` | PF-245–250 | MVP gate 4 — list, by-id and create, each declaring its scope through `require(scope)`; and `documents:read` provably does not reach issues or sprints | Three-route scope matrix (200/401/403 with `details.required_scope`); `createApp()` throws on a route missing `scope` or `list`; seeded issue and sprint absent from `/api/v1/documents` |
| S3 | `pf/L09-schemas` | PF-251–255 | Zod adjacent to the handler in the shape L13's generator walks; one response projection; the live producers of `validation_failed` and `not_found` | No import of `api/src/openapi/schemas/` from the platform tree; `yjs_state` in no response; `details.fields[0].field === 'title'`; four-way `not_found` matrix with no existence oracle |
| S4 | `pf/L09-cursor-list` | PF-256–259 | Cursor Pagination (p.3) on a real endpoint, stable across a real drag-reorder, on an index that covers the real predicate | 50-row page walk over HTTP is gapless; `position` mutation shifts nothing; `EXPLAIN` shows no `Seq Scan`; a NULL-`created_at` insert is rejected |
| S5 | `pf/L09-tenancy` | PF-260–261 | A token sees exactly one workspace and exactly what its user can see — the p.18 grader-safety question, answered by assertion | Cross-workspace id 404s; foreign cursor returns nothing; private rows absent for another user's token and the page walk stays gapless |
| S6 | `pf/L09-event-callsite` | PF-262–265 | The publish site is the service (L14 fills it in), the internal surface is unregressed, and the generator gets exactly one resource | Grep finds no `.publish(` under `platform/api/v1/`; internal regression suite green with no test edits; enumerator returns documents only |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **PF-241 and L14's PF-403 are the same extraction, ticketed twice.** Both cut
  `documentService.create` out of `api/src/routes/documents.ts:565`. This is not an accident of
  parallel authorship that can be resolved by deleting one: L09 is tier 3 and L14 is tier 4, so
  **L09 lands first and must**, because a public route with no service to call has to inline the SQL
  and then the boundary claim is false from the first commit. The fix I would make: PF-241 owns the
  extraction of `list/get/create`, PF-403 shrinks to *"add the publish call inside the already
  extracted service, and extract `update`/`delete` which L09 does not need."* PF-262 is written to
  make that shrink cheap — the service already takes the bus. Do not let both lanes extract, and do
  not let L09 skip it on the assumption L14 will.
- **PF-250 is the largest decision in this lane and I made it rather than escalating.** Ship's
  unified document model means `documents` is the table everything lives in; the PRD's public
  contract treats `documents`, `issues` and `sprints` as three resources with three scope pairs
  (p.3). Those two facts cannot both be honoured without deciding which `document_type` values the
  public `documents` resource exposes. I chose the narrative types and excluded `program`,
  `project` and `person` entirely, on the reasoning that p.3 registers no scope that would name
  them and inventing one would break PF-062's exactly-seven assertion. The consequence is real and
  worth stating plainly: **three of Ship's ten document types are unreachable through the public
  API this week.** The defensible alternative is `documents` = everything except `issue` and
  `sprint`, which keeps the surface complete at the cost of `documents:read` being a near-superuser
  read scope. If the audit prefers that, the change is one constant and one test.
- **PF-259's `NOT NULL` migration is mine, and it touches an existing table.** `created_at` on
  `documents` is nullable today (`api/src/db/schema.sql:153`). Every row in the seeded database has
  a value, so the backfill is a no-op in practice — but this is a constraint added to Part 1's
  hottest table during MVP week, and if any test fixture inserts an explicit NULL the migration
  fails at deploy. Worth a `SELECT count(*) FROM documents WHERE created_at IS NULL` against a
  restored production dump before the slice lands. The alternative — `ORDER BY created_at NULLS
  LAST` plus a `COALESCE` in the predicate — makes the index unusable and I rejected it.
- **`me` is not in this lane and the scope question it raises is not mine, but it lands on L03.**
  L10 owns `/api/v1/me`, and `me` has no natural scope from p.3's seven. PF-079 asserts every v1
  route declares a *registered* scope, so `me` either forces an eighth scope (breaking PF-062) or
  forces PF-079 to accept an explicit null. L10 raises it as PF-271; flagging it here so the audit
  sees it from both sides rather than treating it as one lane's local problem.
- **`Advances: MVP-4` is only on PF-245/246/247, deliberately.** The gate item is three routes
  declaring scopes, and those three tickets are the three routes. It would be easy to spray MVP-4
  across the whole lane — the schemas, the pagination and the service seam are all needed for the
  routes to be real — but a traceability matrix where twenty-four tickets claim one checkbox tells
  you nothing about whether the checkbox is met. PF-241–244 carry `SUB:Architecture Document` and
  `CTR:Public API Boundary` instead, which is what they actually advance.
- **Two tickets cite L14 and L03 IDs across a tier boundary the spine does not record.** PF-262 and
  PF-263 depend on PF-398/PF-404 (L14, tier 4) while this lane is tier 3, and PF-249 depends on
  PF-080 (L03, tier 1, not listed in this lane's `Blocks on`). The L14 direction is the awkward
  one: L14 blocks on L09 in the spine, and PF-263 blocks on L14. In practice PF-263 is the last
  ticket in the lane and lands after L14's S3 — but the spine's dependency graph does not express
  that, and if the audit wants the graph to be honest, PF-263 should move to L14's block or the
  spine should record the back-edge. Flag it; do not silently re-point it.
- **What I could not ticket.** The PRD never says what a public `document` *is* in a product where
  every row is a document — PF-250 answers it by fiat. It never names a `PATCH`/`DELETE` for
  documents either: gate item 4 asks for exactly list/get/create, and `document.updated` and
  `document.deleted` are registered event types (p.3) with no public producer in this lane as a
  result. L14's PF-409 assumes a delete path exists; the internal one does
  (`api/src/routes/documents.ts:1153`, a hard delete) but it is not public, so those two event
  types can only fire from internal traffic this week. That is a genuine hole in the eight-event
  story and it belongs to whoever owns the event surface — I have left it here rather than filing
  it in `lane-99-unassigned.md` because it is arguably this lane's scope to have caught.
- **The sketches on disk are spikes.** `api/src/platform/api/v1/router.ts` has a
  `TODO(josh) E2: /documents — GET list (cursor), GET :id, POST (scoped)` and nothing else; there
  is no documents module, no schema file, no service. Nothing in this lane is partially done.
- **Not covered here, on purpose:** the bearer middleware and its three 401 codes (L06), the
  `require(scope)` factory itself (L03 PF-067), the cursor codec and page envelope (L08
  PF-217–224), the OpenAPI entry for these routes (L13 PF-358–363), the event bus and the publish
  implementation (L14), rate-limit headers (L11) and the audit row (L12). If any is unowned at
  audit time it goes to `lane-99-unassigned.md`, not into this file.
