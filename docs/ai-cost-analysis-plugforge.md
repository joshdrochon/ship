# AI Cost Analysis — PlugForge (Week 6)

PRD p.13: *"Tracked dev spend, production projections table, explicit assumptions for
webhook fanout, agent active rate, and storage retention."* The structure below is p.9's,
not one of my own choosing: **Development & Testing Costs to Track**, **Production Cost
Projections** at p.9's four tiers, and the three assumptions p.9–p.10 name.

> `docs/ai-cost-analysis.md` is the **Week 5** document (it cites the ShipShape brief).
> Neither supersedes the other.

---

## The headline discipline, proven rather than asserted

p.9: *"the platform itself does zero AI work."* p.11: *"The platform never invokes the
LLM."* This is the one claim here a reader can falsify in thirty seconds, so it goes first
and it goes as a command:

```
$ grep -rlE "@langchain|anthropic|openai" api/src/platform/ | wc -l
0

$ grep -rlE "@langchain" agent/src | wc -l
10
```

Zero files under `api/src/platform/**` reach for an LLM client; ten under `agent/src` do.
p.9's *"cost scales with agent activity, not platform traffic"* is therefore a structural
property, not a policy someone has to remember.

---

## 1. Development & Testing Costs to Track

p.9 names five. Each is measured, not estimated.

### LLM API spend during the agent rewire (Epic 7)

**Production: $0.00, established. Development: not established — see the gap below.**

**First, what the agent actually calls.** The provider is chosen at
`agent/src/llm/client.ts:181`, and the direct Anthropic API is the *primary*:

```
$ grep -n "BEDROCK_ENDPOINT) return\|ANTHROPIC_API_KEY) return\|buildAnthropicModel()\|new ChatAnthropic" agent/src/llm/client.ts
180:  if (env.BEDROCK_ENDPOINT) return 'bedrock';
181:  if (env.ANTHROPIC_API_KEY) return 'anthropic';
220:      selectProvider() === 'anthropic' ? buildAnthropicModel() : buildBedrockModel();
248:function buildAnthropicModel(): BaseChatModel {
249:  return new ChatAnthropic({
```

Bedrock is the fallback, kept so `BEDROCK_ENDPOINT` can steer CI and `./start.sh` at the
local mock. **That matters for the measurement**: direct Anthropic API calls bill to
Anthropic, not to AWS, so nothing on the Anthropic path can appear in Cost Explorer.

**The AWS query, and what it does and does not cover:**

```
$ aws ce get-cost-and-usage --time-period Start=2026-08-08,End=2026-08-16 \
    --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
```

No Amazon Bedrock line appears at all — not a zero row, no row; total AWS for the window
is **−$0.0000031** net of credits. That is conclusive **for the Bedrock path and for
nothing else.**

**Production is still zero, by a different check.** The deployed environment carries four
application variables (`AWS_REGION`, `ENVIRONMENT`, `NODE_ENV`, `PORT`) — no
`ANTHROPIC_API_KEY`, no `BEDROCK_ENDPOINT`. `selectProvider()` therefore falls to
`bedrock` with no credential, the model client fails to initialise, and judgement degrades
to `ai_unavailable` (`client.ts:214–228`). Nothing is billed on either provider because
nothing can be called.

**The gap: p.9 asks about *development* spend, and development is where the key is.**

```
$ grep -c '^ANTHROPIC_API_KEY=' .env agent/.env
.env:1
agent/.env:1
```

Both files are gitignored and untracked, and `start.sh:207` deliberately does **not** point
`BEDROCK_ENDPOINT` at the mock ("a mocked run reports success and produces no finding —
indistinguishable from a healthy project, while proving nothing"). So a local `./start.sh`
resolves to `'anthropic'` and issues a real, billed call.

**I cannot measure that spend and will not report a zero for it.** No instrument in this
repository records it: it does not reach AWS, the agent writes no token ledger, and the
only authoritative source is the Anthropic Console's billing page, which is outside CI and
outside this document's re-runnable standard. What can be bounded from the code is the
shape, not the total:

| | Value | Source |
|---|---|---:|
| Model | `claude-opus-4-5` | `client.ts:107` |
| Calls per judged turn | 1 | `judge.ts:147`, `answer.ts:65` |
| `MAX_TOKENS` | 2,048 | `client.ts:113` |
| `MAX_ATTEMPTS` (retries on 429/5xx) | 3 | `client.ts:117` |
| Scans run on a dev machine in the window | **unrecorded** | — |

The last row is why there is no total. An honest gap is worth more here than a zero taken
from an instrument that cannot see the provider in use.

**What remains a gap is the per-day *dollar* series, and only that.** p.9's bullet has two
halves. The spend half is unmeasurable here and is stated as a gap above rather than filled
with a zero. The **token-volume half is measured**, and it is next.

### The rewire's effect on token volume — measured, and it refutes p.9's hypothesis

p.9 asks to *"confirm the rewire does not change token volume."* **It does change it. The
measurement exists in this repository, it is deterministic, it costs nothing to run, and it
refutes the claim rather than confirming it.**

**An earlier version of this section argued the opposite, by construction rather than by
measurement:** `grep -rn SHIP_AGENT_VIA_SDK agent/src/llm/` returns **0 hits**, the flag is
read in exactly one place (`agent/src/composition.ts:44`), so — the argument went — the
rewire moved the data path and not the prompt. **Both facts are true and the conclusion drawn
from them is false.**

**The reason the argument fails is worth stating, because it is the trap.** The prompt is not
written by the LLM layer. It is *rendered from data the rewired path fetched*.
`renderJudgeInput` (`agent/src/llm/prompts/judge.ts:150`) is a pure function of
`{signals, participants, scope}`, and the agent makes exactly one call per turn — so the
input volume per turn **is** that string. Grepping `agent/src/llm/` proves the *template* is
untouched. It says nothing about the *content*, which arrives through the seam the rewire
replaced. Swap the reader underneath and the string can move. It does:

```
$ cd agent && npx vitest run src/data/rewireCost.test.ts
[PF-711] judge prompt, same fixture, 27 signals — flag-off 10727 chars, flag-on 10376 chars,
delta -351 chars (-3.27%). Cause: F143 — 13 started_at lines dropped, 351 chars, which is
the WHOLE delta.

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

| Judge prompt, one 42-issue fixture, 27 signals | Flag **off** (SQL) | Flag **on** (SDK) | Delta |
|---|---:|---:|---:|
| Input volume per turn | 10,727 chars | 10,376 chars | **−351 chars (−3.27%)** |

**The whole delta is attributed to one named cause, and the test asserts that exactly.**
`issueSchema` carries no `started_at`, so `stalledWork`'s `context.started_at` renders as an
ISO date on the SQL path and as `null` on the SDK path, and `renderSignal` drops null context
entries: 13 signals × one dropped line = 351 chars. The assertion is `before - after ===`
the sum reconstructed from the signals themselves — **not a threshold somebody picked.** It
carries a control: `reviewBottleneck`, which reads no field `issueSchema` lacks, renders
**byte-identically** on both paths, which is what makes the `stalledWork` delta attributable
rather than ambient.

**Characters, not tokens, and this document does not convert between them.** There is no
tokenizer in this repository. A tokenizer would move the absolute figures by its own ratio;
it would not change the delta's sign or its cause, which is what p.9 asks to confirm. **No
token count is stated here because none was measured** — the label on these numbers is
`chars`, and it is the unit that was counted.

**So: the rewire changes input volume per turn by −3.3% on this fixture, in the agent's
favour, and p.9's hypothesis is refuted rather than confirmed** — cheaply, deterministically,
and without a single billed API call. A rewire that moved token volume and said nothing is
precisely what that p.9 bullet exists to catch; here it moved, and this is the saying.

### CI minutes for the TTFE drill

p.9: *"Time it on Day 1 and budget the weekly CI bill explicitly."*

**Day 1 of the drill is not Day 1 of the week.** The `ttfe` job entered `.gitlab-ci.yml` on
2026-08-14, the third day of PlugForge work:

```
$ git log --oneline --reverse -S"ttfe" -- .gitlab-ci.yml
06cdc49 feat(L20): the TTFE drill, run end to end [PF-586-611, F130-F134]

$ git log -1 --format=%ad --date=iso 06cdc49
2026-08-14 01:07:41 -0500
```

The project's first pipeline is 17378 (2026-07-30) and the first `pf/` pipeline is 19276
(2026-08-12); neither could run a job that did not exist yet. So there is no Day-1-of-the-week
figure to report, and inventing one would be worse than saying so. The earliest run that
exists is pipeline **19893**, and that is the Day-1 number:

| | Day 1 — pipeline 19893 | Last crashed run — pipeline 20223 | First green run — pipeline 20237 |
|---|---:|---:|---:|
| Date (UTC) | 2026-08-14 15:15 | 2026-08-15 15:26 | 2026-08-15 17:51 |
| `ttfe` | 69.9 s | 27.9 s | **56.4 s** |
| `ttfe-controls` | 32.9 s | 22.5 s | **50.1 s** |
| **TTFE subtotal, per pipeline** | **102.8 s** | **50.4 s** | **106.5 s** |

**Only the third column times the drill.** The first two are the cost of crashing; see
below.

```
$ glab api "projects/joshrochon%2Fship/pipelines/19893/jobs?per_page=100" \
    --repo joshrochon/ship --hostname labs.gauntletai.com
$ glab api "projects/joshrochon%2Fship/pipelines/20223/jobs?per_page=100" \
    --repo joshrochon/ship --hostname labs.gauntletai.com
```

> **Every `glab` line in this document carries `--hostname labs.gauntletai.com`, and it is
> load-bearing.** `--repo joshrochon/ship` alone resolves against the *current directory's*
> git remotes, so these commands work inside the repo and silently 404 against gitlab.com
> from anywhere else. Verified by running the same call from a scratch directory: without
> the flag, `404 Project Not Found`; with it, the job array.

**Neither of the first two numbers times the drill.** Both jobs died before it ran, and this
is the trace that says so:

```
$ glab api "projects/joshrochon%2Fship/jobs/65064/trace" \
    --repo joshrochon/ship --hostname labs.gauntletai.com
$ node scripts/ttfe/check-fitness.mjs
ttfe fitness OK — 15 file(s): no sleeps, retry: 0, no Playwright, one thresholds file
$ docker pull postgres:16
/usr/bin/bash: line 196: docker: command not found
ERROR: Job failed: exit code 127
```

**Exit 127 at that line in 70 of the 72 `ttfe`/`ttfe-controls` jobs that ran** — not in all
of them. The two exceptions are jobs **65807** and **65808**, in pipeline 20073, which never
reached the script at all: they died pulling their own container image.

```
$ glab api "projects/joshrochon%2Fship/jobs/65807/trace" \
    --repo joshrochon/ship --hostname labs.gauntletai.com | grep -i 'ERROR'
ERROR: Job failed: failed to pull image "node:22-bookworm" … 429 Too Many Requests
```

That is a Docker Hub rate limit, not the missing binary, and it is why those two jobs are
2.5 s and 2.8 s rather than ~28 s. **It changes nothing about the core finding** — a job
that dies at image pull has run even less of the drill than one that dies at `docker pull
postgres:16`. The runner has no Docker binary, the drill provisions its Postgres through
testcontainers, and both jobs are `allow_failure: false`, so the pipeline has been red on
them since the day they landed.

**For most of this project the TTFE drill never executed in CI, and it executes now.** Both
halves are true and the history is the more useful half, so it is kept.

*What was measured when this section was first written.* Every one of the 72 completed
`ttfe`/`ttfe-controls` jobs up to that point was read, and none reached the drill: 70 exit
127 at `docker pull postgres:16`, 2 die earlier on a Docker Hub 429. Across pipelines
19893–20223 — 35 of them, unbroken from the day the job landed — **not one run of the drill
ever happened**, and p.13's *"For Epic 6, proof is the TTFE drill passing in CI"* had no
artifact behind it. The two 429 jobs got *less* far than the rest, not more.

*What is true now.* The pre-pull was the whole defect: the runner mounts the Docker socket
but `node:22-bookworm` ships no `docker` CLI, and testcontainers never wanted one — it
speaks the Engine API over the socket through dockerode. Deleting the `docker pull
postgres:16` line (`774ab9d`) turned the job green with nothing else changed. **First green
run: job 66739, pipeline 20237, `success` in 56.375 s, finished 2026-08-15 17:51:03 UTC.**
Thirteen `ttfe` and thirteen `ttfe-controls` jobs have succeeded since, job 68257 the most
recent. p.9's flake target has its own artifact too: `ttfe-soak` job 67859, 20/20 passes on
one commit, and job 68258 after it. **Epic 6's proof exists and is on `main`.**

*What the pre-fix durations in the table above measure* is therefore checkout, `pnpm
install`, `tsc -p tsconfig.drill.json` and `check-fitness.mjs`, then the crash — the 69.9 s
→ 27.9 s "improvement" is pnpm cache warmth, not a faster drill. Across the **36 pipelines
whose `ttfe` pair ran to completion before the fix**, `ttfe` had a median of 28.4 s (range
2.5–69.9) and `ttfe-controls` 24.9 s (2.8–52.1) — the shape of install variance, with none
of the drill in it. **Over the 13 green runs the same medians are `ttfe` 62.8 s (range
56.4–109.7) and `ttfe-controls` 60.0 s (49.9–89.4)**: roughly a doubling, and that
difference is the drill.

**The weekly bill.** 62 pipelines ran in the trailing seven days — counted from the pipeline
list, not extrapolated from a PR rate. The window is frozen at pipelines **18500 → 20224**,
`created_at >= 2026-08-08`, snapshotted **2026-08-15 16:17 UTC**.

**The bill is summed, not extrapolated.** An earlier version of this table took one
pipeline's total (20044, 17.1 min) and multiplied it by 62. That is wrong by 3.3×, and the
reason is instructive: **20044 is an early-failing pipeline.** Six of its nineteen jobs were
canceled — four of them before they started, recording no duration at all — and its `e2e`
job was killed at **66.5 s** against a median *successful* `e2e` of **2,315.5 s** (n=28).
Multiplying an outlier by 62 measures the outlier, not the week.

Summing the actual per-job durations across all 62 pipelines instead:

```
$ mkdir -p jobs && for p in 1 2; do glab api \
    "projects/joshrochon%2Fship/pipelines?per_page=100&page=$p" \
    --repo joshrochon/ship --hostname labs.gauntletai.com; done \
  | python3 -c "import json,sys; [print(x['id']) for x in json.load(sys.stdin) \
      if x['created_at'] >= '2026-08-08' and x['id'] <= 20224]" > ids.txt
$ wc -l < ids.txt
62
$ while read id; do glab api \
    "projects/joshrochon%2Fship/pipelines/$id/jobs?per_page=100" \
    --repo joshrochon/ship --hostname labs.gauntletai.com > jobs/$id.json; done < ids.txt
$ python3 -c "import json,glob; print(sum(j['duration'] for f in glob.glob('jobs/*.json') \
    for j in json.load(open(f)) if j.get('duration')) / 3600)"
59.37705993266722
```

| | |
|---|---:|
| Pipelines, 7 days to 2026-08-15 | 62 |
| Jobs across them | 1,072 (97 with no duration — canceled or skipped before start) |
| **All CI, weekly — summed job time** | **59.4 h** |
| Median per-pipeline job time | 58.2 min |
| — of which `e2e` | 37.3 h (63%) |
| — of which `test` | 3.9 h (7%) |
| — of which `regression-budget` | 1.1 h (2%) |
| — of which `ttfe` + `ttfe-controls` | 0.59 h (1.0%) |

**59.4 h is a floor, and the run above proves it rather than asserting it.** The same
command executed seven minutes earlier returned **58.52 h**: four pipelines (20219, 20221,
20223, 20224) were still running and still accruing. Anyone re-running this will get a
larger number, not a matching one — which is the correct behaviour for a summed figure over
a window whose tail is still open, and the reason the snapshot instant is printed above.

`e2e` is where the week goes — not `test` (median 199.0 s), not `regression-budget`
(median 111.6 s), and emphatically not the drill.

**There is no dollar figure here, and that is a correction rather than an omission.** Every
job in the window ran on one self-hosted runner:

```
$ python3 -c "import json,glob; from collections import Counter; print(Counter(
    (j.get('runner') or {}).get('description') for f in glob.glob('jobs/*.json') \
    for j in json.load(open(f))))"
Counter({'shipshape-local-Joans-MBP': 975, None: 97})
```

Runner **198**, `is_shared: false`, `runner_type: project_type` — a MacBook Pro, and the 97
jobs with no runner are exactly the 97 with no duration. GitLab's $0.008/min figure prices
**shared** runners; applying it to self-hosted minutes is contradicted by this section's own
evidence, and calling the rate "assumed" does not rescue a rate that is wrong in kind. The
marginal cost of these 59.4 h is **~$0** — electricity and the developer's laptop being
busy. The number that means something is the wall time, and it is above.

**The drill's own weekly minutes — billed, then projected, and the two kept apart.**
The `ttfe` job landed mid-window, so what it *has* cost this week and what it *would* cost
at steady state are different numbers and must not be averaged into one:

| | |
|---|---:|
| Pipelines in the window | 62 |
| — that ran after `ttfe` landed (19893 onward) | 44 |
| — that actually carry a `ttfe` job | 40 — 19894–19897 are `pf/L00`/`pf/L01` branches predating it |
| — whose pair ran to completion | 36 (4 jobs skipped and 4 canceled, across 4 pipelines) |
| **TTFE actually billed this week** | **35.1 min** — the sum of the 72 completed jobs |
| Median per-pipeline TTFE subtotal | **53.0 s** (n=36) |
| *Forward projection*, 62 pipelines × 53.0 s | *54.8 min/week* |

**Both figures are inside a frozen window that closes before the drill went green**
(pipelines 18500 → 20224, snapshotted 2026-08-15 16:17 UTC; the first green `ttfe` is job
66739 in pipeline 20237 at 17:51 UTC). Every job they sum is a crashed one. They are
therefore accurate as a record of what was billed and **stale as a forward projection**:
over the 13 green runs the per-pipeline TTFE subtotal medians **124.1 s**, so the same 62
pipelines project to **~128 min/week** at steady state, a little over double. The frozen
figures are left as measured rather than silently re-based, because the window and its
snapshot time are what make them reproducible.

**53.0 s is the median of the per-pipeline subtotals.** An earlier version printed a figure
under that label that was the **sum of two separate medians** — `ttfe`'s median plus
`ttfe-controls`'s median, here 28.4 s + 24.9 s = 53.3 s. That is a different statistic, and
it is not the median of anything; the two coincide only when both jobs peak in the same
pipeline, which they do not. The gap is small and the correction is cheap. The label was
still describing something the number was not, which is the failure this project already
paid for once.

**Both figures are floors, twice over**: they are what the drill costs while crashing before
it starts. A runner with Docker pays for `docker pull postgres:16`, a testcontainers
Postgres and six timed stages on top. The real figure cannot be given until the job has run
once.

### OAuth flow testing — Playwright browser launches

`e2e/oauth-pkce.spec.ts` holds **5 tests**, each launching a browser context.

**888 tests did not run in 66.5 s.** An earlier version of this line paired that count with
that duration; 66.5 s is pipeline 20044's `e2e` job, which was **canceled**, and a canceled
job's partial duration is not a run time. The two numbers came from different events and
were reported as one.

The run that actually executed 888 tests is job **66343** (pipeline 20193):

```
$ glab api "projects/joshrochon%2Fship/jobs/66343/trace" \
    --repo joshrochon/ship --hostname labs.gauntletai.com | tail
  885 passed (36.5m)
assert-tests-ran: 888 tests executed (>= 874); command exit 0
```

| | |
|---|---:|
| `e2e` job duration (job 66343) | **2,275.9 s** (37.9 min) |
| Median across *successful* `e2e` jobs in the window | 2,315.5 s (n=28) |
| Tests executed | 888, across 76 spec files at **1 worker** |
| `oauth-pkce.spec.ts` | 5 tests |
| OAuth's share, by test count | 0.56% |
| **OAuth's share, by wall time** | **~1.3–1.5%** |

The worker count is measured, not assumed: the trace's own first line reads
`Running 888 tests using 1 worker`, and `.gitlab-ci.yml:583` sets `PLAYWRIGHT_WORKERS: '1'`
on the ref this job ran from. **An earlier version of this table said "75 spec files at 4
workers".** The 4 was stale — the value went 4 → 2 → 1 in three commits on 2026-08-01
(`e668f3f`, `974a016`, `345b7c7`) — and the spec count was one short; 76 distinct
`.spec.ts` paths appear in the trace. (The working tree now holds 77; one was added after
this job ran, which is why the count is taken from the trace and not from `find`.)

**That correction changes the argument, because one worker does not interleave.** The
previous version refused to give a time share on the grounds that "four workers interleave,
so the trace cannot attribute wall time to one spec file." At one worker the suite is
sequential, `oauth-pkce.spec.ts` runs as a contiguous block (tests 490–494 of 888), and the
trace lines are timestamped — so the share *is* derivable, and refusing to give it would now
be the hand-wave p.9 warns against.

**Derived from the trace's line timestamps** (not a per-spec duration the reporter emits —
Playwright's line reporter prints a progress counter, and whether it stamps test start or
test completion changes which end of the block is measured, so both bounds are given):

| | |
|---|---:|
| Block start — line for test 490 | `07:27:14.857` |
| Block end — line for test 494 / first line after (495) | `07:27:43.116` / `07:27:43.130` |
| **`oauth-pkce.spec.ts` wall time** | **28.3–33.1 s** |
| Suite wall time (`885 passed (36.5m)`) | 2,190 s |
| **OAuth's share of suite wall time** | **1.29–1.51%** |

So OAuth costs **~2.5× its share by test count** — and the reason is the one the previous
version correctly predicted: the single *"P95 over 20 runs"* benchmark at
`oauth-pkce.spec.ts:427` spans `07:27:22.595` → `07:27:43.116`, **20.5 s**, which is about
two-thirds of the whole block on its own. The old text was right that converting 0.56% into
~12.8 s would assume every test costs the same; it was wrong that no better number was
available. Either way the conclusion is unchanged in substance — **OAuth is ~1.5% of the e2e
job, a rounding error against the 35.1 min the job bills** — but it is now the measured share
p.9 asks for rather than a count standing in for one.

### OpenAPI generation and validation overhead

| | | What produced it |
|---|---:|---|
| `pnpm openapi:public` (generation alone) | **1.3 s** | local run |
| `openapi-freshness` CI job (generate + diff + fail if stale), pipeline 20044 | **24.4 s** | job 65677, a **single** run |
| `openapi-freshness`, median of the **48 completed** runs in the window | **30.4 s** | the capture below |
| `openapi-freshness`, median of the **16 successful** runs | **38.0 s** | the capture below |

**Its share of the weekly CI bill — computed the same way §1's TTFE share was, by summing
actual per-job durations rather than multiplying one run by a pipeline count.**

**Not all 62 pipelines ran the job, and assuming they did would have overstated it.** The
job entered the pipeline partway through the window, exactly as `ttfe` did:

| | |
|---|---:|
| Pipelines in the window (18500–20224, `created_at >= 2026-08-08`) | 62 |
| — that carry an `openapi-freshness` job | **52** — the earliest is pipeline 19570; 10 predate the job |
| — whose job ran to completion | **48** (4 canceled, recording no duration) |
| **`openapi-freshness` billed this week** | **27.4 min** = **0.457 h** |
| **Share of the week's 59.69 h summed job time** | **0.77%** |

`jobs/*.json` is the same per-pipeline capture §1 builds, re-fetched for this section. The
command is printed in full and its output is verbatim — an elided command is not a command,
by this document's own standard:

```
$ python3 -c "import json,glob,statistics
of=[j for f in glob.glob('jobs/*.json') for j in json.load(open(f)) \
    if j['name']=='openapi-freshness' and j.get('duration')]
tot=sum(j['duration'] for f in glob.glob('jobs/*.json') \
    for j in json.load(open(f)) if j.get('duration'))
print(len(of), sum(x['duration'] for x in of)/3600, tot/3600,
      100*sum(x['duration'] for x in of)/tot)"
48 0.45721898722222226 59.69014795555555 0.7659873578511835
```

Reading the four fields: **48** completed jobs, **0.457 h** of `openapi-freshness`,
**59.69 h** of all CI, **0.766%** — rounded to **0.77%** above.

**Numerator and denominator come from one snapshot, taken 2026-08-15 16:43 UTC** — the same
`jobs/*.json` capture, re-fetched for this section rather than divided into §1's earlier
total. §1's 59.4 h is the earlier frozen snapshot and is a floor by the same open-tail
argument made there; this capture reads **59.69 h**. **The share is 0.77% against either**,
which is the useful property of a ratio over a window that is still accruing.

**24.4 s is one run, and it is pipeline 20044's** — the same pipeline §1 already singles out
as an early-failing outlier whose numbers must not be generalised. Across the window the job
ranges **2.5 s to 114.1 s**, so no single run represents it; the share above is summed and
does not depend on picking one. For a forward budget the figure to use is the successful-run
median: **62 × 38.0 s = 39.3 min/week** at steady state.

Small, as p.9 predicts — and now a number, with its denominator named.

### Storage and egress for the dev portal demo

p.9 wants this sized rather than hand-waved: *"webhook delivery logs grow with every drill
run; size them at the expected demo volume."* Rows per run × bytes per row — and then, in
place of the "× runs per week" this section used to carry, the reason that third factor is
zero no matter what the first two are.

**Rows per drill run: 3.** `pnpm drill ttfe` runs three tests (`assert-tests-ran.sh 3`), and
the third one fans out to two subscriptions rather than one:

| Drill test | Deliveries |
|---|---:|
| The six p.6 stages — creates a `document.created` subscription (`ttfe.drill.ts:218`) and never deletes it, then one `documents.create` (`:253`) | 1 |
| PF-602, the benchmark-link assertion — reads `perf-report.json`, writes nothing | 0 |
| PF-611, the CLI path — `webhooks tail --listen` creates a **second** `document.created` subscription (`webhooksTail.ts:207`), then `docs create` (`:475`) fires **both** | 2 |
| `--controls`, all four tests (below) | 0 |
| **Total** | **3** |

**Why the third test writes two rows.** Fanout selects every active subscription for the
workspace and event type — `WHERE workspace_id = $1 AND event_type = $2 AND active = true`
(`pgSubscriptionRepo.ts:147`) — so one write produces one delivery *per matching
subscription*. Test 1's subscription is still active when test 3 runs: the two tests share a
single `ShipInstance` (one `beforeAll` at `ttfe.drill.ts:79`, torn down in `afterAll` at
`:86`), and `ttfe.drill.ts` contains no `webhooks.delete` call at all. `webhooks tail` does
clean up its own subscription (`webhooksTail.ts:279`) — but only *after* its one delivery
has already been logged.

**The audit that found this flagged a caveat: it assumed both clients land in the same
workspace. They do, and not by luck.** Subscriptions are stamped with the token's workspace
(`workspace_id: who.workspaceId`, `api/v1/webhooks/routes.ts:331`), and both tests
authenticate through the same device grant, approved by the same script against the same
hard-coded owner and workspace from migration 041 (`ttfe.drill.ts:166` and `:435` both call
`approveDeviceGrant`, which shells out to `scripts/l19-device-approve.ts`). Same instance,
same client id, same workspace, same event type. The fanout is deterministic, not incidental.

The controls contribute nothing, and there are **four** of them, not the three an earlier
version of this list named: the packed-exports install failure
(`ttfe.negative.drill.ts:51`), **the same defect leaving the SDK unit suite green**
(`:107`), the `DATABASE_URL` refusal (`:117`), and the concurrent-collision teardown
(`:134`). All four are negative by construction — a refused install or a refused database
produces no delivery. The drill's listener is in-process and answers on the first attempt,
so each delivery is one row rather than six.

**Bytes.** `BYTES_PER_ROW = 160 + 75 + 20 + 80 + 280 + 500 = 1,115` (`retention.ts:61`) — the
same figure §2 and §3 use, deliberately not a second one.

| | Rows | Bytes |
|---|---:|---:|
| Per drill run, first-attempt success | 3 | **3,345 B** |
| Per drill run, worst case (`ATTEMPT_MULTIPLIER_CEILING = 6`, `retention.ts:40`) | 18 | **20,070 B** |

**There is no weekly accrual row, and its absence is the finding.** An earlier version of
this table multiplied the per-run figure by 82 runs/week and reported 183 kB/week. That row
was not merely mis-sized — **it is structurally zero, permanently, and would remain zero on
a runner with Docker.** The harness destroys its own database at teardown:

- `scripts/ttfe/harness.ts:185` issues `DROP DATABASE IF EXISTS "<name>"`, then **:190
  re-queries `pg_database` for that name and throws if a row comes back** — the drill's own
  proof that nothing survived.
- The default path never touches a shared server at all: `:200–205` starts
  `new PostgreSqlContainer('postgres:16')` and disposes it with `container.stop()`.
- `ttfe.negative.drill.ts:134` asserts exactly this, by name — *"two concurrent runs collide
  on neither port nor schema, and neither survives teardown."*

So a drill run's 3 rows exist for the life of one ephemeral container and are gone with it.
**Drill runs accrue zero persistent storage — by design, not by outage.** The per-run figure
above is retained because p.9 asks the log to be sized at the expected demo volume, and a
demo reads the rows while the run is live; it is a peak, not an accrual.

The weekly figure that *was* in this table also rested on a soak assumption — one run a week
at the default `RUNS=20` (`scripts/ttfe/soak.sh:24`). That assumption goes with the row: the
soak is not a CI job, nothing schedules it, and it drops the same database at teardown.

**Egress.** The portal reads the log through `/api/v1/webhooks/deliveries` at
`DEFAULT_PAGE_SIZE = 25` (`api/v1/pagination.ts:49`). The API projection drops `raw_body`, so
the wire row is smaller than the stored row:

An earlier version of this section showed a `node -e '<a row matching deliveries.schema.ts,
JSON.stringify>'` fence with the script itself elided. This document's own standard is that
a claim "goes as a command", and an elided command is not one — a reader cannot check which
field widths produced the bytes. Here is the script, in full:

```
$ cat > /tmp/wire.js <<'EOF'
const U = '00000000-0000-4000-8000-000000000000';           // any UUID: 36 chars
const TS = '2026-08-15T00:00:00.000Z';                      // ISO-8601, 24 chars
const row = (over = {}) => ({
  id: U, delivery_group_id: U, subscription_id: U, event_id: U,
  event_type: 'document.created', attempt_number: 1, status: 'delivered',
  response_status: 200, response_excerpt: null, latency_ms: 12,
  idempotency_key: U, dlq_reason: null, attempted_at: TS, created_at: TS,
  signature_header: 't=1786780000,v1=' + 'a'.repeat(64),    // Ship-Signature, hex MAC
  replay_of_delivery_id: null, ...over,
});
const ok = row();
const failed = row({ status: 'failed', response_status: 500,
  response_excerpt: 'x'.repeat(256), latency_ms: null });
const b = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
console.log('wire bytes / delivery row (success, null excerpt):', b(ok));
console.log('wire bytes / row (failed attempt, full 256-char excerpt):', b(failed));
console.log('wire bytes / 25-row page (DEFAULT_PAGE_SIZE):',
  b({ data: Array.from({ length: 25 }, () => ok), next_cursor: null }));
EOF
$ node /tmp/wire.js
wire bytes / delivery row (success, null excerpt): 633
wire bytes / row (failed attempt, full 256-char excerpt): 886
wire bytes / 25-row page (DEFAULT_PAGE_SIZE): 15879
```

Three inputs are visible in the script rather than buried in the number: every key is
`deliverySchema`'s (`deliveries.schema.ts:37–65`, `.strict()`, so the wire row cannot carry
more); the envelope is `{ data, next_cursor }` (`pagination.ts:5`, `:264–266`); and
`signature_header` is `t=<unix seconds>,v1=<hex hmac-sha256>` (`signer.ts:9`), 80 characters.
The bytes moved when the script was written out — the elided version reported 670 / 944 /
16,842 — because those inputs were assumptions nobody could see. These are lower than the
old figures and, unlike them, re-derivable.

A demo never fills a page. One drill run puts three rows in the log, so the portal's delivery
view returns **~1.9 kB**, and a demo session reloading it twenty times moves **~38 kB**. A
full 25-row page is 15.9 kB. Egress at demo volume is a rounding error — which is the answer
p.9 expected, but it is now the answer to an arithmetic problem rather than a shrug. The
number that carries weight is the steady state in §2.

---

## 2. Production Cost Projections

p.9 supplies the tiers. The first five columns are p.9's; **the two storage columns are
ours**, computed from the constants in the code rather than restated from the PRD.

**Provenance is marked per cell, not per column.** `[P]` = reproduced verbatim from p.9's
table. `[D]` = derived by us from the constants below. Every figure carries one, so a reader
who looks at a **single row** can tell which half of it is the PRD's and which half is ours
without having to read this paragraph first.

| Tier | API calls/day | Webhook deliveries/day | Agent LLM calls/day | Est. cost/month | Delivery log @30d (healthy → worst) | Audit raw @30d |
|---|---:|---:|---:|---:|---:|---:|
| 100 users `[P]` | ~20,000 `[P]` | ~5,000 `[P]` | ~50 `[P]` | $2–8 `[P]` | 167 MB → 1.0 GB `[D]` | 240 MB `[D]` |
| 1,000 users `[P]` | ~200,000 `[P]` | ~50,000 `[P]` | ~500 `[P]` | $15–50 `[P]` | 1.7 GB → 10.0 GB `[D]` | 2.4 GB `[D]` |
| 10,000 users `[P]` | ~2,000,000 `[P]` | ~500,000 `[P]` | ~5,000 `[P]` | $80–250 `[P]` | 16.7 GB → 100.3 GB `[D]` | 24.0 GB `[D]` |
| 100,000 users `[P]` | ~20,000,000 `[P]` | ~5,000,000 `[P]` | ~50,000 `[P]` | $500–1,500 `[P]` | 167.2 GB → 1.0 TB `[D]` | 240 GB `[D]` |

**Every `[D]` cell is one of two formulas, so a marked cell can be re-derived from its own
row** — no cell is derived from another `[D]` cell:

- **Delivery log @30d** = `deliveries/day [P] × 30 × 1,115 B`, and the worst case is that
  × `ATTEMPT_MULTIPLIER_CEILING` (6). At 100 users: `5,000 × 30 × 1,115 = 167.25 MB`, worst
  `× 6 = 1.0 GB`.
- **Audit raw @30d** = `API calls/day [P] × 30 × ~400 B`. At 100 users:
  `20,000 × 30 × 400 = 240 MB`.

Constants, each cited so the arithmetic can be re-run:

| Constant | Value | Source |
|---|---|---|
| `RETRY_SCHEDULE_SECONDS` | 1 · 4 · 16 · 60 · 300 · 1800 s | `platform/webhooks/retry.ts:62` |
| `ATTEMPT_MULTIPLIER_CEILING` | 6 | `platform/webhooks/retention.ts:40` |
| `BYTES_PER_ROW` | 1,115 (160+75+20+80+280+500) | `platform/webhooks/retention.ts:61` |
| `RETENTION_DAYS` (delivery log) | 30 | `platform/webhooks/retention.ts` |
| `RAW_RETENTION_DAYS` (audit) | 30 | `platform/audit/retention.ts:51` |
| `ROLLUP_RETENTION` | indefinite | `platform/audit/retention.ts:54` |
| `DLQ_RETAINED_INDEFINITELY` | true | `platform/webhooks/retention.ts:88` |

**Where our model disagrees with p.9's estimate, and it does.** At 100,000 users the
delivery log alone reaches **1 TB** if every delivery exhausts the retry ladder, and
**167 GB** if none do. Even at Aurora storage prices the healthy case is ~$17/month of
storage before a single vCPU — which fits inside p.9's $500–1,500, but the *worst* case
does not fit comfortably, and it is reachable by one popular subscriber going down for a
day. The 6× is a real operational risk, not a padding factor.

Two mitigations already in the code rather than on a roadmap: the circuit breaker means a
permanently broken subscription accumulates at the breaker's rate rather than the event
rate, and dead letters leave the retry path entirely.

---

## 3. The three assumptions, stated explicitly

p.9–p.10 name these three by name and require each be stated rather than implied.

### Webhook fanout ratio

p.9 asks for two things by name: *"number of webhook deliveries triggered per **write
operation**, given the average number of subscriptions per event type at each tier."* Both
are below.

**An earlier version of this section answered neither.** It reported **0.25** — p.9's ~5,000
deliveries ÷ ~20,000 *total API calls* — and labelled it "deliveries per write operation".
Total API calls is a different and much larger denominator than writes, because most calls
are reads. The number was therefore roughly an order of magnitude too small **and it was
measuring a different quantity than the one p.9 names.** That is the same defect class this
project has already paid for once: a label describing something the number was not.

**Step 1 — the read/write split, stated as the assumption it is.**

p.9 supplies API calls/day but not their method mix, and this platform has no production
traffic to measure, so the split is **assumed: 90% reads / 10% writes.** It is an assumption,
not a measurement. The case for it:

- **The surface is list-heavy.** `DEFAULT_PAGE_SIZE = 25` (`api/v1/pagination.ts:49`), so one
  screen of a large collection is several GETs while a create is one POST.
- **The one heavy client actually modelled here is read-only, and its request mix is
  measured.** The agent holds `documents:read`, `issues:read`, `sprints:read` and nothing
  else (`api/src/db/platformApps.ts:117`), and one scan issues **6 requests, all
  `GET /api/v1/issues`, zero writes** (`agent/src/data/rewireCost.test.ts`, PF-698). It
  contributes to the denominator and can never contribute to the numerator.
- **The write surface is the smaller half even before traffic weighting:** 12 GET operations
  against 10 write operations across 15 paths in `docs/openapi.json`. That is *surface, not
  traffic* — quoted as a floor on read-dominance, not as the split itself.

**Step 2 — deliveries per write operation, and subscriptions per event type, at each tier.**

| Tier | API calls/day `[P]` | Writes/day @10% `[D]` | Deliveries/day `[P]` | **Deliveries per write** `[D]` | **Avg active subs per event type** `[D]` |
|---|---:|---:|---:|---:|---:|
| 100 users | ~20,000 | 2,000 | ~5,000 | **2.5** | **2.5** |
| 1,000 users | ~200,000 | 20,000 | ~50,000 | **2.5** | **2.5** |
| 10,000 users | ~2,000,000 | 200,000 | ~500,000 | **2.5** | **2.5** |
| 100,000 users | ~20,000,000 | 2,000,000 | ~5,000,000 | **2.5** | **2.5** |

**Why the last two columns are the same number.** Fanout selects every active subscription
for the workspace and event type — `WHERE workspace_id = $1 AND event_type = $2 AND active =
true` (`platform/webhooks/pgSubscriptionRepo.ts:147`) — so one event-emitting write produces
exactly one delivery per matching subscription. Deliveries per event-emitting write **is**
the average number of matching active subscriptions.

**They are equal only if every write emits an event, and that is the assumption's soft
edge.** Eight event types are registered (`platform/webhooks/events.ts:119`) covering the
document, issue and sprint write paths; writes outside that set — creating a subscription,
rotating a secret, the OAuth legs — emit nothing and inflate the write denominator without
adding deliveries. Writing `w` for the fraction of writes that emit an event: **avg subs per
event type = 2.5 ÷ w.** At `w = 1` both columns are 2.5; at `w = 0.8` the subscriptions
column is 3.1. **The 2.5 deliveries-per-write figure is what p.9 asks for and it is
unaffected by `w`;** the subscriptions column is stated at `w = 1` and scales as `1/w`.

**Step 3 — sensitivity, because the split is assumed rather than measured.** The ratio is
inversely proportional to the write share, so a wrong split moves it proportionally:

| Read/write split | Writes/day @100 users | Deliveries per write |
|---|---:|---:|
| 80 / 20 | 4,000 | 1.25 |
| **90 / 10 — assumed** | **2,000** | **2.5** |
| 95 / 5 | 1,000 | 5.0 |

**Step 4 — the ratio is flat across tiers, and that is the load-bearing simplification.**
Holding 2.5 at every tier says the average number of subscriptions per event type does *not*
grow with scale. It is optimistic. Fanout is per **subscription**, not per app: a platform
that succeeds acquires more apps subscribing to the *same* popular event types, so the
realistic curve bends upward. If subscriptions per event type doubles at 100,000 users, both
storage columns in §2 double with it.

**Reconciling with `PRESEARCH-PLUGFORGE.md:82`, which says `6N`.** That line reads *"Fanout
is `1 event × N matching active subscriptions × up to 6 attempts` = at most `6N` outbound
requests per event."* **It does not disagree with 2.5. The two count different things and
both are correct in their own unit** — a grader reading both documents should see the units,
not a contradiction:

| | Counts | Retries included? | Value here |
|---|---|---|---|
| `PRESEARCH:82`'s `6N` | outbound HTTP **attempts** per event, worst case | **yes**, ×6 | 6 × 2.5 = **15** |
| This section's **2.5** | **deliveries** (log rows) per **write**, first attempt | **no** | **2.5** |

The `6` is `ATTEMPT_MULTIPLIER_CEILING` (`platform/webhooks/retention.ts:40`), the retry
ladder. **It is not dropped here — it is the same 6 that produces §2's "healthy → worst"
storage spread** (167 MB → 1.0 GB at 100 users is exactly ×6). PRESEARCH folds it into one
figure; this section keeps subscriptions and retries in separate columns so a reader can see
which factor is which. Neither is wrong; `PRESEARCH:82` is the worst-case attempt count and
2.5 is the expected delivery count, which is what p.9's table and §2's storage model need.

### Agent active rate

p.10 asks for two numbers here by name: *"fraction of users who actually use agent features
on a given day, **and average agent turns per active user**."*

**Assumed: 5% of users use agent features on a given day, at ~10 turns per active user.**

**An earlier version of this line said "~1 turn per active user" and was wrong by 10×** — it
contradicted the arithmetic in its own parenthetical, which already read *"~10 turns each"*.
The arithmetic was right and the headline was not. p.10 says the cost projection bends on
this assumption, so it is corrected here in the place a reader checks first.

The two assumed numbers are not independently sourced — p.9 supplies the calls/day column
and the 5% is assumed, so **turns per active user is solved for, not measured**:
`turns = calls per day ÷ (users × 5%)`. It reproduces p.9's column exactly at all four
tiers, which is the check that the pair is self-consistent:

| Tier | × 5% = active users | × 10 turns = calls/day | p.9's Agent LLM calls/day |
|---|---:|---:|---:|
| 100 users | 5 | 50 | ~50 |
| 1,000 users | 50 | 500 | ~500 |
| 10,000 users | 500 | 5,000 | ~5,000 |
| 100,000 users | 5,000 | 50,000 | ~50,000 |

p.10: *"Cost projection bends on this assumption, not on platform traffic."* Correct, and
it is the only line here that moves with a token price.

**An earlier version of this line priced the agent at $3,000–6,000/month, and that was wrong
by roughly 7×.** It rested on a blended **$0.50–1.00 per million tokens**, described as a
Sonnet/Haiku-class rate. No Anthropic model prices there at any input/output mix — the
cheapest, Haiku 4.5, is $1.00/M on input alone, and any real turn also produces output. The
rate was never taken off a price sheet, and it is repriced below against the model the code
actually pins.

**Rates used — an assumption, not a measurement.** A vendor price sheet cannot be verified
from inside this repo, so the rates are stated here for a reader to substitute:

| Model | Input $/MTok | Output $/MTok |
|---|---:|---:|
| **`claude-opus-4-5` — the pinned model** | **$5.00** | **$25.00** |
| `claude-sonnet-4-5` — p.10's recommendation class | $3.00 | $15.00 |
| `claude-haiku-4-5` — the cheapest model offered | $1.00 | $5.00 |

Source: Anthropic model overview, `platform.claude.com/docs/en/about-claude/models/overview`,
retrieved **2026-08-15**. `agent/src/llm/client.ts:107` pins `claude-opus-4-5-20251101` (and
`:96` the Bedrock equivalent). `FLEETGRAPH_MODEL_ID` can override it; nothing in the deployed
environment does.

**The arithmetic.** Volume is unchanged: at 100,000 users, p.9's own ~50,000 calls/day is
1.5M turns/month, and at a ~4k-token turn that is ~6.0B tokens/month. Because that total is
fixed, cost depends only on how it splits between input and output:

> `cost = $5 × input_MTok + $25 × output_MTok`, with `input + output = 6,000 MTok`
> which reduces to **`$30,000 + $20 × output_MTok`**

`MAX_TOKENS = 2048` (`client.ts:113`) caps output per turn, so the split is bounded at both
ends — and the code's own comment on that constant says the cap is *"far more than the schema
can fill"*, because judgement *"returns a handful of short sentences"*:

| Output per turn | Output MTok/month | **Agent LLM cost/month** |
|---|---:|---:|
| 0 — degenerate lower bound, not reachable | 0 | $30,000 |
| ~200 tokens | 300 | **$36,000** |
| **~300 tokens — the assumed case** | **450** | **$39,000** |
| ~400 tokens | 600 | **$42,000** |
| 2,048 — every turn at the `MAX_TOKENS` ceiling | 3,072 | $91,440 |

**The line is ~$36,000–42,000/month, call it ~$39,000** — **6.5× the top of the $3,000–6,000
range it replaces and 13× the bottom.** A first pass at this correction put it higher still
(11–23×) by assuming ~1,300 output tokens per turn; `client.ts:113`'s own comment rules that
out, so the correction to the correction is *downward*. The error was real and an order of
magnitude; it was not quite the order of magnitude first claimed.

**This bill is input-dominated.** At ~300 output tokens per turn, input is ~$27,750 of the
~$39,000 — **71%** — and at the low end more. The lever is therefore prompt size and prompt
caching, not the output cap or the model's output rate. `agent/src/llm/prompts/judge.ts` and
`answer.ts` are 8.8 KB and 5.1 KB of source; the static portion of that prompt is resent on
every one of 1.5M turns per month and is exactly what a cache read would discount.

**What is load-bearing here is the ~4k-token turn, and it is assumed, not measured.** It
appears in this document without a source, the agent has never run against a live model (no
credential in the environment — see §4), and the whole line is linear in it. A turn half that
size halves the bill. This is the first number to measure once the agent is scheduled, and
until then every figure above inherits its uncertainty.

#### Reconciling with p.9's $500–1,500

p.9's tier table gives ~50,000 agent LLM calls/day and *"Est. cost/month $500–1,500"* on the
same row, which reads as a contradiction with a $39,000 agent line. It is not one, and the
reason is p.9's own scope statement directly above that table:

> *"Platform-layer cost scales with API traffic and webhook delivery, not with LLM calls.
> Numbers below assume the agent app is one of N installed apps at each tier; **LLM cost is
> attributable to the agent app's user-driven sessions, not the platform itself.**"* — p.9

So the **$500–1,500 column is platform infrastructure only and excludes the agent's LLM
spend by p.9's own definition.** The calls/day column is a workload input; the cost column
prices storage, compute and egress. The two lines sit side by side because the platform is
what p.9 is costing, and the agent's bill belongs to whoever turns the agent on. This
document keeps them separate for the same reason.

**Of the three ways this could have resolved, the evidence picks the first:** the agent line
genuinely dwarfs the platform line, and p.9's figure covers platform infrastructure. It is
not a too-high token estimate — the estimate was corrected *downward* above and the gap
survives — and it is not closed by a cheaper model, as the next paragraph shows.

**Model choice is a real lever, and it does not close this gap.** Same 6.0B tokens, same
~300-token output, the three rates above:

| Model | Cost formula | **Agent LLM cost/month** | vs. pinned |
|---|---|---:|---:|
| **`claude-opus-4-5` — pinned today** | `$30,000 + $20 × out` | **~$39,000** | — |
| `claude-sonnet-4-5` — p.10's class | `$18,000 + $12 × out` | **~$23,400** | −40% |
| `claude-haiku-4-5` — cheapest offered | `$6,000 + $4 × out` | **~$7,800** | −80% |

**Recommendation: move the agent to Sonnet, and treat it as a decision, not a defect.** It
saves roughly **$15,600/month at the 100,000-user tier** and it is what p.10 asks for —
*"Claude API (Sonnet 4 recommended)"*. The change needs no deploy: `FLEETGRAPH_MODEL_ID`
already overrides the pin (`client.ts:107`). **The model pin is deliberately left as-is in
this pass** — it is a capability/cost tradeoff for the owner to make, and `client.ts:96`
records that Opus was inherited from `api/src/services/ai-analysis.ts` so that one product
does not run two model ids.

But note what the table does *not* show: **even Haiku, the cheapest model offered, prices this
workload at ~$7,800/month — still 5× p.9's whole-tier figure.** No model choice brings the
agent line inside $500–1,500 at this token volume. That is the arithmetic proof that p.9's
column cannot have included agent LLM spend, independent of reading p.9's scope note — and it
is why the reconciliation above is a scope distinction rather than a pricing error.

**Sensitivity — the 2× case, which p.10 asks for by name.** The line is linear in the active
rate: turns/day = `users × active rate × turns per active user`, and per-turn cost is fixed,
so doubling the rate doubles the bill and moves nothing else. Nothing in §2's platform
columns responds — the agent is read-only (below), so it adds no writes, no events and no
deliveries.

| Agent active rate | Active users @100,000 | Agent calls/day | Tokens/month | **Agent LLM cost/month** |
|---|---:|---:|---:|---:|
| **5%** — assumed | 5,000 | ~50,000 | ~6.0B | **~$39,000** |
| **10%** — the 2× case | 10,000 | ~100,000 | ~12.0B | **~$78,000** |

Both at the pinned `claude-opus-4-5` and ~300 output tokens per turn; on Sonnet the same two
rows are ~$23,400 and ~$46,800.

At 10% the agent line alone is **~50× p.9's whole platform estimate for that tier** — which
is not a contradiction, for the scope reason given above, but it is the number a reader
should carry away: **the agent's active rate and its per-turn token size, not the platform's
traffic, are the only assumptions in this document with five-figure consequences.**

The agent's read-only scopes — `documents:read`, `issues:read`, `sprints:read`
(`platformApps.ts:117`) — bound this further, and it is a cost property as much as a
security one: the agent cannot write, so it cannot trigger a webhook, so it cannot grow the
fanout in the row above.

### Storage retention

p.10 asks for **rows × retention days × bytes per row, plus audit rows, both windows
stated, and why each is set there.**

| Store | Window | Model | Why there |
|---|---|---|---|
| Delivery log | **30 days** | `deliveries/day × attempts × 30 × 1,115 B` | Long enough to debug a subscriber outage across a holiday weekend |
| Audit raw | **30 days** | `API calls/day × 30 × ~400 B` | p.13 grades Epic 7 on the agent's audit rows; a window that deletes the evidence before grading is the wrong window at any price |
| Audit rollup | **indefinite** | per-day-per-app counts | Cheap, and it is what the portal's usage view reads |
| Dead letters | **indefinite** | bounded by the breaker | An unreplayed dead letter is unfinished work, not history |

What is deliberately lost at 30 days: the rollup keeps counts per app per day, not
per-route detail. After 30 days you can prove *"this app made 412 calls on 2026-08-12, 9 of
them 4xx"* and you cannot answer *"which document did it read."* The first question is what
Epic 7 and the portal ask; the second has a 30-day answer.

---

## 4. What would move these numbers

- **The drill actually running.** §1's TTFE minutes — 35.1 min billed, 54.8 min projected —
  were floors, measured over a window in which `ttfe` and `ttfe-controls` died before the
  drill started. They are no longer floors for new pipelines: since `774ab9d` deleted the
  `docker pull` line the drill executes, and a green `ttfe` costs about **63 s** against the
  28 s the crashed jobs cost, so the projection roughly doubles as the old jobs age out of
  the window. **It does not start the delivery log accruing:** the harness drops its own
  database and stops its own container at teardown (`harness.ts:185`/`:190`, `:200–205`), so
  drill runs stay at zero persistent storage on any runner. That accrual is closed by
  design, not waiting on infrastructure.
- **Moving CI off the self-hosted runner.** All 1,072 jobs in the measured week ran on
  runner 198, `is_shared: false`. Marginal cost today is ~$0. On GitLab shared runners the
  same 59.4 h would price at roughly $28.50/week at $0.008/min — which is the number that
  would need budgeting, and the reason §1 refuses to quote it as though it applied now.
- **A queue-backed `IEventBus`.** The in-process bus is free and bounded by the API process.
  BullMQ or SQS adds infrastructure that scales with fanout.
- **Fanout growing with scale.** §3 assumes it does not. It probably does.
- **Turning the agent on.** Today it is shipped but not scheduled — `agent/dist/entrypoints/cron.js`
  is in the runtime image and asserted by the Dockerfile, but nothing invokes it and the
  environment holds no model credential. The moment it is scheduled, the §3 agent line stops
  being hypothetical.
- **Any platform-layer AI feature.** p.11 calls this scope creep. It is also the only change
  that would put a token price on the platform's critical path.
