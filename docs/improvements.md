# Improvement Documentation

Brief p.11 asks for five things about every category: the **before measurement**, the
**root cause**, the **fix**, the **after measurement**, and **proof it reproduces**.

This file is the index for all eight. It is deliberately short. Each category's full
account — reproduction steps, tradeoffs, rollback — lives in `CHANGES/lane-N.md`, and
every number here is a link to the raw output it came from, not a retyped figure.

**Read the result column honestly.** The categories that missed are documented at the same
depth as the ones that hit, and where a target is met with a qualification the
qualification is in the summary rather than buried. A measured near-miss reported plainly
is more useful to the next engineer than a pass that cannot be substantiated.

---

## Result summary

| Cat | Target (brief) | Before | After | Met? |
|---|---|---:|---:|:--:|
| 1 Type Safety | eliminate 25% of violations (≤ 756) | 1009 | **741** | ✅ −26.6% |
| 2 Bundle Size | −15% total **or** −20% initial | 2,144,744 B initial | **385,118 B** | ✅ −82.0% |
| 3 API Response | −20% P95 on ≥ 2 endpoints | see §3 | 2 of 4 endpoints | ✅ −30.4% / −20.1% |
| 4 DB Queries | −20% query count on ≥ 1 flow | 50 queries | **37** | ✅ −26.0% |
| 5 Test Coverage | 3 flaky tests fixed with RCA | 3 flaky (of 3 runs) | **4 fixed** | ✅ |
| 6 Error Handling | 3 gaps, ≥ 1 data loss | 3 gaps open | **3 fixed** | ✅ |
| 7 Accessibility | all Critical/Serious on 3 pages | 69 Crit+Serious nodes | **10** | ✅ −85.5% |
| 8 Terraform | local + Render, pinned | 0 of 9 pinned | **20 of 20** | ✅ |

Baseline for every "before" is the frozen commit `2fbc5a4`, not `main`. Freezing it
mattered: several lanes ran for hours in parallel worktrees, and a moving baseline would
have made the pairs incomparable.

---

## 1. Type Safety

| | |
|---|---|
| **Before** | 1009 violations — 258 `any`, 429 `as`, 321 `!`, 1 `@ts-ignore`. `docs/audit/raw/phase2-baseline.md` |
| **Root cause** | Every authenticated route handler reached for caller identity with a non-null assertion (`req.userId!`). One middleware guarantee, asserted 233 separate times, none of them checked. `strict: true` was already on, so no config flip was available — the count had to come out of real code. Separately, `web/tsconfig.json` does not extend the root config and so silently misses `noUncheckedIndexedAccess`. |
| **Fix** | Replaced the assertion with checked narrowing at the middleware boundary, so the guarantee is proved once and carried in the type. Three scoped units: `AuthenticatedRequest` across `api/src` (`f3f8513`), `ProjectDetailsTab.tsx` (`68936b3`), `extractHypothesis.ts` (`e118d70`). |
| **After** | **741** on the integrated tree — 268 eliminated, **−26.6%**, 15 under the 756 ceiling. |
| **Reproduce** | `docs/audit/scripts/count-type-violations.py` — same script both sides. Detail: `CHANGES/lane-1.md`. |

**This target was met, then lost, then met again, and the middle step is the useful part.**
The lane measured 744 in isolation and 753 after the first integration — a margin of 3.
Merging Category 4 then took it to **758, over the ceiling**, because that lane's new test
mocks added 17 `as any`. −25.4% had quietly become −24.9%, and nothing in the gate would
have caught it: type-check, lint, build and 553 unit tests were all green at 758.

Fixed by `api/src/test/queryResult.ts` (`bb90d91`), which supplies the full `pg`
`QueryResult` shape and infers the row type from the literal at each call site, so a typo
in a mocked column name is now a compile error. That removed the 17 casts by making the
honest version easy to write, rather than by editing a count.

Two things follow from this that are worth carrying forward. A category whose target is a
whole-repo aggregate is not owned by the lane that improves it — **any** lane can break it,
and only the integrated tree's number counts. And a thin margin on such a target is not a
near-miss, it is an unowned liability.

12 `as any` remain in `auth.test.ts`, on request and response fixtures rather than query
results. They need a different treatment and were left rather than swept, so the count
reflects work actually done.

---

## 2. Bundle Size

| | |
|---|---|
| **Before** | Initial load **2,144,744 B** (599,789 B gzipped) in a single 2,073,684 B entry chunk. `docs/audit/raw/cat2-before-initial-load.txt` |
| **Root cause** | `web/vite.config.ts` had no `build` block at all — no `manualChunks`, no lazy boundaries. TipTap, Yjs, USWDS and `emoji-picker-react` all landed in the entry chunk and were downloaded before first paint whether or not the user opened an editor. |
| **Fix** | Route-level `React.lazy` boundaries plus explicit vendor chunking. Nothing was deleted — Target A explicitly does not count feature removal, and every feature is exercised in the browser verification. |
| **After** | Initial load **385,118 B** — **−82.0%**, against a −20% bar. Entry chunk −96.8%. Total dist rose 1.0%, which is expected and correct. |
| **Reproduce** | `docs/audit/scripts/measure-bundle.py` (total) and `measure-initial-load.py` (initial). Before-side committed in `ecc2b15` *prior to any source change*, so the pair reconstructs from git history alone. |

**Why two scripts.** Code splitting does not delete bytes, it moves them off the critical
path. Measuring Target B with a total-size tool reports ~0% for a change that cuts first
load by five sixths. `measure-initial-load.py` reads the initial-load set off the built
`dist/index.html` the way a browser resolves it, so there is no hand-maintained list to
drift. Detail: `CHANGES/lane-2.md`.

---

## 3. API Response Time

| | |
|---|---|
| **Before** | Paired against pre-Lane-3 code at `767aa2f`: `/api/team/grid` P95 21.41 ms · `/api/auth/me` 16.58 ms · `/api/projects` 14.38 ms · `/api/documents` 23.28 ms |
| **Root cause** | Documented per endpoint in `CHANGES/lane-3.md`, and the bottleneck was not where the audit first guessed. Response payload size, not SQL, dominates the two endpoints that did not clear the bar — see `docs/audit/raw/cat3-bottleneck-analysis.md`. |
| **Fix** | Four handler rewrites: `GET /api/documents`, `/api/projects`, `/api/team/grid`, `/api/auth/me`. |
| **After** | `/api/team/grid` **14.90 ms (−30.4%)** and `/api/auth/me` **13.24 ms (−20.1%)** clear the p.5 bar. `/api/projects` −8.6% and `/api/documents` −2.6% do not. |
| **Reproduce** | `docs/audit/scripts/bench-api-paired.sh`, raw at `docs/audit/raw/cat3-lane3-paired.json`. ~2160 samples per side per endpoint, 0% failures. |

**The measurement method is the substantive part of this category.** The mandated
sequential `bench-api.sh` pair could not resolve a 20% effect on this machine. Its own
built-in control proves it: `/api/auth/me` was byte-identical on both sides of the first
pair and still moved **+27.3%** at one concurrency level. An endpoint whose code did not
change appeared to get 27% slower. That is the noise floor, and it is wider than the effect
p.5 asks us to detect.

So the reported numbers come from `bench-api-paired.sh`, which runs both builds
simultaneously on `:3103` and `:3104` against one database with k6 alternating between
them. That is not a weaker substitute for Rule 1's "identical conditions" — it is a
stricter reading. Two sequential runs are taken under *similar* conditions; two concurrent
runs are taken under *the same* conditions, request for request.

---

## 4. Database Query Efficiency

| | |
|---|---|
| **Before** | 50 queries on the "view a document" flow. Plans at `docs/audit/raw/cat4-explain-before.txt`, counts at `cat4-lane4-before.json` |
| **Root cause** | `UPDATE sessions SET last_activity` ran unconditionally in two places — every authenticated HTTP request (`middleware/auth.ts`) and every WebSocket handshake (`collaboration/index.ts`, and a document view opens two sockets). **13 of the 50 queries were that one statement**, more occurrences than anything else in the flow. Every read request was therefore also a write: row lock, heap update, WAL record, eventual vacuum — to move a timestamp a few milliseconds. It also serialised one user's concurrent requests behind a single row lock, and a document view fires many at once. |
| **Fix** | `api/src/db/sessions.ts` (new) owns the rule. The write happens only once the stored value is already stale by more than 60 s — a timeout measured in minutes does not need a millisecond-accurate timestamp. Commits `ddaa019` (HTTP), `9933a8b` (WebSocket), `bf37a54` (regression tests). |
| **After** | **50 → 37 queries, −26.0%.** Zero `last_activity` writes remain on any flow. Every other flow improved too: main page −25.0%, issues −30.4%, sprint board −28.6%, search −31.3%. |
| **Reproduce** | `docs/audit/scripts/run-cat4-paired.sh` — takes the lock, runs the before half against `c398a9c`'s `api/src`, renews, restores HEAD, runs the after half, releases on exit. Both halves in one window against one database state. |

**The plan was never the problem, which is the point.** `EXPLAIN ANALYZE` on the offending
statement shows a primary-key index scan, 0.14 ms, five buffers. Nothing is wrong with it.
The waste was frequency: a cheap write running 13 times to accomplish what one write
accomplishes. A category measured in query *count* rather than query *time* is what
surfaces that — optimising the statement would have achieved nothing.

**The tradeoff, stated in the direction that matters.** The stored timestamp can now lag by
up to 60 s, so a session can expire **early by at most 59 s, never late**. Early is the safe
direction for an idle timeout; late would be a security regression. 60 s was not picked
freely — the sliding-cookie refresh five lines below already used that exact threshold, so
the two halves of one window now share a constant instead of drifting apart. A test asserts
the interval stays ≤ 1/10 of `SESSION_TIMEOUT_MS`.

**Two things the audit ruled out**, recorded so the next engineer does not re-investigate:
indexing is thorough (13 indexes including a GIN index on `properties` and a partial
expression index at `api/src/db/schema.sql:358`), and the obvious N+1 is already solved by
`getBelongsToAssociationsBatch`.

**A measurement caveat, and it cuts against the headline.** The frozen baseline recorded 48
queries for this flow; the paired before-half measured **50**, because the baseline was
taken against `ship_dev` and the pair runs against `ship_lane_4`. The before-half was run
twice and returned 32/50/23/14/16 both times, so the pair is internally consistent — which
is what Rule 1 asks for. The −26.0% is computed against the 50 that was measured, not the
48 that would have flattered it.

---

## 5. Test Coverage and Quality

| | |
|---|---|
| **Before** | Flake frequencies across three full `PLAYWRIGHT_WORKERS=4 pnpm test:e2e` runs, recorded at `docs/audit/raw/known-flakes.txt` |
| **Root cause** | **One cause behind all of them, and it is not a race inside any test.** Every flake was a dependency on state another spec file owns — a worker-scoped database, seeded once, shared by every spec on that worker, never reset between tests. Run in isolation with `--repeat-each=3`, the specs passed 39 of 39. |
| **Fix** | Four tests fixed: `my-week-stale-data:28`, `:63`, `status-overview-heatmap:69`, and `weekly-accountability:78` — the fourth surfaced *by* the first three. |
| **After** | Evidence at `docs/audit/raw/lane5-flake-fix-evidence.txt`, generated from the Playwright logs by `docs/audit/scripts/lane5-gen-evidence.sh`. |
| **Reproduce** | `docs/audit/scripts/lane5-*.sh`; gate at `docs/audit/raw/lane5-verification-gate.txt`. |

**The evidence is not uniform and is labelled that way.** Two of the three have a
controlled red→green flip taken back-to-back inside one measurement-lock window. `:63` does
not — its dominant cause is a per-IP WebSocket connection budget that a 49-test run cannot
exhaust, so it passes pre-fix in every small configuration. Its evidence is 3-of-3 red
across the baseline runs, absence post-fix, and a probe reproducing the mechanism. That is
weaker, and it is presented as weaker.

Also recorded, because it changes how the baseline file should be read: `known-flakes.txt`
counts are **per test** and therefore **undercount a shared cause**. `heatmap:69` and `:88`
are siblings; the cause fired 3 of 3 even though neither test shows 3.

---

## 6. Runtime Error and Edge Case Handling

| | |
|---|---|
| **Before** | W6-9: both users' edits survived **0 of 5** concurrent-title-edit runs. W6-1: **6 of 6** top-level routes went blank on a thrown render, 0 recovery paths. W6-5: sync badge read "Cached" while nothing was saving. |
| **Root cause** | W6-9 — the title travelled on a debounced REST `PATCH` carrying the whole field, so last-write-wins destroyed the other user's keystrokes. W6-1 — no error boundary existed above the route tree. W6-5 — badge state was derived from cache freshness, not socket liveness. |
| **Fix** | W6-9 (`fe41fa1`): title moved into the Yjs CRDT as a `Y.Text` in the same Y.Doc as the body, diffed per keystroke. W6-1 (`6f45133`): boundaries on all six routes. W6-5 (`8e7af24`): badge reads socket state. Plus Rule 7 retries/timeouts/circuit breakers across three surfaces (`6ee1638`). |
| **After** | W6-9 **5 of 5**. W6-1 **0** blank, **6** recovery paths. W6-5 badge reads "Offline". |
| **Reproduce** | `docs/audit/scripts/measure-concurrent-edit.mjs`, `measure-runtime-errors.mjs`. Detail: `CHANGES/lane-6.md`. |

**The data-loss fix moved a durability window, and that tradeoff is not hidden.** Closing a
tab is safe — measured 33 ms flush. The residual exposure is an API process crash during
continuous typing: `schedulePersist` measured 2,026 ms while idle but 13,862 ms under
sustained typing, because each keystroke re-arms the debounce. Capping it with a `maxWait`
is an open decision, quantified in `CHANGES/lane-6b.md`.

W6-9 also turned 10 E2E tests red, which is documented separately in `CHANGES/lane-6b.md`
rather than quietly repaired. **They were not a product regression** — the title still
persisted; the tests were asserting on the *transport* that used to carry it, via a
`waitForResponse` on a `PATCH` the new design intentionally no longer sends. The 14×
runtime drop after the fix (15.5m → 1.3m) is the tell: those were timeouts, not assertion
failures.

---

## 7. Accessibility

| | |
|---|---|
| **Before** | **15 Critical / 54 Serious** nodes across 18 routes. `docs/audit/raw/cat7-phase2-before.json` |
| **Root cause** | Five distinct causes, not one. (a) `accent` was `#005ea2`, the USWDS logo blue designed for *white* backgrounds, used as text on `#0d0d0d` — 2.55–2.89:1 across 78 class names, while the comment above the token asserted "All colors meet WCAG 2.1 AA". (b) 22 opacity-modified text utilities silently re-broke `muted`. (c) 284 of 286 inline SVGs were exposed to assistive tech with an empty name. (d) `role="tree"` children that were not `treeitem`s. (e) `aria-controls` on every tab pointing at ids that occur zero times in `web/src`. |
| **Fix** | Six scoped commits: names for unlabeled *and* duplicate-labeled controls (`1be2b06`), the 284-SVG `aria-hidden` sweep (`ef29e8b`), tree roles (`ee7ce88`), dangling `aria-controls` removed (`dc2f490`), the contrast token split (`9bc3339`), source-level regression invariants (`3f3f3bd`). |
| **After** | **1 Critical / 9 Serious** — **69 → 10 nodes, −85.5%**. 16 of 18 routes clean. `docs/audit/raw/cat7-phase2-after.json` |
| **Reproduce** | `docs/audit/scripts/measure-a11y.py`, both sides, under `scripts/measure-lock.sh`. Detail: `CHANGES/lane-7.md`. |

**Target B is the claim: `/settings`, `/admin`, and the issue document editor.** Each had
Critical or Serious violations before and has none now — naming pages that were already
clean would prove nothing. `/settings` alone carried 10 Criticals, every one an unnamed
member-role `<select>`.

**The before-number here is 69, not the audit's 99.** The audit scan was taken on a
different day at a different seed volume — 61 of its contrast nodes are 54 at the frozen
Phase 2 volume, because some failing elements only render with enough data behind them.
Rule 1 asks for identical conditions, so the pair is this lane's own before-scan against
its own after-scan. The audit figure is right for describing the codebase as found and
wrong as a denominator for this change.

**Why the claim is made on axe and not on a Lighthouse score.** p.7 accepts either, and
Target A is in fact also met — `/admin`, the lowest-scoring page, went **88 → 100**. But
Lighthouse cannot demonstrate this work here: it snapshots the DOM before react-query
resolves. At baseline `/settings` scored **100** with 10 Criticals open; after the fixes
the weekly-plan document scores **100 on both form factors** while still carrying one. A
Lighthouse before/after would show a fix that did not happen and miss one that did.

**Two violations remain, reported rather than dropped.** `/my-week` has 9 contrast nodes
that are ours — `MyWeekPage.tsx:339` puts `opacity-40` on a *container*, compositing a
compliant `#9e9e9e` down to 2.09:1, which the text-level opacity sweep could not see. The
weekly-plan Critical is TipTap's own `EditorContent` emitting `aria-expanded` on a roleless
div.

**The highest-value finding in this category came from a human, not a scanner.** The
284-SVG defect is invisible to axe, which checks that the *button* has a name — and it
does. The child does not. Real VoiceOver with mouse-following on announced the delete
control as, in full, `image`.

---

## 8. Terraform

| | |
|---|---|
| **Before** | 9 provider constraints declared, **0 exactly pinned**, 0 of 6 modules declaring `required_providers`, 8 constraint/lock conflicts, 0 of 5 roots with obtainable plan output. |
| **Root cause** | The existing `terraform/` tree is AWS-only (Elastic Beanstalk, S3/CloudFront, WAF, VPC) and every provider was range-constrained, so two engineers running `terraform init` a week apart could resolve different provider versions from identical code. Separately, deployment was 15 manual steps across `scripts/deploy.sh` (220 lines) and `scripts/deploy-frontend.sh` (72 lines). |
| **Fix** | `terraform/local-config/` on `hashicorp/local` (4 resources); `terraform/render/` on `render-oss/render` 1.9.1 declaring `render_web_service.shipshape` + `render_postgres.ship`; exact pins across every root and module; a saved plan leaking account identifiers untracked (`8bbfbcf`). |
| **After** | **20 constraints, 20 exactly pinned. 6 of 6 modules declare `required_providers`. 0 conflicts. 2 of 7 roots produce plan output with no AWS credentials.** Tracked saved plans 1 → 0. |
| **Reproduce** | `docs/audit/scripts/measure-terraform.py`. Before-side reconstructs from git: `git archive 2fbc5a4 terraform \| tar -x -C /tmp/before`, then run the *current* script against it so only the input differs. |

**8.5 is claimed with a qualification, not unqualified.** `git archive HEAD` into an empty
directory, then `init` + `plan` under `env -i` carrying only `PATH`, `HOME` and two
`TF_VAR_` values, honoured the lock file and planned `2 to add, 0 to change, 0 to destroy`
against the live API. But **no `terraform apply` was run** — creating billable
infrastructure was not authorised — and because the fork's repository is private, Render
needs a GitHub OAuth consent that Terraform cannot create. The honest phrasing is "one
credential and one prior consent", not literally "only `terraform apply`".

**The blast-radius work found a real bug, which is the point of doing it.** The first draft
set `database_name = "ship"`. Render disambiguates names on create (`ship_<suffix>`), so
that attribute forces replacement: planning the config against the already-live deployment
reported **`1 to destroy` on the production database**. A `prevent_destroy` lifecycle block
stopped it. Fixed by leaving both name attributes unmanaged. An annotated plan that never
plans against real state would not have caught this.

**Three numbers in the lane's own first table were wrong and were corrected on
re-measurement**, rather than carried forward: 19 → 20 pinned (the Render provider adds
one), stale "of 6" denominators where there are now 7 roots, and a lock-file count that the
script mismeasured because `git ls-files` returns nothing inside the extracted `/tmp/before`
tree — measured with `git ls-tree` on both sides it is 7 → 3.

Still open and stated as such: no end-to-end apply; the OAuth consent step; and W8-10 (Yjs
state held in module-level `Map`s), which is mitigated by pinning `num_instances = 1`
behind a `validation` block so the config cannot be scaled into the bug by accident. That
is application work, not Terraform work.

---

## A note on measuring under load

Ten improvement lanes ran concurrently in separate worktrees on one machine. A benchmark
taken while five other agents are compiling measures the load, not the change, so
`scripts/measure-lock.sh` serialises every measurement across worktrees using an atomic
`mkdir`.

It has a limit worth stating: **it cannot suspend the other agents**, only stop them from
measuring at the same time. Where load was still above the quiet threshold at measurement
time, the lane's own `CHANGES` entry records it rather than dropping it. Category 3's
numbers exist in the form they do specifically because of this.
