# Lane 5 — Test Coverage and Quality

Category 5. Improvement target, verbatim (brief p.6):

> Add meaningful tests for 3 previously untested critical paths, or fix 3 flaky tests with
> documented root cause analysis. "Meaningful" means the test catches a real regression,
> not just asserting that a page loads. Each test must include a comment explaining what
> risk it mitigates.

The first route was closed by the audit — all four critical flows already had coverage — so
this lane took the flake route. Three flaky tests fixed with root cause analysis, plus a
fourth that these fixes surfaced and that is therefore fixed here too.

Every number in this document is committed at
`docs/audit/raw/lane5-flake-fix-evidence.txt`, generated from the Playwright logs by
`docs/audit/scripts/lane5-gen-evidence.sh`. The run scripts are
`docs/audit/scripts/lane5-*.sh`, and the verification gate is at
`docs/audit/raw/lane5-verification-gate.txt`.

Developer documentation for this lane per Rule 8 is at the bottom: how to run it, how to
test it, how to roll it back.

---

## The tests

Chosen as the three most frequent entries in `docs/audit/raw/known-flakes.txt`, which
records how many of the three baseline `PLAYWRIGHT_WORKERS=4 pnpm test:e2e` runs each spec
failed in.

| Test | Baseline | Root cause | Strongest evidence |
|---|---|---|---|
| `my-week-stale-data.spec.ts:28` plan edits visible after navigating back | 2 of 3 | Shared fixture data + a wait that proved nothing | **Red→green, locked, back-to-back** (PRE1 vs POST1/POST2) |
| `status-overview-heatmap.spec.ts:69` displays split cells | 2 of 3 | Shared fixture data over a non-deterministic API | **Red→green from a pre-committed falsifiable prediction** (H-PRE vs H-POST) |
| `my-week-stale-data.spec.ts:63` retro edits visible after navigating back | 3 of 3 | Same two causes as `:28` | 3-of-3 red at full-suite scale, absent post-fix; mechanism reproduced directly by probe |

A fourth was surfaced *by* these fixes and is therefore fixed here too:

| Test | Baseline | Root cause | Strongest evidence |
|---|---|---|---|
| `weekly-accountability.spec.ts:78` POST /weekly-plans returns 201 | not in baseline | Person+week collision, masked by failure-driven worker restarts | **Red→green, fix stashed then restored** (W78-PRE vs W78-POST) |

None of the three was a race inside its own file. Run in isolation at four workers with
`--repeat-each=3`, both specs passed 39 of 39. Every one of them was a dependency on state
that another spec file owns — a worker-scoped database, seeded once, shared by every spec
on the worker, never reset between tests.

**What is and is not demonstrated.** Two of the three have a controlled red→green flip
taken back-to-back inside one lock window. The third, `:63`, does not: its dominant cause
is a per-IP WebSocket connection budget that a 49-test run cannot exhaust, so it passes
pre-fix in every small configuration. Its evidence is 3-of-3 red across the three
full-suite baseline runs, absence from the post-fix full suite, and a probe that reproduces
the mechanism directly. That is weaker than a back-to-back flip and is labelled as such
rather than presented as equivalent.

---

## RCA 1 — the two my-week tests

### What they are for

`/my-week` must not serve a cached response after the user edits their weekly plan or
retro. Plan and retro content is written by the Yjs collaboration server, not by a
client-side mutation, so nothing on the client invalidates the query cache. When
`useMyWeekQuery` carried a five-minute `staleTime`, navigating back from the editor showed
the document as empty even though the edit had been saved. `staleTime` is now 0. These two
tests are what keeps it that way.

### Cause A — shared mutable fixture data

The Playwright database is worker-scoped (`e2e/fixtures/isolated-env.ts:150`): one
PostgreSQL container per worker, seeded once at worker start, then shared by every spec
that lands on that worker with **no reset between tests**.

Both tests assumed no weekly plan or retro existed for Dev User in the current week. Three
other specs create exactly that document, for exactly that person, in exactly that week:

- `e2e/manager-reviews-visual.spec.ts:84` and `:91`
- `e2e/request-changes-ui.spec.ts:84`
- `e2e/accountability-week.spec.ts:87`

When one of them ran first on the same worker, `MyWeekPage` rendered the existing document
as a `<Link>` (`web/src/pages/MyWeekPage.tsx:203`) rather than a create `<button>`, and the
test's `getByRole('button', …).click()` timed out after 60 seconds. Which spec files share
a worker changes between runs, which is what made this look like flake rather than a bug.

Reproduced deterministically by forcing the relevant specs onto one worker:

```
PLAYWRIGHT_WORKERS=1 npx playwright test \
  e2e/accountability-week.spec.ts e2e/manager-reviews-visual.spec.ts \
  e2e/my-week-stale-data.spec.ts e2e/project-weeks.spec.ts \
  e2e/request-changes-ui.spec.ts e2e/status-overview-heatmap.spec.ts \
  e2e/weekly-accountability.spec.ts --retries=0
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /create plan for this week/i })
```

### Cause B — a wait that proved nothing, then a fixed sleep

```ts
await expect(page.getByText('Saved')).toBeVisible({ timeout: 10000 })
await page.waitForTimeout(3000)
```

"Saved" renders when `syncStatus === 'synced'`, and `Editor.tsx` sets that from the
y-websocket `status` and `sync` handlers when the socket **opens**
(`web/src/components/Editor.tsx:389`, `:444`). It is never moved back while the user types.
So "Saved" is already on screen before the first keystroke, and the expectation resolved
immediately.

Probed directly — an assertion for "Saved" placed *before* any typing passes:

```
PROBE-A: "Saved" is visible BEFORE any keystroke — the wait is a no-op
```

That left the fixed 3-second sleep as the only wait covering the whole asynchronous chain:
keystroke → WebSocket → the collaboration server's 2-second persistence debounce
(`api/src/collaboration/index.ts:185`) → three queries. About a second of slack on an idle
machine, and none on a loaded one.

And it could not recover. After navigating back, `useMyWeekQuery` fetches once on mount and
has no polling, so the 15-second timeout on the final assertion was dead time, not a retry
window. If the read raced ahead of the write, the DOM would never update.

Worse, the socket may not connect at all. The API rate-limits WebSocket handshakes to 30
per minute per IP (`api/src/collaboration/index.ts:23`), and every test on a worker shares
one API process and one source IP. Probed by burning the budget from the page and then
running the flow:

```
PROBE-B burned: {"opened":29,"refused":11}
PROBE-B sync status after typing (rate limited): "Cached"
PROBE-B my-week plan items after 3s: []
```

The editor shows "Cached", the typed content never leaves the browser, and the my-week API
returns an empty plan. That is the observed baseline failure, and it explains why
`:63` failed 3 of 3 while `:28` failed 2 of 3 — the retro test runs second in the file, so
the connection budget has already been drawn down by the plan test's own editor session on
the same API process.

The file's previous docstring blamed "how the Yjs collaboration server handles JSON-to-Yjs
conversion for newly created documents" and deferred it to a separate branch. That was
wrong — conversion works. The docstring now records the actual finding.

### The fix

- Each test works in a week number nothing else touches — 901 for the plan test, 902 for
  the retro test — reached via `?week_number`. The create control is always a button.
- The `Saved` assertion and the fixed sleep are replaced by a poll of the my-week API until
  it reports the typed item, with a 45-second budget that covers the product's own
  WebSocket retry window rather than assuming the first handshake succeeds.
- The final assertion is unchanged in intent but now means something. The poll proves the
  server has the data; so if the dashboard does not show it after navigating back, the only
  remaining explanation is a stale client cache — which is the regression under test.

Tradeoffs: the tests no longer click the icon-rail Dashboard button, using a history pop
instead. Both are client-side navigations that remount `MyWeekPage`, so the cache path is
unchanged, and the pop preserves the `?week_number` the spec owns. The 45-second poll
budget is generous, but it is spent only when the product is actually retrying — a healthy
run resolves it in well under a second.

---

## RCA 2 — the heatmap split-cell test

### What it is for

An allocated person's week must render as a **split** cell: a Weekly Plan half and a Weekly
Retro half, each separately labelled and separately clickable. That split is the only way a
manager reaches the two documents independently. If `StatusCell`
(`web/src/components/StatusOverviewHeatmap.tsx:66`) regresses to one button, a whole-cell
link, or a status-less block, the grid silently stops being navigable.

### Cause — shared fixture data over a non-deterministic API

The test relied on the seeded current-week allocation for Dev User to produce a cell with
buttons. That allocation is not stable.

`accountability-grid-v3` builds its `assignments[person][week]` map by iterating an
unordered query with last-write-wins (`api/src/routes/team.ts:1725` — no `ORDER BY`). Other
specs create a **second** sprint document for Dev User in the same week:
`e2e/manager-reviews-visual.spec.ts:66` and `e2e/request-changes-ui.spec.ts:68`. Both
attach the project through `belongs_to` rather than `properties.project_id`, which is the
field that query reads, so their row carries a NULL project.

When that row won the race, `StatusCell` took its "no allocation" branch
(`web/src/components/StatusOverviewHeatmap.tsx:78`), rendered `-`, and emitted no buttons at
all. `getByRole('button', {name: /Weekly Plan/}).first()` then found nothing.

Observed by instrumenting the test and running it on a worker shared with those specs:

```
DIAG current=14 [{"prog":"No Program","person":"Bob Martinez","alloc":[]},
                 {"prog":"No Program","person":"Dev User","alloc":["15:API Test Project:future/future"]}]
DIAG buttons=1
```

Dev User's seeded week-14 allocation is gone — no project — and the only surviving buttons
come from an unrelated **week-15** allocation left behind by `project-weeks.spec.ts`. On
that run the test passed by accident. Had the polluting spec written any week outside the
grid's −6/+2 window, the count would have been 0 and the test would have failed.

### The fix

The test creates its own project and allocates **Bob Martinez** — seeded, and allocated by
no other spec — to it for the current week, through `properties.project_id`. It then
addresses each half of the split cell by its full accessible name, which carries the
project name, and asserts exactly one of each.

Beyond removing the shared-state dependency, this makes the test meaningful in the p.6
sense: it now asserts that a known allocation renders as two separately labelled halves,
rather than that some button somewhere on the page happens to mention a plan.

Tradeoff: three API writes in setup, costing about a second. That is the price of not
sharing fixture state with twenty other spec files.

---

## RCA 3 — `weekly-accountability:78`, which these fixes surfaced

Not in the baseline flake set. It appeared as flaky in the post-fix full suite, and it is a
consequence of this lane's own changes, so it is fixed here rather than reported.

### Cause — a person+week collision that failure-driven worker restarts were hiding

`POST /api/weekly-plans` keys uniqueness on **person + week only**; `project_id` is
accepted, stored, and explicitly ignored by the lookup (`api/src/routes/weekly-plans.ts`,
comment: *"uniqueness by person+week only"*). The test posted for Dev User in week 1 and
demanded `201`. `accountability-week.spec.ts:89` creates a weekly plan for exactly that
person and that week. On any worker where that spec ran first, this test got `200`.
Creating a fresh project — which the test already did — buys nothing, because the API does
not key on the project.

### Why it stayed invisible until now

**Playwright discards the worker process after any test failure**, and this suite's
database is worker-scoped, so every restart brings up a fresh seeded container. Unrelated
failures were therefore resetting the database and washing the collision away before it
could be observed. Distinct worker ids per run were always `failures + 1`:

| Run | Failures | Distinct workers |
|---|---:|---:|
| H-PRE | 3 | 4 |
| H-POST | 1 | 2 |
| PRE1 | 3 | 4 |
| POST1 | 2 | 3 |
| POST2 | 2 | 3 |

Fixing the my-week and heatmap flakes removed those resets, and the collision surfaced.

This is worth stating plainly because it cuts against a comfortable reading of the
headline number: **some of the apparent stability of the old suite was failures cleaning up
after each other.** It is the same root cause as the other three — a worker-scoped database
with no per-test reset, and specs that assume fixture state they do not own — observed from
the other side.

### The fix

Week 803, which no other spec claims, plus an assertion message naming the cause. See
configuration E above for the before/after.

---

## A sibling test with the same defect

`status-overview-heatmap.spec.ts:88` ("clicking plan cell navigates to weekly plan
document") is in `known-flakes.txt` at 1 of 3 and takes the identical fragile locator —
`getByRole('button', {name: /Weekly Plan/}).first()` against an allocation another spec can
destroy. Read together with `:69`, the heatmap cause fired in **3 of 3** baseline runs; it
simply landed on `:69` twice and `:88` once, depending on which specs shared the worker:

| Test | run1 | run2 | run3 |
|---|---|---|---|
| `status-overview-heatmap.spec.ts:69` | — | ✗ | ✗ |
| `status-overview-heatmap.spec.ts:88` | ✗ | — | — |

`:88` is **not fixed here** — it was outside the three this lane committed to, and changing
it after the measurement runs would have invalidated them. It is the obvious next
candidate, and the fix is the same shape: have the test own its allocation and address the
cell by accessible name rather than taking `.first()`.

---

## Product findings — reported, not fixed

`GET /api/team/accountability-grid-v3` is non-deterministic when a person has more than one
allocation sprint for the same week. `api/src/routes/team.ts:1719-1725` iterates the result
of a query with no `ORDER BY` and assigns unconditionally:

```ts
assignments[personId][sprintNumber] = { projectId: row.project_id, … }
```

Whichever row PostgreSQL returns last decides the person's project for that week, and a row
whose sprint carries no `properties.project_id` will blank the cell entirely. Two users
loading the Status Overview can see different grids from the same data.

Not fixed here — product source is outside this lane's boundary. A deterministic tie-break
(prefer a non-NULL project, then most recently updated) would settle it.

**Weekly-plan uniqueness ignores the project.** `POST /api/weekly-plans` accepts and
stores a `project_id` but keys uniqueness on person + week alone
(`api/src/routes/weekly-plans.ts`). Two projects therefore cannot each have a plan for one
person in one week, and a caller that passes a distinct project still gets someone else's
document back with a `200`. Either the project belongs in the key or it should not be
accepted. Not fixed — product source is outside this lane.

Two adjacent test-side observations, also left alone:

- `e2e/manager-reviews-visual.spec.ts:66` and `e2e/request-changes-ui.spec.ts:68` create
  allocation sprints with the project attached via `belongs_to` instead of
  `properties.project_id`. Those allocations are invisible to the three allocation-grid
  endpoints. The specs pass anyway, so they are asserting less than they appear to.
- `e2e/weekly-accountability.spec.ts:384` and `e2e/project-weeks.spec.ts:178` fail under the
  forced single-worker ordering used to reproduce these flakes. Both failed identically
  before this lane's changes. `project-weeks.spec.ts:178` is itself in the baseline flake
  set (1 of 3 runs) with the same shared-fixture shape.

---

## Before / after

All runs below were taken under the measurement lock unless marked otherwise, with the
pre-fix and post-fix halves back-to-back inside one lock window so both saw the same load.

**Rule 1 caveat, recorded rather than smoothed over.** The machine never went quiet.
`measure-lock.sh` gave up its quiet-wait and reported: *"WARNING: load still 9.11 after
180s — measuring anyway. Record this in the lane's CHANGES entry; the pair may not satisfy
Rule 1."* Five other lanes and Docker were active throughout. Taking each pair
back-to-back is what makes them usable despite that; absolute timings from these runs
should not be compared against anything measured on an idle machine.

### The runs

**Every number below is committed at `docs/audit/raw/lane5-flake-fix-evidence.txt`,
generated from the Playwright logs by `docs/audit/scripts/lane5-gen-evidence.sh`. The run
scripts are `docs/audit/scripts/lane5-*.sh`. Nothing here rests on recollection.**

**Configuration A — the two fixed specs alone, `PLAYWRIGHT_WORKERS=4`, x3, unlocked.**
This is the configuration p.6 asks for, and on its own it proves little here. Run against
the pre-fix commit at `--repeat-each=3` these two specs already passed 39 of 39; the flake
never reproduced in isolation because its cause was never inside these files.

| Run | Result |
|---|---|
| A1 | 13 passed (28.4s) |
| A2 | 13 passed (28.1s) |
| A3 | 13 passed (27.9s) |

Three clean runs show the fixes did not break the specs. They do not establish that the
flake is gone. The evidence that does is below.

**Configuration B — seven interfering specs, one worker, under the lock, back-to-back.**
Pre-fix = the two lane-5 specs checked out at `767aa2f`; post-fix = `HEAD`. Same lock
window, so both halves saw the same load.

| Run | Failed | Which |
|---|---|---|
| PRE1 | 3 | **`my-week-stale-data.spec.ts:28`**, `project-weeks:178`, `weekly-accountability:384` |
| POST1 | 2 | `project-weeks:178`, `weekly-accountability:384` |
| POST2 | 2 | `project-weeks:178`, `weekly-accountability:384` |

POST is a **strict subset** of PRE. The only test that changed state is mine. Of the two
survivors, `project-weeks:178` is in `known-flakes.txt` (1 of 3); `weekly-accountability:384`
is not, but it fails identically with this lane's changes reverted, so it is not
attributable here.

This pair demonstrates **one** of the three. In PRE1, `:63` and `:69` passed — see below
for why, and for what does evidence them.

**Configuration C — the falsification, six specs, `project-weeks.spec.ts` removed.**
The heatmap RCA says `:69` survives pre-fix only on a stray week-15 allocation that
`project-weeks.spec.ts` leaves behind. Prediction stated before the run, with a promise to
retract the RCA if it passed: remove that spec and the pre-fix heatmap test finds zero
Weekly Plan buttons and fails.

| Run | Failed | Which |
|---|---|---|
| H-PRE | 3 | `my-week:28`, **`status-overview-heatmap.spec.ts:69`**, `weekly-accountability:384` |
| H-POST | 1 | `weekly-accountability:78` (see below) |

The prediction held. `:69` red pre-fix, green post-fix, from a hypothesis committed in
advance rather than one fitted afterwards.

**Configuration D — full suite, post-fix, four workers, under the lock.**

| | Passed | Failed | Flaky |
|---|---:|---:|---:|
| baseline run1 (pre-fix, audit) | 864 | 0 | 5 |
| baseline run2 (pre-fix, audit) | 865 | 0 | 4 |
| baseline run3 (pre-fix, audit) | 862 | 0 | 7 |
| **after (post-fix)** | **866** | **0** | **3** |

All three targets absent:

| Test | Baseline | After |
|---|---|---|
| `my-week-stale-data.spec.ts:63` | failed 3 of 3 runs | **absent** |
| `my-week-stale-data.spec.ts:28` | failed 2 of 3 runs | **absent** |
| `status-overview-heatmap.spec.ts:69` | failed 2 of 3 runs | **absent** |

The three remaining flaky: `inline-comments:118` and `mentions:374` are both in
`known-flakes.txt` at 1 of 3. `weekly-accountability:78` is not — it was surfaced by these
fixes and is dealt with below.

Two caveats worth stating rather than burying. The baseline runs were taken on a different
day under different load, so this is a weaker pair than B, C and E, which were back-to-back
in one lock window. And a single green run of a flaky test proves little on its own; the
weight for `:63` comes from 3-of-3 red beforehand, at the only scale where its cause
operates.

**Configuration E — `weekly-accountability:78`, fix stashed then restored.**

| Run | Result |
|---|---|
| W78-PRE | 1 failed, 22 passed — `:78` (the 201-vs-200 test) **failed** |
| W78-POST | 1 failed, 22 passed — `:78` **passed**; `:410` failed instead |

`:410` is the same test as pre-fix `:384` (the fix adds 30 lines, shifting it by 26) — the
pre-existing single-worker-ordering artifact from configuration B. It surfaced through the
very mechanism this fix documents: in the "before" run the `:78` failure restarted the
worker and reset the database, incidentally letting `:410` pass.

---

## Developer documentation (Rule 8)

**What changed.** Three E2E spec files (four tests). No product source, no configuration, no dependencies.

- `e2e/my-week-stale-data.spec.ts` — both tests own a private week number and poll the
  my-week API for the real postcondition instead of waiting on the "Saved" label and
  sleeping.
- `e2e/status-overview-heatmap.spec.ts` — the split-cell test creates its own project and
  allocation and addresses both halves of the cell by accessible name.
- `e2e/weekly-accountability.spec.ts` — the 201-vs-200 test uses a week number no other
  spec claims.

**How to run it.**

```bash
PLAYWRIGHT_WORKERS=4 pnpm test:e2e
```

`PLAYWRIGHT_WORKERS=4` is required on macOS. `playwright.config.ts:38` sizes the pool from
`os.freemem()`, which counts cached pages as used on Darwin and clamps to one worker.

**How to test it.** The committed scripts reproduce every measurement in this document:

```bash
docs/audit/scripts/lane5-locked-pair.sh       # seven-file PRE/POST/POST, takes the lock
docs/audit/scripts/lane5-heatmap-and-full.sh  # six-file falsification, then the full suite
docs/audit/scripts/lane5-w78.sh               # the 201-vs-200 pair
docs/audit/scripts/lane5-gen-evidence.sh      # rebuilds the summaries from the logs
```

Each checks out the pre-fix specs at `767aa2f`, runs, restores `HEAD`, runs again, and
restores the worktree via a `trap` on any exit path. They assert a minimum pass count and
abort loudly if zero tests execute — a zero-test run once passed silently in this lane
because an unquoted shell variable holding a file list does not word-split in zsh. Written
in bash for that reason. Lane-0's `scripts/assert-tests-ran.sh` closes the same gap
generally, with a distinct exit code 2.

Quick check of just the fixed specs:

```bash
PLAYWRIGHT_WORKERS=4 npx playwright test \
  e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts --retries=0
```

Note that this configuration passes with or without the fixes — the flake was never inside
these files. Use the seven-file and six-file scripts to see the difference.

**How to roll it back.** Each fix is one commit touching one file:

```bash
git revert bfb1d13   # weekly-accountability 201-vs-200 test
git revert 3a76c6f   # my-week retro test
git revert 5c3d499   # my-week plan test
git revert 20d4a97   # heatmap split-cell test
```

Revert in that order (newest first); they touch three separate files and do not conflict.
Reverting restores the previous tests, including their flake. Nothing else depends on these
changes — no product source, configuration or dependency was touched. The evidence commit
`b45c8b8` is documentation only and can be left in place.
