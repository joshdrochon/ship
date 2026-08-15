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

**$0.00.** Measured:

```
$ aws ce get-cost-and-usage --time-period Start=2026-08-08,End=2026-08-16 \
    --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
```

No Amazon Bedrock line appears at all — not a zero row, no row. The deployed environment
carries four application variables (`AWS_REGION`, `ENVIRONMENT`, `NODE_ENV`, `PORT`): no
`ANTHROPIC_API_KEY`, no `BEDROCK_ENDPOINT`. Total AWS for the window is **−$0.0000031**
net of credits.

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

| | Day 1 — pipeline 19893 | Final — pipeline 20044 |
|---|---:|---:|
| Date (UTC) | 2026-08-14 15:15 | 2026-08-14 21:58 |
| `ttfe` | 69.9 s | 31.8 s |
| `ttfe-controls` | 32.9 s | 27.0 s |
| **TTFE subtotal, per pipeline** | **102.8 s** | **58.8 s** |

```
$ glab api "projects/joshrochon%2Fship/pipelines/19893/jobs?per_page=100" --repo joshrochon/ship
$ glab api "projects/joshrochon%2Fship/pipelines/20044/jobs?per_page=100" --repo joshrochon/ship
```

**Neither number times the drill.** Both jobs die before it runs:

```
$ glab api "projects/joshrochon%2Fship/jobs/65064/trace" --repo joshrochon/ship
$ node scripts/ttfe/check-fitness.mjs
ttfe fitness OK — 15 file(s): no sleeps, retry: 0, no Playwright, one thresholds file
$ docker pull postgres:16
/usr/bin/bash: line 196: docker: command not found
ERROR: Job failed: exit code 127
```

The same exit 127 at the same line in every `ttfe` and `ttfe-controls` run in the project's
history — 35 attempted runs, 19893 through 20223. The runner has no Docker binary, and the
drill provisions its Postgres through testcontainers. Both jobs are `allow_failure: false`,
so the pipeline has been red on them since the day they landed.

What the durations above measure is therefore checkout, `pnpm install`, `tsc -p
tsconfig.drill.json` and `check-fitness.mjs`, then the crash. The 69.9 s → 31.8 s
"improvement" is pnpm cache warmth, not a faster drill. Across the 35 attempted runs `ttfe`
has a median of 28.0 s (range 2.5–69.9) and `ttfe-controls` 24.6 s (2.8–52.1) — the shape of
install variance, with none of the drill in it.

**The weekly bill.** 62 pipelines ran in the trailing seven days — counted from the pipeline
list, not extrapolated from a PR rate:

| | |
|---|---:|
| Pipelines, 7 days to 2026-08-15 | 62 |
| TTFE subtotal, median per pipeline | 52.6 s |
| **TTFE, weekly** | **54 min → ~$0.44** |
| Whole pipeline, summed job time (20044, 19 jobs) | 17.1 min |
| **All CI, weekly** | **17.7 h → ~$8.48** |

At the $0.008/min GitLab shared-runner rate — an assumed price, not a measured one. The drill
is 5% of the bill; the expensive jobs are `test` (194.7 s) and `regression-budget` (110.5 s).

That **$0.44/week is a floor**, and this is the one line in this section that should not be
quoted without its caveat: it is what the drill costs while crashing on a missing binary. A
runner with Docker pays for `docker pull postgres:16`, a testcontainers Postgres and six
timed stages on top. The real figure cannot be given until the job has run once.

### OAuth flow testing — Playwright browser launches

`e2e/oauth-pkce.spec.ts` holds **5 tests**, each launching a browser context. The whole
e2e job is **66.5 s** for **888 tests** across 75 spec files at 4 workers. OAuth's share is
~0.6% of the e2e job — a rounding error against `test`, and worth the count rather than
the hand-wave p.9 warns about.

### OpenAPI generation and validation overhead

| | |
|---|---:|
| `pnpm openapi:public` (generation alone) | **1.3 s** |
| `openapi-freshness` CI job (generate + diff + fail if stale) | **24.4 s** |

Small, as p.9 predicts, and now a number.

### Storage and egress for the dev portal demo

p.9 wants this sized rather than hand-waved: *"webhook delivery logs grow with every drill
run; size them at the expected demo volume."* Rows per run × bytes per row × runs per week.

**Rows per drill run: 2.** `pnpm drill ttfe` runs three tests (`assert-tests-ran.sh 3`), and
exactly two of them write:

| Drill test | Deliveries |
|---|---:|
| The six p.6 stages — one subscription, one `documents.create` (`ttfe.drill.ts:253`) | 1 |
| PF-602, the benchmark-link assertion — reads `perf-report.json`, writes nothing | 0 |
| PF-611, the CLI path — `webhooks tail` with `maxDeliveries: 1` (`:471`) fed by `docs create` (`:475`) | 1 |
| `--controls`, all four tests: packed-exports defect, DATABASE_URL refusal, concurrent collision | 0 |

The controls are negative by construction — they assert failures, and a refused install or a
refused database produces no delivery. The drill's listener is in-process and answers on the
first attempt, so each delivery is one row rather than six.

**Bytes.** `BYTES_PER_ROW = 160 + 75 + 20 + 80 + 280 + 500 = 1,115` (`retention.ts:61`) — the
same figure §2 and §3 use, deliberately not a second one.

| | Rows | Bytes |
|---|---:|---:|
| Per drill run, first-attempt success | 2 | **2,230 B** |
| Per drill run, worst case (`ATTEMPT_MULTIPLIER_CEILING = 6`, `retention.ts:40`) | 12 | **13,380 B** |
| Per week — 62 pipelines + one 20-run soak = 82 runs | 164 | **183 kB** |
| Same week, worst case | 984 | **1.1 MB** |

Two named assumptions in that third row. The pipeline count is the measured 62 from the
section above. The soak is **assumed to run once a week at its default `RUNS=20`**
(`scripts/ttfe/soak.sh:24`, sized to p.9's 20-consecutive-run flake target); it is not a CI
job and nothing schedules it, so its frequency is a choice rather than an observation.

**Today the measured figure is zero.** No drill run in CI has ever reached the write — every
one exits 127 at `docker pull`. The 183 kB is what the log accrues once the runner has
Docker, at the frequency CI is already running.

**Egress.** The portal reads the log through `/api/v1/webhooks/deliveries` at
`DEFAULT_PAGE_SIZE = 25` (`api/v1/pagination.ts:49`). The API projection drops `raw_body`, so
the wire row is smaller than the stored row:

```
$ node -e '<a row matching deliveries.schema.ts, JSON.stringify>'
wire bytes / delivery row (success, null excerpt): 670
wire bytes / row (failed attempt, full 256-char excerpt): 944
wire bytes / 25-row page (DEFAULT_PAGE_SIZE): 16842
```

A demo never fills a page. One drill run puts two rows in the log, so the portal's delivery
view returns **~1.3 kB**, and a demo session reloading it twenty times moves **~27 kB**. A
full 25-row page is 16.8 kB. Egress at demo volume is a rounding error — which is the answer
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

- **A CI runner with Docker.** Two numbers in §1 are floors only because `ttfe` and
  `ttfe-controls` exit 127 before the drill starts. Giving the runner a Docker binary turns
  the drill's $0.44/week into a real figure and starts the delivery log accruing the 183 kB.
- **A queue-backed `IEventBus`.** The in-process bus is free and bounded by the API process.
  BullMQ or SQS adds infrastructure that scales with fanout.
- **Fanout growing with scale.** §3 assumes it does not. It probably does.
- **Turning the agent on.** Today it is shipped but not scheduled — `agent/dist/entrypoints/cron.js`
  is in the runtime image and asserted by the Dockerfile, but nothing invokes it and the
  environment holds no model credential. The moment it is scheduled, the §3 agent line stops
  being hypothetical.
- **Any platform-layer AI feature.** p.11 calls this scope creep. It is also the only change
  that would put a token price on the platform's critical path.
