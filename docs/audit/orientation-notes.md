# Codebase Orientation Notes

ShipShape Week 4 · Appendix: Codebase Orientation Checklist
Repository: `US-Department-of-the-Treasury/ship` @ `076a183`

---

## Findings register

Everything worth carrying into the audit, collected as it was found. Severity is provisional —
the audit assigns final ratings with measurements behind them.

**Legend:** 🔴 blocks work or ships a real defect · 🟠 needs a fix · 🟡 worth noting ·
🟢 checked, no problem

| # | Finding | Cat | Sev | Detail |
|---|---|---|---|---|
| F1 | `pnpm db:migrate` applies 10 of 42 on a fresh DB, then **exits 0**. Error swallowed by an `already exists` catch outside the loop (`migrate.ts:106`). 033–037 never apply | infra · 8 | 🔴 | [§1](#1-repository-overview--getting-it-running) |
| F2 | CSRF failure returns Express's default HTML error page with absolute filesystem paths and dependency versions. No custom handler | 6 | 🟠 pending | [§8](#8-middleware--auth) |
| F3 | `SESSION_SECRET` falls back to `'dev-only-secret-do-not-use-in-production'` when unset (`app.ts:44`) | 6 | 🟠 pending | [§8](#8-middleware--auth) |
| F4 | `web/tsconfig.json` has no `extends` — silently drops `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Frontend is less strict than backend | 1 | 🟠 | [§10](#10-typescript-patterns) |
| F5 | 858 type-safety violations. 584 in `api/`, 274 in `web/`, 0 in `shared/`. Prod/test split is 728 / 130 | 1 | 🟠 | [§10](#10-typescript-patterns) |
| F6 | Two error response formats in a single request path — `authMiddleware` returns structured, Zod validation returns `{error: string}` four lines later | 6 | 🟡 | [§7](#7-request-flow--creating-an-issue) |
| F7 | `claude-reference/gotchas.md` §3 describes a dual association system using columns dropped by migrations 027/029. Verified against the live DB — only `parent_id` remains | docs | 🟡 | [§2](#2-reading-docs) |
| F8 | `shared/types/auth.ts` is two comment lines. Login request/response shapes are deliberately duplicated in `api/` and `web/` rather than shared | 1 | 🟡 | [§3](#3-the-shared-package) |
| F9 | Zero `Pick` / `Omit` / `Required` / `Readonly` anywhere. One `satisfies` in 95k lines despite TS 5.7 | 1 | 🟡 | [§10](#10-typescript-patterns) |
| F10 | Six columns support issue↔project conversion (`converted_to_id`, `original_type`, `conversion_count`, …); all null across 257 seeded rows | 4 | 🟡 | [§5](#5-data-model) |
| F11 | 10 of 18 tables empty after seed. `comments` is empty because migration `035_add_comments` is one of the five that never applies | infra | 🟡 | [§5](#5-data-model) |
| F12 | Every debounced save parses the document body and writes `plan`, `success_criteria`, `vision`, `goals` into `properties`. Undocumented in `docs/` | 4 · 6 | 🟡 | [§9](#9-real-time-collaboration) |
| F13 | Collaboration doc evicted from memory 30s after the last client leaves. Untested against longer outages or IndexedDB reconciliation | 6 | 🟡 test | [§9](#9-real-time-collaboration) |
| F14 | **Indexing is thorough** — 13 indexes on `documents` incl. a partial composite on `(workspace_id, document_type)`, GIN on `properties`, expression index on `properties->>'user_id'` | 4 | 🟢 | [§5](#5-data-model) |
| F15 | **N+1 already solved** — `getBelongsToAssociationsBatch` exists and list endpoints use it; singular version only on single-record reads | 4 | 🟢 | [§7](#7-request-flow--creating-an-issue) |
| F16 | **No auth bypass.** 31 of 170 routes lack inline `authMiddleware`; 20 covered by router-level `use()` in `admin.ts`, 8 intentionally public | sec | 🟢 | [§8](#8-middleware--auth) |

| F17 | `CLAUDE.md:56` mandates `/e2e-test-runner` for all E2E runs. **The skill does not exist** — not in `.claude/skills/`, not in `scripts/`. The documented procedure is unfollowable | infra | 🟠 | [§11](#11-testing-infrastructure) |
| F18 | **`pnpm test` runs only `@ship/api`.** 16 web test files / 151 tests never execute in the documented command | 5 | 🟠 | [§11](#11-testing-infrastructure) |
| F19 | **13 web tests fail on clean `main`** — invisible because of F18. Three distinct root causes, all stale tests rather than code defects | 5 | 🟠 | [§11](#11-testing-infrastructure) |
| F20 | Zero `test.fixme` and zero `test.skip` across all 71 E2E specs — the `gotchas.md` §5 empty-test footgun is not currently biting | 5 | 🟢 | [§11](#11-testing-infrastructure) |
| F21 | **`npx playwright install` is documented nowhere.** Following the README exactly gives 869 E2E tests that all fail with `browserType.launch: Executable doesn't exist` | 5 · infra | 🟠 | [§11](#11-testing-infrastructure) |
| F22 | **`pnpm test` destroys the dev database.** `test/setup.ts:14` runs `TRUNCATE … CASCADE` on 15 tables in `beforeAll`. No `.env.test` exists and vitest sets no override, so `db/client.ts:10` resolves `.env.local` — the developer's own DB. Reseed required after every unit-test run | infra · 5 | 🔴 | [§11](#11-testing-infrastructure) |
| F23 | **No CI of any kind.** `.gitlab-ci.yml` and `.github/workflows/` both absent; no deploy script references CI. Yet `playwright.config.ts` branches on `process.env.CI` in four places — the config anticipates a pipeline that was never wired up. Rule 4 target is GitLab CI | infra · 8 | 🟠 | [§12](#12-build-and-deploy) |
| F24 | **Worker autoscaling is inverted on macOS.** `playwright.config.ts:38` sizes the pool from `os.freemem()`, which counts cached pages as used on Darwin. Measured: `freemem` 0.29 GB on a 64 GB / 10-core machine while `memory_pressure` reports 85% free → `(0.29−2)/0.5 = −4` → clamped to **1 worker**. Roughly 4× the runtime, and it silently destroys the contention that flake testing depends on | 5 | 🟠 | [§11](#11-testing-infrastructure) |
| F25 | **Terraform providers are constrained, not pinned** — `aws ~> 5.0` and `terraform >= 1.6.0` in all five roots. `environments/dev` and `environments/shadow` have no `.terraform.lock.hcl`, so they resolve fresh on every init. Category 8 explicitly requires pinned versions | 8 | 🟠 | [§12](#12-build-and-deploy) |
| F26 | **Deployed artifacts have no provenance.** `deploy.sh:105` compiles on the developer's laptop and `Dockerfile:22` copies the result in; `VERSION` is a timestamp, not a SHA; nothing checks branch or a dirty tree. A deployed build cannot be mapped back to code. Directly against Implementation Rule 5 | 8 | 🟠 | [§12](#12-build-and-deploy) |
| F27 | **Deploys are ungated.** Neither `deploy.sh` nor `deploy-frontend.sh` runs `pnpm test`, `type-check`, or `lint`. 451 api unit tests and 869 E2E tests exist; none gate a release. The only automated gate is a husky pre-commit hook that `--no-verify` bypasses | 8 · 5 | 🟠 | [§12](#12-build-and-deploy) |
| F28 | `deploy-frontend.sh:9` accepts only `dev\|prod`, but `deploy.sh` accepts `dev\|shadow\|prod` and CLAUDE.md requires deploying to shadow before merging. The shadow environment can never receive a frontend deploy | 8 | 🟡 | [§12](#12-build-and-deploy) |
| F29 | **No one-command local start.** `docker-compose.yml` starts Postgres only — no api, no web. `pnpm dev` shells out to `scripts/dev.sh` to create a DB, find ports, and run both servers on the host. Implementation Rule 6 requires a single command from a clean checkout | infra · 8 | 🟠 | [§12](#12-build-and-deploy) |
| F30 | `Dockerfile:8,11` set `strict-ssl false` for both npm and pnpm before any install, so every dependency tarball is fetched without certificate validation. Commented as a government-VPN accommodation — deliberate, but it is the image's supply-chain trust boundary | sec · 8 | 🟠 | [§12](#12-build-and-deploy) |
| F31 | **The app cannot run as more than one process, and is deployed behind a load balancer that will create one.** All coordination state is in module-level `Map`s (`collaboration/index.ts:89-108`); `express-session` has no `store:` so sessions use the in-process MemoryStore (`app.ts:147`); no Redis, pub/sub, or cluster anywhere. Terraform sets `MinSize=1 / MaxSize=4`, `LoadBalanced`, and **no stickiness**. Scale-out logs users out at random and silently splits Yjs documents — both instances debounce-write the same `yjs_state`, last write wins | 6 · 8 | 🔴 | [§13](#13-architecture-assessment) |

### What this means for the audit

**F14 and F15 kill the two obvious Category 4 angles.** Both "one big table must scan" and
"the junction table must N+1" were pre-empted by the team. Any query finding will need
`EXPLAIN ANALYZE` behind it, not reasoning.

**F1 is the most serious thing found so far** and it is not in any category — it's an
environment defect that also blocks Implementation Rule 6 (one-command local start).

**F2 and F3 both resolve at item 12.** Severity depends entirely on whether the deployed
environment sets `NODE_ENV` and `SESSION_SECRET`.

---

# Phase 1 — First Contact

## 1. Repository Overview — getting it running

### The sequence that works

```bash
npm install -g pnpm@10.27.0
pnpm install
cp api/.env.example api/.env.local
cp web/.env.example web/.env
docker compose up -d
pnpm db:seed
pnpm db:migrate          # ⚠️ stops at 10 of 42 — see below
pnpm dev
```

To run the E2E suite you additionally need:

```bash
npx playwright install chromium-headless-shell    # ~90 MB, in no documentation
PLAYWRIGHT_WORKERS=4 pnpm test:e2e                # override required — see §11
```

Verified working: API `localhost:3000` → 200, web `localhost:5173` → 200, unauthenticated
`/api/documents` → 401. Login `dev@ship.local` / `admin123`.

Environment: Apple M1 Max · 64 GB · macOS 14.6.1 · Node v26.5.0 · Docker 29.6.1 ·
Compose 5.2.0. `pnpm install` 10s cold, postgres ready in ~2s.

### What the README doesn't tell you

| # | Gap | Impact |
|---|---|---|
| 1 | README says `npm install -g pnpm`; `package.json` pins `packageManager: pnpm@10.27.0` | Unpinned install risks lockfile mismatch |
| 2 | README says `docker-compose up -d` — v1 syntax. Only `docker compose` exists in Docker 29 | Command not found |
| 3 | `docker-compose.yml` declares an obsolete `version:` key | Warning on every invocation |
| 4 | `.claude/CLAUDE.md` says local PostgreSQL is expected, README says Docker | Contradiction; Docker works |
| 5 | **`pnpm db:migrate` applies 10 of 42 migrations and exits 0** | See below |
| 6 | **`npx playwright install` is required and appears in no documentation** | All 869 E2E tests fail identically at `browserType.launch`. Correct target is `chromium-headless-shell`, not `chromium` *(F21)* |
| 7 | **`pnpm test` truncates the developer's own database.** `test/setup.ts:14` runs `TRUNCATE … CASCADE` on 15 tables; no `.env.test` exists, so `db/client.ts:10` resolves `.env.local` | Reseed required after every unit-test run. Nothing warns you *(F22)* |
| 8 | E2E defaults to **1 worker** on macOS regardless of hardware — `playwright.config.ts:38` sizes the pool from `os.freemem()`, which counts cached pages as used on Darwin | ~4× runtime, and no contention, so timing-sensitive tests stop being exercised. Needs `PLAYWRIGHT_WORKERS=4` *(F24)* |

Checked and **not** a problem: the README's ordering of seed before migrate. `seed.ts` applies
`schema.sql` itself, so seeding an empty database works. Assumed this was broken; it isn't.

### Migrations do not apply cleanly to a fresh database

Reproduced twice from an empty volume (`docker compose down -v`).

**Chain of events** (`api/src/db/migrate.ts`):

1. `schema.sql` is applied first. It already contains objects that later migrations create —
   e.g. `oauth_state`, which `010_oauth_state.sql` also creates.
2. Migration `010` runs `CREATE TABLE oauth_state` → PostgreSQL raises *"already exists"*.
3. The per-migration `catch` rolls back and rethrows (`migrate.ts:96`).
4. The outer `catch` at `migrate.ts:106` matches **any** message containing `already exists`,
   prints `"Database schema already exists, continuing..."`, and returns — abandoning the loop.
5. **Exit code 0.** A run that skipped 32 migrations reports success.

Marking `010` applied by hand and re-running hits the identical wall at
`025_prevent_circular_parent`. Past that, `033_sprint_to_week_rename` fails outright:
`error: "sprint_plan" is not an existing enum label` — a real dependency on a skipped step.

Final state from a clean start: **37 of 42 applied.** Migrations 033–037 never run. Those
cover the sprint→week rename and the comments table.

The app works anyway, because `schema.sql` is current. But any environment provisioned this
way silently differs from one provisioned incrementally.

**Fix direction:** move the `already exists` tolerance inside the per-migration loop so one
collision skips one migration rather than aborting the run; make migrations idempotent with
`CREATE TABLE IF NOT EXISTS`. Root cause is shipping a `schema.sql` that overlaps the
migration chain.

## 2. Reading `docs/`

6,353 lines across 15 files in `docs/`, plus 17 tracked files in `docs/claude-reference/`
(added 2026-01-27 by Sam Corcos — written for Claude Code, not humans).

### The product model

```
Program   → never ends. A persistent area of responsibility.
Project   → a hypothesis. ICE-scored. Ends validated or invalidated.
Week      → a 7-day accountability window. Exactly one owner.
Issue     → a unit of work.
```

**Projects are binary.** A project states a hypothesis and ends validated or invalidated —
"partially achieved" is explicitly disallowed, to prevent goalpost-moving. ICE =
Impact × Confidence × Ease, each 1–5, max 125, with impact mapped to dollar ranges.

**People own weeks, not projects.** One owner per week, and a person can own only one week per
window across all programs. *"Only people can be held accountable, not projects."*

Issues are a **trailing** indicator — they record what happened. The weekly plan is the
**leading** indicator declaring intent. Standups are async posts on a week, not meetings.

### The architectural decisions that shape the code

| Decision | Consequence |
|---|---|
| **Everything is a document** | One `documents` table, `document_type` discriminator. Rule: full page → document; dropdown entry → config. States and labels are strings in JSONB, not tables |
| **Weeks are computed, not stored** | Week N derives from workspace start date + arithmetic; status derives from today. No week table, no "start week" button. A week *document* per program is the explicit commitment |
| **Server is truth** | Offline-tolerant, not offline-first. Reads may be stale; writes need network and roll back. Only editor content works offline (Yjs + IndexedDB) |
| **Boring technology** | Express, React, raw `pg` with no ORM, session cookies. Stated principles: "maximally simple," "boring technology" |
| **Auth separate from content** | `workspace_memberships` gates access; person documents hold profile. No FK between them — linked by `user_id` inside JSONB |
| **Workspace-level permissions only** | No per-document ACLs. In or out |
| **Properties in JSONB** | Custom fields without migrations; TypeScript enforces shape at compile time |

### `claude-reference/gotchas.md` — the team's own trap list

High risk: cascade deletes · empty tests passing silently · never run `pnpm test:e2e`
directly · Yjs state is `BYTEA` and needs `Buffer.from()` · never edit `schema.sql`.

Medium: two session timeouts (15 min idle **and** 12 hr absolute, NIST SP 800-63B-4 AAL2,
enforced on WebSockets too) · two error response formats across routes · types split between
`shared/` and route files.

**One entry is stale.** §3 describes a dual association system with `program_id`/`project_id`
columns at `schema.sql:107-109`. Those columns were dropped by migrations 027 and 029 —
confirmed in `schema.sql:123`, in `shared/src/types/document.ts:245`, and against the live
database, where only `parent_id` remains. Everything now routes through
`document_associations`.

### Cascade behaviour, corrected

- `documents.parent_id` → `ON DELETE CASCADE`. Deleting a parent wiki deletes its children.
- `document_associations.document_id` and `.related_id` → both `ON DELETE CASCADE`.

So deleting a project does **not** delete its issues. It deletes the association rows. The
issues survive, keep their program association, and simply stop appearing under that project.
Nesting is containment; project membership is a label.

### The naming trap

**"Sprint" in the database means "week" in the UI.** An unfinished rename. `sprint_number`,
`sprint_start_date`, `sprint_iterations`, `document_type = 'sprint'`, `WeekDocument` typed as
`document_type: 'sprint'`. Migrations 033–037 were the cleanup — the same five that fail to
apply.

## 3. The `shared/` package

501 lines, 8 files. `types/document.ts` is 344 of them; the rest is small.

| File | Lines | Contents |
|---|---:|---|
| `types/document.ts` | 344 | `DocumentType` union, per-type properties, document variants, `computeICEScore` |
| `types/workspace.ts` | 62 | Workspace + settings |
| `constants.ts` | 29 | `HTTP_STATUS`, `ERROR_CODES`, session timeouts |
| `types/api.ts` | 13 | `ApiResponse<T>`, `ApiError` |
| `types/user.ts` | 10 | `User` |
| `types/auth.ts` | **2** | A comment recording that the types were removed |

### The discriminated union

The strongest TypeScript in the repo. `Document` is the base; ten variants narrow it:

```typescript
export interface IssueDocument extends Document {
  document_type: 'issue';
  properties: IssueProperties;
  ticket_number: number;
}
```

Checking `doc.document_type === 'issue'` narrows `properties` to `IssueProperties`
automatically. This is the unified document model expressed in the type system.

### What actually crosses the boundary

13 files import `@ship/shared` on each side. The most-imported symbols are constants, not
types:

```
7×  SESSION_TIMEOUT_MS · HTTP_STATUS · ERROR_CODES
5×  computeICEScore · ABSOLUTE_SESSION_TIMEOUT_MS
1×  DocumentType · IssueState · IssuePriority · DocumentVisibility · …
```

**Observation:** `types/auth.ts` contains only *"unused types (LoginInput, LoginResponse,
Session) removed — all auth types are defined locally in api/ and web/ packages."* Login
request and response shapes are the most obvious thing the two halves must agree on, and they
are deliberately duplicated instead. Combined with `gotchas.md` §10 (types defined in route
files), the shared contract is thinner than the architecture implies. `shared/` has zero
type-safety violations largely because there is little in it.

## 4. Package relationship diagram

Moved to its own file: **[`docs/architecture-diagram.md`](../architecture-diagram.md)**

Summary of what it shows:

- `shared/` is compile-time only — types and constants, erases at build
- **Three** transports run between browser and server, which is unusual: HTTP for `/api/*`,
  one WebSocket for Yjs collaborative editing, a second for live updates
- Vite proxies all three (`web/vite.config.ts:31-45`); ports come from `.ports` written by
  `scripts/dev.sh` so multiple worktrees coexist

## 5. Data Model

Mapped from the **live database**, not the migration files — since only 37 of 42 migrations
apply, the running schema is the only reliable source.

### 18 tables

| Table | Cols | Rows | Purpose |
|---|---:|---:|---|
| `documents` | 26 | 257 | Everything. All 10 content types |
| `document_associations` | 6 | 403 | Org relationships (program / project / week) |
| `users` | 11 | 11 | Auth identity |
| `workspace_memberships` | 6 | 11 | Who can access what, with what role |
| `workspaces` | 6 | 1 | Tenant root |
| `sessions` | 8 | 1 | Server-side session store |
| `audit_logs` | 11 | 1 | |
| `schema_migrations` | 2 | 37 | Migration tracking |
| `comments`, `document_history`, `document_links`, `document_snapshots`, `files`, `api_tokens`, `workspace_invites`, `oauth_state`, `issue_iterations`, `sprint_iterations` | — | 0 | Empty in seed |

Ten tables are empty after seeding. `comments` is empty because migration `035_add_comments`
is one of the five that never applies — its table comes from `schema.sql` instead.

### The `documents` table

26 columns doing the work of what would normally be ten tables.

**Identity and type:** `id`, `workspace_id`, `document_type` (enum, 11 labels), `title`,
`visibility`

**Content:** `content` (JSONB — TipTap document), `yjs_state` (BYTEA — CRDT binary),
`properties` (JSONB — everything type-specific)

**Hierarchy:** `parent_id` — the *only* relationship column left. `program_id`, `project_id`,
`sprint_id` were dropped by migrations 027 and 029

**Issue workflow:** `ticket_number`, `position`, plus five state timestamps — `started_at`,
`completed_at`, `cancelled_at`, `reopened_at`, `archived_at`

**Soft delete:** `deleted_at`

**Conversion tracking:** `converted_to_id`, `converted_from_id`, `converted_at`,
`converted_by`, `original_type`, `conversion_count` — six columns supporting issue↔project
conversion, all null for every row in the seed

### Two relationship mechanisms, doing different jobs

| | `parent_id` column | `document_associations` table |
|---|---|---|
| Models | Containment / nesting | Org membership |
| Delete behaviour | `CASCADE` — children die with the parent | `CASCADE` on the join row only; documents survive |
| Live usage | **2 rows** (nested wiki pages) | **403 rows** |

Association breakdown: `program` 154 · `project` 139 · `sprint` 108 · `parent` 2.

Note `parent` exists as a `relationship_type` in the junction table **and** as a column. Two
rows use the junction version, two use the column. Minor duplication, low stakes.

The important consequence: **deleting a project does not delete its issues.** It deletes the
association rows. Issues keep their program link and simply stop appearing under that project.
Deleting a parent wiki page *does* delete its children. Nesting is containment; project
membership is a label.

### Indexing is careful

13 indexes on `documents`. This is not a naive schema:

- `idx_documents_active` — composite on `(workspace_id, document_type)`, **partial** on
  `archived_at IS NULL AND deleted_at IS NULL`. Exactly the shape of the common query
- `idx_documents_properties` — **GIN** on the JSONB blob, so property filters are indexed
- `idx_documents_person_user_id` — **expression index** on `(properties->>'user_id')`, partial
  to `document_type = 'person'`
- Partial indexes on `archived_at`, `deleted_at`, and both conversion columns

`document_associations` has six indexes covering both directions plus composites on
`(document_id, relationship_type)` and `(related_id, relationship_type)`, and a uniqueness
constraint on the triple.

**Worth stating plainly:** the "everything in one table" decision is usually where you'd expect
index problems, and the team pre-empted it. Any Category 4 finding will need `EXPLAIN ANALYZE`
to stand up — the obvious criticism is already handled.

### Foreign keys into `documents`

Twelve. Ten `CASCADE`, two `SET NULL`:

```
CASCADE   comments · document_associations (×2) · document_history · document_links (×2)
          document_snapshots · issue_iterations · sprint_iterations · documents.parent_id
SET NULL  documents.converted_from_id · documents.converted_to_id
```

Conversion links use `SET NULL` so deleting one side of a converted pair doesn't destroy the
other — the history just loses its pointer.

### How `document_type` is actually used in queries

Measured across `api/src`: **407 literal comparisons** (`document_type = 'issue'`) against
**8 parameterised ones** (`document_type = $n`). The discriminator is nearly always hardcoded
at the call site rather than passed in.

That is a deliberate consequence of the model. Because every type shares one table, the type
filter is not a user input — it is the route's identity. Each route file effectively owns its
slice:

| File | `document_type` refs |
|---|---|
| `routes/weeks.ts` | 91 |
| `routes/documents.ts` | 59 |
| `routes/team.ts` | 53 |
| `routes/projects.ts` | 49 |
| `routes/programs.ts` | 44 |
| `routes/issues.ts` | 33 |

By value, weighted toward the week/sprint machinery:

```
sprint 88 · issue 71 · person 44 · program 43 · project 42
weekly_plan 21 · standup 18 · weekly_retro 12 · weekly_review 7
```

Three query shapes recur:

1. **Plain discriminator** — `WHERE document_type = 'sprint'`. The common case.
2. **Discriminator + JSONB property** — `WHERE document_type = 'issue' AND
   properties->>'state' = 'done'`. The type narrows the row set, then a JSONB key does the
   real filtering. This is where the unified model earns or loses its performance.
3. **Multi-type `IN`** — `document_type IN ('sprint', 'weekly_plan', 'weekly_retro')`, used
   where a view spans types. This shape is the reason one table is convenient: a cross-type
   query is a filter, not a union of joins.

The indexing follows the same logic — the discriminator is used as an **index predicate**,
not just a filter:

```sql
idx_documents_document_type    ON documents(document_type)
idx_documents_active           ON documents(workspace_id, document_type)
                               WHERE archived_at IS NULL AND deleted_at IS NULL
idx_documents_person_user_id   ON documents ((properties->>'user_id'))
                               WHERE document_type = 'person'
```

That last one is the pattern worth noting. A partial expression index keyed on the
discriminator gives a single type its own effectively-dedicated index inside the shared
table — the "everything in one table" tradeoff bought back where it would otherwise hurt.
It is also why Category 4 findings need `EXPLAIN ANALYZE`: shape 2 above may or may not hit
`idx_documents_active`, and reasoning about it from the schema alone is not evidence.

## 6. Relationships

Covered above — see "Two relationship mechanisms" and the foreign key list.

Summary of how the three org relationships are modelled today:

```
Issue ──association(program)──> Program     always present
Issue ──association(project)──> Project     optional
Issue ──association(sprint)───> Week doc    when scheduled
Wiki  ──parent_id────────────> Wiki         nesting, cascades
```

Everything goes through `document_associations` except nesting. The dual-column system
described in `claude-reference/gotchas.md` §3 no longer exists.

## 7. Request Flow — creating an issue

Traced end to end. Eleven steps, browser to database and back.

### Client

**1. Component calls the hook.** `useCreateIssue()` in `web/src/hooks/useIssuesQuery.ts:207`.
Called from `IssuesList.tsx`, `CommandPalette.tsx`, `IssuesContext.tsx`, `App.tsx`.

**2. Optimistic insert before any network call** (`:212-241`). TanStack Query cancels in-flight
list queries, snapshots the current cache, builds a fake issue with
`id: temp-${crypto.randomUUID()}`, `ticket_number: -1`, `display_id: 'PENDING'`, and prepends
it to the list. The row appears instantly.

**3. `createIssueApi`** (`:154`) sends only `{ title, belongs_to }` — everything else is
defaulted server-side.

**4. `apiPost` → `fetchWithCsrf`** (`web/src/lib/api.ts:146`). Attaches `X-CSRF-Token`,
`credentials: 'include'` for the session cookie. **On a 403 it clears the token, fetches a
fresh one, and retries once** (`:100-113`) — so a stale CSRF token self-heals.

### Server

**5. Middleware chain** (`api/src/app.ts`): `helmet` → `cors` → `cookieParser` → `session` →
CSRF → rate limiter → route.

**6. `authMiddleware`** (`api/src/middleware/auth.ts`) checks the session and enforces
**both** timeouts — 12-hour absolute (NIST SP 800-63B-4 AAL2) and 15-minute inactivity. Either
one deletes the session row and returns 401. Sets `req.userId` and `req.workspaceId`.

**7. Zod validation** (`issues.ts:566`) via `createIssueSchema.safeParse`. Invalid input →
400 with `{ error, details }` — note the **old** error format, not the structured one.

**8. Transaction opens**, then the interesting part:

```sql
SELECT pg_advisory_xact_lock($1)   -- key derived from workspace_id
SELECT COALESCE(MAX(ticket_number), 0) + 1 FROM documents
  WHERE workspace_id = $1 AND document_type = 'issue'
```

A **PostgreSQL advisory lock** serializes ticket-number generation per workspace, held until
the transaction ends. Without it, two concurrent creates would read the same `MAX` and collide.
This is a deliberate, non-obvious concurrency fix.

**9. Insert + associations.** One `INSERT` into `documents` with properties assembled as JSONB,
then a loop inserting each `belongs_to` entry into `document_associations` with
`ON CONFLICT DO NOTHING`. `COMMIT`.

**10. Post-commit side effect.** Counts issues in the sprint; if this was the first,
`broadcastToUser(..., 'accountability:updated', ...)` pushes over the events WebSocket. Outside
the transaction, so a failure here can't roll back the issue.

**11. Response** — 201 with the issue plus its resolved `belongs_to`.

### Back on the client

`onSuccess` swaps the temp row for the real one by matching `optimisticId`. `onError` restores
the snapshot. `onSettled` invalidates the list either way, forcing a refetch.

### Two things worth recording

**The N+1 is already handled.** `document-crud.ts` has both
`getBelongsToAssociations` (single) and `getBelongsToAssociationsBatch` (`:148`), the latter
commented *"to avoid N+1 queries"*. The batch version uses `WHERE da.document_id = ANY($1)`
and groups in JS. List endpoints (`issues.ts:227`, `:474`) use the batch version; single-record
endpoints use the singular. Correctly split.

That kills the obvious Category 4 hypothesis. Combined with the 13 indexes on `documents`, the
two most predictable "one big table" criticisms were both pre-empted by the team.

**Error format inconsistency, confirmed in the flow.** `authMiddleware` returns the structured
`{success, error: {code, message}}` shape. The validation failure four lines later returns
`{error: 'Invalid input', details: [...]}`. Two formats in one request path — matches
`gotchas.md` §4.

## 8. Middleware & auth

### The chain

From `api/src/app.ts`, in order:

```
helmet → cors → cookieParser → session → CSRF (csrf-sync) → rate limiter → route
```

- **CSRF** reads the token from an `x-csrf-token` header; clients fetch one from
  `GET /api/csrf-token` (`app.ts:47-60`, `:160`)
- **Rate limiting** is split — a stricter `loginLimiter` (`:71`) and a general
  `apiLimiter` (`:81`)
- **Session secret** falls back to `'dev-only-secret-do-not-use-in-production'` when
  `SESSION_SECRET` is unset (`:44`)

### Two authentication patterns

`authMiddleware` is **not** global. It is applied two different ways:

| Pattern | Where | Example |
|---|---|---|
| Per-route, inline | Most routers | `router.post('/', authMiddleware, handler)` — `issues.ts:563` |
| Router-level | `admin.ts` | `router.use(authMiddleware, superAdminMiddleware)` — `admin.ts:11` |

**Checked for gaps.** 31 of 170 route definitions have no inline `authMiddleware`:

- **20 in `admin.ts`** — covered by the router-level `router.use()` at line 11, which also
  adds `superAdminMiddleware`
- **8 intentionally public** — `auth.ts` login · `caia-auth.ts` status/login/callback ·
  `invites.ts` view/accept · `setup.ts` status/initialize
- Remainder are non-route matches

**No unprotected routes found.** Recording the negative result deliberately: a per-route
pattern is the kind that leaks one endpoint eventually, so "audited, clean at `076a183`" is
worth having on record.

### Unauthenticated request

`GET /api/documents` with no session:

```
HTTP 401
{"success":false,"error":{"code":"UNAUTHORIZED","message":"No session found"}}
```

`authMiddleware` (`api/src/middleware/auth.ts:140-180`) also enforces both session timeouts —
12-hour absolute (NIST SP 800-63B-4 AAL2) and 15-minute inactivity. Either deletes the session
row and returns 401 with `SESSION_EXPIRED`.

### Finding — CSRF failures return an HTML stack trace

`POST /api/auth/login` without a CSRF token returns Express's **default error handler** output:
an HTML page containing

```
ForbiddenError: invalid csrf token
   at csrfSync (file:///…/node_modules/.pnpm/csrf-sync@4.2.1/node_modules/csrf-sync/lib/index.js:22:33)
   at <anonymous> (/…/ship/api/src/app.ts:47:55)
```

That exposes absolute filesystem paths and dependency versions. No custom error handler catches
CSRF rejections.

**Severity: pending.** Express suppresses stack traces when `NODE_ENV=production`. If the
deployed environment sets it, this is Low and dev-only. If not, it is an information leak in a
production government application. Resolve while reading the Dockerfile and deploy scripts
(item 12).

Belongs in the audit under **Category 6 — runtime error and edge case handling**.

---

# Phase 2 — Deep Dive

## 9. Real-time Collaboration

`api/src/collaboration/index.ts` — 834 lines, the densest file in the repo.

### Two WebSocket servers on one HTTP server

Both created with `noServer: true` and dispatched by a shared `upgrade` handler
(`:606-680`), so one port serves REST and both sockets.

| Path | Purpose |
|---|---|
| `/collaboration/{docType}:{docId}` | Yjs CRDT sync for the editor |
| `/events` | Notifications, presence-adjacent pushes |

`maxPayload` is 10 MB on both.

### The upgrade handshake — four gates before a socket opens

1. **Path match** — anything not `/events` or `/collaboration/*` gets `socket.destroy()`
2. **Connection rate limit** — 30/min per IP, from `x-forwarded-for` first then
   `remoteAddress`. Over → raw `HTTP/1.1 429` written to the socket
3. **Session validation** — `validateWebSocketSession()` (`:347`). No session → `401`.
   Enforces the same 15-min idle and 12-hr absolute timeouts as HTTP
4. **Document access** — `canAccessDocumentForCollab()` (`:396`) checks visibility.
   Fails → `403`

Only then does `wss.handleUpgrade()` run. Auth happens *before* the socket exists, not after.

### Loading state — three-tier fallback

`getOrCreateDoc()` (`:195`) keeps a `Map<string, Y.Doc>` in memory. On first request for a
document:

1. **`yjs_state` exists** → `Y.applyUpdate(doc, state)`. Preferred path
2. **Only `content` exists** → convert TipTap JSON to Yjs via `jsonToYjs()`. Happens for
   documents created through the REST API. Marks the doc in `freshFromJsonDocs`, which makes
   the server tell the browser to **clear its IndexedDB cache** (message type
   `messageClearCache = 3`) — otherwise a stale client cache would fight the converted state
3. **Neither** → empty document

There is a guard for content that starts with `<` — output from an older
`XmlFragment.toJSON()`. It's skipped rather than parsed. Evidence of a past data-format
migration that left artifacts behind.

### Concurrent edits

Standard Yjs CRDT. Both edits apply; the CRDT merges deterministically without a server
referee. Message types are `sync = 0`, `awareness = 1`, `customEvent = 2`, `clearCache = 3`.
Awareness carries cursors and presence and is explicitly *not* persisted — on disconnect,
`removeAwarenessStates()` drops that client's cursor.

### Persistence — debounced, 2 seconds

`schedulePersist()` (`:181`) clears any pending timer and sets a new 2s one, so a burst of
keystrokes writes once. `persistDocument()` (`:111`) then does more than save:

- Encodes Yjs state → `Buffer.from(state)` into `yjs_state` (the `BYTEA` handling `gotchas.md`
  §7 warns about)
- Converts Yjs → TipTap JSON and writes it to `content` as a **readable fallback**, so REST
  reads don't need the collaboration server
- **Extracts `plan`, `success_criteria`, `vision`, `goals` from the document body** and writes
  them into `properties`. Typing prose in the editor silently updates structured fields
- For `weekly_plan` and `weekly_retro` only, writes a `document_history` row — throttled to
  once per minute per document

That extraction step is the surprise. The editor is not just storing text; it is parsing it for
accountability fields.

### Disconnect and reconnect

On `close` (`:749`): remove awareness state, drop the connection, clean rate-limit maps. If
that was the last connection to the document:

1. Cancel the pending debounce and **persist immediately** — no 2s window to lose
2. Keep the `Y.Doc` in memory for **30 seconds** in case of quick reconnect, then evict

So a refresh or brief network blip rejoins a warm document. Past 30s it reloads from
`yjs_state`.

### Abuse handling

- Message rate limit: 50/sec per connection
- Violations tracked per socket; **50 violations closes it** with code 1008
- Counter resets on any non-limited message
- Rate-limited messages are dropped silently — Yjs's sync protocol retries on its own
- Oversized frames close with 1009

### Where the audit will land

Category 6 asks specifically about network-disconnect recovery during collaborative editing.
The mechanisms above look deliberate, but three things are worth testing rather than assuming:

- The 30-second eviction window versus a longer outage
- Whether the client's IndexedDB copy reconciles cleanly after the server evicted the doc
- What a mid-edit session expiry looks like to the user — the WebSocket enforces the same
  15-minute idle timeout, so an idle editor gets disconnected by design

## 10. TypeScript Patterns

**TypeScript 5.7.2** across all packages.

### Strict mode — on, but unevenly

| Flag | root | api | web | shared |
|---|---|---|---|---|
| `strict` | ✅ | ✅ | ✅ | ✅ |
| `noUncheckedIndexedAccess` | ✅ | ✅ | ❌ | ✅ |
| `noImplicitReturns` | ✅ | ✅ | ❌ | ✅ |
| `noFallthroughCasesInSwitch` | ✅ | ✅ | ❌ | ✅ |

`api/` and `shared/` inherit via `"extends": "../tsconfig.json"`. **`web/tsconfig.json` has no
`extends`** — it redeclares options from scratch and silently drops three. The frontend runs
under weaker guarantees than the backend and nothing warns about it.

### Violation counts

Line-hit counts, same command must be reused for any after-measurement:

| | `any` | `as` | `!` | `@ts-*` | total |
|---|---:|---:|---:|---:|---:|
| `api/src` | 229 | 65 | 290 | 0 | **584** |
| `web/src` | 31 | 210 | 32 | 1 | **274** |
| `shared/src` | 0 | 0 | 0 | 0 | **0** |
| | 260 | 275 | 322 | 1 | **858** |

One `@ts-ignore` in 95k lines is good hygiene. The `api/` count traces to one decision — raw
`pg` returns `QueryResult<any>`, so 229 `any` is that choice expressed 229 times, not 229
mistakes.

### Discriminated unions — the strongest pattern here

`shared/src/types/document.ts` defines `Document` as the base, then ten variants narrowing on
the `document_type` literal:

```typescript
export interface IssueDocument extends Document {
  document_type: 'issue';
  properties: IssueProperties;
  ticket_number: number;
}
```

Checking `doc.document_type === 'issue'` narrows `properties` from
`Record<string, unknown>` to `IssueProperties`. Six `switch (document.document_type)` sites
consume it — `UnifiedEditor.tsx:292`, `PropertiesPanel.tsx:498`,
`UnifiedDocumentPage.tsx:335`, `CommandPalette.tsx:190`, `BacklinksPanel.tsx:79`.

This is the unified document model expressed in the type system, and it's the pattern that
makes one editor component work for ten content types.

### Generics — three, all well-chosen

| Site | Signature |
|---|---|
| `SelectableList.tsx:59` | `<T extends { id: string }>` — constrained generic component; caller keeps its own row type through `renderRow` |
| `useSelection.ts:41` | `<T>` — selection state independent of item shape |
| `lib/api.ts:158` | `request<T>` — response typing at the fetch boundary |

### Type guards — seven

`associations.ts:36` `value is RelationshipType` · `useIssuesQuery.ts:18`
`error is CascadeWarningError` · `uswds/types.ts:511` `name is IconName` ·
`QualityAssistant.tsx:80` `result is AnalysisError` · `mcp/server.ts:184`
`schema is ReferenceObject` · plus two inline `.filter((x): x is T => …)` narrowings in
`useTeamMembersQuery.ts` and `ReviewsPage.tsx`.

### Utility types — lopsided

```
Record      222        Partial      70        ReturnType   33
Pick         0         Omit          0        Required      0        Readonly  0
```

Heavy `Record` use is mostly `Record<string, unknown>` for JSONB. **Zero `Pick` or `Omit`** —
where a derived shape is needed, a new interface gets hand-written instead. That's the gap the
rubric's "use TypeScript features appropriately" criterion points at.

`as const` appears 72 times, but **`satisfies` only once**
(`useWeeklyReviewActions.ts:309`) despite being available since TS 4.9 and ideal for the
config-object patterns this codebase uses.

### Candidates for the Discovery write-up

- **`pg_advisory_xact_lock` for ticket numbering** — `issues.ts:590`. A Postgres advisory lock
  serializing `MAX(ticket_number)+1` per workspace inside the transaction
- **`freshFromJsonDocs` + a `clearCache` WebSocket message type** —
  `collaboration/index.ts:193`, `:17`. Server tells the browser to drop its IndexedDB copy when
  a document was hydrated from JSON rather than CRDT state
- **Content-derived properties** — `collaboration/index.ts:124-140`. Every debounced save
  parses the prose and writes `plan`, `success_criteria`, `vision`, `goals` into `properties`

## 11. Testing Infrastructure

### How the suites are split

| Suite | Command | Files | Tests | Result | Runtime |
|---|---|---:|---:|---|---:|
| API unit | `pnpm test` | 28 | 451 | ✅ all pass | 13.3s |
| Web unit | `pnpm --filter @ship/web test` | 16 | 151 | ❌ **13 fail** | 2.4s |
| E2E | `pnpm test:e2e` | 71 | 869 | *(see below)* | — |

**`pnpm test` is `--filter @ship/api test`.** It does not run the web suite. 151 tests and
their 13 failures are invisible to anyone following the documented command. *(F18)*

### The 13 web failures — all stale tests, no code defects

Confirmed by reading the source, not just the assertions.

**`lib/document-tabs.test.ts` — 9 failures.** Every one asserts the tab list contains
`'sprints'`. Actual: `['issues', 'details', 'weeks', …]`. The code completed the sprint→week
rename; the tests didn't. Same unfinished rename as migrations 033–037.

```
AssertionError: expected [ 'issues', 'details', 'weeks', …(1) ] to include 'sprints'
```

**`editor/DetailsExtension.test.ts` — 3 failures.** Two problems, both in the test:

1. Asserts `config.content === 'block+'`; actual is `'detailsSummary detailsContent'` — the
   old content model before the node was split into summary + content children
2. Builds an editor with `StarterKit` and `DetailsExtension` only, so ProseMirror throws
   `No node type or group 'detailsSummary' found`

Both child nodes **do** exist — `DetailsExtension.ts:162` (`DetailsSummary`) and `:192`
(`DetailsContent`) — and the real editor registers all three
(`Editor.tsx:596-598`). The test's setup is incomplete; the extension is fine.

**`hooks/useSessionTimeout.test.ts` — 1 failure.** React `act()` warnings plus a fake-timer
assertion on dismissal-before-timeout.

**Implication for Category 5:** the target is *"fix 3 flaky tests with documented root cause
analysis."* These qualify — but they are consistently failing, not flaky, and fixing them
changes no application behaviour. Worth stating plainly rather than presenting test edits as
improvements.

### E2E architecture

`e2e/fixtures/isolated-env.ts` gives **each Playwright worker its own stack**:

- A PostgreSQL container via `@testcontainers/postgresql`
- Its own API and preview-server processes
- A dedicated 100-port range from base 50000, keyed on worker index, so parallel workers
  cannot collide

Teardown is `scope: 'worker'` — `container.stop()` and `SIGTERM` to both processes. Worker
count is calculated from available memory (~500 MB per worker) rather than hardcoded; the
config notes 8 workers with vite dev previously caused problems, so preview is used instead.

`retries: 1` locally, `2` in CI. Timeout 60s. Three reporters: `line`, `html`, and a custom
`e2e/progress-reporter.ts` that writes `test-results/progress.jsonl` and
`test-results/summary.json` for live monitoring.

**No `webServer` block** — the fixture starts servers per worker instead.

### Empty-test footgun — clean

Zero `test.fixme(` and zero `test.skip(` across all 71 specs. 254 `test.describe` blocks. The
`gotchas.md` §5 trap (tests containing only TODO comments pass silently) is not currently
triggered. `scripts/check-empty-tests.sh` runs on pre-commit. *(F20)*

### The mandated runner does not exist

`.claude/CLAUDE.md:56` states: *"ALWAYS use `/e2e-test-runner` when running E2E tests. Never
run `pnpm test:e2e` directly."*

That skill is not in `.claude/skills/` (only `ship-deploy`, `ship-philosophy-reviewer`,
`ship-worktree-preflight`), not in `~/.claude/skills/`, and there is no equivalent script in
`scripts/`. The documented procedure cannot be followed. *(F17)*

Worked around by running `pnpm test:e2e` with output redirected to a file and polling
`test-results/summary.json` — which is what the skill was described as doing.

### E2E results

**The first attempt was void.** 215 of 869 tests completed with **0 passes** before it was
killed at 12 minutes. Every failure was identical — `browserType.launch: Executable doesn't
exist`. Playwright browsers were never installed and `npx playwright install` appears in no
documentation (F21). The correct target is `chromium-headless-shell`, not full chromium:
the config sets no `channel`, `devices['Desktop Chrome']` carries none, and `headless` is
unset, which Playwright 1.57 resolves to the headless shell binary.

Three valid runs followed, all at `PLAYWRIGHT_WORKERS=4`.

#### Baseline

| Run | Passed | Failed | Flaky | Runtime |
|---|---|---|---|---|
| 1 | 864 | 0 | 5 | 9.6m |
| 2 | 865 | 0 | 4 | 10.0m |
| 3 | 862 | 0 | 7 | 9.8m |

**869 tests. Zero hard failures across all three runs.** "Flaky" here is Playwright's
meaning — failed on the first attempt, passed on the single configured retry
(`retries: 1` locally).

Aggregate flake rate: **16 occurrences / 2,607 test executions = 0.61%**, across **12
distinct tests**.

A note on the worker count, because it changes the number. The config sizes its pool from
`os.freemem()`, which is meaningless on macOS — measured 0.29 GB "free" on a 64 GB machine
while `memory_pressure` reported 85% free. The formula yields −4 and clamps to **1 worker**
(F24). All three runs above therefore required an explicit `PLAYWRIGHT_WORKERS=4` override.
This matters for flake measurement specifically: at 1 worker there is no contention, so the
timing races below would likely not reproduce at all.

Runtime is also far better than the void run suggested. Extrapolating that run's startup
rate predicted ~45 minutes each; the real figure is **under 10 minutes**.

#### Flaky tests, ranked by recurrence

| Test | Runs flaky |
|---|---|
| `my-week-stale-data.spec.ts:63` — retro edits visible on /my-week after navigating back | **3 / 3** |
| `my-week-stale-data.spec.ts:28` — plan edits visible on /my-week after navigating back | **2 / 3** |
| `status-overview-heatmap.spec.ts:69` — displays split cells for plan/retro status | **2 / 3** |
| `status-overview-heatmap.spec.ts:88` — clicking plan cell navigates to weekly plan | 1 / 3 |
| `edge-cases.spec.ts:320` — Unicode content (emoji, CJK) | 1 / 3 |
| `programs.spec.ts:212` — program cards show emoji or initial badges | 1 / 3 |
| `project-weeks.spec.ts:178` — project link navigates back to project | 1 / 3 |
| `mentions.spec.ts:374` — sync mentions between collaborators | 1 / 3 |
| `drag-handle.spec.ts:300` — drag preserves full paragraph content | 1 / 3 |
| `inline-comments.spec.ts:118` — canceling a comment removes the highlight | 1 / 3 |
| `performance.spec.ts:366` — many images do not crash the editor | 1 / 3 |
| `team-mode.spec.ts:408` — clicking collapsed header expands the group | 1 / 3 |

#### What this gives the audit

Category 5's improvement target offers "fix 3 flaky tests with documented root cause
analysis" as an alternative to adding tests for untested paths. The top three are picked for
us by the data, and two of them share a file:

1. `my-week-stale-data.spec.ts:63` — flaky in every run
2. `my-week-stale-data.spec.ts:28` — the sibling case, flaky in two
3. `status-overview-heatmap.spec.ts:69` — flaky in two

Both `my-week-stale-data` cases assert that an edit is visible after navigating away and
back. That is a single behaviour — whether the view refetches or serves stale cache — so one
root cause plausibly explains two of the three. Worth confirming before committing to it as
the Category 5 deliverable.

The nine single-occurrence tests are spread across unrelated features (drag, comments,
mentions, images, unicode) with no shared file or fixture, which reads as ordinary
contention noise at 4 workers rather than a defect.

**Separate improvement candidate:** a preflight check that verifies the browser binary
exists before launching 869 tests. The void run cost 12 minutes to discover something
detectable in under a second.

## 12. Build and Deploy

*Maps to Appendix checklist item 7. Four questions, answered in order.*

### What the build produces

The `Dockerfile` does **not** build the app. It packages an already-built one.

`scripts/deploy.sh:105` wipes `shared/dist` and `api/dist`, runs `pnpm build:shared &&
pnpm build:api` **on the developer's laptop**, then `Dockerfile:22-23` copies those `dist/`
directories into the image. The image itself only installs production dependencies
(`--frozen-lockfile --prod --ignore-scripts`, `Dockerfile:19`).

So the artifact is a `node:20-slim` image containing:

| Layer | Source |
|---|---|
| production `node_modules` | resolved inside the image from the lockfile |
| `shared/dist/`, `api/dist/` | compiled on the developer's machine, copied in |
| runtime env | `NODE_ENV=production`, `PORT=80` baked at `Dockerfile:29-31` |

Entrypoint is `sh -c "node dist/db/migrate.js && node dist/index.js"` (`Dockerfile:35`) —
migrations run on every container start, before the server.

The web build is separate and never containerised: `deploy-frontend.sh:52` runs
`VITE_APP_ENV=production pnpm build:web`, then `aws s3 sync web/dist/` to a bucket behind
CloudFront.

Two things follow from building locally rather than in the image. The deployed artifact is
whatever was in the developer's working tree — `VERSION` is a timestamp
(`deploy.sh:71`), not a commit SHA, and nothing checks the branch or whether the tree is
dirty. And the build is not reproducible between machines. Both are squarely against
Implementation Rule 5 ("build/release/run separation… tag each artifact with the git commit
SHA for provenance"), so this is fix territory in Phase 2, not just a note.

The script's preflight checks are, in contrast, unusually good: it test-builds the Docker
image before deploying (`:130`), boots the container to confirm imports resolve (`:151`),
and compares migration file counts between `src` and `dist` (`:119-124`). Those catch the
`--prod` dependency class of bug that only shows up in production.

### What docker-compose starts

`docker-compose.yml` starts exactly one service: `postgres:16`, with a named volume and a
`pg_isready` healthcheck. It is explicitly optional — the header says most developers use
native PostgreSQL and points at CLAUDE.md instead.

It is **not** a way to run the app. There is no api or web service in it. Ship has no
one-command local start today; `pnpm dev` (`scripts/dev.sh`) shells out to create a
database, find free ports, and run both servers on the host.

That is the gap Implementation Rule 6 asks to close ("a script that starts the full composed
system locally — app, database, and any mock external services — with a single command from
a clean checkout").

`docker-compose.local.yml` is a second, fuller compose file wired to `Dockerfile.dev` and
`Dockerfile.web`, reachable via `pnpm docker:up`. It is undocumented in CLAUDE.md.

### Terraform: provider and pinning

42 `.tf` files. Root `terraform/` holds the prod-shaped config directly (74 resources, no
modules); `terraform/environments/{dev,shadow,prod}` are thin roots composing 5–6 modules
each; `terraform/bootstrap/` holds 5 resources for state setup.

Single provider throughout: **`hashicorp/aws`**. No other provider appears anywhere.

Versions are **constrained but not pinned**:

```hcl
required_version = ">= 1.6.0"
required_providers {
  aws = { source = "hashicorp/aws", version = "~> 5.0" }
}
```

`~> 5.0` permits any 5.x. `>= 1.6.0` permits any future Terraform. Seven
`.terraform.lock.hcl` files exist (all modules plus `environments/prod`), which pins hashes
for those roots — but `environments/dev` and `environments/shadow` have no lockfile, so they
resolve fresh.

Against the brief this matters directly. Category 8's improvement target requires "both
configs must have pinned provider versions," and Week 4 replaces this AWS config with the
**local** provider for exercises and the **`render-oss/render`** provider for deployment,
with no AWS account needed. So none of the existing AWS resource definitions carry forward —
what carries forward is the structure (module composition, per-environment roots) and the
lesson that `~> 5.0` is not a pin.

### CI/CD

**There is none.** Verified by absence, not by reading:

| Looked for | Result |
|---|---|
| `.github/workflows/` | does not exist |
| `.gitlab-ci.yml` | does not exist |
| any CI reference in deploy scripts | none |

`process.env.CI` is branched on in `playwright.config.ts` (workers, retries, reporter,
`forbidOnly`), so the code anticipates CI that was never wired up.

The only automated gate is a husky `pre-commit` hook: empty-Playwright-test check, API route
coverage check, and `comply opensource --hook --staged --exclude e2e --skip-trivy`. It runs
on the developer's machine and `--no-verify` bypasses it — CLAUDE.md forbids that by policy,
which is the only thing enforcing it.

Nothing runs the test suite before a deploy. `scripts/deploy.sh` and
`scripts/deploy-frontend.sh` contain no invocation of `pnpm test`, `type-check`, or `lint`.
451 api unit tests and 869 E2E tests exist and none of them gate a release.

Implementation Rule 4 requires CI workflows running build, lint, type-check, test, coverage,
`pnpm audit`, and a security scan on every PR and commit, with a source-code inventory
produced per run. All of that is greenfield here — nothing to extend.

> **Platform note.** The brief's Rule 4 says "GitHub Actions"; confirmed as a typo — the
> pipeline is **GitLab CI** (`.gitlab-ci.yml`), matching the GitLab repository named in the
> submission requirements. The GitHub URL on the brief's cover page is the genuine upstream
> we fork from and is not affected.

---

# Phase 3 — Synthesis

## 13. Architecture Assessment

*Maps to Appendix checklist item 8.*

### The 3 strongest decisions

**1. Per-worker testcontainers for E2E.** Each Playwright worker gets its own PostgreSQL
container, its own API server on a dynamic port, and its own Vite *preview* server
(`playwright.config.ts`, `e2e/fixtures/isolated-env.ts`). There is no shared test database
and no `webServer` block — the fixture owns startup.

The payoff is measured, not asserted: **869 tests, 864 passed, 0 failed, 5 flaky, 9.6
minutes** at 4 workers. A suite that size with a shared database would normally be a swamp
of order-dependent failures. The config comments also record *why* preview replaced dev
("8 workers with vite dev caused a 90GB memory explosion and system crash") — a real
incident preserved where the next engineer will hit it.

**2. The team pre-empted the obvious performance criticisms.** Two findings that looked like
free wins turned out to be already handled. `documents` carries 13 indexes including a
partial composite on `(workspace_id, document_type)`, a GIN index on `properties`, and an
expression index on `properties->>'user_id'` (F14). And `getBelongsToAssociationsBatch`
exists and is used by the list endpoints, with the singular version reserved for
single-record reads (F15).

This is the strongest signal about the codebase's character: the unified-document-model
tradeoff was made deliberately and then defended. Any Category 4 finding needs
`EXPLAIN ANALYZE` behind it, not an argument from first principles.

**3. Deploy preflight that tests the thing it is about to ship.** `deploy.sh` builds the
Docker image and refuses to continue if it fails (`:130`), then actually *runs* the
container to confirm the import graph resolves under a `--prod` install (`:151`), then
compares migration file counts between `src` and `dist` (`:119`). That catches the
"dependency was in devDependencies" class of bug that otherwise only appears in production.
It is a better gate than most projects have — which makes its absence of a test run
(F27) more conspicuous, not less.

Honourable mention: discriminated unions are the strongest TypeScript pattern in the repo
(§10), and the `shared/` package genuinely holds zero type-safety violations.

### The 3 weakest points

**1. The application cannot run as more than one process — but is deployed behind a load
balancer that will create a second one.** Detailed below; this is the single most serious
thing in the notes.

**2. Nothing verifies the code before it ships.** No CI exists at all (F23), and neither
deploy script runs `pnpm test`, `type-check`, or `lint` (F27). 451 api unit tests and 869
E2E tests exist and none of them gate a release. The one automated gate is a husky
pre-commit hook that `--no-verify` bypasses — held in place by a CLAUDE.md policy, not a
mechanism. Compounding it, the deployed artifact is tagged with a timestamp rather than a
commit SHA and is compiled on a developer's laptop (F26), so a bad deploy cannot be traced
back to the code that produced it.

**3. The local environment is quietly hostile to new developers.** `pnpm db:migrate` applies
10 of 42 migrations and exits 0 (F1). `pnpm test` truncates the developer's own database
(F22). `npx playwright install` is required and documented nowhere (F21). The E2E runner
that CLAUDE.md mandates does not exist (F17). Each is small; together they mean following
the documentation exactly produces a broken environment with no error message saying so.

**Where I would focus:** weakness 1 first — it is the only one that corrupts user data
silently. Then 2, because it is what would have caught 1.

### What I would tell a new engineer first

> Everything is a row in `documents`, distinguished by `document_type`. Read
> `docs/unified-document-model.md` before you reach for a new table — the answer to "where
> does this data live" is almost always "the same place as everything else."
>
> "Sprint" in the database means "week" in the UI. The rename was started and abandoned.
> When a query says `sprint` and the screen says Week, they are the same thing.
>
> The docs are good but they are not the system. Three claims in
> `docs/claude-reference/gotchas.md` describe columns that migrations 027 and 029 dropped
> (F7). Check the live schema.
>
> Before you trust your local environment: run the migrations and confirm you got 42, not
> 10. And do not run `pnpm test` against a database you care about.

### What breaks first at 10× users

**Not a query. The session and collaboration layers, and they break by silently losing
data rather than by slowing down.**

The API holds all its coordination state in module-level `Map`s inside a single Node
process — `docs`, `awareness`, `conns`, `pendingSaves`, `eventConns`
(`collaboration/index.ts:89-108`). Sessions are `express-session` with **no `store:`
option** (`app.ts:147`), so they land in the default in-process MemoryStore. There is no
Redis, no pub/sub, no adapter, and no cluster module anywhere in `api/` — verified by
grep, not assumed.

Meanwhile the infrastructure is configured to create a second process under load:

```hcl
MinSize = "1"          # terraform/elastic-beanstalk.tf:161
MaxSize = "4"          # :167
EnvironmentType = "LoadBalanced"
LoadBalancerType = "application"
```

and there is **no stickiness setting anywhere in `terraform/`**.

So the first scale-out event produces two failures at once:

| Layer | What happens on instance #2 |
|---|---|
| Sessions | Round-robined requests miss the MemoryStore that holds the session. Users are logged out at random, and the CSRF token store goes with it |
| Collaboration | Two users on different instances open the same document. Each instance builds its **own** `Y.Doc` from the DB and they never exchange updates. Both debounce-persist to the same `yjs_state` column every 2s (`:185`). Last write wins — one user's edits vanish with no error |

The Yjs case is the dangerous one. CRDTs are conflict-free only when the peers actually
exchange updates; split across two processes with no relay, they are just two divergent
documents overwriting each other.

Worth being precise about severity: `MaxSize = 4` means this is not a 10× hypothetical. It
is reachable under today's autoscaling triggers. 10× only makes it certain rather than
occasional.

Everything else scales further than this does. The indexes are in place (F14), the batch
loader is in place (F15), and Aurora absorbs read growth long before either becomes the
constraint. The document-per-row model is not the bottleneck — the single-process
assumption is.
