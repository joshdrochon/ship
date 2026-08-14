# Rules for any number that gates a merge

Written after the P95 evidence for MVP gate item 9 was accepted and then failed review.
Three defects sat under a green check, and every one of them would have been caught by
rule 1. See `docs/regression-paired-runs.md` for what they were.

These apply to any measured threshold — latency budgets, bundle size, coverage, the
type-violation ceiling, drill timings.

---

## 1. A/A before A/B. Always.

**Measure the same thing twice and compare it to itself before you compare it to
anything else.** If the two runs differ by more than the budget, the instrument cannot
enforce that budget and no verdict from it means anything — including the ones that pass.

```bash
DATABASE_URL=... node scripts/perf-self-check.mjs --budget 10
```

Exit 0 usable · 2 too noisy · 1 could not run.

This is not a formality. The evidence that failed review reported `GET /health` — a route
with no query and no database — as +32%, and in another run +108%. A route that does
nothing cannot regress. One A/A run says so immediately.

**A control that cannot move is the cheapest thing you can add.** `/health` is that
control here. When it moves, the instrument is broken, and you know it without knowing
anything about the change.

## 2. A label is not evidence

`docs/baseline-part1.json` said `"Part 1 performance baseline"` and recorded
`gitRef 41393f6`. That commit is four commits *after* Week 5's `main` and already contained
`api/src/platform/`, the OAuth router and the SDK — so the "before" picture already had
half the "after" in it.

Nobody checked. The filename said Part 1 and the number was plausible.

**Resolve the ref. Read its date and subject. Ask whether it is what the label claims.**

```bash
git log --format='%h %ad %s' --date=short -1 <the-ref-in-the-artifact>
```

## 3. Hold everything constant except the thing under test

The Part 1 tree capped its test rate limiter at 10,000/min; the current tree at
1,000,000. Above a certain sample count the Part 1 side started answering `429`, and the
harness recorded `GET /api/issues` at 0.23 ms — the error path, measured as though it
were the route.

Both sides now pin `API_RATE_LIMIT_MAX` explicitly. It is a real difference between the
trees; it is not the difference being measured, so it gets held constant.

Same rule killed the naive A/A: the first pass to touch the database gets clean tables,
every later pass inherits dead tuples. `perf-self-check.mjs` discards a warm-up pass for
exactly that reason.

## 4. The instrument must not be in the measurement

`measureRoutes` used to call `request(app)` per sample, which makes supertest bind an
ephemeral server, accept one connection and tear both down — **inside the timed region**.
Route latency was mostly the cost of that.

The tell was the control: `/health` p95 fell from ~0.7 ms to ~0.24 ms when the bind moved
out. Two-thirds of the reported latency was the harness.

**Ask what the timed region contains besides the thing you mean to time.**

## 5. Changing the instrument invalidates the baseline

`compare-baseline` now refuses outright when `method.transport` differs between baseline
and current:

```
The baseline was captured through a different measurement path.
```

Numbers taken through different harnesses are not comparable in either direction — the
same fix that made `/health` look 65% faster would invent regressions if it landed the
other way round. Re-capture the baseline at its own commit with the current harness.

## 6. One run is not a result on a machine you do not control

Four consecutive comparisons of the same tree against the same baseline gave
WITHIN / OVER / WITHIN / WITHIN. Publishing whichever one passed would be picking the
answer.

Where the A/A says the machine is too noisy, use the paired protocol — both sides
re-measured alternately in one session, so drift lands on both:

```bash
scripts/perf-paired-runs.sh <part1-worktree> 10
```

## 7. Never quiet a guard to make a pipeline green

`docs/audit/type-violations-ceiling.txt` says it, and it generalises: raising a ceiling,
adding `--strict-latency` to override a load check, or widening a tolerance because a job
is red are all the same move. If the guard is wrong, fix the guard and say why in the
commit. If it is right, fix the code.

`--strict-latency` exists and it overrode the load guard that was trying to say the
machine was at ratio 0.86. The flag was not the problem; reaching for it was.
