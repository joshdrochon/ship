# Lane 3 — API Response Time

You own one ShipShape category. Five other agents are working other lanes in sibling
worktrees right now. Stay inside your boundary.

## Target, verbatim (p.5)

> 20% reduction in P95 response time on at least 2 endpoints. You must provide
> before/after benchmarks run under identical conditions (same data volume, same
> concurrency, same hardware). Document the root cause of each bottleneck.

## Numbers

| Endpoint | Baseline P95 | You need |
|---|---:|---:|
| `/api/documents` | 36.1 ms | **≤ 28.88 ms** |
| `/api/projects` | 24.24 ms | **≤ 19.39 ms** |

Baseline frozen at `docs/audit/raw/phase2-baseline.md`; full detail in the audit report's
Category 3. Measuring command, both sides:

```bash
docs/audit/scripts/bench-api.sh      # k6
```

## Your database is already at the right volume

`ship_lane_3` has been seeded **and augmented** to 600 documents / 170 issues / 25 users /
35 sprints — the exact volume the baseline was taken at, and above p.4's floor of
500+/100+/20+/10+.

**If you ever re-seed, you must re-augment**, or "same data volume" is violated and your
pair is invalid:

```bash
pnpm db:seed && node docs/audit/scripts/augment-seed.mjs
```

`pnpm test` truncates this database. Re-seed *and* re-augment after any api test run.

## Measurement lock — mandatory for this lane

You are the most load-sensitive lane on the machine. A P95 measured while five agents
compile is measuring contention, not your change, and Rule 1 (p.8) makes that pair
worthless.

```bash
scripts/measure-lock.sh acquire lane-3 1800   # blocks until it is your turn
trap 'scripts/measure-lock.sh release lane-3' EXIT
docs/audit/scripts/bench-api.sh > after.json
scripts/measure-lock.sh release lane-3
```

`acquire` also waits for the 1-minute load average to drop below 0.6/core before it
returns. If it warns that load was still high, record that in your CHANGES entry rather
than quietly reporting the number.

**Take a fresh before-measurement under the lock too.** The committed baseline was taken
on a different day; the honest pair is two runs you took yourself, back to back, under the
same lock.

## Known trap — read before benchmarking

The audit found latency **flat across all three concurrency levels** (10/25/50) because
the rate limiter binds before concurrency does. If you benchmark naively you will measure
the limiter, not the endpoint, and your −20% will not appear. Raise or bypass the limiter
identically on both sides of the pair, and say so in your writeup.

## You own

`api/src/routes/*.ts` handler bodies.

**Off limits:** `api/src/db/` and SQL inside repositories — **Lane 4 owns those** and is
targeting the same endpoints from the query side. If you both change the same path,
neither can claim identical conditions. Also off limits: `web/`, `terraform/`, `e2e/`,
dependency changes, and `CHANGES.md` (write `CHANGES/lane-3.md`).

## Done means

- [ ] ≥2 endpoints at −20% P95, measured under the lock
- [ ] Same data volume (600/170/25/35), same concurrency levels, same hardware
- [ ] Root cause documented per endpoint — p.5 requires it
- [ ] Before/after raw output committed under `docs/audit/raw/`
- [ ] `pnpm test` (461) and `pnpm --filter @ship/web exec vitest run` (174) pass
- [ ] `pnpm type-check`, `pnpm lint`, `pnpm build` exit 0

## Deliverables

1. Separately scoped commits (Rule 11, p.9).
2. `CHANGES/lane-3.md`: what changed, why the original was suboptimal, why yours is
   better, tradeoffs (Rule 9, p.9), root cause per endpoint, before/after.

## Rules

`docs/audit/implementation-rules.md` — all 11, verbatim.

Report back with the P95 pair for each endpoint, the command, and anything blocked.
