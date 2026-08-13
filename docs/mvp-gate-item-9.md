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
separately true, and one of them is **not yet fully established**.

| Half | Status |
|---|---|
| Playwright regression suite passes on main | Passing as of 2026-08-12 on the L01 tree — **not re-run on the integration tree**, see below |
| P95 latency ≤ +10% | **Not established.** Machine too contended to measure; see *The latency half* |
| Bundle size ≤ +10% | **PASS** — −0.00% (32 bytes smaller) |
| Per-route query counts ≤ +10% | **PASS** — 0.00% on all six routes, bit-identical |

---

## Mechanism

| Piece | Path |
|---|---|
| Baseline (denominator) | `docs/baseline-part1.json` — captured 2026-08-12, gitRef `b639059` |
| Schema, cited by both sides | `docs/baseline-schema.md` |
| Shared measurement | `api/src/scripts/lib/perf-measure.ts` |
| Comparison logic | `api/src/scripts/lib/perf-compare.ts` |
| Producer CLI | `api/src/scripts/measure-baseline.ts` → `pnpm baseline:measure` |
| Consumer CLI | `api/src/scripts/compare-baseline.ts` → `pnpm baseline:compare` |
| Tests | `api/src/scripts/lib/perf-compare.test.ts` — 36 tests |
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

Bundle, gzipped total: baseline **747,644 B** → current **747,612 B**, **−0.00%** (32
bytes smaller). **PASS.**

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

## The latency half — not established, and why

**This is the one part of gate item 9 this lane cannot currently certify.**

The comparator is correct and the CI job is real. The obstacle is measurement, not code.

Three consecutive runs of the **same commit on the same machine**, minutes apart:

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

### What is needed to close it

Run on an idle machine matching the baseline fingerprint:

```bash
pnpm build:web
pnpm baseline:compare -- --strict-latency
```

The load line in the report must read a ratio at or under 0.8. If the three deltas come in
at or under +10%, paste the report into `SUBMISSION-PLUGFORGE.md` and this half is closed.
Everything needed to do that is landed; only a quiet machine is missing.

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
