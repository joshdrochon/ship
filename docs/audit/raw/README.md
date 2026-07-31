# Raw measurement data

Tool output behind every number in [`../audit-report.md`](../audit-report.md) and in the
Phase 2 lane write-ups under [`../../../CHANGES/`](../../../CHANGES/), kept because p.10 asks
the audit report to *"Include methodology, tools used, and raw data."*

Methodology and tools live in the report and in [`../scripts/`](../scripts/). This directory
is the third thing — what the tools actually emitted.

Every file here was produced by a script in `../scripts/`, or by a `pnpm` command named in
its row, so each number is re-derivable rather than taken on trust. Everything in the
directory is listed below; if a file is here it has a row.

---

## Phase 1 — the audit measurements

| File | Category | Produced by | Contains |
|---|---|---|---|
| `cat3-results.json` | 3 API Response Time | `scripts/bench-api.sh` | k6 output — P50/P95/P99/max, request counts and failure rate for 5 endpoints × 10/25/50 VUs (15 runs) |
| `cat4-raw.json` | 4 Query Efficiency | `scripts/measure-queries.mjs` | Per-flow query counts, slowest statement, and repeated-shape clusters for the 5 user flows p.5 names |
| `cat6-raw.json` | 6 Runtime Errors | `scripts/measure-runtime-errors.mjs` | Console/network entries over 11 routes, malformed-input results, offline/reconnect cycle, 3G throttle timings. 45 console entries; `console_delta` 17 across the offline cycle |
| `cat6-concurrent-raw.json` | 6 Runtime Errors | `scripts/measure-concurrent-edit.mjs` | **Nine two-user concurrent-edit runs**, each driving two authenticated browser contexts (`dev@ship.local`, `alice.chen@ship.local`) against one document, title and body separately. Conditions: three fresh, three no-debounce, two websocket-only, one immediately after an API restart. This is the file W6-9 was found in |
| `cat7-keys.json` | 7 Accessibility | `scripts/measure-keyboard.mjs` | Arrow-key focus movement per composite widget, Enter/Space activation, focus-visibility sampling |
| `cat7-tree.json` | 7 Accessibility | `scripts/measure-a11y-tree.mjs` | Accessibility tree for 7 pages, signed in — interactive node counts, unnamed nodes by role, headings, landmarks |
| `cat7-tree-2.json` | 7 Accessibility | same script, second run | Reproducibility check. Byte-identical to `cat7-tree.json` |
| `cat7-traversal-map.json` | 7 Accessibility | `scripts/map-a11y-traversal.mjs` | 4 pages (login, docs home, document editor, workspace settings): total nodes, expected VoiceOver cursor stops, the predicted stop-by-stop order, and unnamed stops by role. Written *before* the screen-reader passes so each run had a prediction to be checked against |
| `cat7-virtual-sr.json` | 7 Accessibility | `scripts/measure-virtual-screenreader.mjs` | `@guidepup/virtual-screen-reader` driven over the real app in Chromium, 5 pages, signed in. Per page: announcement counts, distinct announcements, controls announced with a usable name, controls left at a bare role, indistinguishable groups. Totals: **914 controls announced, 0 at a bare role, 388 indistinguishable from another control**. The file states its own caveat — it is a simulator, so it establishes that controls are announced, not that the speech is comprehensible |
| `cat7-voiceover.json` | 7 Accessibility | `scripts/measure-voiceover.mjs` | **Real VoiceOver on macOS 14.6.1, driven by AppleScript against Safari** — not the simulator and not a tree dump. 140 steps per page; per page: steps taken, phrases spoken, silent steps, distinct phrases, cursor stalls with the stalling phrase, repeated phrases, and whether the cursor escaped the browser. **Read the `/login` page only.** The script cannot sign Safari in, so the pages labelled authenticated walked `/login` again — caught because five pages returned identical numbers. The limitation is written up at the end of `../voiceover-protocol.md`, which is the manual pass covering the rest |
| `viz-data.json` | 2 Bundle Size | `vite-bundle-visualizer` | Per-module `renderedLength` / `gzipLength`, the source for the dependency attribution table |
| `../bundle-treemap.html` | 2 Bundle Size | `vite-bundle-visualizer` | Interactive treemap (p.3 asks for one) |
| `bundle-build-output.txt` | 2 Bundle Size | `pnpm build:web` | Vite chunk listing with raw and gzip sizes, including its own >500 kB chunk warning |
| `coverage-api.txt` | 5 Test Coverage | `pnpm --filter @ship/api test:coverage` | v8 coverage report, per-file and per-directory |
| `coverage-web.txt` | 5 Test Coverage | `vitest run --coverage --coverage.reportOnFailure` | v8 coverage report. `reportOnFailure` is required — 13 web tests fail and vitest suppresses the table otherwise |

### The E2E flake baseline

| File | Category | Produced by | Contains |
|---|---|---|---|
| `e2e-run1-summary.txt` | 5 Test Coverage | `scripts/measure-tests.py --e2e-runs 3` (`PLAYWRIGHT_WORKERS=4`) | Run 1 of 3. **5 flaky, 864 passed** (9.6m), with each flaky test named at `spec:line` |
| `e2e-run2-summary.txt` | 5 Test Coverage | same run set | Run 2 of 3. **4 flaky, 865 passed** (10.0m) |
| `e2e-run3-summary.txt` | 5 Test Coverage | same run set | Run 3 of 3. **7 flaky, 862 passed** (9.8m) |
| `known-flakes.txt` | 5 Test Coverage | `scripts/lane5-gen-evidence.sh`, aggregating the three files above | The 12 distinct tests that flaked, with the number of the three runs each flaked in |

These three files are the whole basis of Category 5's flake claim, so the arithmetic is worth
stating: 869 tests × 3 runs = 2,607 executions, 16 of them flaky — **0.61%**, spread over 12
distinct specs. Only one (`my-week-stale-data.spec.ts:63`) flaked in all three runs; two flaked
in two; the remaining nine flaked once each.

That distribution is why three runs were taken rather than one, and why Lane 5's fix is
argued from controlled pairs (`lane5-flake-fix-evidence.txt`) rather than from a green run.
A test that flakes one run in three is silent in a single pass two thirds of the time, so one
clean run neither proves a fix nor, on its own, identifies a flake worth fixing.

---

## Phase 2 — before/after pairs

Implementation Rule 1 (p.8) requires both sides of every claim to be measured under identical
conditions. `phase2-baseline.md` fixes what "before" means; the paired files below are the two
sides.

| File | Lane / Category | Produced by | Contains |
|---|---|---|---|
| `cat1-density-ranking-unfiltered.txt` | 1 Type Safety | `scripts/count-type-violations.py --by-file` | Both rankings of the most violation-dense files, at baseline `767aa2f` and at HEAD. Exists because the report's Top-5 density table applied a production-only filter it never declared, which removed three test files that are genuinely denser than anything in production. All three ranking rules are stated in the file, including the undeclared one, and it records one report number that did not reproduce (`UnifiedEditor.tsx` 498 LOC vs 502 measured; the ranking does not move) |
| `cat1-w1-4-web-strict-flags.txt` | 1 Type Safety | `tsc` under a temporary config outside the tree, method written out in the file | Quantifies W1-4 — `web/tsconfig.json` declares its options from scratch instead of extending the root, silently dropping `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`. Shipped config: **0 errors** at both commits. With the three root flags applied: **102 at baseline, 111 at HEAD**, broken down by error code. `web/tsconfig.json` is byte-identical between the two, verified by `diff`, and both counts are verified two ways. The point of the pair: the headline violation count fell 1,009 → 741 while the hidden compiler-error count rose — different surfaces, one a source-text grep and one errors no committed config ever asks for |
| `phase2-baseline.md` | all | — | The frozen before-state: commit `24bf639`, hardware, Node/pnpm/PostgreSQL versions, seed volume, and the per-lane starting numbers. Also records the known baseline gap — the seed was below p.4's floor on documents and users until `scripts/augment-seed.mjs` was run |
| `cat2-before-bundle.json`, `cat2-before-bundle.txt`, `cat2-after-bundle.json`, `cat2-after-bundle.txt` | 2 Bundle Size | `scripts/measure-bundle.py` (`--json` for the JSON) | Whole-`dist` size, per-extension breakdown, gzipped JS+CSS, largest chunk and its share of all JS. Largest chunk **2,073,684 B (92.1% of all JS) → 476,475 B**; chunk count 261 → 312 |
| `cat2-before-initial-load.json`, `cat2-before-initial-load.txt`, `cat2-after-initial-load.json`, `cat2-after-initial-load.txt` | 2 Bundle Size | `scripts/measure-initial-load.py` | What the browser must fetch before first paint, resolved off the built `index.html` exactly as a browser would. **2,144,744 B across 1 JS file → 385,118 B across 4** (gzip 599,789 → 114,910); deferred JS 176,747 B → 1,968,775 B. The separate measurement exists because code splitting does not move the whole-`dist` number at all |
| `cat3-lane3-before.json` / `cat3-lane3-after.json` | 3 API Response Time | `scripts/bench-api.sh` (RATE=12) | Lane 3's own before/after pair, both runs taken back to back under `scripts/measure-lock.sh` on one machine at 600 docs / 170 issues / 25 users / 35 sprints |
| `cat3-lane3-saturation-before.json` / `cat3-lane3-saturation-after.json` | 3 API Response Time | `scripts/bench-api-saturation.sh` (RATE=150) | The same pair with the rate limiter lifted (`API_RATE_LIMIT_MAX`) and arrival rate past the point where requests overlap, so 10/25/50 VUs are a real variable rather than a flat line (W3-3) |
| `cat3-lane3-paired.json`, `cat3-lane3-paired-2.json` | 3 API Response Time | `scripts/bench-api-paired.sh` | Old and new code run **simultaneously** on two ports against one database, so background load lands on both sides in the same instant. `-paired.json` at 24 req/s over 4 endpoints; `-paired-2.json` a follow-up at 48 req/s on the two that had moved (`/api/team/grid`, `/api/auth/me`) |
| `cat3-concurrency-paired.json` | 3 API Response Time | `scripts/bench-api-concurrency.sh` | The reading of p.4 that cannot be argued with: a **closed** loop (`constant-vus`), so "10 / 25 / 50 simultaneous connections" is literally true rather than inferred from rate × latency, with old and new code again running concurrently on two ports against one database. One record per endpoint × connection level: before and after P50/P95/P99/max, sample counts, failure counts, and the P50/P95/P99 deltas. Both sides run with `API_RATE_LIMIT_MAX` lifted — at 50 VUs a limiter turns the run into a 429 benchmark — lifted identically, so it is not a variable |
| `cat3-bottleneck-analysis.md` | 3 API Response Time | written from the files above | Where the time actually goes, and two corrections: the first pass compared the three VU levels as if they were replicates (they are not), and the prepared-statement regression hypothesis was tested directly and found wrong. Records that three of five endpoints regressed at every concurrency level |
| `cat4-lane4-before.json` / `cat4-lane4-after.json` | 4 Query Efficiency | `scripts/run-cat4-paired.sh` (wrapping `measure-queries.mjs`) | Per-flow query counts, distinct shapes, slowest statement and repeated-shape clusters, both sides in one lock window |
| `cat4-explain-before.txt` / `cat4-explain-after.txt` | 4 Query Efficiency | `scripts/run-cat4-paired.sh` (wrapping `scripts/explain-cat4.sh`, `PG_DB=ship_lane_4`) | `EXPLAIN (ANALYZE, BUFFERS)` for each hot statement, against a 600-document database, with the database name, workspace and user ids in the header so the plans can be reproduced |
| `cat6-before-lane6.json` / `cat6-after-lane6.json` | 6 Runtime Errors | `scripts/measure-runtime-errors.mjs` | The audit's own harness re-run either side of Lane 6, same 11 routes. **40 console entries → 4**; offline-cycle `console_delta` 11 → 3. `ui_recovered_after_reconnect` is `false` on both sides — see `CHANGES/lane-6.md`, which shows the probe itself is wrong |
| `cat6-w6-9-before.json` / `cat6-w6-9-after.json` | 6 Runtime Errors | `scripts/measure-concurrent-edit-suite.mjs` | Five scripted two-user concurrent title edits per side. **Both edits survived 0 of 5 runs before, 5 of 5 after**; one edit destroyed 5 of 5 → 0 of 5; clients converged 5 of 5 on both sides. Per run: what each user typed, what the server ended up with, characters gained per user, and whether any conflict indicator appeared (never) |
| `cat6-w6-9-after-lane6b.json` | 6 Runtime Errors | same script, re-run after Lane 6b | Confirms the W6-9 result survived Lane 6b's durability change: 5 of 5 both-survived, 5 of 5 converged |
| `cat6-title-durability.json` | 6 Runtime Errors | `scripts/measure-title-durability.mjs` | Lane 6b. How long a title edit lives only in the collaboration server's memory: idle flush 2,026 ms; through 12 s of continuous typing the column stayed stale for the entire session, flushing 1,862 ms after the last keystroke — a 13,862 ms exposure window. Tab close is covered by an immediate flush (durable 33 ms after close) |
| `cat7-phase2-before.json`, `cat7-phase2-before.txt`, `cat7-phase2-after.json`, `cat7-phase2-after.txt` | 7 Accessibility | `scripts/measure-a11y.py` (driver `scripts/a11y-scan.mjs`) | axe-core over 18 routes scored against the WCAG 2.1 A/AA + Section 508 tag set, plus keyboard traversal. Critical+Serious nodes **69 → 10**; routes with zero Critical/Serious 10 of 18 → 16 of 18. The `.txt` is the same run rendered as tables; the `.json` is the machine-readable form the numbers come from |
| `cat7-phase2-before-lighthouse.json` / `cat7-phase2-after-lighthouse.json` | 7 Accessibility | `scripts/measure-a11y.py` (Lighthouse 13 via `npx`, desktop + mobile) | Lighthouse accessibility score and failed audits for 17 routes × desktop and mobile, both sides (17 not 18 — the auto-opening modal is not a URL). Reported for completeness and **not** used as the before/after claim, and the pair is the evidence for why: `/settings` scores 100 at baseline while carrying 10 open Critical violations, and the weekly plan document scores 100 desktop and mobile after the fixes while still carrying an open Critical. A Lighthouse-based claim would have shown a fix that did not happen and missed one that did |
| `cat7-f16-after.json`, `cat7-f16-after.txt`, `cat7-f16-after-lighthouse.json` | 7 Accessibility | `scripts/measure-a11y.py` (driver `scripts/a11y-scan.mjs`) | F16 closeout, third scan in the same series and directly comparable to the `cat7-phase2-*` pair — same 18 routes, same database, same discovered document ids. Critical+Serious nodes **10 → 0**; routes with zero Critical/Serious 16 of 18 → **18 of 18**, `/my-week` and the weekly plan document being the two that closed. The `.txt` keeps its own `[measure-lock]` header, which records that `wait-quiet` timed out at load 15.9 — stated because it is a real difference in conditions from the earlier pair |
| `cat7-f16-myweek-composited.json` | 7 Accessibility | `scripts/verify-myweek-contrast.mjs` | Corroboration for F16 that does not depend on the calendar. Reads computed style off the live `/my-week`: for every label in every future-day row, the product of ancestor `opacity` and the colour actually painted. **1.0 and 7.25:1 after, against 0.4 and 2.09:1 before.** Exists because the axe node count on that page is a function of how many future days the current date leaves — five on a Monday, none on a Sunday — so "9 nodes → 0 nodes" is not a like-for-like row count and this is |
| `lane5-flake-fix-evidence.txt` | 5 Test Coverage | `scripts/lane5-gen-evidence.sh` (over `lane5-locked-pair.sh`, `lane5-heatmap-and-full.sh`, `lane5-w78.sh`) | The controlled pairs behind Lane 5, extracted verbatim from Playwright logs that are themselves gitignored: a seven-spec interference set run pre-fix and post-fix back-to-back under one lock, and a six-spec falsification run against a prediction stated before the run with a retraction promised if it passed |
| `lane5-verification-gate.txt` | 5 Test Coverage | `scripts/lane5-gen-evidence.sh` | Rule 2 gate: api 451/451, web 152/152, type-check/lint/build all exit 0. Also records a gap honestly — the first `pnpm test` after E2E work reported 450/451 because `api/src/test/setup.ts:14` had truncated the dev database, and the identity of the one failing test was lost before it could be captured |
| `cat5-e2e-integration-final.txt` | 5 Test Coverage | `pnpm test:e2e` on the integrated tree, gated by `scripts/assert-tests-ran.sh` | The full Playwright log for the final integrated tree, all lanes merged: **871 executed, 865 passed, 0 failed, 6 flaky** (7.5m), and the gate line `assert-tests-ran: 871 tests executed (>= 860); command exit 0`. This is what makes the flake claim a claim about the shipped tree rather than about one lane's branch — compare its 6 flaky against the 5 / 4 / 7 in the three baseline runs above, and note that none of Lane 5's three named target specs appear in it |

---

## Two things the earlier version of this index got wrong

**Concurrent editing was tested, extensively.** An earlier revision of this file said two-user
concurrent editing was "not performed." That was wrong, and it was wrong about the single
finding Category 6's data-loss result rests on. Two authenticated browser contexts were driven
simultaneously, first in `cat6-concurrent-raw.json` (9 runs, which is where W6-9 was found) and
then as a scripted before/after suite in `cat6-w6-9-before.json` / `-after.json` (5 runs a side,
0/5 → 5/5). Screenshots of both states are committed at `../evidence/w6-9/`.

**A real screen reader was driven, on one page.** An earlier revision said no live screen
reader was run at all, because guidepup's `voiceOver.start()` failed. The cause turned out to
be guidepup's own preference bundle, not the machine: with that bundle mounted every content
object in VoiceOver's scripting dictionary returned `-1728`. Talking to VoiceOver directly,
with "Allow VoiceOver to be controlled with AppleScript" ticked in VoiceOver Utility, works.
`cat7-voiceover.json` is the result — real VoiceOver on macOS 14.6.1 against Safari.

The honest scope is one page. Safari cannot be signed in from the script, so only `/login` was
genuinely walked. `cat7-virtual-sr.json` is the simulator pass over five pages signed in,
`cat7-traversal-map.json` the predicted traversal both were checked against, and
[`../voiceover-protocol.md`](../voiceover-protocol.md) the manual pass for the authenticated
pages — which is also the only thing that answers p.7's actual question, whether the structure
is *understandable*. No capture settles that.

## Not included, and why

**Terraform plan output against AWS.** `terraform plan` against the existing AWS configuration
could not be run — no credentials exist on this machine and p.7 states none are required. The
exact error is quoted in Category 8. The drift demonstration p.8 asks for needs no cloud
account and was run for real against the committed `terraform/local-config`; its before/after
plan output is reproduced inline in [`../lane-8-drift-detection.md`](../lane-8-drift-detection.md).

**Full Playwright logs.** The three baseline runs and the lane-5 controlled pairs each write a
log too large to commit; they are gitignored by `.gitignore:156` (`docs/audit/raw/e2e-*.log`).
The `*-summary.txt` files here are the pass/fail/flaky lines and failing `spec:line` lists
extracted from them verbatim by `scripts/lane5-gen-evidence.sh`. `cat5-e2e-integration-final.txt`
is the exception — it is the full log, kept whole because it is the run the submission's headline
test numbers come from.

## Reproducing

Each script is single-command and re-runnable. Prerequisites: the app on `:5173`/`:3000`,
PostgreSQL seeded to p.4's minimums via `scripts/augment-seed.mjs`, and for Category 4,
`log_statement='all'`. Anything measuring before/after should be run under
`scripts/measure-lock.sh` so two lanes cannot benchmark the same machine at once.

```bash
docs/audit/scripts/count-type-violations.py          # Cat 1
docs/audit/scripts/measure-bundle.py                 # Cat 2  (--json for the .json)
docs/audit/scripts/measure-initial-load.py           # Cat 2
docs/audit/scripts/bench-api.sh                      # Cat 3
docs/audit/scripts/bench-api-saturation.sh           # Cat 3
docs/audit/scripts/bench-api-paired.sh               # Cat 3  (old and new, simultaneously)
docs/audit/scripts/bench-api-concurrency.sh          # Cat 3  (closed loop, 10/25/50 connections)
node docs/audit/scripts/measure-queries.mjs          # Cat 4
docs/audit/scripts/run-cat4-paired.sh                # Cat 4  (paired, wraps the above)
docs/audit/scripts/explain-cat4.sh                   # Cat 4
docs/audit/scripts/measure-tests.py --e2e-runs 3     # Cat 5  (the flake baseline; ~30 min)
docs/audit/scripts/lane5-gen-evidence.sh             # Cat 5
node docs/audit/scripts/measure-runtime-errors.mjs   # Cat 6
node docs/audit/scripts/measure-concurrent-edit.mjs  # Cat 6  (two browser contexts)
node docs/audit/scripts/measure-concurrent-edit-suite.mjs   # Cat 6  (N runs, aggregated)
node docs/audit/scripts/measure-title-durability.mjs # Cat 6
node docs/audit/scripts/capture-w6-9.mjs             # Cat 6  (screenshots)
docs/audit/scripts/measure-a11y.py                   # Cat 7  (axe + keyboard + Lighthouse)
node docs/audit/scripts/measure-keyboard.mjs         # Cat 7
node docs/audit/scripts/measure-a11y-tree.mjs        # Cat 7
node docs/audit/scripts/map-a11y-traversal.mjs       # Cat 7
node docs/audit/scripts/measure-virtual-screenreader.mjs    # Cat 7
node docs/audit/scripts/measure-voiceover.mjs        # Cat 7  (VoiceOver on, AppleScript
                                                     #         control ticked in VO Utility)
docs/audit/scripts/measure-terraform.py              # Cat 8
```

The concurrent-edit and screenshot scripts take `BASE`, `API` and `DOC_ID` from the
environment. Get a document id after seeding:

```sql
select id from documents where document_type = 'wiki' and title = 'Project Overview';
```
