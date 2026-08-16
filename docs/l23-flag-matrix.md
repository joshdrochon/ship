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
| `data/rewireCost.test.ts` | 8 | ← added 2026-08-16; the rows summed to 222 against a measured total of 230, and this file was the missing 8 |
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
| `actions/act.test.ts` | 11 | ← moved from bucket 2, 2026-08-15 |
| `actions/client.test.ts` | 20 | ← moved from bucket 2, 2026-08-15 |
| **Total** | **230** |

Plus `e2e/fleetgraph-chat.spec.ts`, which drives the on-demand path and touches
no action at all.

**Measured both ways, 2026-08-15:** 230/230 with the flag off, 230/230 with the
flag on, via `./scripts/agent-flag-matrix.sh` (exit 0, ~2 min). The count was
191 when this document was written and is 230 now for two reasons: tests were
added to the suite (191 → 199), and `act.test.ts` + `client.test.ts` moved in
from bucket 2 after being measured green flag-on (199 → 230).

## Bucket 2 — one state. Now one file, not three.

**Corrected 2026-08-15 by measurement.** Bucket 2 was authored as three files on
the argument that each *instantiates an implementation directly and is therefore
a test of that implementation*. The argument is tidy. Two of the three files do
not need it, and running them is what showed that.

The rule bucket 2 is held to now: **a file is excluded only if it has been
measured to fail in the other state, and the measurement is in this table.** An
argument is not sufficient. An exclusion list that skips files which would have
passed does not make the matrix safer — it narrows what the matrix is permitted
to prove, for free, and it is indistinguishable to a reviewer from a list that
skips the files that would fail.

| File | Tests | Measured flag-on | Verdict |
|---|---|---|---|
| `actions/act.test.ts` | 11 | **11/11 pass** | **Moved to bucket 1.** Stubs `FetchLike`, never reaches the composition root, so the flag never touches it |
| `actions/client.test.ts` | 20 | **20/20 pass** | **Moved to bucket 1.** Same — the retry ladder, breaker and allowlist are all below the seam |
| `entrypoints/cron.test.ts` | 6 | **5 fail, 1 passes** | **Stays.** The one entry the rule keeps — see below |

Bucket 1 is therefore **230** tests, not 191, and the matrix covers 230 of the
agent suite's 236. `git log -S` on `scripts/agent-flag-matrix.sh` shows the list
shrinking from three entries to one.

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

Three alternatives were considered and rejected:

- **Set `AGENT_CLIENT_SECRET` in the test environment.** The obvious fix, and it
  does not work — it relocates the failure rather than removing it. Measured
  2026-08-15 with `SHIP_AGENT_VIA_SDK=1 AGENT_CLIENT_SECRET=dummy-secret`: the
  same five tests fail, now at

  ```
  ShipError: Client credentials exchange failed (invalid_client):
  Client authentication failed.
  ```

  because flag-on the composition root does a real RFC 6749 §4.4 exchange, which
  needs a **running API server with a seeded first-party app**. `cron.test.ts`
  starts a Postgres container and nothing else. Making this leg pass means
  standing up the API inside a unit test — that is the `cli-server-suite` shape,
  not this one, and it is what closing this gap would actually cost.
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

**`.gitlab-ci.yml` → job `agent-flag-matrix`, stage `verify`, `needs: ['build']`,
`allow_failure: false`.** It runs `./scripts/agent-flag-matrix.sh`, and it is the
answer to p.17 §2.6.

> **Until 2026-08-15 this section described a script no pipeline ran.** The
> script existed and its header claimed to be the proof, but
> `grep -nE "agent-flag-matrix|SHIP_AGENT_VIA_SDK" .gitlab-ci.yml` matched
> nothing across all 27 jobs the file then defined (it defines **28** now, this
> job being the addition), and `agent-test` ran the suite exactly once at the
> flag's default — OFF. A proof script no pipeline invokes proves whatever the
> reader assumes it proves. Recorded rather than quietly fixed, because "the
> script exists" and "CI runs it" are different claims and only the second
> answers the PRD's question.

**Not a `parallel: matrix` on `agent-test`.** That is the obvious wiring and it
is wrong here: `agent-test` runs the *whole* agent suite, `cron.test.ts`
included, so a `SHIP_AGENT_VIA_SDK: ['0','1']` matrix on it would be red flag-on
from the first run, for the reason documented above. `agent-test` keeps running
the whole suite once at the default; this job runs the flag-invariant 230 twice.

Two anti-vacuity guards live in the script rather than the YAML so they cannot be
lost in a job edit, because a matrix that runs zero tests in one leg is green and
meaningless:

1. **A floor on the test count per leg** — `MIN_BUCKET_1_TESTS=200`, asserted
   inline against `numTotalTests` from vitest's JSON reporter. (The guard is in
   the script itself, not `scripts/assert-tests-ran.sh`; an earlier draft of this
   section named that helper and the script never used it.) L99's F28 records
   that a zero-stage run otherwise reads as a pass. The floor sits below the
   current 230 so adding a test does not break CI, and far above zero so a
   filter that matched nothing does.
2. **Both legs must report the same count.** A leg that quietly skipped the
   flag-sensitive files would otherwise pass for the wrong reason — the exact
   failure this script exists to catch in the code it tests.
3. **A break-it check.** Breaking the SDK reader must turn the flag-on leg red
   while the flag-off leg stays green. Verified by hand on this branch by
   returning `[]` from `issuesInState`: `citizenReader.test.ts` failed flag-on
   (`expected [] to have length above 0`) and passed flag-off, because flag-off
   never constructs the reader.

`cron.test.ts` — the whole of bucket 2 — runs once, flag-off, inside `agent-test`.
