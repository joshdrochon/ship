# Lane 3 — API Response Time (Category 3, brief p.5)

> **Target, verbatim (p.5):** *20% reduction in P95 response time on at least 2 endpoints.
> You must provide before/after benchmarks run under identical conditions (same data volume,
> same concurrency, same hardware). Document the root cause of each bottleneck.*

Four handlers changed, all four of them endpoints the audit's frontend network trace names:
`GET /api/documents`, `GET /api/projects`, `GET /api/team/grid` and `GET /api/auth/me`.

## Result

**Primary measurement — `docs/audit/scripts/bench-api-paired.sh`.** Pre-Lane-3 code
(`767aa2f`) on `:3103` and this branch on `:3104`, one database at 600 documents / 170
issues / 25 users / 35 sprints, `API_RATE_LIMIT_MAX=100000` on both, k6 alternating between
them at 12 req/s per side for 180 s. ~2160 samples per side per endpoint, 0% failures.
Raw output: `docs/audit/raw/cat3-lane3-paired.json`.

| Endpoint | P50 before | P50 after | ΔP50 | P95 before | P95 after | **ΔP95** | ≥20%? |
|---|---:|---:|---:|---:|---:|---:|:--:|
| `GET /api/team/grid` | 8.65 ms | 5.65 ms | −34.7% | 21.41 ms | **14.90 ms** | **−30.4%** | ✅ |
| `GET /api/auth/me` | 5.25 ms | 3.99 ms | −24.0% | 16.58 ms | **13.24 ms** | **−20.1%** | ✅ |
| `GET /api/projects` | 8.44 ms | 7.14 ms | −15.4% | 14.38 ms | 13.14 ms | −8.6% | ✗ |
| `GET /api/documents` | 13.08 ms | 12.21 ms | −6.7% | 23.28 ms | 22.67 ms | −2.6% | ✗ |

**Two endpoints clear the p.5 bar. Two do not, and the reason is worth more than the
number** — see *Why `/api/documents` and `/api/projects` stop where they do* below.

### The measurement p.4 actually asks for: 10, 25 and 50 simultaneous connections

The table above is taken at a fixed 12 req/s per side. That is the right way to compare
service time, but at ~13 ms it leaves about **0.16 requests in flight** — so it is not the
concurrency p.4 specifies, and for a long time nothing in this repo was. Both prior
harnesses missed it from opposite sides: `bench-api.sh` holds the arrival rate so low that
the VU count is not a variable at all, and `bench-api-saturation.sh` raises the rate but
uses an **open** loop, where in-flight count is an emergent property of rate × latency
rather than the thing being set — and it runs one server at a time, so before and after are
minutes apart.

`docs/audit/scripts/bench-api-concurrency.sh` closes both gaps. It uses `constant-vus`, a
**closed** loop in which each of N virtual users holds exactly one request open at all
times, so "10 simultaneous connections" is literally true rather than inferred. And it runs
both builds **concurrently** — `767aa2f` on `:3103`, this tree on `:3104`, one database, one
machine — so Rule 1's "identical conditions" is satisfied by simultaneity rather than by
hoping the machine did not change between runs.

Measured 2026-07-30, 45 s per cell, `DB_POOL_MAX=60` and the rate limiter lifted identically
on both sides. Raw: `docs/audit/raw/cat3-concurrency-claim-endpoints.json`.

| Endpoint | | 10 conns | 25 conns | 50 conns |
|---|---|---:|---:|---:|
| `GET /api/team/grid` | P95 before → after | 70.87 → 22.01 ms | 459.37 → 61.85 ms | 1275.74 → 102.84 ms |
| | **ΔP95** | **−68.9%** | **−86.5%** | **−91.9%** |
| `GET /api/auth/me` | P95 before → after | 38.30 → 6.23 ms | 241.95 → 12.88 ms | 899.06 → 25.93 ms |
| | **ΔP95** | **−83.7%** | **−94.7%** | **−97.1%** |

0% failures on both sides in all six cells; 5,143–25,358 samples per before-side cell and
41,863–173,888 per after-side cell.

**The improvement grows with concurrency, and that is the point.** Both defects this lane
fixed — a query in the grid handler whose result was discarded, and three reads in
`/api/auth/me` serialised for no reason — cost almost nothing on an idle server and dominate
once requests queue behind each other. Measuring at 12 req/s understated the fix by roughly
a factor of three; measuring at the concurrency the brief specifies shows what it is
actually worth.

### Two ways this measurement was wrong before it was right

Both are recorded because the first version of this script produced numbers that looked
clean and were not.

**Pool starvation read as latency.** The first sweep put P50 at exactly **2,005 ms** on
several cells. That is `connectionTimeoutMillis: 2000` in `api/src/db/client.ts` — the dev
pool is `max: 10`, so at 50 simultaneous connections every request past the tenth waited out
the connect timeout and failed. Two endpoints ran at a **100% failure rate** and still
printed a percentage. `DB_POOL_MAX` now exists so the pool can be sized to the concurrency
under test, identically on both sides.

**A 429 read as a win.** With the limiter at 100,000/min, the after side of `/api/auth/me`
was fast enough to issue **531,908 requests in 45 s** — past the ceiling, so 88% of its
responses were 429s, which are fast. That produced a flattering −94% on an endpoint that was
mostly failing. The limiter is now lifted far enough that neither side can reach it.

Neither was caught by inspection. Both were caught because the harness records the failure
rate per cell — and it now stamps `valid: false` on any cell with a non-200 and exits 3
rather than printing a summary. A percentage computed over failed requests is not a
measurement, and it looks exactly like one.

### Against the lane's absolute targets, and why that comparison is weaker

The lane brief sets `/api/documents` ≤ 28.88 ms and `/api/projects` ≤ 19.39 ms, derived from
the frozen baseline of 36.1 ms and 24.24 ms. Both are met — 22.67 ms and 13.14 ms. **That
comparison should not be relied on.** The frozen baseline was captured on a different day
under different machine load; a large part of the apparent gap is the machine, not the code.
The honest number is the paired one above, where both builds answered requests in the same
instant. Stating it the other way round would be the exact failure mode the measurement lock
exists to prevent.

### The mandated `bench-api.sh` pair, and why it cannot resolve 20% here

Both halves taken back to back inside a single `scripts/measure-lock.sh` hold, same database,
same `API_RATE_LIMIT_MAX`, same commands, only the route files swapped between them. Raw
output in `docs/audit/raw/cat3-lane3-{before,after}.json` and the `-saturation-` pair.

**1-minute load average on this 10-core machine was 11.8 → 16.0 across the *before* side and
15.6 → 10.9 across the *after* side.** The lock serialises measurements but cannot suspend
the five other agents sharing the box, and `wait-quiet` gave up after its 180 s budget with
load still above its 6.0 threshold. That is recorded here rather than quietly dropped.

The first such pair contained its own control. `/api/auth/me` was byte-identical on both of
its sides — Lane 3 had not yet touched `auth.ts` — and it moved **+8.6% / +8.0% / +27.3%**
across the three VU levels. An endpoint whose code did not change appeared to get 27% slower.
That is the noise floor of a 240-sample P95 on a contended machine, and it is wider than the
20% effect p.5 asks us to resolve. Any per-endpoint delta smaller than that band is measuring
the machine.

This is why `bench-api-paired.sh` exists and why its numbers are the ones reported above. It
is not a weaker substitute for Rule 1's "identical conditions" — it is a stricter reading of
it. Two sequential runs are taken under *similar* conditions; two concurrent runs are taken
under *the same* conditions, request for request.

### With the rate limiter lifted, where concurrency actually binds

`bench-api.sh` samples at a fixed 12 req/s to stay under the limiter, which leaves the server
~97% idle at every VU count — the reason the audit found P95 flat across 10 / 25 / 50 VUs
(W3-3). `bench-api-saturation.sh` sets `API_RATE_LIMIT_MAX=100000` **on both sides** and
drives 150 req/s, so requests overlap and the VU count becomes a real variable. Confirmed at
2250 requests per 15 s cell with 0% failures — at the stock 1000/min dev ceiling that same
load would have been 90% 429s. Raw output in `docs/audit/raw/cat3-lane3-saturation-*.json`.

### Mechanism, measured directly

Interleaved A/B at the connection-pool layer, 50 alternating samples each so load drift
cannot bias one side, isolating exactly the work these changes remove:

| | P50 before | P50 after | P95 before | P95 after |
|---|---:|---:|---:|---:|
| `/api/projects` query + the admin round trip it no longer makes | 5.01 ms | 1.83 ms | 7.42 ms | 3.06 ms |
| `/api/documents` query + flatten + serialise, ditto | 7.10 ms | 6.30 ms | 10.82 ms | 8.37 ms |

### Why `/api/documents` and `/api/projects` stop where they do

Server-side instrumentation of a single `/api/documents` request, before any change
(temporary timing middleware, medians over 144 requests):

| Phase | ms |
|---|---:|
| express stack before the route (helmet, cors, body parsers, session, CSRF) | 0.24 |
| **`authMiddleware` — 3 serial round trips** | **~1.6** |
| `isWorkspaceAdmin()` round trip | 0.38 |
| the list query itself (plan 0.66 + execute 0.73 + wire/parse ~1.7) | 3.07 |
| flatten 600 rows | 0.05 |
| `res.json` — stringify 351 kB, ETag, socket write | ~2.3 |

Lane 3 owns the route handlers. Of that budget it could reach the admin round trip, the
planning cost and the row copy — and it took all three. What it could not reach is the
**~1.6 ms authentication preamble every request pays**: session fetch, membership check, and
a per-request `UPDATE sessions SET last_activity`. That is audit W4-1, it lives in
`api/src/middleware/auth.ts`, and it is Lane 4's diagnosed fix. Two lanes editing one path
would leave neither able to claim identical conditions, so it was left alone.

`/api/documents` is additionally the hardest case in the set: 600 rows and a 351 kB response
whose size is fixed by the endpoint's contract, over an already-optimal single sequential
scan. There is no algorithmic defect left in it — only fixed costs, most of which are not in
this lane. `/api/team/grid` and `/api/auth/me` moved much further precisely because they had
real structural defects: a query whose result was thrown away, and reads serialised for no
reason.

The two endpoints that fell short should get there once Lane 4's session-write throttle and
supporting indexes land. That is a prediction, not a result, and it is written here as such.

---

## How to run it

Both sides of the pair are the same commands with the same environment. Nothing about the
harness differs between them; only the four route files do.

```bash
# 1. database at the volume p.4 requires (600 documents / 170 issues / 25 users / 35 sprints)
pnpm db:seed && node docs/audit/scripts/augment-seed.mjs

# 2. API with the rate limiter lifted — identical on both sides
cd api && PORT=3103 API_RATE_LIMIT_MAX=100000 npx tsx src/index.ts

# 3. hold the machine still, then measure
scripts/measure-lock.sh acquire lane-3 1800
trap 'scripts/measure-lock.sh release lane-3' EXIT
API=http://localhost:3103 RATE=12  OUT=docs/audit/raw/cat3-lane3-after.json \
  docs/audit/scripts/bench-api.sh
API=http://localhost:3103 RATE=150 OUT=docs/audit/raw/cat3-lane3-saturation-after.json \
  docs/audit/scripts/bench-api-saturation.sh
scripts/measure-lock.sh release lane-3
```

For the paired measurement, stand the old code up beside the new one and run both at once —
this needs no lock, which is the point:

```bash
# old code on :3103
git show 767aa2f:api/src/routes/documents.ts > /tmp/before/documents.ts   # and projects, team, auth
cd api && PORT=3103 API_RATE_LIMIT_MAX=100000 npx tsx src-before/index.ts &
cd api && PORT=3104 API_RATE_LIMIT_MAX=100000 npx tsx src/index.ts &

A=http://localhost:3103 B=http://localhost:3104 RATE=24 DURATION=180s \
  ENDPOINTS="/api/documents /api/projects /api/team/grid /api/auth/me" \
  OUT=docs/audit/raw/cat3-lane3-paired.json docs/audit/scripts/bench-api-paired.sh
```

`pnpm test` truncates the working database (`api/src/test/setup.ts`), so re-run step 1 after
any unit-test run or the next measurement is taken against empty tables.

## How to test it

```bash
pnpm test                                   # 476 passed / 30 files
pnpm --filter @ship/web exec vitest run     # 152 passed / 16 files
pnpm type-check                             # 0
pnpm lint                                   # 0 errors, 262 warnings (baseline was 0 / 263)
pnpm build                                  # 0
```

Two new regression files, both against a real database — Rule 3 cover for changes that are
latency-only and therefore have to prove the *answer* did not change:

`api/src/routes/list-endpoints-regression.test.ts`
* All six `GET /api/documents` prepared-statement shapes — no filter, `type`,
  `parent_id=null`, `parent_id=<uuid>`, and both `type` + `parent_id` combinations. Each
  shape numbers its bind parameters independently and the benchmark only ever exercises the
  no-filter shape, so a numbering mistake in any other shape would otherwise ship unnoticed.
* The seven flattened backwards-compatibility fields still present alongside full
  `properties`.
* `sprint_count`, `issue_count` and every `inferred_status` branch on `GET /api/projects`,
  including the zero-association `COALESCE` path, the rule that only sprints *with assignees*
  count, and that a wiki linked with `relationship_type='project'` counts as neither.
* Private-document visibility for creator / non-creator / workspace admin on both endpoints —
  the semantics the folded admin subquery replaced.

`api/src/routes/team-auth-regression.test.ts`
* `GET /api/team/grid`: the four top-level keys, the computed week range with exactly one
  `isCurrent`, archived people excluded unless asked and sorted last when included,
  `isPending` / `personId` / `email` handling, the assignee → sprint → `{programs, issues}`
  cells including program emoji, colour and `issueCount`, and admin visibility. This is what
  proves the deleted query really was dead.
* `GET /api/auth/me`: workspace list ordered by name (fixtures name the workspaces so
  alphabetical order differs from insertion order), archived workspaces excluded,
  per-membership role, and the `COALESCE(role, 'admin')` super-admin fallback.

Beyond the tests, **all ten request variants were checked for byte-identical responses
against the two live servers** — `/api/documents` with each filter combination, `/api/projects`
with `archived=true` and each sort field, `/api/team/grid`, `/api/auth/me`. Ten of ten matched
exactly, 400,987 bytes down to 472.

## How to roll it back

Each change is its own commit and none depends on another.

```bash
git revert <sha>
```

No migration, no schema change, no new dependency, nothing to unwind in config.
`API_RATE_LIMIT_MAX` is opt-in: unset, the limiter behaves exactly as before.

---

## What changed, why the original was suboptimal, and the tradeoffs

### 1. `GET /api/documents` — the query was re-parsed and re-planned on every request

**Root cause.** The handler concatenated its SQL per request, so every call arrived at
PostgreSQL as a fresh unnamed statement. `EXPLAIN (ANALYZE, BUFFERS)` at 600 documents:

```
Sort  (cost=121.21..122.71 rows=600) (actual time=0.639..0.669 rows=600)
  Sort Key: documents."position", documents.created_at DESC
  ->  Seq Scan on documents  (actual time=0.017..0.248 rows=600)
        Filter: ((archived_at IS NULL) AND (deleted_at IS NULL) AND (workspace_id = $0))
Planning:
  Buffers: shared hit=388
Planning Time: 0.658 ms
Execution Time: 0.733 ms
```

**Planning was 47% of the server-side cost of the app's highest-traffic endpoint**, with 388
buffer hits of catalogue lookups repeated every time. Same observation as audit W4-4, here on
the list query rather than the session lookup.

**Fix.** The filter combinations are a closed set of six shapes. Each now has a stable name
and memoised text issued through node-postgres's named-statement path, so a pooled connection
parses and plans each shape once and afterwards only binds and executes.

**Tradeoff.** A named statement can settle on a *generic* plan rather than a per-value custom
one. PostgreSQL 12+ runs `plan_cache_mode = auto` and keeps the custom plan whenever the
generic one costs more, so this is bounded — but it is a real change in planner behaviour if
`document_type` ever develops a badly skewed distribution. The query text also no longer sits
inline where you read the handler.

### 2. All four endpoints — a whole round trip to ask "is this user an admin?"

**Root cause.** Each handler opened with `isWorkspaceAdmin()` / `getVisibilityContext()` — a
separate `SELECT role FROM workspace_memberships …` — purely to obtain a boolean it then
passed to the main query as `(… OR $3 = TRUE)`. A second pool checkout, a second round trip
and a second parse/plan cycle, **strictly serialised in front of the query that answers the
request**, for a value that was already reachable from inside it. It is duplicated work at the
request level too: `authMiddleware` had already queried `workspace_memberships` for the same
`(workspace_id, user_id)` pair one middleware earlier.

**Fix.** The predicate is expressed inline:

```sql
(visibility = 'workspace' OR created_by = $2
 OR (SELECT wm.role FROM workspace_memberships wm
      WHERE wm.workspace_id = $1 AND wm.user_id = $2) = 'admin')
```

It is uncorrelated with the outer query, so PostgreSQL hoists it into an InitPlan and
evaluates it exactly once per execution — one index probe inside a query already being
issued.

**Tradeoff.** The admin rule now lives in two places for these handlers: the SQL string and
`middleware/visibility.ts`. That is a genuine duplication risk if the definition of "admin"
ever changes. `getVisibilityContext()` remains the right call for handlers that are not on a
hot path and is left in place for them; only the measured endpoints changed.

### 3. `GET /api/projects` — three correlated subqueries re-executed once per row

**Root cause.** `sprint_count`, `issue_count` and `inferred_status` were each per-row scalar
subqueries. At 59 projects that is **177 subquery executions to answer one list request**, all
re-aggregating the same two small tables. The cost is the product of row count and subquery
count, so it grows quadratically in the thing the endpoint exists to list. Measured, the three
were 71% of the query's runtime: removing `inferred_status` alone took it from 3.58 ms to
2.15 ms; removing the two counts took it to 2.50 ms.

**Fix.** Two grouped CTEs computed once and joined — `assoc` for the counts,
`alloc` for the `MAX` sprint-timing rank per project. Semantics preserved including the parts
that are easy to lose: only sprints with a non-empty `assignee_ids` count, `plan_validated`
outranks any allocation, `archived_at` outranks everything, and a project with no associations
reports `0` rather than `null`.

**Tradeoff.** The query is longer and `inferred_status` is no longer one self-contained
`CASE`. The CTEs also aggregate before the visibility filter, so a user who can see very few
of very many projects pays for rows they will not receive. At any realistic ratio the
pre-aggregated form is far ahead, and unlike the correlated form it stops scaling with project
count.

### 4. `GET /api/team/grid` — a query whose result was thrown away, and four needless serialisations

**Root cause, and the largest single defect found in this lane.** A query for "all sprints in
this date range" — a four-table join with two `::date` casts over JSONB text — ran on every
request and **its result was never read**. `dbSprintsResult` was assigned once and referenced
nowhere; the response is built from `sprints` (computed arithmetically), `usersResult` and
`issuesResult`.

The surviving reads were then serialised for no reason. The handler paid **five sequential
round trips** — admin lookup, people list, workspace row, the dead sprint query, issue list —
even though none of the three that matter depends on another.

**Fix.** Dead query deleted, along with the `minDate`/`maxDate` that existed only to
parameterise it. The remaining three issue as one concurrent batch, with the admin lookup
folded into each statement's predicate. Five serial round trips become one batch of three.

**Tradeoff.** Three pooled connections are held briefly per request instead of one at a time.
The pool is 10 (20 in production) and each query is sub-millisecond, so mean occupancy rises
by well under a connection at the arrival rates this endpoint sees. If that ever stops being
true the answer is a larger pool, not a return to serialising independent reads.

### 5. `GET /api/auth/me` — three serialised queries for one answer

**Root cause.** The most-requested endpoint in the audit's trace (9 calls across the common
flows) issued three strictly serialised queries: the user row, the user's workspaces, then the
current workspace. Each paid its own pool checkout, round trip and parse/plan cycle, on top of
the authentication preamble. The second and third read the same two tables, and the third's
answer is a single row the second already scanned past.

**Fix.** Both are now scalar subqueries hanging off the user row, shaped with
`json_build_object` so the payload is unchanged key-for-key, including the
`COALESCE(role, 'admin')` fallback for a super-admin holding no membership row. Six round
trips per request become four, and two of the remaining four are the session preamble this
lane does not own.

**Tradeoff.** The response shape is now partly defined in SQL, so a new field has to be added
to the `json_build_object` rather than to the object literal below it.

### 6. `API_RATE_LIMIT_MAX` — making the endpoints measurable at all

**Root cause.** The ceiling was hardcoded at 1000/min in dev, 100/min in production. 1000/min
is 16.7 req/s, so a load generator must stay below it or measure 429s instead of latency —
which is why the audit found P95 flat across all three concurrency levels (W3-3).

**Fix.** An opt-in environment override, set identically on both sides of every pair here.
Unset, behaviour is unchanged. This does **not** address W3-1 (100 req/min per IP in
production is very low for an app making 4–5 API calls per page view); it only makes the limit
configurable.

**Tradeoff.** An environment variable that can weaken a defensive control is a footgun if it
reaches a production environment file. It is opt-in and validated as finite and positive, but
it is a knob that did not exist before.

---

## What was deliberately *not* done

Recorded so the next engineer does not repeat the analysis.

| Considered | Measured | Why not |
|---|---|---|
| gzip the 351 kB `/api/documents` body in the handler | gzip level 1 costs 1.38 ms CPU; the whole `res.json` → socket-finish phase is only ~1.1 ms over loopback | Net loss on the benchmark's loopback transport, and under CPU contention adding CPU is the wrong direction. It is the right fix over a real network and deserves a WAN-shaped measurement |
| Server-side JSON assembly (`json_agg`, `string_agg(row_to_json)`) to skip node's serialiser | 6.30 ms and 6.79 ms vs 5.08 ms for query + map + `JSON.stringify` | PostgreSQL re-serialising 600 rows is slower than node stringifying them |
| Emit timestamps as pre-formatted ISO text so neither the pg driver nor `JSON.stringify` round-trips through a `Date` | 5.04 ms → 4.78 ms, output byte-identical | Real but small (−5%), and it puts a `to_char` format string in the query that silently has to keep matching `Date.prototype.toISOString`. Not worth the trap |
| Pass `properties` through as text to avoid parsing then re-serialising it | ~−0.6 ms at best | The seven flattened fields still need the parsed object, so only the re-serialise is saved, and manual JSON assembly has to reproduce express's output exactly |
| Skip express's ETag over the 351 kB body | 0.17 ms | Too small to justify weakening conditional-request support |
| Micro-cache the serialised response | not measured | It would move the number a lot and mean very little — the benchmark hammers one URL. Correct invalidation spans mutation handlers in six route files |
| Throttle the per-request `UPDATE sessions SET last_activity` (W4-1, ~1.6 ms of every request) | — | `api/src/middleware/auth.ts` is Lane 4's diagnosed fix. Two lanes changing one path means neither can claim identical conditions |
| Indexes for `(workspace_id, …) WHERE archived_at IS NULL` and `ORDER BY updated_at DESC` (W4-2, W4-3) | — | `api/src/db/` is Lane 4's. Not touched |

## Boundary

Changed: `api/src/routes/{documents,projects,team,auth}.ts`, `api/src/app.ts` (the rate-limit
override only), two new test files, two new benchmark scripts, raw output under
`docs/audit/raw/`. Not touched: `api/src/db/`, repository SQL, `web/`, `terraform/`, `e2e/`,
`package.json`, `CHANGES.md`.

## One harness defect recorded rather than hidden

`bench-api.sh` resolves the document id for its `/api/documents/:id/backlinks` case out of
the `ship_dev` database, while each lane worktree runs against its own (`ship_lane_3` here).
That id does not exist locally, so those rows report `fail_rate: 1`. It is identical on both
sides of every pair and is not one of this lane's endpoints, but the numbers in that row are
404 latencies, not backlink latencies.
