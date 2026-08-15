# P95 latency vs the Part 1 baseline — paired-run evidence

**MVP gate item 9 (PRD p.2):** *"Existing Playwright regression suite passes on main;
P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."*
Budget restated on p.6.

**Result: within budget. Largest regression +4.3%, against a +10% budget.**

| Route | Part 1 p95 (ms) | Current p95 (ms) | Delta |
|---|---:|---:|---:|
| `GET /health` | 0.26 | 0.24 | −5.8% |
| `GET /api/documents` | 3.10 | 3.18 | +2.6% |
| `GET /api/documents/:id` | 4.21 | 4.21 | −0.1% |
| `GET /api/issues` | 5.36 | 5.59 | +4.3% |
| `GET /api/weeks` | 6.42 | 6.44 | +0.4% |
| `GET /api/dashboard/my-work` | 8.06 | 8.11 | +0.6% |

Ten alternating pairs per side, 25 trials of 60 samples per route per run, both sides
running identical measurement code. Bundle size and per-route query counts are unchanged
and are reported by `docs/regression-report.md`; this document exists for latency, which
is the only one of the three that is noisy.

Reproduce: `scripts/perf-paired-runs.sh <part1-worktree> 10`. Raw per-run samples are in
`docs/perf-paired-runs.txt`; the table above is the median of each side's ten runs.

`GET /health` is the **control**. It runs no query and touches no database, so it cannot
regress; the −5.8% it moved is the run-to-run floor. A large move on that row means the
instrument is broken and the run is void — which is how the three defects below were found.

> **This document is the authority for the latency half of MVP gate item 9.**
> `docs/mvp-gate-item-9.md` records the gate item as a whole and cites this file for P95.
> It previously said P95 was *"Not established"*, which was written on 2026-08-13 and was
> already stale when this evidence landed on 2026-08-14 in `b6177e4`. If the two ever
> disagree again, check which baseline each is standing on: this one is `5455f4e`, Week 5's
> `main`. Anything citing a 2026-08-12 ref (`41393f6`, `b639059`) predates the re-capture
> and is measuring Week-6-with-PlugForge against Week-6-with-more-PlugForge.

---

## Three things were wrong with the earlier evidence

This is written out because each one produced a *confident* number, and two of them
produced a confident number that was wrong in the reassuring direction.

### 1. The baseline was not Part 1

`docs/baseline-part1.json` recorded `gitRef 41393f6`, committed **2026-08-12** and
titled *"Part 1 performance baseline"*. It is four commits **after** Week 5's `main`
(`5455f4e`, 2026-08-08) and already contains `api/src/platform/`, the OAuth router and
the SDK.

So the +10% budget was being evaluated as Week-6-with-PlugForge against
Week-6-with-more-PlugForge. Whatever the platform layer cost, most of it was already in
the denominator. The baseline is now captured at `5455f4e` — the actual Part 1 tree, 43
migrations against the current 61 — by checking that commit out into a worktree and
copying this repo's current harness into it.

### 2. The harness measured itself

`measureRoutes` called `request(app)` per sampled request. That makes supertest bind a
fresh ephemeral server, accept one connection, and tear both down — **inside the timed
region**, once per sample.

The cost of that bind/accept/close is scheduler-dependent and it swamped the routes it
was measuring:

- per-trial p95 spread on **unchanged code** was 21%–87%, against a 10% budget;
- `GET /health`, which runs no query and touches no database, moved **32%** between runs
  of identical code, and in one comparison reported **+108%**;
- at 25 trials the run died with `ECONNRESET` — 9,000 listen/close pairs do not recycle
  through `TIME_WAIT` fast enough.

The harness now binds once with `app.listen(0)` and reuses one keep-alive socket for the
whole run. `GET /health` p95 fell from ~0.7–1.5 ms to ~0.24 ms, which is the size of the
artifact that was being reported as route latency. This does introduce a real loopback
TCP hop, so numbers are **not** comparable to any baseline captured with the old
in-process path — which is the other reason the Part 1 baseline had to be re-captured
rather than reused.

### 3. The two trees had different rate-limit ceilings

Part 1 defaults its test limiter to 10,000 requests/minute; the current tree raised that
to 1,000,000 (L14). At 75 trials the Part 1 side started answering **429**, and the
harness recorded `GET /api/issues` at 0.23 ms — the error path, measured as if it were
the route. The guard that refuses to record a route erroring during warm-up caught it one
route later.

Both sides now pin `API_RATE_LIMIT_MAX` to the same value. It is a difference between the
trees, but it is not the difference under test, so it is held constant.

---

## Why a single `pnpm baseline:compare` is not the evidence

Even with the harness fixed, one comparison run on a contended laptop still flips. Four
consecutive 50-trial runs of the same tree against the same baseline:

```
run 1: WITHIN BUDGET
run 2: OVER BUDGET — 1 metric above +10%
run 3: WITHIN BUDGET
run 4: WITHIN BUDGET
```

Publishing whichever run passed would be picking the answer. The paired protocol above
re-measures both sides alternately in one session, so machine drift lands on both sides
rather than on whichever was measured while something else woke up.

**The honest residual:** on this hardware — a laptop whose Docker VM alone holds ~190% CPU
— a single-run verdict is not deterministic, and `--strict-latency` will override the
very load guard that exists to catch that. The paired protocol is what makes the result
stable here. A quiet CI runner should be able to use the single-run comparison directly,
and that has not been demonstrated, because no CI job has been observed running green on
either platform yet.

## Method

Both sides run byte-identical measurement code (`api/src/scripts/lib/perf-measure.ts`),
so the route list, sample counts, percentile rule, fixture and bundle glob cannot drift
between denominator and numerator. Per route: 15 discarded warm-up requests, then
`PERF_TRIALS` independent passes of 60 counted samples each; the reported p95 is the
**median of the per-pass p95 values**, not the p95 of the pooled samples — pooling lets
one bad pass pull the combined tail up and look exactly like a regression.

Query counts come from one clean request with the pool instrumented, so a statement
issued inside a transaction is still counted. Routes are measured against a purpose-built
fixture (one workspace, one user, 25 documents) created and destroyed by the run, so the
numbers do not move with whatever is in the database.

These are a before/after pair for this repo against itself over loopback — not a
production SLO.
