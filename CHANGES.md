# CHANGES

Developer documentation for changes made to this fork.

Required by Week 5 engineering requirement 5 (brief p.4) — *"what was built, how to run and
test it locally, and how to roll it back if it fails"* — which continues Week 4's
Implementation Rule 8 rather than replacing it. Newest work first.

Written for the next engineer who inherits this, not for a grader. Week 4 audit findings live
in `docs/audit/audit-report.md`; Week 5 architecture reasoning lives in `PRESEARCH.md`. This
file is only about what changed and how to undo it.

---

# Week 5 — FleetGraph

## The migration chain could not run against a fresh database

**What was wrong.** `migrate.ts` applies `schema.sql` first, then every migration in order.
`schema.sql` carries *current* state, so several migrations collided with objects it had
already created. On a genuinely empty database the run died at `010_oauth_state`
(`CREATE TABLE oauth_state` — already there), and an outer `catch` treated any
`"already exists"` as benign, logged *"Database schema already exists, continuing..."*, and
**abandoned every remaining migration**. Exit code 0. It looked like success.

The effect: `011`–`037` silently never ran on any fresh database. Nothing structural was
lost, because `schema.sql` is complete — which is exactly why nobody noticed. It was found
while adding `038`, which would have been skipped the same way, on the fresh database that a
destroy-and-redeploy produces.

**What changed.**

| File | Change |
|---|---|
| `010_oauth_state.sql` | `CREATE TABLE` / `CREATE INDEX` → `IF NOT EXISTS` |
| `025_prevent_circular_parent.sql` | `ADD CONSTRAINT` guarded via `pg_constraint`; trigger `DROP ... IF EXISTS` first |
| `033_sprint_to_week_rename.sql` | enum renames guarded on **both** labels — `017` re-adds `sprint_review`, so on a fresh database both old and new exist and a rename collides on the target |
| `035_add_comments.sql` | `CREATE INDEX` → `IF NOT EXISTS` |
| `migrate.ts` | every failure is fatal now, including `"already exists"` |

Safe to change migrations after the fact: any database that ran them successfully has them
recorded in `schema_migrations` and will never execute them again.

**Before / after**, same command against a dropped-and-recreated `ship_dev`:

```
before   ✅ Schema applied → died at 010 → 9 migrations recorded, exit 0
after    ✅ Schema applied → ✅ 42 migration(s) applied successfully → max = 037
```

**How to run it.** `pnpm docker:up`, then
`DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_dev pnpm --filter @ship/api db:migrate`.
There is no PostgreSQL on the host — the database comes from Docker.

**How to test it.** Drop and recreate the database, run migrate, and check
`select count(*) from schema_migrations` reaches 43 (42 + `038`). `agent/src/data/boundary.test.ts`
also applies the whole chain against a fresh testcontainer on every run, so a future
collision fails CI rather than silently truncating the chain.

**How to roll it back.** `git revert` the commit. The guards are additive; reverting restores
the previous (broken-on-fresh) behaviour without touching any database.

---

## FleetGraph data layer — migration 038

**What was added.** `api/src/db/migrations/038_fleetgraph.sql`:

- `idx_documents_workspace_updated` on `(workspace_id, updated_at DESC)`, partial on
  not-archived/not-deleted — the proactive scan's access path
- `api_tokens.scopes TEXT[]`, nullable; `NULL` means unscoped, which is what every existing
  token already is
- `fleetgraph_observations` — the agent's memory. **The unique index on
  `(workspace_id, fingerprint)` is load-bearing**: without it the same finding is re-judged
  every run, turning one finding into ~480 model calls a day with a cost graph as the only
  symptom
- `fleetgraph_notifications` — the delivery channel Ship has never had
- `fleetgraph_watermarks` — how far the last *completed* scan got

Plus `agent/src/data/boundary.ts` and `agent/src/data/pool.ts`.

**Why `boundary.ts` exists.** Every query joining agent tables to Ship tables lives in that
one file. FleetGraph shares Ship's database, which is reversible only while the joins are
contained — the reversal path is written in the file header. If those joins spread inline
across node code, splitting the database later stops being a config change.

**Measured effect of the index**, 50,257 documents, three runs each:

| | Before | After |
|---|---|---|
| Execution | 6.47 / 6.66 / 6.83 ms | 0.137 / 0.157 / 0.158 ms |
| Buffers | 1589 | 36 |
| Plan | Index Scan + **Sort** | Index Scan, no sort |

The `Sort` node disappears because the index supplies the ordering.

**How to run it.** Migrations apply automatically on boot (`Dockerfile:111`) and via
`pnpm --filter @ship/api db:migrate` locally.

**How to test it.** `pnpm --filter @ship/agent test` — 14 tests against a testcontainer
Postgres, including the suppression constraint asserted twice: once through the upsert, and
once with a raw duplicate insert that must be rejected. The second matters because the upsert
would still pass if someone dropped the index — `ON CONFLICT` would simply never fire.

**How to roll it back.** `git revert`, then by hand:
`DROP TABLE fleetgraph_notifications, fleetgraph_observations, fleetgraph_watermarks;`
`DROP INDEX idx_documents_workspace_updated;`
`ALTER TABLE api_tokens DROP COLUMN scopes;`
`DELETE FROM schema_migrations WHERE version = '038_fleetgraph';`
Nothing outside the agent reads any of it, so dropping is safe while the agent is not running.

---

# Week 4 — ShipShape

## A gate for the target that was already lost once

**What was wrong.** Category 1's target is a whole-repo aggregate — −25% of the
1009-violation baseline, so a hard ceiling of **756**. It was met, then **silently lost at
758** when Category 4's merge added 17 `as any` in new test mocks. −25.4% had become
−24.9%, the category had failed, and every gate said pass: `pnpm type-check`, `pnpm lint`,
`pnpm build` and 553 unit tests were all green at 758. It was found by re-measuring by hand.

That is a structural problem, not a slip. Any lane can break an aggregate target, only the
integrated number counts, and the lane that breaks it has no idea it is spending another
lane's budget. `docs/improvements.md` §1 named it — *"a thin margin on such a target is not
a near-miss, it is an unowned liability"* — and then nothing was built to own it.

Current count is **742**, which leaves **14** of headroom against the grading ceiling.
Fourteen is roughly one merge's worth of test mocks.

**What was added.** `scripts/check-type-violations.sh`, wired as a `type-violations` job on
**both** pipelines. It parses the total out of the existing
`docs/audit/scripts/count-type-violations.py` rather than recomputing it, so the gate and
the audit can never disagree about what a violation is.

The ceiling lives in `docs/audit/type-violations-ceiling.txt` and **ratchets**: the script
lowers it on request and *refuses to raise it*. Raising is a deliberate edit to a tracked
file, justified in a commit message — never a quiet adjustment to turn a pipeline green.

**How to run it.**
```bash
scripts/check-type-violations.sh            # check against the committed ceiling
scripts/check-type-violations.sh --update   # lower the ceiling to the current count
python3 docs/audit/scripts/count-type-violations.py --by-file -n 20   # find what moved
```

**How to test it.** All four behaviours were verified before this was committed:

| Scenario | Expected | Result |
|---|---|---|
| clean tree | pass, exit 0 | `PASS 742, exactly at the ceiling` |
| 3 `as any` added in a test mock (the 758 shape) | fail, exit 1 | `FAIL 745, ceiling 742 (+3)` |
| counter script missing | **exit 2**, not 1 | `counter not found` |
| `--update` asked to raise the ceiling | refuse, exit 1 | `refusing to raise the ceiling: 700 -> 742` |

Exit **2** is deliberately distinct from 1, so *"we could not measure"* can never be read as
*"we measured and it was fine"* — the same reasoning as `scripts/assert-tests-ran.sh`.

**How to roll it back.** Delete the `type-violations` job from `.gitlab-ci.yml` and
`.github/workflows/ci.yml`. The script and ceiling file are inert on their own — nothing
else calls them. Or revert the commit.

**Tradeoff.** This blocks merges on a metric that is a proxy, not a truth: a `as unknown as
Foo` double-cast scores the same as an honest narrowing, and legitimate assertions (parsing
external JSON, DOM APIs) are counted as violations. The alternative was continuing to trust
that nobody adds mocks, which has already failed once. A proxy that fails loudly beats an
aggregate nobody watches.

---

## E2E truth, and the title durability bug it was hiding

Changes made after the submission commit `b827ddb`, from one thread: the E2E suite was
reporting failures, and running them down turned up two broken tests and one real product
bug.

Items 1 and 2 are test-only — nothing in `api/src` changed. Item 3 bounds a data-loss
window and ships. **Item 4 was shipped and then reverted; it is not in the product.**

### 1. The Bedrock fake spoke HTTP/1.1; the SDK speaks HTTP/2

**What was wrong.** The in-process Bedrock fake (`e2e/fixtures/mock-bedrock.ts`, added in
`6ce14b7`) was an HTTP/1.1 listener. `@aws-sdk/client-bedrock-runtime` defaults to
`NodeHttp2Handler` — Bedrock's streaming operations require h2 and the handler is
client-wide, so even non-streaming `InvokeModel` goes out over HTTP/2. The server answered
`ERR_HTTP2_ERROR: Protocol error` before reading a byte, `callBedrock` threw, and both
analysis routes degraded to `ai_unavailable`.

That degradation is exactly what the strict assertions were added to catch, so the two
tests failed as designed. Before those assertions existed the check was
`isAnalysis || isUnavailable` — a tautology that passed whether the AI worked or not, and
the reason nobody noticed these tests could make **live, billed Bedrock calls** on any
machine with AWS credentials in its environment.

**What changed.** `createServer` now comes from `http2` with `allowHTTP1: true`, serving
both protocols through the compat `request` handler. Teardown changed with it:
`closeAllConnections()` is an `http.Server` method that does not exist on `Http2Server` and
threw during fixture teardown, so transport sockets are tracked and destroyed directly.

**How to run it.** Nothing to run — it is test infrastructure, exercised by any E2E run.

**How to test it.**
```bash
pnpm exec playwright test e2e/ai-analysis-api.spec.ts --workers=1
# 11 passed. Was 2 failed / 9 passed, plus a teardown error.
```

**How to roll it back.** `git revert a20b3ab`. The two analysis tests go red again — they
are correct; the fake would be wrong.

### 2. A test locator matched the same project in two panels

**What was wrong.** `e2e/project-weeks.spec.ts:178` located a project with an unqualified
`a:has-text("Navigation Test Project")`. In the 4-panel layout that name appears twice —
the contextual sidebar's project list and the Properties sidebar — both linking the same
document id. The test passed only in the window where exactly one panel had painted: 0
matches read as `element(s) not found`, 2 as `strict mode violation`.

Retrying made it *worse*, not better: the second attempt renders both panels from a warm
cache, so a retry is more likely to see 2 than the first attempt. That is why it surfaced
as a hard failure rather than a flake.

**What changed.** The locator is scoped to `getByLabel('Document properties')` — the panel
the test is named for. No application code changed.

**How to run it.** Test-only; it runs as part of any E2E run. To see the behaviour it
covers, open a project's Weeks tab, click a weekly plan cell, and use the project link in
the Properties sidebar on the right.

**How to test it.**
```bash
pnpm exec playwright test e2e/project-weeks.spec.ts -g "navigates back to project"
# 3 of 3 consecutive runs green.
```

**How to roll it back.** `git revert 8cb4987`.

### 3. Unsaved title time is now bounded on the client

**What was wrong — and this one is a real bug.** `6ce14b7` capped the *server's* persist
debounce (`PERSIST_MAX_WAIT_MS`, `api/src/collaboration/index.ts`). The same defect was
still live on the client, and the server cap cannot reach it: before a collaboration
session exists, nothing arrives at the server to schedule a persist at all.

`useCollaborativeTitle`'s fallback timer was cleared on every keystroke, so a user typing
without a 1.5 s pause never triggered a REST save. The whole run lived in React state until
something else flushed it; a crash, reload or navigation lost it silently. The window is
not exotic — it is every slow WebSocket handshake, which means a cold start, a loaded
machine, or a bad network. Precisely when losing the work is most likely.

**What changed.** `TITLE_FALLBACK_MAX_WAIT_MS` bounds an unbroken run at 3 s, matching the
server's ceiling so both paths bound the exposure the same way. The debounce still
collapses bursts.

**How to run it.** No configuration and no flag — it is active in the editor as soon as the
app runs (`pnpm dev`, or `./start.sh` for the full stack). To exercise the path it fixes,
create a document and type into the title without pausing; the value reaches the server
within 3 s instead of waiting for a pause that never comes. Change the ceiling by editing
`TITLE_FALLBACK_MAX_WAIT_MS` in `web/src/hooks/useCollaborativeTitle.ts`; keep it at or
below the server's `PERSIST_MAX_WAIT_MS` so the two paths stay consistent.

**How to test it.**
```bash
pnpm --filter @ship/web exec vitest run src/hooks/useCollaborativeTitle.test.tsx
# 20 passed. Stub out the cap and "saves during unbroken typing" goes red.
```

**How to roll it back.** `git revert c4866df`. Continuous typing becomes unbounded again.

### 4. Reverted: opening the CRDT path at cache load (`3faae2a`)

**Status: reverted in `0e76b00`. It is not in the product.** Recorded here because it was
shipped to `main` and claimed as a fix, and Rule 8 covers what was removed as well as what
was added.

**What it did.** `markCacheLoaded()` opened the CRDT title path at the IndexedDB cache load
rather than at WebSocket `sync`, to make a brand-new document's title durable during the
handshake.

**Outcome.** It replaced a bounded exposure with an unbounded one. Cache load precedes the
socket, so flipping the flag there disarmed the REST fallback and sent keystrokes into a
client-only `Y.Doc`. Measured on a document titled through that window: the client `Y.Doc`
held the title, the server persisted the same document with `title = null`, and no REST
fallback fired. The title existed only in the browser.

| | with `3faae2a` | reverted |
|---|---|---|
| 4 affected specs, `--workers=4 --repeat-each=3`, `--retries=0` | 6 failed / 72 | **0 / 72** |

**Current behaviour.** A new document's title waits for `markSynced`. Item 3's 3 s ceiling
bounds the unsaved window; that is the durability guarantee the product ships with.

**Known gap.** The pre-socket window on a brand-new document is bounded, not eliminated, and
the revert removed the unit tests that covered `markCacheLoaded`. No test currently asserts
behaviour inside that window.

**How to test it.**
```bash
pnpm --filter @ship/web exec vitest run src/hooks/useCollaborativeTitle.test.tsx
pnpm exec playwright test e2e/title-persistence.spec.ts e2e/autosave-race-conditions.spec.ts \
  --workers=4 --repeat-each=3 --retries=0
```

**How to roll it back.** `git revert 0e76b00` reinstates `3faae2a` and the data-loss path
above. There is no reason to.

### 5. Uploads can survive a deploy — Render persistent disk

**What was wrong.** `api/src/routes/files.ts:421` writes to S3 only when `NODE_ENV=production`
**and** `S3_UPLOADS_BUCKET` are both set; otherwise it falls through to `UPLOADS_DIR`
(`/app/api/uploads` in the container). On Render that filesystem is ephemeral, discarded on
every deploy, restart and instance move — while the `files` rows persist in Postgres. The
UI keeps listing attachments whose bytes are gone, and nothing reports a failure. Same
class as W6-9: silent loss behind an interface that says the work is safe.

Not in the audit; found while documenting what Render replaced in the AWS stack.

**What changed.** An optional `disk` on `render_web_service`. A disk rather than turning on
the S3 path because the difference is the credential: S3 means a long-lived AWS key pair in
Render's environment, unrotated, for one feature, on a repo where W8-1 is a leaked AWS
account identifier. Full reasoning and tradeoffs: [`CHANGES/lane-8.md`](CHANGES/lane-8.md) §6.

**How to run it.**
```bash
cd terraform/render
terraform plan -var uploads_disk_size_gb=1   # requires the `starter` plan or above
```

**How to test it.**
```bash
terraform validate && terraform fmt -check   # both clean
```

**How to roll it back.** Omit the variable — it defaults to `null` and plans no disk, which
is the committed state. Or `git revert 6324d6c`.

> **Not applied.** The committed config plans no disk and the live free-plan service is
> unchanged. Render disks require `starter` or above, so attaching one costs money and is
> the account owner's decision.

---

## E2E isolation and clocks

Three changes to the suite itself. None touches product source.

### Database state is reset at each spec-file boundary (`7f9b22e`)

**What was wrong.** The Postgres container is worker-scoped and was seeded once, so every
spec sharing a worker inherited the writes of every spec before it. Test outcomes depended
on file ordering.

**What changed.** A worker-scoped fixture resets to the seeded state the first time a given
spec file runs on that worker, tracked by a marker file under the worker's output
directory. An `auto: true` test fixture invokes it, so no spec has to remember to.

**How to test it.** Any full run exercises it. To see the isolation directly, run two specs
that write conflicting data in either order and confirm both pass.

**How to roll it back.** `git revert 7f9b22e`.

### Two tests were failing deterministically, not flaking (`b9b26d6`)

**Outcome.** `inline-comments.spec.ts` pressed Escape before the comment input had focus,
and the handler only acts on a focused field. `accessibility-remediation.spec.ts` queried a
combobox before navigation completed and without scoping to a panel. Both now wait on the
condition they depend on. No product source changed.

**How to roll it back.** `git revert b9b26d6`.

### One assertion ran on a different clock than its siblings (`11b4935`)

**Outcome.** `project-weeks.spec.ts:213` had no explicit timeout, so it took Playwright's
5 s default while the four waits around it — including the two gating the same page load —
all specify 10 s. There is no `expect.timeout` in `playwright.config.ts` to close the gap.
It now matches its siblings.

Raising a timeout cannot be proven to remove a flake, only to make it less likely. The
assertion's subject is that the link exists and navigates, never that it renders within five
seconds.

**How to roll it back.** `git revert 11b4935`.

### The assignments grid had exactly one unassigned person (`isolated-env.ts`)

**What was wrong.** The grid renders an "Unassigned" group only while at least one person
has no current-sprint allocation. The seed created two people and allocated one, so the
group had a population of exactly one — Bob Martinez. Several tests in
`team-mode.spec.ts` assign a project to the `.first()` unassigned row, and `fullyParallel:
true` spreads one spec file's tests across workers. When one of those landed on the only
unassigned person, the group header stopped existing and every Collapse/Expand test failed
with `element(s) not found`.

**Outcome.** Four people are seeded onto a bench and never allocated, so the invariant
survives concurrent mutation. CLAUDE.md already asks for N+2 rows where a test needs N;
this was at N.

| | before | after |
|---|---|---|
| `drag-handle` + `team-mode`, `--repeat-each=5 --workers=4 --retries=0` | 6 failed / 195 | see run below |

**How to roll it back.** Remove the `benchNames` loop in `e2e/fixtures/isolated-env.ts`.

### A hover-dependent element was queried without waiting (`drag-handle.spec.ts`)

**Outcome.** `dragBlockToPosition` asserted the drag handle visible with a polling
`expect`, then re-queried it with `page.$` — a one-shot lookup that returns whatever is in
the DOM at that instant. The handle is rendered on hover and removed when the pointer
leaves, so it could vanish in the gap, and the failure read as `Required elements not
found`, which looks like a selector bug rather than a race. The handles now come from
`locator.elementHandle()`, which waits.

`:nth-child` is kept for the target rather than `.nth(index)`; the two differ when the
document holds a non-paragraph sibling and the callers were written against `:nth-child`.

**How to roll it back.** Restore the three `page.$` calls.

### E2E is now a blocking CI gate

**What was wrong.** The 874 Playwright tests were local-only. Everything the unit suites
cannot see — the 4-panel layout, the collaboration socket, session expiry, the editor —
was unguarded on every merge to main. Two real bugs reached main that way.

**What changed.** An `e2e` job in both `.gitlab-ci.yml` and `.github/workflows/ci.yml`, in
the `verify` stage alongside `test` and `coverage`, so a red suite blocks the merge.

Three details that are not incidental:

- **A `postgres` service, not testcontainers.** The suite provisions a database per
  worker. Locally that is a testcontainers instance, which needs a Docker daemon —
  and reaching one from inside a CI job means docker-in-docker, which means a runner
  willing to grant privileged mode. The runner this project has sets
  `privileged = false`, so that design made the gate a property of one machine's
  configuration rather than of the commit. `E2E_DATABASE_URL` now switches
  `e2e/fixtures/isolated-env.ts` onto a database-per-worker on an ordinary service
  container. Isolation is unchanged — no two workers share tables either way — and the
  variable is unset locally, so a developer's run still uses testcontainers.
- **`PLAYWRIGHT_WORKERS` is pinned to 4.** Otherwise the count is derived from free memory
  at launch, which is not a property of the commit.
- **The run is wrapped in `scripts/assert-tests-ran.sh 874`.** A crashed worker that drops
  tests exits 2 rather than reading as a pass.

**Tradeoff.** `retries: 2` on the CI path lets a known timing flake through. A
deterministic failure still fails all three attempts, so the gate keeps its teeth; the
untried flake rate is measured separately at `--retries=0` and published rather than
hidden by the retry setting.

**Known risk.** The GitLab job needs a runner that permits privileged mode. If the shared
runners do not, it fails at an explicit `docker info` preflight with a named reason, and
the GitHub workflow carries the same gate on runners that do.

**How to roll it back.** Delete the `e2e` job from either file.

### Four things that only broke in CI

The suite was green on a laptop and red on a runner. None of the four causes was
flakiness, and each was found by reproducing inside `node:22-bookworm` -- the CI image
-- rather than by guessing across pipeline runs. Recorded because every one of them is
invisible from a macOS checkout.

**1. The preview server bound where nothing was looking (`d50b27d`).**
`vite preview` binds the IPv6 loopback only. Node's `fetch('http://localhost:PORT')`
resolves to `127.0.0.1`, so `waitForServer` polled an address with no listener, every
worker's web server timed out at 30 s, and all 874 tests failed identically. Measured in
the image: `curl [::1]` 200, `curl 127.0.0.1` refused. `--host 127.0.0.1` fixes it and
macOS is unaffected either way.

**2. Four workers did not fit (`974a016`).**
Each worker carries an API server, a Vite preview and a Chromium. Four of each was killed
by the OOM reaper at test 510 of 874 in a 7.8 GB container, with no test failures logged
first -- SIGKILL, so the run is void rather than red. 7.8 GB is the Docker VM this
project's GitLab runner lives in. Two workers fit.

Raising Docker Desktop's memory would also have worked, and was rejected: it fixes one
machine and puts the gate back to passing only where someone configured it that way,
which is the same objection that moved this job off testcontainers.

**3. Sixty minutes was less than a clean run costs (`5a013af`).**
Measured at 2 workers on the project's runner: 266 of 874 tests in 30 minutes with zero
failures, so roughly 100 minutes end to end. The job would have been killed around test
530 and reported as a failure indistinguishable from a real one. Raised to 150m.

**4. Six tests pressed a key that does not exist on Linux (`360e1f7`).**
Editor shortcuts were sent as `Meta+...` -- Cmd on macOS, the Super key on Linux. TipTap
binds `Mod-`, which ProseMirror resolves to Ctrl off macOS, so the presses reached nothing
and the following assertion failed on every attempt. The comment above one of them already
described the correct behaviour while the code did the Mac half only:

```
await page.keyboard.press('Meta+a'); // Use Meta for Mac, Control for Windows/Linux
```

`ControlOrMeta` resolves per platform. 49 occurrences across 17 spec files.

| | before | after |
|---|---|---|
| `backlinks` `edge-cases` `inline-code` `inline-comments` `tables` `toc`, Linux, 2 workers, `--retries=0` | 6 failed every attempt | **57 passed of 57** |

**How to test any of these.** Reproduce the runner rather than trusting a macOS run:

```bash
docker network create cinet
docker run -d --name cipg --network cinet --network-alias postgres \
  -e POSTGRES_DB=ship_test -e POSTGRES_USER=ship -e POSTGRES_PASSWORD=ship_test_password postgres:16
git archive HEAD | tar -x -C /tmp/cirepro
docker run -d --name cijob --network cinet -v /tmp/cirepro:/builds/ship -w /builds/ship \
  -e E2E_DATABASE_URL='postgresql://ship:ship_test_password@postgres:5432/postgres' \
  -e SESSION_SECRET=ci-only -e NODE_ENV=test -e CI=true node:22-bookworm sleep infinity
docker exec cijob bash -lc 'cd /builds/ship && git init -q && corepack enable &&
  pnpm config set store-dir /root/.pnpm-store && pnpm install --frozen-lockfile &&
  pnpm exec playwright install --with-deps chromium &&
  PLAYWRIGHT_WORKERS=2 pnpm exec playwright test --retries=0'
```

Two traps in that harness, both hit here and neither a pipeline problem: pnpm cannot
hardlink across a bind mount (`system error -116`), so the store must live outside it; and
`postinstall` runs `git config`, which exits 128 in a tarball extraction without a `.git`.

**How to roll any of them back.** `git revert` the SHA named in each item. Reverting 1 or 4
returns the suite to failing in CI while still passing locally.

### Three more that only appear on a runner

**Sleeping instead of waiting, in 59 places.** Specs typed a `/` command and then slept
300-500 ms before pressing Enter to pick an item. If the menu had not rendered, Enter
reached nothing, no file chooser opened, and the test sat until its 60 s timeout. The menu
now carries `data-testid="slash-menu"` -- it had no other stable hook, only utility classes
-- and `waitForSlashMenu` in `e2e/fixtures/test-helpers.ts` waits for it.

**`addParagraphs` slept 300 ms after typing** (`drag-handle.spec.ts`). The drag then looked
up `.ProseMirror p:nth-child(N)`, which matched nothing because the paragraph did not exist
yet. It reported as `locator.elementHandle: Timeout exceeded`, so the first attempt at a fix
raised that timeout from 2 s to 10 s -- and it failed again at 10 s. That was the useful
result: a longer clock cannot produce an element that is never created. It now waits for the
typed text to be in the editor.

**A link named by data that arrives later** (`project-weeks.spec.ts`). The Properties panel
renders the project link immediately with `projectId.substring(0, 8) + '...'` as its label
and only swaps in the real title once a separate fetch returns
(`PropertiesPanel.tsx:251`, `useWeeklyReviewActions.ts:167`). The test matched on the name
and raced that fetch; it now matches the `href`, which is correct from first paint. A link
whose accessible name is a truncated UUID is also a real accessibility defect and is *not*
fixed here.

**Measured on GitHub across five runs**, each adding one fix:

| | passed | failed |
|---|---:|---:|
| baseline | 862 | 6 |
| + `ControlOrMeta` | 868 | 1 |
| + href locator | 870 | 2 |
| + slash-menu waits | 863 | 1 |
| + paragraph wait | **862** | **0** |

The passed column moves around because tests shift between failed and flaky; the failed
column is the one that matters. 12 remain flaky and are not claimed as passing.

**How to roll back.** Revert the SHA named in each item. Reverting the slash-menu change
also removes `data-testid="slash-menu"`, which is the only product change among them.

### Reading an E2E run

Two ways a run can look clean without being one:

- **`did not run` is not zero failures.** Any run reporting it is void.
- **Worker count drifts.** `playwright.config.ts` derives it from free memory at launch, so
  the same command on the same tree ran at 1 worker and at 10 within an hour. Pin
  `PLAYWRIGHT_WORKERS` before comparing two runs.

---

## Build once, promote — Rule 5 (closes audit finding F26)

**What was wrong.** Three independent builds of the same source existed and none
promoted any other, so nothing that ran anywhere was traceable to a commit:

| Build | Fate |
|---|---|
| GitLab CI `docker-image` → `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA` | tag was invalid — **failed every `main` pipeline** |
| GitHub Actions `docker-image` | `push: false` — built, then discarded |
| Render, `runtime_source.docker` | cloned the branch and built its **own** image |
| `scripts/deploy.sh` | compiled on the operator's laptop, `VERSION="v$(date …)"` |

`/health` returned `{"status":"ok"}` with no version, so "which commit is in
production?" had no answer at all.

The GitLab failure was live, not theoretical. `$CI_REGISTRY_IMAGE` expands to the
empty string because **the GitLab instance runs no container registry** —
`labs.gauntletai.com/jwt/auth?service=container_registry` answers
`{"code":"UNAVAILABLE","message":"registry not enabled"}`, and the project's
`container_registry_image_prefix` is null. So the job ran
`docker build -t ":c432768…"` and died with `invalid reference format`, on five
consecutive `main` commits including HEAD. The other eight jobs were green and
this job only runs on `main`, so every lane branch looked clean while the default
branch was red.

**What changed.**

| File | Change |
|---|---|
| `Dockerfile` | `ARG GIT_SHA=unknown` → `LABEL org.opencontainers.image.revision` + `ENV GIT_SHA` |
| `api/src/app.ts` | `/health` returns `{"status":"ok","revision":"<sha>"}` |
| `api/src/routes/health.test.ts` | regression tests for the field and its `unknown` fallback |
| `.github/workflows/ci.yml` | **now the publisher** — builds, verifies provenance three ways, pushes `ghcr.io/joshdrochon/ship:<sha>` |
| `.gitlab-ci.yml` | builds with a valid local tag and asserts the SHA is inside the image; no longer pretends to publish |
| `terraform/render/main.tf` | `runtime_source.docker` → `runtime_source.image`; optional `render_registry_credential.ghcr` |
| `terraform/render/variables.tf` | `repo_url`/`branch`/`dockerfile_path`/`auto_deploy` removed; `image_repository`, `image_tag`, registry auth added |
| `terraform/render/outputs.tf` | `deployed_image`, `verify_deployed_revision` |
| `scripts/deploy.sh` | version label is `git rev-parse HEAD`; refuses a dirty working tree |
| `docs/artifact-lifecycle.md` | new — the lifecycle documentation Rule 5 requires |

**Registry: ghcr.io.** Not a preference — the GitLab registry does not exist (above),
and no credential fixes a service that is not deployed. ghcr.io needs **no credential
to be provisioned**: Actions issues `GITHUB_TOKEN` with `packages: write` to the job.
Pushing to ghcr.io *from* GitLab would have needed a long-lived GitHub PAT in a masked
CI variable, for the same result.

**The substantive fix is the Terraform one.** `runtime_source.image` means Render
pulls the image CI built instead of building a fourth one. A deploy becomes
`terraform apply -var image_tag=<sha>`; a rollback is the same command with an older
SHA. `image_tag` has no default and is validated `^[0-9a-f]{7,40}$`, so `latest` is
refused — a floating tag would re-open the exact question this change closes.

It also removes a Category 8 qualification. The git source required the Render account
to hold a GitHub OAuth consent for the private repo, which Terraform cannot create;
that is why `terraform/render/README.md` said "one credential and one prior consent"
rather than "deployable using only `terraform apply`". Pulling a published image needs
no repo connection.

### How to run it

```bash
# CI publishes on every push. To deploy a published commit:
cd terraform/render
terraform apply -var image_tag=<sha>

# Roll back
terraform apply -var image_tag=<older-sha>
```

`scripts/deploy.sh` (the AWS path) is unchanged in usage but now refuses to run with
uncommitted changes — commit or stash first. There is no override flag.

### How to test it

```bash
# Provenance reaches the image and the wire
docker build --build-arg GIT_SHA=test -t ship:test .
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ship:test   # test
docker run -d --name p -p 18080:80 -e SESSION_SECRET=x \
  -e DATABASE_URL=postgres://unused:unused@127.0.0.1:5432/unused ship:test node dist/index.js
curl -s localhost:18080/health    # {"status":"ok","revision":"test"}
docker rm -f p

# Local dev is unaffected — no build arg means no lie
docker build -t ship:nosha .
curl -s localhost:18081/health    # {"status":"ok","revision":"unknown"}

# Terraform
cd terraform/render && terraform validate && terraform fmt -check
terraform plan -var image_tag=latest    # refused by the validation rule

# Unit
pnpm --filter @ship/api exec vitest run src/routes/health.test.ts
```

All of the above were run except the last (the database was under a concurrent
benchmark). Results are in the report accompanying this change.

### How to roll it back

| To undo | Do this |
|---|---|
| Everything | `git revert <sha>` — the change is one commit and touches no schema |
| Just the Render promotion | Restore `runtime_source.docker` in `terraform/render/main.tf` and the four `repo_url`/`branch`/`dockerfile_path`/`auto_deploy` variables. Reintroduces the fourth build and the OAuth consent step. |
| Just the `/health` field | Revert the `revision` line in `api/src/app.ts` and the two new cases in `health.test.ts`. Note `terraform output verify_deployed_revision` then has nothing to compare against. |
| Just the dirty-tree gate | Delete the `git status --porcelain` block in `scripts/deploy.sh`. Keep the SHA version label — it is independent. |
| Just the ghcr.io push | Set `push: false` on the GitHub job. Render then points at a tag nobody publishes, so pin `image_tag` to a SHA already in the registry first. |

No migration to reverse. Full lifecycle documentation: `docs/artifact-lifecycle.md`.

---

## Accessibility, after Category 7 was closed

Per-category detail lives in `CHANGES/lane-*.md` and is indexed from `SUBMISSION.md`. This
one gets a line here because it is a **correction to a category that had already been
reported as done**, and someone reading only the root file should not miss that.

Category 7 scoped its scan and its fixes to *"the 3 most important pages"*, which is what
p.7 asks for. Five of its own findings sat outside that scope and were never fixed —
W7-6, W7-7, **W7-8** (eight pages titled "Ship | Ship", WCAG 2.4.2 Level A) and **W7-9**
(a nested `<main>`, no landmark on `/login`, a missing `<h1>`, an empty `<th>`) — and the
lane doc's "still open" table did not list them either. W7-8 and W7-9 are now fixed;
W7-6 and W7-7 are fixed in the e2e suite; **W7-11 is a deliberate non-fix**, recorded with
its numbers.

Reading every page instead of three then turned up three defect sets the audit never
recorded at all: 6 unnamed `<select>`s (one set on the page that grants workspace admin),
8 unnamed icon-only buttons (2 destructive), and an `<li>` in a `role="group"` tree.

**What changed, why the original was worse, the tradeoffs, and how to roll each piece
back: [`CHANGES/lane-7.md`](CHANGES/lane-7.md), §8–§11.** Audit findings, including the
three that were never in it and why they were missed: `docs/audit/audit-report.md`,
Category 7.

---

## Lane 0 — CI, one-command start, and the test suite that blocks them

**Why this went first.** Rule 2 says *"any change that causes a regression in the CI
pipeline must be rolled back immediately"* (p.8). There was no CI pipeline, and 13 of
`web/`'s 151 unit tests were already failing, so "tests still pass" could not be asserted
about anything. Nothing else could be proven until this existed.

### Measured before/after

Every number below comes from re-running the same command before and after. Commands are
in the "How to test" section so they can be reproduced.

| Metric | Before | After | How measured |
|---|---:|---:|---|
| `web/` unit tests passing | 138 / 151 | **152 / 152** | `pnpm --filter @ship/web exec vitest run` |
| `api/` unit tests passing | 451 / 451 | **451 / 451** | `pnpm test` |
| Critical dependency advisories | 3 | **0** | `pnpm audit --audit-level critical` |
| High / moderate / low advisories | 58 / 64 / 10 | **51 / 55 / 9** | `pnpm audit --json` |
| Lint errors | *no linter existed* | **0** (263 warnings) | `pnpm lint` |
| React hook-order violations | 9 | **0** | `pnpm lint` |
| CI checks | 0 | **8**, on two platforms | `.gitlab-ci.yml`, `.github/workflows/ci.yml` |
| Commands to start from clean checkout | 7 (+ host Node, pnpm, PostgreSQL) | **1** (Docker only) | `./start.sh` |

The advisory drop in high/moderate/low is a side effect of the three version pins, not a
separate effort — pinning `vitest >=4.1.0` pulled forward transitive dependencies that
carried their own advisories.

---

### 1. Fixed 13 failing `web/` unit tests

**What was wrong.** Three test files had drifted from the product. Not flaky — wrong.

| File | Failures | Cause |
|---|---:|---|
| `web/src/lib/document-tabs.test.ts` | 9 | Product renamed the `sprints` tab to `weeks` and gave sprint documents tabs. Tests still asserted `'sprints'` and `toEqual([])`. |
| `web/src/components/editor/DetailsExtension.test.ts` | 3 | `DetailsExtension` declares `content: 'detailsSummary detailsContent'`, but the test built an `Editor` with only `DetailsExtension`, so ProseMirror could not resolve the child node types. |
| `web/src/hooks/useSessionTimeout.test.ts` | 1 | The fetch mock was `{ ok, json }` with no `headers`. `ensureCsrfToken` (`web/src/lib/api.ts:59`) reads `response.headers.get(...)`, which threw, so `apiPost` rejected and the hook took its fail-secure branch and called `onTimeout`. |

**Why the tests were changed rather than the code.** Rule 2 permits *"fix the test (with
justification)"*. In all three cases the product behaviour is correct and deliberate — the
`sprint`→`week` rename is a real product decision, registering all three TipTap extensions
together is what `web/src/components/Editor.tsx:596-598` actually does, and forcing logout
when session extension fails is correct fail-secure behaviour. The tests encoded stale
expectations and an invalid mock.

**Tradeoff.** Two `resolveTabLabels` tests asserted that a count reached the project
`weeks` tab. It never can — that tab's label is a static string. Renaming the id alone
would have made the assertion vacuous, so the dynamic-count case was moved to program
tabs, where the label *is* count-driven. The alternative was deleting the assertion,
which would have silently dropped coverage of dynamic labels.

`useSessionTimeout.test.ts` also gained a `clearCsrfToken()` call in `beforeEach`. The
CSRF token is cached at module scope in `web/src/lib/api.ts:15`, so it leaked between
tests and made results order-dependent.

Net test count is 152, not 151: one test was added asserting that `DetailsSummary` and
`DetailsContent` exist, which is the thing whose absence caused the original failure.

### 2. Fixed 9 React hook-order violations

**What was wrong.** Three components called hooks after an early `return`:

- `web/src/components/UnifiedEditor.tsx` — `if (!user) return null` sat above 7 hooks
- `web/src/components/icons/uswds/Icon.tsx` — invalid-name guard above a `useMemo`
- `web/src/components/review/WeeklyReviewSubNav.tsx` — review-mode guard above a `useMemo`

**Why it matters.** React matches hooks by call order. When the guard condition flips
between renders, the hook count changes and React throws *"Rendered more hooks than
during the previous render."* In `UnifiedEditor` this is latent only because
`ProtectedRoute` currently prevents that subtree rendering while `user` is null — a
routing change would surface it as a hard crash.

**Fix.** Hooks hoisted above the guards. `Icon.tsx` needed the lookup itself to absorb
the invalid case (`isValidIconName(name) ? getLazyIcon(name) : null`) since it now runs
unconditionally.

**Tradeoff.** `Icon` now computes the lazy lookup even for an invalid name. That is a map
read, and the alternative — leaving a hook below a conditional return — is a latent crash.

### 3. Added eslint (`eslint.config.js`)

**What was added.** eslint 9 flat config with `typescript-eslint` and
`eslint-plugin-react-hooks`. Root scripts `lint` and `lint:fix`.

**Why this shape.** The repo had no linter and 312 of 315 source files fail
`prettier --check`. Two obvious options were both wrong: gating on prettier means
reformatting 312 files, which Rule 10 explicitly excludes (*"reformatting code... do not
count as improvements"*, p.9) and would collide with every other lane's diff; and a config
that flags nothing is theatre.

The line drawn: **errors are things that are defects regardless of style** —
`no-fallthrough`, `no-unreachable`, `no-dupe-keys`, `react-hooks/rules-of-hooks`.
Everything that is debt already owned by a named improvement lane is a warning, with the
owner in a comment. Result: 0 errors, 263 warnings, and the warning count is the number to
drive down.

Deliberately **not** using `recommendedTypeChecked`. It needs a TypeScript program per
package and roughly triples lint time, and `pnpm type-check` already runs `tsc --noEmit`
across all three packages in CI.

Rules turned off with reasons, rather than silently:

| Rule | Why off | Where |
|---|---|---|
| `@typescript-eslint/no-namespace` | Declaration merging is the only way to augment Express's `Request` type | `api/src/middleware/auth.ts:8` and 2 route files |
| `no-empty-pattern` | Playwright's worker-fixture signature is `async ({}, use, workerInfo)` — the empty destructure is required by the API | `e2e/fixtures/isolated-env.ts:109` |
| `no-empty` (tests only) | `.catch(() => {})` is how these specs express "may or may not exist" | 15 sites in `e2e/` |
| `no-undef` (TS only) | `tsc` already enforces it; duplicating doubles the report | — |

**How to tighten.** Move a rule from `warn` to `error` once its count reaches zero.
`@typescript-eslint/no-explicit-any` is the one Lane 1 will drive down.

### 4. Fixed 3 critical dependency advisories

`pnpm.overrides` in `package.json`:

| Package | Pinned | Advisory | Reached via |
|---|---|---|---|
| `fast-xml-parser` | `>=5.3.5` | Entity encoding bypass via regex injection | `@aws-sdk/client-bedrock-runtime` |
| `protobufjs` | `>=7.5.5` | Arbitrary code execution | `testcontainers > dockerode` |
| `vitest` | `>=4.1.0` | Arbitrary file read/execute when the UI server is listening | direct dev dependency |

All three were transitive or dev-only with patched versions available. `vitest` needed an
override rather than a version bump because `api/` and `web/` declare `^4.0.16`
independently and the lockfile had pinned 4.0.17, inside the advisory window.

**Tradeoff.** `vitest` went 4.0.17 → 4.1.10, a minor bump across both suites. Verified:
603 tests still pass (451 api + 152 web).

### 5. Added CI (`.gitlab-ci.yml` and `.github/workflows/ci.yml`)

**The Rule 4 / p.10 conflict, and how it was resolved.** Rule 4 says *"Add GitHub Actions
workflows"* (p.8). The submission target is *"Forked repo with all improvements on clearly
labeled branches"* in a GitLab repository (p.10), and this fork's `origin` is GitLab.
Earlier notes treated these as incompatible and planned to document a deviation. They are
not incompatible — this repo has both remotes configured, so **both pipelines exist and
run the same eight checks.** `.gitlab-ci.yml` is the gate that blocks merges on the
submitted repository; the Actions workflow satisfies Rule 4 literally on the platform it
names. No deviation needed. If the two drift, `.gitlab-ci.yml` wins.

All eight Rule 4 checks, on both platforms:

| Check | Job | Notes |
|---|---|---|
| build | `build` | Runs once; every later job consumes the artifact (Rule 5) |
| lint | `lint` | `pnpm lint` — 0 errors required |
| type-check | `type-check` | `tsc --noEmit` × 3 packages |
| test | `test` | **Both** suites. `pnpm test` alone is api-only and leaves 151 web tests unrun |
| coverage | `coverage` | `web` needs `--coverage.reportOnFailure`; vitest defaults it false |
| dependency audit | `dependency-audit` | Gates on zero critical |
| security scan | `security-scan` | gitleaks |
| source-code inventory | `license-inventory` | 1018 packages, 14 licences |

**Two documented deviations** (Rule 4 permits them *"with written justification"*):

1. **The audit gate is critical-only, not all severities.** 51 high and 55 moderate
   advisories remain, effectively all transitive ReDoS reports in dev tooling with no
   patched path today. Gating on them would block every merge for reasons unrelated to
   the change under review. Instead `scripts/audit-summary.mjs` diffs against
   `audit-baseline.json` (105 known advisories) and reports anything new, so a genuinely
   new advisory is still visible. Refresh the baseline deliberately with
   `node scripts/audit-summary.mjs --write-baseline`.
2. **gitleaks instead of `comply`.** `comply` is the organisation's scanner and what
   `.husky/pre-commit` expects, but it is not installable in either CI image — and it is
   not installed locally either, so the pre-commit secrets scan has been skipping with a
   warning on every commit. gitleaks actually runs.

Also: `--frozen-lockfile` everywhere, so lockfile drift fails the pipeline rather than
silently installing something else. That is what enforces Rule 4's pinning requirement.

`DATABASE_URL` is set explicitly in both pipelines and points at a throwaway service
container. This is deliberate: `api/src/test/setup.ts:14` truncates 15 tables in a
`beforeAll` against whatever `DATABASE_URL` resolves to, so it must never be allowed to
inherit a real value.

### 6. Added one-command local start (`./start.sh`)

**What was wrong.** README setup was 7 steps and required host Node, pnpm, and a
PostgreSQL the developer installed themselves. `docker-compose.yml` starts only
PostgreSQL. `docker-compose.local.yml` did already run all three services — so the gap
was narrower than the audit's F29 implied — but nothing wrapped it, nothing waited for
readiness, and there was no mock for the one external dependency.

**What was added.**

- `start.sh` — checks Docker is installed *and running*, handles both `docker compose` and
  `docker-compose`, brings the stack up, polls `/health` until the API answers (migrations
  and seeding happen on API start, so a fixed sleep is wrong), then prints URLs,
  credentials, and the seeded document count. On timeout it dumps the failing container's
  last 40 log lines and leaves the stack up for inspection.
- `docker-compose.mocks.yml` + `mocks/bedrock-expectations.json` — mock AWS Bedrock, so
  the AI quality banners work without AWS credentials. Layered as an override; skip it
  with `--no-mocks`.
- `api/src/services/ai-analysis.ts` — reads `BEDROCK_ENDPOINT` and passes it to the
  Bedrock client. Unset in production, where the SDK resolves the real regional endpoint
  exactly as before. This one-line product change is what makes the mock reachable.
- README cold-start guide rewritten. Host setup is preserved under a `<details>` block
  with the two footguns named: partial migrations exiting 0, and `pnpm test` truncating
  the dev database.

**Two defects found by running it, not by reading it.** Both are worth knowing about
because the second one is a trap anyone extending these compose files will hit.

1. **The two compose files collide on container name.** `docker-compose.yml` and
   `docker-compose.local.yml` both declare a service called `postgres`. Under the default
   compose project name (the directory, `ship`) they resolve to the same container,
   `ship-postgres-1` — so bringing up the local stack *recreated* the plain stack's
   container and moved the database from port 5432 to 5433, silently breaking `pnpm dev`
   on the host. The first run of `start.sh` did exactly this. Fixed by giving the script
   its own project (`-p ship-local`), so it gets its own containers and its own volume
   and the two paths coexist. The shared `postgres_data` volume name is why no data was
   lost when it happened.
2. **The mockserver image is distroless.** The healthcheck was written as `CMD-SHELL`
   with `curl`, and the image has neither a shell nor curl, so the container reported
   unhealthy forever while serving correctly — and `condition: service_healthy` then
   blocked the API from starting at all. Docker has no shell-free HTTP probe, so the
   healthcheck was removed. Strict ordering was never needed: `ai-analysis.ts` builds its
   client lazily on the first analysis request and returns null on failure, so the API
   boots regardless.

**Tradeoff.** `./start.sh` runs everything in containers, so hot-reload is slower than
`pnpm dev` on the host. Both paths are documented; `pnpm dev` is still there and unchanged.
Because the containerised stack now has its own volume, its database is separate from the
host one — seeded independently, and unaffected by `pnpm test` truncating the host DB.

**Scope boundary.** The mock is not a Bedrock emulator — it answers non-streaming
`InvokeModel` with a fixed well-formed payload and ignores SigV4. Adding retries,
timeouts, and a circuit breaker around this call is Rule 7 work and belongs to the error
handling lane, not here.

---

## How to run it

```bash
./start.sh                  # full stack: postgres + api + web + mock bedrock
./start.sh --clean          # discard the database volume and re-seed
./start.sh --down           # stop
```

Then http://localhost:5173, log in `dev@ship.local` / `admin123`.

CI runs on push and pull/merge request on both platforms. No manual trigger.

## How to test it

```bash
# The before/after numbers in the table above, reproduced:
pnpm --filter @ship/web exec vitest run     # expect 152 passed
pnpm test                                   # expect 451 passed  (TRUNCATES the dev DB)
pnpm db:seed                                # put the 257 seed documents back
pnpm type-check                             # expect exit 0
pnpm lint                                   # expect 0 errors
pnpm audit --audit-level critical           # expect exit 0
pnpm build                                  # expect exit 0

# Source-code inventory
pnpm licenses list --json > licenses.json && node scripts/license-inventory.mjs

# Dependency audit summary + new-advisory check
pnpm audit --json > pnpm-audit.json || true
node scripts/audit-summary.mjs

# One-command start, from scratch
./start.sh --clean
curl -fsS http://localhost:3000/health
```

**`pnpm test` truncates whatever `DATABASE_URL` points at.** Re-seed after running it or
the next measurement is taken against an empty database.

## How to roll it back

Everything here is additive except four edited files, and it is separable (Rule 11).

| To undo | Do this |
|---|---|
| CI, both platforms | `rm .gitlab-ci.yml .github/workflows/ci.yml` |
| eslint | `rm eslint.config.js`; remove `lint`/`lint:fix` from root `package.json`; `pnpm remove -Dw eslint typescript-eslint @eslint/js globals eslint-plugin-react-hooks` |
| Dependency pins | Delete the `pnpm.overrides` block from `package.json`, then `pnpm install`. Reintroduces 3 critical advisories. |
| One-command start | `rm start.sh docker-compose.mocks.yml`; `rm -rf mocks/`; revert the README section |
| Bedrock endpoint override | Revert `getClient()` in `api/src/services/ai-analysis.ts`. Safe — the variable is unset outside local dev. |
| Test fixes | `git checkout <pre-change-sha> -- web/src/lib/document-tabs.test.ts web/src/components/editor/DetailsExtension.test.ts web/src/hooks/useSessionTimeout.test.ts`. Restores 13 failures. |
| Hook-order fixes | Revert `UnifiedEditor.tsx`, `Icon.tsx`, `WeeklyReviewSubNav.tsx`. **Not recommended** — reintroduces a latent crash. |
| Inventory/audit scripts | `rm scripts/license-inventory.mjs scripts/audit-summary.mjs audit-baseline.json` |

Nothing here changes the database schema, so there is no migration to reverse.

### Files touched

**Added:** `.gitlab-ci.yml` · `.github/workflows/ci.yml` · `eslint.config.js` ·
`start.sh` · `docker-compose.mocks.yml` · `mocks/bedrock-expectations.json` ·
`scripts/license-inventory.mjs` · `scripts/audit-summary.mjs` · `audit-baseline.json` ·
`CHANGES.md`

**Edited:** `package.json` (scripts, overrides, devDeps) · `web/package.json`
(`test:coverage`) · `shared/package.json` (no-op `test`) · `README.md` (cold start) ·
`api/src/services/ai-analysis.ts` (endpoint override) ·
`web/src/components/UnifiedEditor.tsx` · `web/src/components/icons/uswds/Icon.tsx` ·
`web/src/components/review/WeeklyReviewSubNav.tsx` · the three test files above ·
`e2e/manager-reviews-visual.spec.ts` (redundant escapes)
