# Phase 2 Baseline Freeze

Implementation Rule 1 (brief p.8) requires before/after measurement "run under identical
conditions." These are the **before** numbers, taken at the commit the parallel lanes
branch from. Any lane reporting an after-number must re-run the same command listed here.

**Frozen at:** `24bf639` (branch `lane-0/ci-and-cold-start`)
**Full SHA:** `24bf63949c95fd7c3a339e87837fe638022fe5c4`
**Captured:** 2026-07-30T00:43:59Z

Not `main`. Lane 0 fixed 13 failing web tests, 9 hook-order violations, and 3 critical
advisories, so a baseline taken on `main` would credit that work twice — once to Lane 0
and again to whichever lane measured against it.

## Environment

| | |
|---|---|
| Hardware | Apple M1 Max, 64 GB |
| OS | macOS 14.6.1 |
| Node | v26.5.0 |
| pnpm | 10.27.0 |
| PostgreSQL | 16 (docker, `ship-postgres-1`, port 5432) |
| Seed volume | 257 documents · 11 users · 104 issues |

## Lane 1 — Type Safety

```
docs/audit/scripts/count-type-violations.py
```

| Package | any | as | ! | @ts | Total |
|---|---:|---:|---:|---:|---:|
| api | 232 | 143 | 288 | 0 | **663** |
| web | 26 | 286 | 33 | 1 | **346** |
| shared | 0 | 0 | 0 | 0 | 0 |
| **Total** | **258** | **429** | **321** | **1** | **1009** |

Target: 25% reduction (p.3) → **≤ 756**, i.e. at least 253 eliminated.

Unchanged from the Phase 1 audit figure. Lane 0 edited 11 source files but none of its
changes fall in a counted bucket — `let`→`const` is not a violation type.

## Lane 6 — Error Handling

Baselines in `docs/audit/audit-report.md` Category 6; raw output in `cat6-raw.json` and
`cat6-concurrent-raw.json`. Target: fix 3 gaps, ≥1 involving real data loss (p.7).

W6-9 is the data-loss one — a title edit destroys a concurrent body edit, reproduced
13/13 runs by `docs/audit/scripts/measure-concurrent-edit.mjs`.

## Lane 8 — Terraform

```
docs/audit/scripts/measure-terraform.py
```

42 `.tf` files · 145 resources · 5 roots · 6 modules · **0 providers exactly pinned**
(9 range constraints) · 4 of 5 roots without a lock file.

Target is additive (p.8): two new configs, local provider and Render provider, both with
pinned versions. The existing AWS Terraform is not on the critical path.

## Cross-cutting, already moved by Lane 0

Recorded so no later lane claims them again.

| Metric | Before Lane 0 | At this freeze |
|---|---:|---:|
| web unit tests passing | 138 / 151 | 152 / 152 |
| api unit tests passing | 451 / 451 | 451 / 451 |
| Critical advisories | 3 | 0 |
| High / moderate / low advisories | 58 / 64 / 10 | 51 / 55 / 9 |
| Lint errors | no linter | 0 (263 warnings) |
| React hook-order violations | 9 | 0 |
| CI checks | 0 | 8 |

## Known baseline gap

p.4 requires 500+ documents, 100+ issues, 20+ users, 10+ sprints before Category 3 and 4
benchmarking. The seed gives 257 documents and 11 users — **below the floor on two of
four counts.** `docs/audit/scripts/augment-seed.mjs` exists for this. It does not affect
Lanes 1, 6, or 8, but Lanes 3 and 4 cannot record a valid number until it is run.
