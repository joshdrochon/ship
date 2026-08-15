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

p.9 also asks to *"confirm the rewire does not change token volume."* It cannot, by
construction rather than by measurement: the rewire changed the agent's **data path** —
direct service calls became SDK calls against `/api/v1` — and touched nothing in
`agent/src/llm/`. The prompt, the model and the one-call-per-turn ceiling are identical on
both sides of the `SHIP_AGENT_VIA_SDK` flag, which is why the flag can be flipped in either
direction with the Part 2 suite green.

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

| | Day 1 — pipeline 19893 | Latest settled — pipeline 20223 |
|---|---:|---:|
| Date (UTC) | 2026-08-14 15:15 | 2026-08-15 15:26 |
| `ttfe` | 69.9 s | 27.9 s |
| `ttfe-controls` | 32.9 s | 22.5 s |
| **TTFE subtotal, per pipeline** | **102.8 s** | **50.4 s** |

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

**Neither number times the drill.** Both jobs die before it runs:

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

**The TTFE drill has never executed in CI.** Every one of the 72 completed
`ttfe`/`ttfe-controls` jobs was read, and none reached the drill: 70 exit 127 at `docker
pull postgres:16`, 2 die earlier on a Docker Hub 429. No job in the project's history has
ever succeeded. **p.13 says: *"For Epic 6, proof is the TTFE drill passing in CI."* That
proof does not exist.** Nothing in the corrections above softens this; the two 429 jobs got
*less* far than the rest, and the runner correction below makes the drill cheaper, not more
likely to have run.

What the durations above measure is therefore checkout, `pnpm install`, `tsc -p
tsconfig.drill.json` and `check-fitness.mjs`, then the crash. The 69.9 s → 27.9 s
"improvement" is pnpm cache warmth, not a faster drill. Across the **36 pipelines whose
`ttfe` pair ran to completion**, `ttfe` has a median of 28.4 s (range 2.5–69.9) and
`ttfe-controls` 24.9 s (2.8–52.1) — the shape of install variance, with none of the drill
in it.

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
| Tests executed | 888, across 75 spec files at 4 workers |
| `oauth-pkce.spec.ts` | 5 tests |
| **OAuth's share, by test count** | **0.56%** |

**That share is by count, and the count is all this instrument can give.** Playwright's CI
reporter prints completions, not per-spec durations, and four workers interleave, so the
trace cannot attribute wall time to one spec file. Converting 0.56% into ~12.8 s would
assume every test costs the same, and one of the five is a *"P95 over 20 runs"* benchmark
that plainly does not. So: 5 tests of 888, a rounding error either way — the count p.9 asks
for rather than the hand-wave it warns against, without a time share the trace cannot
support.

### OpenAPI generation and validation overhead

| | |
|---|---:|
| `pnpm openapi:public` (generation alone) | **1.3 s** |
| `openapi-freshness` CI job (generate + diff + fail if stale) | **24.4 s** |

Small, as p.9 predicts, and now a number.

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
(`ttfe.negative.drill.ts:50`), **the same defect leaving the SDK unit suite green**
(`:106`), the `DATABASE_URL` refusal (`:116`), and the concurrent-collision teardown
(`:133`). All four are negative by construction — a refused install or a refused database
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

- `scripts/ttfe/harness.ts:149` issues `DROP DATABASE IF EXISTS "<name>"`, then **:154
  re-queries `pg_database` for that name and throws if a row comes back** — the drill's own
  proof that nothing survived.
- The default path never touches a shared server at all: `:165–169` starts
  `new PostgreSqlContainer('postgres:16')` and disposes it with `container.stop()`.
- `ttfe.negative.drill.ts:133` asserts exactly this, by name — *"two concurrent runs collide
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

p.9 supplies the tiers. The columns below are p.9's; **the two storage columns are ours**,
computed from the constants in the code rather than restated from the PRD.

| Tier | API calls/day | Webhook deliveries/day | Agent LLM calls/day | p.9 est. cost/month | Delivery log @30d (healthy → worst) | Audit raw @30d |
|---|---:|---:|---:|---:|---:|---:|
| 100 users | ~20,000 | ~5,000 | ~50 | $2–8 | 167 MB → 1.0 GB | 240 MB |
| 1,000 users | ~200,000 | ~50,000 | ~500 | $15–50 | 1.7 GB → 10.0 GB | 2.4 GB |
| 10,000 users | ~2,000,000 | ~500,000 | ~5,000 | $80–250 | 16.7 GB → 100.3 GB | 24.0 GB |
| 100,000 users | ~20,000,000 | ~5,000,000 | ~50,000 | $500–1,500 | 167.2 GB → 1.0 TB | 240 GB |

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

**Assumed: 0.25 deliveries per write operation at every tier**, i.e. p.9's ~5,000
deliveries against ~20,000 API calls/day. That ratio holds across all four tiers in p.9's
own table, which is itself an assumption worth surfacing — it says the average number of
subscriptions per event type does *not* grow with the tier.

That is the load-bearing simplification here, and it is optimistic. Fanout is per
**subscription**, not per app: one event matching N subscriptions produces N deliveries. A
platform that succeeds acquires more apps subscribing to the *same* popular event types, so
the realistic curve bends upward with scale. If the ratio doubles at 100,000 users, both
storage columns double with it.

### Agent active rate

**Assumed: 5% of users use agent features on a given day, at ~1 turn per active user** —
which reproduces p.9's numbers exactly (100,000 users → 5,000 active → ~50,000 calls/day
requires ~10 turns each; at 100 users → 5 active → ~50 calls/day, ~10 turns each).

p.10: *"Cost projection bends on this assumption, not on platform traffic."* Correct, and
it is the only line here that moves with a token price. At 100,000 users and ~50,000 calls
per day at a ~4k-token turn, the agent is **$3,000–6,000/month on its own** — several times
p.9's whole $500–1,500 estimate for that tier. **The two are not in conflict: p.9 attributes
LLM cost to the agent app's user-driven sessions, not to the platform.** The platform's own
bill at 100,000 users is storage, compute and egress; the agent's bill belongs to whoever
turns the agent on.

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

- **A CI runner with Docker.** §1's TTFE minutes — 35.1 min billed, 54.8 min projected —
  are floors only because `ttfe` and `ttfe-controls` die before the drill starts. A Docker
  binary turns them into real figures. **It does not start the delivery log accruing:** the
  harness drops its own database and stops its own container at teardown
  (`harness.ts:149`/`:154`, `:165–169`), so drill runs stay at zero persistent storage on
  any runner. That accrual is closed by design, not waiting on infrastructure.
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
