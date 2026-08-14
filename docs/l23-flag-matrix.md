# Part 2's suite under `SHIP_AGENT_VIA_SDK` — the three buckets

**PF-705, PF-706, PF-707.** PRD p.11 requires the Epic 7 rewire to land *"behind
a feature flag so Part 2's tests pass with the flag on or off"*, and p.17 asks
*"How does CI prove Part 2's tests pass with the flag both on and off?"*

That cannot be answered without knowing which tests are flag-sensitive, so this
is the inventory. **Counts are measured, not estimated** — `vitest --reporter=json`
over `agent/src/**/*.test.ts` on 2026-08-14.

## The headline, stated the way it has to be stated

> Part 2's suite passes with the flag on and off **at the suite level, with one
> e2e assertion forked and named, and one composition-root spec running in its
> own state.** It is **not** byte-for-byte identical in both states, and any
> write-up claiming otherwise is false.

That sentence is the single easiest false statement to make in this epic, which
is why it is written out here rather than summarised.

## Bucket 1 — flag-invariant. Must pass in BOTH states.

These assert the agent's *behaviour*: what it measures, what it decides, what it
refuses. None of them constructs a transport, so none of them cares which reader
or which act implementation is behind the seam.

| File | Tests |
|---|---|
| `actions/autonomy.test.ts` | 8 |
| `actions/restart.test.ts` | 3 |
| `actions/suppression.test.ts` | 4 |
| `actions/readOnlyAct.test.ts` | 15 |
| `data/boundary.test.ts` | 11 |
| `data/citizenReader.test.ts` | 14 |
| `detectors/fingerprint.test.ts` | 10 |
| `detectors/index.test.ts` | 6 |
| `detectors/loadImbalance.test.ts` | 14 |
| `detectors/sprintMissRisk.test.ts` | 17 |
| `detectors/stalledWork.test.ts` | 9 |
| `flagSite.test.ts` | 13 |
| `graph/index.test.ts` | 6 |
| `graph/nodes/escalate.test.ts` | 9 |
| `graph/use-cases.test.ts` | 8 |
| `index.test.ts` | 3 |
| `llm/answer.test.ts` | 8 |
| `llm/client.test.ts` | 7 |
| `llm/converse-mock.test.ts` | 3 |
| `llm/judge.test.ts` | 14 |
| `observability/tracing.test.ts` | 9 |
| **Total** | **191** |

Plus `e2e/fleetgraph-chat.spec.ts`, which drives the on-demand path and touches
no action at all.

**Measured both ways:** 191/191 with the flag off, 191/191 with the flag on.

## Bucket 2 — transport-specific. One state, by construction.

These instantiate an implementation directly and are therefore tests *of* that
implementation. Running them in the other state would not be a stronger check;
it would be a test of something they are not about.

| File | Tests | Which state, and why |
|---|---|---|
| `actions/act.test.ts` | 11 | Constructs `makeShipAct` with a stubbed `FetchLike` and asserts the HTTP shapes. It IS the flag-off action path |
| `actions/client.test.ts` | 20 | The retry ladder, the circuit breaker, the `SINGLE_DOCUMENT_PATH` allowlist. Same |
| `entrypoints/cron.test.ts` | 6 | **Found by running it — see below** |
| **Total** | **37** | |

### ⚑ `cron.test.ts` is a bucket-2 member PF-705 did not predict

PF-705's authoring-time prediction was that bucket 3 held exactly one member and
said a list that comes back empty is a finding to re-check. The finding turned
out to be in the *other* bucket.

Measured: with the flag on, five of `cron.test.ts`'s six tests fail with

```
[fleetgraph] SHIP_AGENT_VIA_SDK is on but AGENT_CLIENT_SECRET is not set.
```

which is the composition root refusing to run the rewired agent without a
credential — **working exactly as designed** (`cron.ts`, `resolveReader`). These
tests call `scanWorkspace()` without injecting `db`, so they exercise the
composition root itself, and the composition root is the one place the flag
lives. A test of the flag-off composition is a transport test whatever its
assertions are about.

Two alternatives were considered and rejected:

- **Inject `db` into `cron.test.ts` so it becomes flag-invariant.** It would
  work, and it would edit a Part 2 test to make a claim about Part 2's tests
  come out nicer. PF-708's whole point is that the old path survives untouched.
- **Make the flag-on path fall back to SQL when no credential is present.** This
  is the dangerous one and it is worth naming: the suite would go green, every
  run would read over SQL, and every audit assertion in PF-709 would pass
  vacuously *because there would be no rows to contradict it*. A green matrix
  proving nothing is worse than an honest one member wider.

## Bucket 3 — genuinely conflicting. Forked and named.

Exactly one, and it is a **"no"** rather than a technicality.

| Assertion | Why it cannot pass in both states |
|---|---|
| `e2e/fleetgraph-agent.spec.ts:431–443` | Fetches `GET /api/documents/{weekId}/comments` and asserts a comment exists carrying `— FleetGraph` and the measurement. Under D5b there is no comment, so this is **false by design** flag-on |

**It is forked, not deleted.** Flag-off asserts the comment exactly as today;
flag-on asserts a `kind='recommendation'` row (migration 075) carrying the same
measurement string. Both halves assert the *same underlying property* — the
finding reached a human — which is what the original test was protecting.

If a later pass finds bucket 3 has more than one member, **that is a real finding
and this document changes with it.** Do not let the count go stale.

## The CI matrix

`scripts/agent-flag-matrix.sh` runs bucket 1 twice, once per state, both
blocking. Two anti-vacuity guards, because a matrix that runs zero tests in one
leg is green and meaningless:

1. **A non-zero test count per leg**, via `scripts/assert-tests-ran.sh` — L99's
   F28 records that a zero-stage run otherwise reads as a pass.
2. **A break-it check.** Breaking the SDK reader must turn the flag-on leg red
   while the flag-off leg stays green. Verified by hand on this branch by
   returning `[]` from `issuesInState`: `citizenReader.test.ts` failed flag-on
   (`expected [] to have length above 0`) and passed flag-off, because flag-off
   never constructs the reader.

Bucket 2 runs once, in its own state, and the job name says so.
