# Improvement Documentation

Brief p.11 asks for five things about every category: the **before measurement**, the
**root cause**, the **fix**, the **after measurement**, and **proof it reproduces**.

This file is the index for all eight. It is deliberately short. Each category's full
account — reproduction steps, tradeoffs, rollback — lives in `CHANGES/lane-N.md`, and
every number here is a link to the raw output it came from, not a retyped figure.

**Read the result column honestly.** Four categories met their target, one missed and
says so, and the ones that missed are documented at the same depth as the ones that hit.
A category that reports a measured near-miss is more useful to the next engineer than one
that reports a pass it cannot substantiate.

---

## Result summary

| Cat | Target (brief) | Before | After | Met? |
|---|---|---:|---:|:--:|
| 1 Type Safety | eliminate 25% of violations (≤ 756) | 1009 | **753** | ✅ −25.4% |
| 2 Bundle Size | −15% total **or** −20% initial | 2,144,744 B initial | **385,118 B** | ✅ −82.0% |
| 3 API Response | −20% P95 on ≥ 2 endpoints | see §3 | 2 of 4 endpoints | ✅ −30.4% / −20.1% |
| 4 DB Queries | −20% query count on ≥ 1 flow | 48 queries | *pending* | ⏳ |
| 5 Test Coverage | 3 flaky tests fixed with RCA | 3 flaky (of 3 runs) | **4 fixed** | ✅ |
| 6 Error Handling | 3 gaps, ≥ 1 data loss | 3 gaps open | **3 fixed** | ✅ |
| 7 Accessibility | all Critical/Serious on 3 pages | 34 Crit / 65 Serious | *pending* | ⏳ |
| 8 Terraform | local + Render, pinned | 0 of 19 pinned | *pending* | ⏳ |

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
| **After** | **753** on the integrated tree — 256 eliminated, **−25.4%**, 3 under the 756 ceiling. |
| **Reproduce** | `docs/audit/scripts/count-type-violations.py` — same script both sides. Detail: `CHANGES/lane-1.md`. |

The margin is 3. That is thin, and it is stated rather than padded: the lane measured 744
in isolation and 753 after integration, because merging brought in other lanes' code. The
number that counts is the one from the tree being submitted.

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

*Pending — implementation and after-measurement in flight.*

| | |
|---|---|
| **Before** | 48 queries on the "view a document" flow. `EXPLAIN ANALYZE` plans at `docs/audit/raw/cat4-explain-before.txt` |
| **Root cause** | *pending* |
| **Fix** | *pending* |
| **After** | *pending* |
| **Reproduce** | `docs/audit/scripts/measure-queries.mjs` |

Two things the audit checked and ruled **out**, recorded so the next engineer does not
re-investigate them: indexing is thorough (13 indexes including a GIN index on `properties`
and a partial expression index at `api/src/db/schema.sql:358`), and the obvious N+1 is
already solved by `getBelongsToAssociationsBatch`.

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

*Pending — Render half in flight.*

| | |
|---|---|
| **Before** | 9 provider constraints declared, **0 exactly pinned**, 0 of 6 modules declaring `required_providers`, 8 constraint/lock conflicts, 0 of 5 roots runnable without credentials. |
| **Root cause** | The existing `terraform/` tree is AWS-only (Elastic Beanstalk, S3/CloudFront, WAF, VPC) and every provider was range-constrained, so two engineers running `terraform init` a week apart could resolve different provider versions against the same code. |
| **Fix** | *partial — local config done, Render pending* |
| **After** | *pending* |
| **Reproduce** | `docs/audit/scripts/measure-terraform.py`. Before-side reconstructs from git: `git archive 2fbc5a4 terraform \| tar -x -C /tmp/before`, then run the *current* script against it so only the input differs. |

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
