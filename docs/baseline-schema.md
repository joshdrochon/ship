# `docs/baseline-part1.json` — schema

The Part 1 performance baseline: the denominator for the +10% regression budget on
**MVP gate item 9**.

> **PRD p.2, gate item 9** — *"Existing Playwright regression suite passes on main; P95
> latency, bundle size, and per-route query counts within +10% of the Part 1 baseline."*
>
> **PRD p.6, Performance Targets** — *"Telemetry / regression vs Part 1 baseline — ≤ +10%
> on P95, bundle size, query counts."*

This file is the single place both sides of that comparison cite (PF-802):

| Side | Code | Role |
|---|---|---|
| Producer | `api/src/scripts/measure-baseline.ts` (PF-020, L01) | writes `docs/baseline-part1.json` |
| Consumer | `api/src/scripts/compare-baseline.ts` (PF-803, L26) | reads it, re-measures, computes deltas, fails the PR over budget |
| Shared measurement | `api/src/scripts/lib/perf-measure.ts` | the route list, sample counts, percentile rule, fixture, bundle glob — imported by **both**, so the two sides cannot drift |
| Comparison logic | `api/src/scripts/lib/perf-compare.ts` | validation + delta computation, I/O-free so the failure modes are directly testable |

Neither file is hand-edited. Regenerate the baseline with `pnpm baseline:measure`
(after `pnpm build:web` — the bundle figure needs `web/dist`).

## Commands

```bash
pnpm build:web && pnpm baseline:measure   # (re)capture the denominator
pnpm baseline:compare                     # measure now, compare, write the report, exit non-zero over budget
pnpm baseline:compare -- --strict-latency # also enforce latency when the machine differs from the baseline's
```

## Top-level shape

```jsonc
{
  "$schema":   "https://ship.internal/schemas/baseline-part1.json",
  "_comment":  "…generated-file warning…",
  "capturedAt": "2026-08-12T20:31:10.713Z",   // ISO 8601, when the run happened
  "gitRef":     "b639059…",                    // commit measured, or null outside a repo
  "method":  { … },   // how it was measured — see below
  "budget":  { … },   // the budget being enforced
  "summary": { … },   // headline figures, convenience only
  "routes":  { … },   // per-route measurements — the P95 and query-count denominators
  "bundle":  { … }    // the bundle-size denominator
}
```

`capturedAt`, `method`, `budget`, `routes` and `bundle` are **required**. The comparator
throws `BaselineError` and exits non-zero if any is absent — see *Validation* below.

### `method` — the environment fingerprint

```jsonc
{
  "transport":       "in-process (supertest), no TCP — a before/after pair, not a production SLO",
  "samplesPerRoute": 60,          // counted requests per route
  "warmupPerRoute":  15,          // discarded first: JIT warm-up, pool fill, plan caching
  "percentile":      "nearest-rank",
  "fixtureDocuments": 25,         // rows the list endpoints page over
  "node":     "v26.5.0",
  "platform": "darwin-arm64",
  "cpuCount": 10
}
```

`node`, `platform` and `cpuCount` are load-bearing, not decoration. The comparator reads
them to decide whether the **latency** comparison is meaningful — see *Environment
comparability*.

### `budget`

```jsonc
{
  "maxRegressionPercent": 10,
  "appliesTo": ["latencyMs.p95 per route", "bundle.totalGzipBytes", "queriesPerRequest per route"],
  "source": "PRD p.2 (MVP gate item 9), p.6 (Performance Targets)"
}
```

The comparator takes `maxRegressionPercent` **from the file**, so the budget travels with
the baseline rather than being hardcoded twice.

### `routes` — keyed by stable route id

Keys are ids like `"GET /api/documents"`, never a concrete URL: a fixture UUID in the key
would change every run and make two baselines undiffable. Do not rename them — a rename
reads as one route disappearing and another appearing.

```jsonc
"GET /api/documents": {
  "method": "GET",
  "path":   "/api/documents",     // `:id` form for parameterised routes
  "status": 200,                  // observed during warm-up; ≥400 aborts the capture
  "samples": 60,
  "latencyMs": { "p50": 2.62, "p95": 3.63, "p99": 4.19, "min": 1.87, "max": 4.19, "mean": 2.65 },
  "queriesPerRequest": 3,         // SQL statements one request issues, transactions included
  "note": "…why this route is in the set…"
}
```

Only `latencyMs.p95` and `queriesPerRequest` are budgeted. The others are recorded because
a P95 with no P50 or max beside it is hard to sanity-check.

### `bundle`

```jsonc
{
  "totalBytes": 2387826,
  "totalGzipBytes": 747644,       // ← the budgeted figure
  "javascriptBytes": …, "javascriptGzipBytes": …,
  "cssBytes": …,        "cssGzipBytes": …,
  "fileCount": 317,
  "largestChunks": [ { "file": "vendor-editor-….js", "bytes": …, "gzipBytes": … } ]
}
```

`totalGzipBytes` is the enforced number — gzipped is what a browser actually pulls over the
wire. The rest is diagnostic: when the total moves, `largestChunks` is where you look first.

## What gets compared, and how

For every metric the comparator emits **current value, baseline value, and percentage
delta** (PF-803):

| Metric | Granularity | Source field | Enforced |
|---|---|---|---|
| P95 latency | **per route** | `routes[id].latencyMs.p95` | when the machine matches, or under `--strict-latency` |
| Bundle size | one total | `bundle.totalGzipBytes` | always |
| Query counts | **per route** | `routes[id].queriesPerRequest` | always |

Query counts are reported per route and never aggregated. p.2's wording is *"per-route query
counts"*, and a total hides one route that tripled behind five that did not move.

`percent = (current − baseline) / baseline × 100`. A metric **fails** when that exceeds
`budget.maxRegressionPercent`. Improvements are unbounded — the budget is one-directional.

### The zero-baseline case

`GET /health` records `queriesPerRequest: 0`. If a change puts a query on that path the
delta is `(1 − 0) / 0` — infinite, not a number a report can print. The comparator marks
this `unboundedRegression: true` and **always fails it**. This is not a corner case to
tidy away: an audit or rate-limit hook landing on the shared middleware path is one of the
likeliest regressions PlugForge could cause, and `/health` is where it shows up first.

### Environment comparability

Bundle bytes and query counts are deterministic — same tree, same numbers, any machine.
**P95 latency is not.** An in-process P95 taken on a 10-core laptop against one taken on a
2-core shared CI runner differs by the runner.

So the comparator compares `method.platform`, `method.node` (major) and `method.cpuCount`.
On a mismatch, latency deltas are still computed and reported but marked `advisory`, with
the differing dimensions named in the report; bundle and query counts stay enforced. This
cuts both ways and that is the point — a mismatched machine can hide a real regression
behind a faster box as easily as invent one on a slower box, and a perf job that goes red
for reasons unrelated to the diff gets disabled within a week.

`--strict-latency` forces enforcement regardless, and is what the recorded MVP gate
evidence run uses, on a machine matching the baseline.

## Validation — why the comparator fails loudly

L01's audit note flagged the capture→enforce handoff as a possible gap between lanes. It
was one: `docs/baseline-part1.json` was written and nothing read it. **The failure mode
that matters is not a missing job — it is a job that runs, finds no baseline, and reports
success.** Every condition below therefore throws `BaselineError` and exits non-zero:

| Condition | Why it cannot be a pass |
|---|---|
| File missing | No denominator; the budget is unenforceable |
| File empty / not JSON / not an object | Same, with a corruption cause |
| Missing `capturedAt`, `method`, `budget`, `routes`, or `bundle` | Schema mismatch — the file is not this file |
| `budget.maxRegressionPercent` absent or not finite | The budget is the point of the file |
| `bundle.totalGzipBytes` ≤ 0 or absent | One of the three metrics has no denominator |
| `routes` empty | Two of the three metrics have no denominator |
| A route missing `latencyMs`, `queriesPerRequest`, or `path` | That route is unenforceable |
| A route with `latencyMs.p95` ≤ 0 | Not a measurement |
| A route with negative or non-integer `queriesPerRequest` | Not a measurement |
| A baselined route absent from the current run | The budget covers it and this run cannot speak to it |

That last row is the same vacuous pass, one route at a time: silently dropping an
unmeasured route would let a regressing route vanish from the report while the job stays
green.

## Outputs

`pnpm baseline:compare` writes two committed artifacts (PF-803 requires something a grader
can read, not console text):

- **`docs/regression-report.md`** — the human artifact: result, provenance, environment,
  any over-budget metrics named with both numbers, then a table per metric.
- **`docs/regression-report.json`** — the same data machine-readably, for CI.

Exit code is `0` within budget and `1` over it, so the CI job needs no output parsing.

## Measuring soundly

`pnpm test` TRUNCATEs the database, so a number taken straight after a test run is
otherwise suspect. It does not corrupt **this** measurement: the routes are driven against
a fixture the script creates and destroys — one workspace, one user, 25 documents — rather
than against seed or developer data, which is also why two runs on two machines differ by
the machine and not by whatever happened to be in the table. The report records the
database state anyway, under `databaseState`, because that is the first question the
numbers invite.
