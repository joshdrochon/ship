# MVP gate item 9 — evidence

> **PRD p.2, gate item 9** — *"Existing Playwright regression suite passes on main; P95
> latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."*
>
> **PRD p.6, Performance Targets** — *"Telemetry / regression vs Part 1 baseline — ≤ +10%
> on P95, bundle size, query counts."*
>
> **PRD p.18, Pre-Search 3.3** — *"How will the +10% performance regression budget be
> enforced — manual benchmark, automated baseline comparison, perf job that fails the
> PR?"* Answer: **a perf job that fails the PR.** `regression-budget` in both pipelines.

The gate item is two claims. They are recorded separately below because they are
separately true, and one of them is **still not established**.

| Half | Status |
|---|---|
| Playwright regression suite passes on main | Passing as of 2026-08-12 on the L01 tree — **not re-run on the integration tree**, see below |
| P95 latency ≤ +10% | **PASS** — worst route +4.3%. Established by the paired protocol, not by a single run; see *The latency half* |
| Bundle size ≤ +10% | **PASS** — +2.72% (747,644 → 767,960 B gzipped), integration tree `dbfb46d`, 2026-08-15 |
| Per-route query counts ≤ +10% | **PASS** — 0.00% on all six routes, bit-identical |

> **Superseded 2026-08-14.** Until then this table read *"P95 latency — Not established.
> Machine too contended to measure"*, and the Mechanism table below pointed at a baseline
> captured at `b639059`. Both statements were written on 2026-08-13 and both were
> overtaken the next day by `b6177e4`, which re-captured the baseline at the real Part 1
> commit and produced the paired-run evidence. `b639059` is **three commits after Week 5's
> `main`** (`5455f4e`) and already contains `api/src/platform/`, the OAuth router and the
> SDK — so the "before" picture had much of the "after" already in it, which is
> `docs/measurement-rules.md` rule 2. The settling evidence is
> **`docs/regression-paired-runs.md`**, ten alternating pairs against a baseline captured
> at `5455f4e`, raw samples in `docs/perf-paired-runs.txt`.

---

## Mechanism

| Piece | Path |
|---|---|
| Baseline (denominator) | `docs/baseline-part1.json` — captured 2026-08-14, gitRef `5455f4e` (Week 5 `main`, the actual Part 1 tree) |
| Latency evidence | `docs/regression-paired-runs.md` + raw samples in `docs/perf-paired-runs.txt` |
| Schema, cited by both sides | `docs/baseline-schema.md` |
| Shared measurement | `api/src/scripts/lib/perf-measure.ts` |
| Comparison logic | `api/src/scripts/lib/perf-compare.ts` |
| Producer CLI | `api/src/scripts/measure-baseline.ts` → `pnpm baseline:measure` |
| Consumer CLI | `api/src/scripts/compare-baseline.ts` → `pnpm baseline:compare` |
| A/A self-check (runs first) | `scripts/perf-self-check.mjs` |
| Paired A/B protocol | `scripts/perf-paired-runs.sh` |
| Tests | `api/src/scripts/lib/perf-compare.test.ts` — 43 tests |
| CI job | `regression-budget` in `.gitlab-ci.yml` (authoritative) and `.github/workflows/ci.yml` |

Both sides import the same measurement module, so the route list, sample counts,
percentile rule, fixture and bundle glob cannot drift between the denominator and the
numerator.

---

## PF-802 — the comparator fails loudly on an absent denominator

L01's audit note flagged the capture→enforce handoff as a possible gap. It was one:
`docs/baseline-part1.json` was written and nothing read it. The failure mode that matters
is **not a missing job — it is a job that runs, finds no baseline, and reports success.**

Real CLI runs, exit codes observed:

```
$ pnpm baseline:compare -- --baseline .l26-evidence/does-not-exist.json
BASELINE UNUSABLE

No baseline at …/does-not-exist.json.

The +10% regression budget (PRD p.2 gate item 9, p.6) has no denominator, so there is
nothing to compare against and this check cannot pass. Capture one with:

    pnpm build:web && pnpm baseline:measure

This is deliberately fatal. A perf job that finds no baseline and reports success is
the exact failure PF-802 exists to prevent.

exit 1
```

```
$ pnpm baseline:compare -- --baseline .l26-evidence/baseline-empty.json
BASELINE UNUSABLE

Baseline at …/baseline-empty.json is empty (0 bytes of content).
Re-run `pnpm baseline:measure`.

exit 1
```

Twelve further degenerate inputs — non-JSON, JSON array, each missing top-level key,
absent budget, zero bundle figure, zero routes, a route missing `latencyMs` or
`queriesPerRequest`, a non-positive P95, a negative query count, and a baselined route
absent from the current run — are covered in `perf-compare.test.ts`. There is no branch
that returns a usable default.

**Anti-vacuity:** a validator that simply threw on everything would pass all of those.
One test loads the *real committed baseline* and asserts it survives validation and is
enforceable, and the control run below exits 0.

---

## PF-803 — all three metrics as explicit deltas

Every metric emits current value, baseline value and percentage delta. Query counts are
reported **per route, never aggregated** — p.2's wording is *"per-route query counts"*,
and a total hides one route that tripled behind five that did not move. A test seeds
exactly that case (documents 3→9, my-work 7→1, total unchanged at 10) and asserts the
per-route failure still fires.

Output is committed artifacts, not console text: `docs/regression-report.md` and
`docs/regression-report.json`, uploaded by the CI job on every run.

### Measured — this tree vs the Part 1 baseline

Query counts, three consecutive runs, `pf/L26-regression-budget`:

| Route | Baseline | Run 1 | Run 2 | Run 3 | Delta |
|---|---:|---:|---:|---:|---:|
| `GET /health` | 0 | 0 | 0 | 0 | 0.00% |
| `GET /api/documents` | 3 | 3 | 3 | 3 | 0.00% |
| `GET /api/documents/:id` | 4 | 4 | 4 | 4 | 0.00% |
| `GET /api/issues` | 5 | 5 | 5 | 5 | 0.00% |
| `GET /api/weeks` | 5 | 5 | 5 | 5 | 0.00% |
| `GET /api/dashboard/my-work` | 7 | 7 | 7 | 7 | 0.00% |

Bit-identical across every run. **PASS.**

Bundle, gzipped total: baseline **747,644 B** → current **767,960 B**, **+2.72%**. **PASS.**

*(The −0.00% / 747,612 B figure previously recorded here was measured on the L26 tree alone,
before the other lanes landed. Re-measured 2026-08-15 on the integration tree `dbfb46d`. The
budget is +10% and the current figure is +2.72%, so the verdict is unchanged; the number is
not. Re-measure this row before submission — it moves with every lane that lands.)*

**Database state:** freshly migrated `ship_l26` (58 migrations, no seed). The routes are
driven against a fixture the script creates and destroys — one workspace, one user, 25
documents — not against seed or developer data, so a preceding `pnpm test` TRUNCATE does
not contaminate the numbers. Recorded in every report under `databaseState`.

---

## PF-804 — the job fails the PR, proven three separate times

Method: one **real** measurement of this tree, compared against four baselines. The
regression is seeded into the **denominator**, so the numerator stays a real measurement
in all four runs — hand-editing the measured values would prove the comparator can
subtract, not that it fails a real run. Generator: `.l26-evidence/seed-regressions.mjs`.

| # | Seeded regression | Exit | Message |
|---|---|:--:|---|
| 0 | **control** — nothing moved | **0** | `WITHIN BUDGET — 13 enforced metric(s) at or under +10%.` |
| 1 | P95 latency, `GET /api/documents` | **1** | `P95 latency · GET /api/documents: 26.41 ms vs baseline 23.79 ms (+11.01%, budget +10%)` |
| 2 | Bundle size, total gzipped | **1** | `Bundle size · total gzipped: 747612 bytes vs baseline 673524 bytes (+11.00%, budget +10%)` |
| 3 | Query count, `GET /api/dashboard/my-work` | **1** | `Queries per request · GET /api/dashboard/my-work: 7 queries vs baseline 6 queries (+16.67%, budget +10%)` |

Each failing message names the metric, the affected route where applicable, and both
numbers. Run 0 is the anti-vacuity control: a job that has only ever been seen to fail is
no better evidence than one that has only ever been seen to pass.

Row 3 is +16.67% rather than ~11% because **query counts are integers** — the smallest
regression expressible on a 7-query route is 7→8. That is the ~11%-class regression this
metric can express; there is no fractional query.

Row 2 ran **without** `--strict-latency` and still failed, which is the point: bundle size
is deterministic and enforced unconditionally.

---

## The latency half — established, by the paired protocol

**Result: within budget. Worst route +4.3%, against a +10% budget.**

| Route | Part 1 p95 (ms) | Current p95 (ms) | Delta |
|---|---:|---:|---:|
| `GET /health` *(control)* | 0.26 | 0.24 | −5.8% |
| `GET /api/documents` | 3.10 | 3.18 | +2.6% |
| `GET /api/documents/:id` | 4.21 | 4.21 | −0.1% |
| `GET /api/issues` | 5.36 | 5.59 | **+4.3%** |
| `GET /api/weeks` | 6.42 | 6.44 | +0.4% |
| `GET /api/dashboard/my-work` | 8.06 | 8.11 | +0.6% |

Ten alternating pairs per side, 25 trials of 60 samples per route per run, both sides
running byte-identical measurement code against a baseline captured at `5455f4e` — Week
5's `main`, the actual Part 1 tree. Full method and the three defects this replaced:
`docs/regression-paired-runs.md`. Raw per-run samples: `docs/perf-paired-runs.txt`.
Reproduce with `scripts/perf-paired-runs.sh <part1-worktree> 10`.

`GET /health` is the control — it runs no query and touches no database, so it cannot
regress. It moved −5.8%, well inside the run-to-run floor, which is what says the
instrument was working. When that control moves a lot, the run is void, not the tree.

**Why the paired protocol and not a single `pnpm baseline:compare`:** a single run on this
hardware is not deterministic — four consecutive comparisons of the same tree against the
same baseline gave WITHIN / OVER / WITHIN / WITHIN. Publishing whichever one passed would
be picking the answer. Alternating both sides in one session makes machine drift land on
both sides instead of on whichever was measured while something else woke up.

### What this replaced — the single-run attempt that could not resolve the budget

Kept because it is why the protocol above exists. Three consecutive runs of the **same
commit on the same machine**, minutes apart:

| Route | Baseline | Run 1 | Run 2 | Run 3 | Spread |
|---|---:|---:|---:|---:|---:|
| `GET /health` | 0.91 | 3.60 | 6.84 | 2.74 | 2.5× |
| `GET /api/documents` | 3.63 | 7.71 | 16.00 | 5.96 | 2.7× |
| `GET /api/documents/:id` | 3.99 | 10.80 | 7.37 | 4.69 | 2.3× |
| `GET /api/issues` | 3.69 | 20.57 | 4.27 | 4.67 | **4.8×** |
| `GET /api/weeks` | 4.24 | 8.37 | 13.18 | 13.74 | 1.6× |
| `GET /api/dashboard/my-work` | 6.93 | 8.88 | 40.60 | 6.73 | **6.0×** |

The budget being policed is **+10%** (1.1×). The run-to-run noise reaches **6.0×** — about
sixty times the budget. No verdict at 10% survives that.

Cause, measured rather than inferred: the machine was at **load average 13.25–18.8 across
10 cores** (ratio 1.33–1.88), with six `yes` processes each holding ~90% of a core. The
baseline was captured on the same hardware in a quieter state.

Two things say this is contention and not a code regression:

1. **Query counts are bit-identical to the baseline on all six routes across all three
   runs.** A regression that added work to the request path — an audit hook, a rate-limit
   lookup, extra middleware — would move them. They did not move at all.
2. `GET /api/dashboard/my-work` measured **6.73 ms against a 6.93 ms baseline** on the
   quietest run: *below* baseline on the same route that read 40.60 ms on the noisiest.
   A systematic regression does not do that.

### What was added because of this

The original design gated latency enforcement on an environment fingerprint —
`platform`, `node` major, `cpuCount` — from the baseline's `method` block. That
fingerprint **matched exactly** here (darwin-arm64, v26.5.0, 10 cores) and was still not
enough: it says *"same box"*, not *"the box was idle enough to time anything on"*.

So the measurement now also records the 1-minute load average and its per-core ratio, and
the comparator vetoes latency enforcement above a ratio of **0.8** — 0.8 rather than 1.0
because the measurement itself occupies roughly one core. Bundle bytes and query counts
are deterministic and answer to neither veto; they stay enforced always. `--strict-latency`
overrides the vetoes, and when it does the report states plainly that a latency *failure*
is not by itself evidence of a code regression while a latency *pass* is the stronger
claim.

Logged as **F80** in `lane-99-unassigned.md`.

### How it was closed

Not by waiting for a quiet machine — that wait never ended. By re-measuring **both** sides
alternately in one session, so the machine's drift lands on both and cancels:

```bash
scripts/perf-paired-runs.sh <part1-worktree> 10
```

Ten pairs, exit 0, worst route +4.3%. That is the evidence for the latency half, and
`docs/regression-paired-runs.md` is where it lives.

**A single-run `pnpm baseline:compare -- --strict-latency` is *not* an acceptable
substitute on this hardware,** and the earlier version of this section was wrong to offer
it as the closing move. `--strict-latency` overrides the load guard that exists to catch
exactly the condition this machine is in, which is `docs/measurement-rules.md` rule 7. The
flag is not the problem; reaching for it to turn a run green is. If the machine is quiet
enough for a single run — load ratio at or under 0.8, reported in the artifact — the plain
`pnpm baseline:compare` establishes it without the flag, and the flag is unnecessary. If it
is not quiet, the flag does not make the number true.

---

## Why latency is advisory in CI

Bundle bytes and query counts are deterministic — same tree, same numbers, any machine. An
in-process P95 is not. The baseline is darwin-arm64 / node v26 / 10 cores; CI runners are
linux-x64 / node 22 / 2–4 shared cores. Comparing those measures the runner, in **both**
directions: it can hide a real regression behind a faster box as easily as invent one on a
slower box.

So the CI job enforces the two deterministic metrics unconditionally and reports latency
as advisory, naming the reason in the artifact on every run. The latency half is enforced
on a machine matching the baseline and recorded here.

**What that must NOT mean: a green artifact.** See the next section.

---

## An unjudged budget is not a passed budget

`docs/regression-report.json` used to emit this combination:

```json
"latencyEnforced": false,
"failures": [],
"ok": true
```

on a run whose six P95 rows read **+14.29% to +68.36%** against a +10% budget. The rows
were `"status": "advisory"` because `loadRatio` 0.89 exceeded the 0.8 limit and latency
enforcement was vetoed. The veto was correct — refusing to judge latency on a contended
machine is the whole discipline of `docs/measurement-rules.md`. Emitting `ok: true` and an
empty `failures` array as the result of that refusal was not. A grader opening that file to
check gate item 9 saw a clean pass on a metric nothing had judged.

The report now distinguishes the two:

| Field | Meaning |
|---|---|
| `verdict: "pass"` | every budget was judged, and met |
| `verdict: "fail"` | something judged exceeded its budget |
| `verdict: "indeterminate"` | nothing judged exceeded its budget, but not every budget was judged |
| `unjudged: [...]` | the metrics that were measured but not judged — mirrors `failures` |
| `ok` | `true` only when `verdict === "pass"` |

`ok` stays a **boolean** deliberately. A tri-state string there would be truthy in every
naive `if (report.ok)` consumer, so `"indeterminate"` would read as success in precisely
the code paths the field exists to protect. `false` is the value that is safe for a
consumer that has never heard of `verdict`.

`compare-baseline` exits **2** on an indeterminate run — the code it already used for "the
instrument could not answer" — keeping exit 1 to mean a real, measured breach. The two must
stay distinguishable: a pipeline that tolerates "could not measure" must **not** thereby
tolerate "measured, and over budget".

Covered by `api/src/scripts/lib/perf-compare.test.ts`, which reconstructs the exact shape
of the committed artifact and asserts it is no longer a pass, and — anti-vacuity — that a
clean run on a quiet matching machine still reports a plain `pass`.

### The committed report, and the conditions it was taken under

`docs/regression-report.json` was regenerated on **2026-08-15** against the integration tree
`dbfb46d`, baseline `5455f4e`, on a dedicated database (`ship_l26int`, 61 migrations, no
seed; routes driven against the fixture the script creates and destroys).

**It is `verdict: "indeterminate"`, and that is the honest result, not a placeholder.**

The A/A self-check was run first, as `docs/measurement-rules.md` rule 1 requires, and it
failed:

```
$ API_RATE_LIMIT_MAX=100000000 PERF_TRIALS=25 node scripts/perf-self-check.mjs --budget 10

  route                                 A        B     diff
  GET /api/issues                   46.87    14.89    68.2%
  GET /health                        2.48     1.20    51.6%
  GET /api/dashboard/my-work        19.18    27.97    45.8%
  ...
  TOO NOISY — GET /api/issues moved 68.2% between two runs of identical code.
```

**The control moved.** `GET /health` runs no query and touches no database, and it read
51.6% apart across two runs of identical code — and in the comparison itself, 1.67 ms
against a 0.21 ms baseline. A route that does nothing cannot regress by 695%. That is the
machine, and by rule 1 it voids any latency verdict from this run, including a passing one.

Machine state during the run: 1-minute load average **17.15 across 10 cores (ratio 1.71)**,
against a limit of 0.8 — eight to nine GitLab runner containers building concurrently and a
Docker VM holding ~600% CPU. Load was sampled every 30 s for the preceding half hour and
never came near the threshold; it was rising, not falling. No quiet window was available,
so none was claimed.

**The latency numbers printed in that artifact are contention, not code.** They are marked
`"status": "advisory"` and listed under `unjudged`, the verdict is `indeterminate`, and `ok`
is `false`. Read them as nothing at all. The latency half of gate item 9 is established by
`docs/regression-paired-runs.md`, whose protocol is designed for exactly this machine.

---

## Wiring the credible measurement into CI

`scripts/perf-paired-runs.sh` produces the only latency evidence in this repo that survives
its own noise, and **no CI job runs it.** The good number is manual; the weaker single-run
comparison is the one in the pipeline. That is backwards, and it is why the stale "not
established" line survived a day longer than the evidence that refuted it.

It does not belong in the per-MR pipeline: ten alternating pairs at `PERF_TRIALS=25` is
roughly 20 restarts of the measurement across two worktrees, far too slow to sit in front
of every merge, and it needs a Week 5 worktree checked out at `5455f4e` with the current
harness copied in — which is state a normal MR job should not be building.

**Proposed job — `perf-paired-latency`.** `.gitlab-ci.yml` is owned by another lane right
now, so this is a description rather than an edit:

| Field | Value |
|---|---|
| Stage | `verify` |
| Trigger | `rules: - if: $CI_PIPELINE_SOURCE == "schedule"` plus a manual `when: manual` entry, **not** on every MR |
| Setup | worktree at `5455f4e`, current `api/src/scripts/lib/perf-measure.ts` copied in — both sides must run identical measurement code |
| Env | `API_RATE_LIMIT_MAX` pinned identically on both sides; two databases, `BASELINE_DATABASE_URL` (Part 1 schema) and `CURRENT_DATABASE_URL` |
| Script | `scripts/perf-self-check.mjs --budget 10` first, then `scripts/perf-paired-runs.sh $PART1_WT 10` |
| Exit | the script already exits 1 when any route exceeds +10%; exit 2 from the self-check means the runner is too noisy and the run is void, not passing |
| Artifacts | `docs/perf-paired-runs.txt`, `when: always` |
| Caveat | the runner must restore `docs/baseline-part1.json` afterwards — `measure-baseline.ts` rewrites it in whichever tree it runs in |

The per-MR `regression-budget` job stays as it is: the two deterministic metrics enforced
on every change, latency reported and marked unjudged. That job answers "did this diff
change the bundle or the query count", which it can do honestly on any runner. This one
answers "is the latency budget met", which needs the paired protocol.

**Pipeline note for the new exit code.** With latency unjudged on a linux runner,
`regression-budget` now exits 2 rather than 0. GitLab expresses the right tolerance
directly — `allow_failure: exit_codes: [2]` — which keeps exit 1 (a real, measured breach)
failing the MR while an unmeasurable latency half shows as a warning rather than a false
green. GitHub Actions has no equivalent, so its step needs an explicit
`|| [ $? -eq 2 ]` wrapper. Do **not** reach for a blanket `allow_failure: true`: that
swallows exit 1 as well and removes the thing PF-804 exists to provide.

This is a judgment call and it is the softest one in the slice. The alternative readings
are: enforce latency in CI anyway (produces red builds unrelated to the diff — the fastest
route to a disabled perf job), or widen the tolerance for CI (changes the +10% number the
PRD names, which is not ours to change). The split keeps p.2's number intact and states
where each half of it is enforced, rather than quietly applying it somewhere it does not
hold.

---

## The Playwright half

PF-019 executed the full existing Playwright suite on the refactored `createApp` on
**2026-08-12**, recorded in commit `41393f6`:

- 74 spec files, 894 test executions
- `829 passed · 1 failed · 47 did not run` (27.2 min, 1 worker), then the 47 unstarted
  specs run directly: `65 passed` (1.5 min)
- The one failure — `program-mode-week-ux.spec.ts:380` — passes on `--last-failed` rerun;
  a flake, not a regression. The internal middleware stack was byte-identical (PF-018).

**Two caveats, stated rather than smoothed over:**

1. That run was on the **L01 tree**, not on the current integration tree. p.2 says *"passes
   on main"*. Every lane has landed since. The run must be repeated on the final tree
   before submission — via `/e2e-test-runner`, never `pnpm test:e2e` directly.
2. The run needed two passes because the machine could not hold the suite in one. That is
   the honest claim; *"874 passed"* on one line would not be.

This lane does not re-run it here: it is a ~30-minute suite whose result on an interim
branch would not be the recorded evidence anyway. Tracked as the remaining work on PF-805.
