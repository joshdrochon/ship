# AI Cost Analysis — PlugForge (Week 6)

PRD p.13: *"Tracked dev spend, production projections table, explicit assumptions for
webhook fanout, agent active rate, and storage retention."*

> `docs/ai-cost-analysis.md` is the **Week 5** document (it cites the ShipShape brief,
> p.11). This is Week 6's. Neither supersedes the other.

---

## 1. The platform does zero AI work — proven, not asserted

p.9 and p.11 both state it, and it is the one claim in this document a reader can falsify
in thirty seconds, so it goes first and it goes as a command:

```
$ grep -rlE "@langchain|anthropic|openai" api/src/platform/ | wc -l
0

$ grep -rlE "@langchain" agent/src | wc -l
10
```

Zero files under `api/src/platform/**` reach for an LLM client. Ten under `agent/src` do.
The boundary is real and it is where the PRD puts it: the agent is a *consumer* of the
platform, and the platform never invokes a model on anyone's behalf.

That is why almost every number below is a storage and delivery number rather than a
token number. **PlugForge's marginal AI cost is the agent's, and nothing else's.**

## 2. Tracked dev spend

| | |
|---|---:|
| Claude Max subscription — flat, not metered | **$100 / month** |
| Metered LLM API spend attributable to PlugForge | **$0.00** |
| Total AWS spend, 2026-08-08 → 2026-08-16 | **−$0.0000031** (net of credits) |
| *Marginal cost attributable to this project* | ***$0.00*** |

Measured, not estimated:

```
$ aws ce get-cost-and-usage --time-period Start=2026-08-08,End=2026-08-16 \
    --granularity MONTHLY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=SERVICE
```

No Amazon Bedrock line appears in the result at all — not a zero row, no row — so the
agent's Bedrock fallback was never exercised. And the deployed environment carries exactly
four application environment variables (`AWS_REGION`, `ENVIRONMENT`, `NODE_ENV`, `PORT`):
**no `ANTHROPIC_API_KEY` and no `BEDROCK_ENDPOINT`**, so the deployed agent cannot make an
LLM call even if scheduled.

**The subscription is not attributable to this project and is not presented as if it
were.** It is a flat monthly fee that would have been paid regardless, and folding a share
of it into a project figure would require deciding how much of the month this project
"used" — an allocation choice presented as a measurement. This week's build, including
eight parallel subagents, ran inside it.

The honest headline is that a platform week costs nothing in AI spend, because the platform
does no AI work. The interesting money is in §3.

## 3. Production projections

**Every figure below is a projection from a stated assumption, not a measurement.** The
service is days old and has no production traffic; there is nothing to measure yet. What
follows is a model, and the point is that a reader can check the arithmetic and swap an
assumption for their own.

Constants come from the code, not from this document:

| Constant | Value | Source |
|---|---|---|
| Retry ladder | 1s · 4s · 16s · 1m · 5m · 30m | `RETRY_SCHEDULE_SECONDS`, `platform/webhooks/retry.ts:62` |
| Attempts before dead-letter | 6 | `ATTEMPT_MULTIPLIER_CEILING`, `webhooks/retention.ts:40` |
| Delivery-log row | 1,115 bytes | `BYTES_PER_ROW` = 160+75+20+80+280+500 |
| Delivery-log retention | 30 days | `RETENTION_DAYS` |
| Audit raw retention | 30 days | `RAW_RETENTION_DAYS`, `audit/retention.ts:51` |
| Audit rollup retention | indefinite | `ROLLUP_RETENTION` |
| Dead letters | retained indefinitely | `DLQ_RETAINED_INDEFINITELY` |

### Assumption A — webhook fanout

**Assumed:** 50 registered apps · 3 subscriptions each · 200 qualifying events/day.

Fanout is per *subscription*, not per app: one event matching N subscriptions produces N
deliveries. `50 × 3 = 150` subscriptions, but a subscription only fires on the event types
it matched, so the modelled figure is deliveries, not subscriptions × events.

| | |
|---|---:|
| Deliveries/day at a 10% match rate | 200 × 150 × 0.10 = **3,000** |
| Steady-state delivery log, worst case | 3,000 × 6 × 30 × 1,115 B ≈ **602 MB** |
| Steady-state delivery log, healthy case (1 attempt) | 3,000 × 1 × 30 × 1,115 B ≈ **100 MB** |

The 6× is the ceiling, not the expectation — it assumes *every* delivery exhausts the
ladder. The gap between 100 MB and 602 MB is the cost of subscriber reliability, and it is
charged to us rather than to them, which is the argument for the dead-letter queue existing
at all: a permanently broken subscription accumulates at the circuit breaker's rate, not at
the event rate.

### Assumption B — agent active rate

**Assumed:** the agent runs on a cron cadence, one LLM call per turn, over 50 workspaces.

p.11 caps this at one call per agent turn and the code holds to it. At Claude Opus pricing
and a ~4k-token turn:

| Cadence | Turns/month (50 workspaces) | Indicative spend |
|---|---:|---:|
| Daily | 1,500 | ~$30–60 |
| Hourly | 36,000 | ~$700–1,400 |

The spread is a token-length spread, not a rate uncertainty. **This is the only line in the
whole analysis that scales with an AI price**, which is the architectural point of Epic 7:
the agent's cost is bounded by its cadence, and the cadence is a config value rather than
something user traffic drives.

Read-only scopes bound it further — `documents:read`, `issues:read`, `sprints:read`
(`platformApps.ts:117`). The agent cannot trigger a write, so it cannot trigger a webhook,
so it cannot cause the §A fanout to grow. That is a cost property, not just a security one.

### Assumption C — storage retention

| Store | Window | Why there |
|---|---|---|
| Audit raw | 30 days | p.13 grades Epic 7 on the agent's audit rows; a window that deletes the evidence before grading is the wrong window at any price |
| Audit rollup | indefinite | Per-day-per-app counts. Cheap, and it is what the portal's usage view reads |
| Delivery log | 30 days | Long enough to debug a subscriber outage over a holiday weekend |
| Dead letters | indefinite | An unreplayed dead letter is unfinished work, not history |

What is deliberately lost at 30 days: the rollup keeps counts per app per day, not
per-route detail. After 30 days you can prove *"this app made 412 calls on 2026-08-12, 9 of
them 4xx"* and you cannot answer *"which document did it read"*. The first question is what
Epic 7 and the portal ask; the second is a debugging question with a 30-day answer.

## 4. What would change these numbers

- **A queue-backed `IEventBus`.** The in-process bus is free and bounded by the API
  process. Moving to BullMQ or SQS adds infrastructure cost that scales with fanout.
- **Turning the agent hourly.** The one line that moves with an AI price, and it moves ~24×.
- **Any platform-layer AI feature.** p.11 calls this scope creep and it is also the only
  change that would put a token price on the platform's critical path.
