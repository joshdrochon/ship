# The Time-to-First-Event drill

> p.6: *"on a clean container, with only the published docs and the SDK, how long does it take a
> developer to go from nothing to a verified signed webhook in their terminal?"*
> p.14: *"The TTFE drill is the rubric."*

```bash
pnpm drill ttfe              # the loop, < 60 s budget            (PF-586)
pnpm drill ttfe --controls   # the negative controls              (PF-587, PF-607)
node scripts/ttfe/check-fitness.mjs   # no sleeps, retry: 0, one thresholds file
node scripts/ttfe/check-series.mjs    # the P95 gates
scripts/ttfe/soak.sh 20               # p.9's 20 consecutive runs
```

Nothing needs to be running first. The drill provisions a Postgres, applies 61 migrations, seeds the
three first-party apps, boots `api/src/index.ts` on a free port, and destroys all of it at teardown.
`DATABASE_URL` must **not** be set — see *Refusals*, below.

---

## What each stage asserts

p.6 names the six and this is their order. `STAGE_IDS` in
`integrations/cli/tests/ttfe/stages.ts` is the frozen list; a stage that does not report fails the
run rather than shortening it.

| # | Stage | Asserts (p.8's Evaluation Criteria row) |
|---|---|---|
| 1 | `install` | The packed tarball **resolves** through the `exports` map from outside the workspace, and **evaluates** (different failures — L99 F14 fails only the second); `tsc --noEmit` over a two-line consumer resolves the declarations; the installer's captured output carries no peer-dependency complaint |
| 2 | `login` | `onUserCode` is called with a non-empty code **and** a verification URL; the device poll completes; the credential **persists** — proven by building a second `ShipClient` from the store alone and calling `.me()`, not by reading the file back |
| 3 | `register_subscription` | `create()` returns an id a later `get` resolves; `signing_secret` is **present on create and absent from every later read**, asserted both ways in the same stage; the subscription appears in `GET /api/v1/webhooks`, which *is* the dev portal's data source (L22 consumes the public API and adds no privileged route) |
| 4 | `create_document` | `documents.create({ title: 'hello' })` — p.7's literal call — returns a document `documents.get` resolves |
| 5 | `receive_webhook` | A POST arrives on a real `http.Server`, carrying `Ship-Signature` and `Idempotency-Key`; **exactly one** delivery for that write (a stage asserting only "the document was created" passes green on a platform whose event bus is disconnected) |
| 6 | `verify_signature` | `verifyWebhook` returns `true` on the **bytes that actually arrived**; `false` on one flipped byte; `false` on a `t` 301 s old at the documented 300 s default |

Stage 6 runs against the received delivery and never a re-signed fixture. Golden vectors prove the
verifier agrees with the signer; this proves the **wire** agrees with both, which is the case vectors
structurally cannot cover.

**Testing Scenario 9 is one test, not six.** No stage is skippable and an unreached stage is a
failure rather than an absence — six `it()` blocks would let five green ones read as progress while
the sixth never ran.

**The same loop also runs through the CLI** (PF-611, second half). p.5 and p.6 both write the story
as `ship login` / `ship docs create` / `ship webhooks tail`, so the drill imports L19's exported
command functions (`runLogin`, `runDocsCreate`, `runWebhooksTail` — PF-581) with an injected output
sink and branches on PF-561's exit codes. It does not re-implement command logic and it does not
scrape a terminal: a drill that re-implements is timing a parallel path that can drift from what the
demo actually runs.

---

## Reading `test-results/ttfe.json`

```json
{
  "mode": "fast",
  "commit": "…",
  "startedAtIso": "…",
  "stages": [{ "id": "install", "elapsedMs": 1436.1 }, …],
  "totalMs": 6637.7,
  "pass": true,
  "metrics": {
    "eventToPostMs": 24.2,
    "verifySingleCallMs": 0.45,
    "setupMs": 3700,
    "loadAvg1": 14.22, "cpuCount": 10, "loadRatio": 1.422, "loadCertified": false,
    "stageSumMs": 6637.5, "interStageGapMs": 0.31, "reconciliationErrorMs": 0.05
  }
}
```

Four consumers read this one file — the per-run gate, the P95 series, the CI-minutes figure and the
submission evidence. Four consumers scraping four log formats is how a graded number quietly stops
being comparable between runs. Every run also appends one line to
`test-results/ttfe-series.jsonl`.

Three things worth knowing before quoting a number from it:

- **`totalMs` is first-stage-start → last-stage-end.** Booting the throwaway Ship is `setupMs` and
  is deliberately outside it: p.8's example sets `t0` before the install line. `setupMs` is what CI
  pays for; `totalMs` is what a developer waits for.
- **`reconciliationErrorMs` is the honesty check.** Stage times plus *measured* inter-stage gaps must
  reconcile with the total to within 1 ms. Five stages summing to 8 s inside a 55 s run is a
  measurement bug, and without this nobody sees it — the run still says "under 60 s".
- **`receive_webhook` is routinely ~0 ms and that is correct.** The POST usually lands while stage 4
  is still running its `documents.get`, so by the time stage 5 opens, the predicate is already
  satisfied. The delivery figure to quote is `metrics.eventToPostMs`, which is measured
  `documentCreatedAt → firstPostReceivedAt` and does not care where a stage boundary fell.

**Every timing carries the load it was taken under** (L99 F80). Above `loadRatio` 0.8 the number is
recorded but `loadCertified` is `false`, and nothing should quote it as a measurement of the
platform.

---

## Refusals — what the drill will not do

| Refusal | Why |
|---|---|
| Start with `DATABASE_URL` set | The harness provisions and **drops** a database. Adopting an inherited URL risks running migrations, seeds and a teardown `DROP` against a dev or deployed database. `TtfeForeignDatabaseError`, before a container is started, with the credential redacted. The check is on *presence*, not on the value: a harness that decided `ship_dev` "looks like" a dev database is one hostname away from dropping the wrong one |
| Start with `api/.env.local` present | `api/src/index.ts` loads it, so values in it become part of the measurement and "clean working directory" (p.6) stops being true |
| Retry | p.9's target is 0% flake, and a retry is the mechanism that converts a flake into a pass |

Concurrency is safe: the database name carries 8 bytes of entropy and the port is whatever the kernel
hands out for `listen(0)`, neither derived from a worker index or the clock. Two concurrent runs are
asserted not to collide, and both are asserted to leave nothing behind — the harness re-queries
`pg_database` after its `DROP` and exits non-zero if the database survived, so the drill's "exit 0"
is the teardown proof it cannot take itself (it may not hold a database client).

---

## The negative controls

`pnpm drill ttfe --controls`. p.11 claims the drill *"will catch contract regressions faster than any
unit test"* and p.14 asks for *"a bug the TTFE drill caught that your unit tests missed"* — both
assertions about a red path nobody had seen.

The defect: **the packed `exports` map resolves `.` to the browser build under every condition.**
Every file in the tarball is untouched and correct; only the map that chooses between them is wrong.
Resolution still succeeds — that is the trap — and evaluation yields a namespace with no
`verifyWebhook`. The drill goes red naming `install`. `pnpm --filter @ship/sdk test` on the same
commit stays green, because every test in `sdk/` imports TypeScript **source** through the workspace
and the `exports` map is consulted only by a resolver outside it. That resolver exists exactly once
in this repository: in the drill's install stage.

**One of PF-607's three suggested defects turned out not to be a defect.** "The packed `exports` map
loses its types entry" was tried first and did **not** turn the drill red: under
`moduleResolution: NodeNext`, TypeScript resolves the JS target of the matching condition and then
picks up an *adjacent* `index.d.ts`. A missing `types` condition is invisible whenever the
declaration sits beside the JavaScript, which it does here.

---

## The 20-run soak — p.9's flake target

p.9: *"Drill flake rate over 20 consecutive CI runs — 0% (any flake = bug in the drill or the
platform)."*

```bash
scripts/ttfe/soak.sh 20        # locally
```

In CI this is the **`ttfe-soak`** job. It runs the drill twenty times against one commit, each run
provisioning its own `postgres:16` container, then gates on `check-series.mjs --soak`, which refuses
to count anything until the window holds twenty runs of exactly **one** commit.

### Why the `ttfe` job alone could never produce this number

`ttfe` runs the drill once and calls `check-series.mjs`, which prints `TTFE series — 1 run(s) of the
last 20` and can print nothing else. `test-results/ttfe-series.jsonl` is written inside the job and
published as an artifact, so twenty pipelines make twenty one-line series and nothing joins them.
The soak script existed before the job did; no pipeline invoked it.

### What the soak is, and what it is not

**It is** twenty consecutive drill runs, in CI, on one commit, no retries, no re-runs, no filtering.
**It is not** twenty separate pipeline runs. The distinction is deliberate, and it is recorded here
rather than left for a reader to assume away:

- An accumulated window would span twenty **commits**, and `--soak` fails such a window on purpose —
  p.9 reads a flake as *"a bug in the drill or the platform"*, which is only decidable against a
  fixed commit. Twenty re-runs of one SHA would avoid that, at twenty times the queue.
- There is no carrier for an accumulated series anyway. This project's runner logs *"No URL provided,
  cache will not be uploaded to shared cache server"* in every job, so a branch-keyed `cache:` is not
  a durable record, and an artifact chain would make run twenty's verdict depend on nineteen
  artifact expiries.

### Cost, and where it runs

Measured, not estimated: job 67099 spent 20.4 s of wall clock inside `pnpm drill ttfe`, of which 7.5 s
was the graded total and the rest container start, migrations and server boot. Twenty is ~7 minutes.
p.15 asks for a daily CI-minute ceiling and there is one self-hosted runner, so `ttfe-soak` runs
automatically on `main` and on scheduled pipelines and is manual elsewhere — manual but
`allow_failure: false`, because GitLab defaults a manual job to `allow_failure: true` and a soak that
cannot fail the pipeline is a soak nobody has to look at.

### The record

`test-results/ttfe-soak.json` carries the provenance: `context` (`ci` or `local`), the run and pass
counts, the commit, and in CI the job and pipeline that produced it. p.9 grades *CI* runs, so where a
soak ran is part of its result and not metadata about it — an artifact that does not say what produced
it gets quoted as whichever kind of run the reader needed. The per-run series stays in
`test-results/ttfe-series.jsonl` beside it.

A failing run is **not** re-run to clear it. It stays in the series, the soak fails, and the
diagnosis names either the drill or the platform.

### Measured — job 67859

**20/20, flake rate 0%.** GitLab job [**67859**](https://labs.gauntletai.com/joshrochon/ship/-/jobs/67859),
pipeline **20338**, ref `pf/L20-flake-and-clean`, commit `93d6fe6`, 2026-08-15T22:53:41Z →
23:00:57Z (7 min 16 s of soak inside an 8.4 min job).

```
ttfe soak: 20/20 passed

TTFE series — 20 run(s) of the last 20
  pass rate            20/20
  totalMs P95          8500 ms  (budget 60000)
  event→POST P95       30 ms  (budget 2000)
  load-certified runs  0/20
```

Verified from the published artifacts rather than from the job's status badge: `ttfe-series.jsonl`
holds 20 lines, every one `mode: fast`, every one commit `93d6fe64`, `pass` true on all 20, totals
spanning 7358–10339 ms. `ttfe-soak.json` reads `"context": "ci"`, `"ciJobId": "67859"`.

**Two caveats, neither of them small.**

1. **This is twenty consecutive drill runs inside one CI job, not twenty separate pipeline runs.**
   The reasoning is above. Anyone quoting the 0% should quote that sentence with it.
2. **Every sample is above F80's load veto** — `load-certified 0/20`. The job prints `uptime` at
   both ends: **1-minute load 11.97 at start, 10.80 at end** (5-minute 13.01 → 11.93, 15-minute
   12.65 → 12.36) on a 10-core box, because three other pipelines shared the runner. An earlier
   revision of this line quoted the range as *"10.8–12.4"*, which took the low end from the 1-minute
   average and the high end from the 15-minute one — three different windows are printed and mixing
   them is not a range of anything. This does **not** weaken the flake
   verdict: a pass is a pass however loaded the machine, and contention makes flake *more* likely,
   not less, so 20/20 under load is the stronger version of the result. It does mean the 8500 ms P95
   is a measurement of a contended machine and is not quotable as a platform timing. The 7× margin
   against the 60 s budget makes the verdict safe either way. L99 F134.

---

## Clean mode (`--clean`) — shipped 2026-08-16, and it closes one conjunct of two

`pnpm drill ttfe --clean` **runs**. It used to exit 2 with a message, and this section used to be
that message's footnote.

**Measured, twice, on this machine:**

```
  mode                 clean
  install                    7066 ms
  login                      5126 ms
  register_subscription        75 ms
  create_document             118 ms
  receive_webhook               0 ms
  verify_signature              3 ms
  graded total              12393 ms   (0.21 min of a 30 min budget)
  setup (not graded)        13465 ms
  container wall clock      20199 ms
```

An earlier run of the same build: graded total **11467 ms**, install 5995 ms, login 5257 ms. Both
runs pass. `test-results/ttfe.json` carries `"mode": "clean"` and
`scripts/ttfe/check-series.mjs` filters the 60 s P95 window to `mode === 'fast'`, so these figures
can never be averaged into the fast mode's.

**The number is not load-certified, and that is stated for the same reason the soak's is.**
`loadRatio` was **1.608** on a 10-core box (`loadAvg1` 16.08), well over F80's 0.8 veto — the API
suite was running concurrently. Under the veto the timing is not quotable as a platform
measurement. The verdict is safe anyway: 0.21 min against a 30 min budget is a **145× margin**, and
contention only ever makes the number worse.

### What `--clean` actually does, and how each claim is checked

PF-590 names four properties. All four are done rather than aliased onto the fast path, and each
lands in the artifact so a reader need not take the flag's word for it:

| PF-590 asks for | How it is done | Recorded as |
|---|---|---|
| cold `node:22-bookworm` container, **no bind mount of the repo** | `scripts/ttfe/clean-runner.mjs` passes no `-v`, no `--mount`, no `--network`; a unit test greps the docker argument list for them | `repoBindMounted: false` |
| **empty pnpm store** | a consequence of a fresh container, not a flag: pnpm itself is fetched by `corepack prepare pnpm@10.27.0` inside it | `pnpmStoreWarm: false` |
| the packed tarball **served over HTTP** | a one-file static server on the host serves `/ship-sdk.tgz`; the container runs `pnpm add http://…/ship-sdk.tgz` | `tarballOverHttp: true` |
| **no prebuilt `dist`** | `sdk/dist` **and its `.tsbuildinfo`** are removed and the SDK rebuilt from source before packing | `sdkRebuiltFromSource: true` |

The Ship instance is booted by `scripts/ttfe/harness.ts` on the **host** and reached from the
container over the network — PF-590's own words, *"It reaches the Ship instance over the network
like any external consumer."* Booting it is setup and lands in `setupMs`, never in the graded
total, exactly as fast mode treats it.

The container runs `scripts/ttfe/clean/consumer.mjs`, fetched over the same HTTP server. It is a
second copy of the six-stage loop written against `@ship/sdk` and node builtins alone, because the
drill spec imports this repository's test support and L19's CLI commands and neither exists inside
a container with no repo mounted. `integrations/cli/tests/cleanConsumerParity.test.ts` asserts the
two copies agree on the six stage ids and their order, on the pinned pnpm version, and on the two
stdout prefixes — a second six-stage loop with nothing checking it is a second loop that stops
being the same one.

### Three things the first runs found, recorded because they were real bugs

1. **Deleting `sdk/dist` alone is not a rebuild.** `sdk/tsconfig.tsbuildinfo` survived, tsc
   concluded the project was up to date, emitted nothing for the ESM half and exited 0. `sdk/dist`
   then held only `cjs/`, so the packed tarball's `exports.import` and `types` entries both pointed
   at files not in it. The runner now removes the build info too and asserts `dist/index.js`,
   `dist/index.d.ts` and `dist/cjs/index.js` exist before packing.
2. **The verification URL is not the URL the consumer dialled, and that is correct.** The container
   reaches Ship at `host.docker.internal:PORT`; Ship advertises itself at its own `APP_BASE_URL`,
   `127.0.0.1:PORT`. The fast drill's `expect(verifyUrl).toContain(baseUrl)` is host-specific and
   false here for an honest reason — any consumer behind a NAT, proxy or container boundary sees the
   same thing. The clean consumer checks the parts that must hold for a human to finish the flow: an
   absolute http(s) URL, same port, carrying the user code.
3. **A stage that threw was reported as the stage after it.** The failing id was inferred from
   `records.length`, and the recorder's `finally` had already counted the stage that threw. Now
   tracked explicitly, which is what PF-593 asks for.

### The clause has two conjuncts. One is now closed; the other is not, and cannot be by a script

p.8 reads *"≤ 30 min on a clean machine following only the published docs"*; p.6 writes the same
target as *"clean machine, docs only"*. That is an AND:

| Conjunct | What would satisfy it | Status |
|---|---|---|
| *"on a clean machine"* | cold container, no repo bind mount, empty pnpm store, tarball over the network | **CLOSED** — PF-590, `pnpm drill ttfe --clean`, 0.21 min of 30 |
| *"following only the published docs"* | a newcomer reaching a verified webhook using nothing but what is published | **OPEN** — PF-601 |

The second is not a scripting problem. The failure mode the 30-minute number measures is *a step
that is missing from the docs*, and any script is written by someone who already knows the step —
including this one. A harness that extracted its commands from the fenced blocks in the docs would
come closer, since an omitted command would then fail the run, but it still could not fail on a
missing prerequisite, an ambiguous instruction, or a stated assumption a stranger does not share,
and the author still chooses which document and which fences count.

Two further gaps in `--clean` itself, named rather than left for a reader to find:

- **The device grant is approved out of band by the host**, which holds the database the container
  deliberately does not. PF-595's audit note asks for that to be stated; it is the one step a
  scripted drill cannot perform the way a human does.
- **The base image was already present locally** on both runs (`imageWasCached: true`,
  `imagePullMs: 209`). A machine that has never pulled `node:22-bookworm` pays ~1.6 GB first. The
  runner times and records the pull separately rather than folding it into either figure — obtaining
  a base image is part of owning a computer, not part of the developer's loop — but a reader
  budgeting for a genuinely bare machine should add it.

So the verdict, restated at the precision the evidence supports:

> **"on a clean machine" — MET, and measured: 0.21 min against a 30 min budget, twice, from a cold
> container with no repo mounted, a cold pnpm store, the tarball over HTTP and the SDK rebuilt from
> source. Not load-certified (ratio 1.608).**
>
> **"following only the published docs" — UNMET. No script can close it.** It needs one person, one
> clean machine, a stopwatch and a log of every documentation gap hit — PF-601, roughly an hour of
> someone's time.

The fast mode's totals (~7 s graded, ~20 s wall clock) belong to p.8's *< 60 s in CI* row and must
never be quoted against either half of this one. That is why every run carries a `mode` field.

---

## Not done, and why

- **PF-601 — the human-timed clean-machine run.** p.6 frames the claim as *"with only the published
  docs and the SDK"*, which is a statement about **documentation**: a script cannot discover that a
  step is missing from the README, and that is the failure mode the 30-minute number actually
  measures. It needs one person, one clean machine, a stopwatch, and a log of every documentation
  gap hit. Nothing in this repository can substitute for it. If only one of `--clean` and the human
  run survives a scope cut, keep the human run — a green `--clean` with an undocumented step still
  means the platform is a curl tutorial to a stranger.
- **PF-590 — `--clean` itself.** Above.
- **PF-610 — the durable link to a green `ttfe` job.** The job is wired on both platforms and
  blocking; the *link* has to come from a real pipeline run, and it has to still resolve when a
  grader clicks it. This repository has already shipped a submission whose first link 404'd for the
  whole window in which every other check was green, which is why `.gitlab-ci.yml` grew a
  `doc-links` job.
