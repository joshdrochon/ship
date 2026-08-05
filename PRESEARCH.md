# PRESEARCH — FleetGraph

A project intelligence agent for Ship.

This document answers every question in the Presearch checklist: 3 phases, 9 categories,
32 explicit bullets (the compound bullet in §2 expands to 4, so 35 discrete answers).

Every answer states **the decision**, **why**, **what else was considered**, and **why the
choice wins**. Cost-to-build and time-to-build are never the deciding argument.

---

## Grounding

Answers here are constrained by what Ship actually is, verified against `main` at `1ca148f`
rather than assumed. The facts that did the most work:

| Fact | Where | Consequence |
|---|---|---|
| `accountability.ts` is **read-only inference**, computed per request | `routes/accountability.ts` — *"No issues are created"* | It detects, but has no trigger, memory, delivery, or judgment |
| No scheduler, cron, or queue anywhere in `api/src` | only `setInterval`s are Yjs + rate-limit cleanup | Proactive mode is new construction |
| **100 req/min per IP in production** | `app.ts` — audit W3-1 | HTTP polling is not viable for detection |
| ~4-query auth preamble on every request | audit W4-1 | Compounds the above |
| No index on `documents.updated_at` | no migration past 037 | A watermark scan seq-scans today |
| `document_history` covers 6 `TRACKED_FIELDS` in 3 route files; **bulk path bypasses it** | `utils/document-crud.ts` | Not a complete event log |
| No `LISTEN`/`NOTIFY`, no triggers, no notifications table, no webhook infra | schema | Delivery is new construction |
| `api_tokens` has **no scope column** | schema | A token inherits its user's full permissions |
| 114 registered OpenAPI paths → ~114 MCP tools | `openapi/`, `mcp/server.ts` | Far too many to hand an LLM |
| `CircuitBreaker` exists, wired to Bedrock | `services/circuitBreaker.ts` | Rule 7 has a working precedent to extend |
| `terraform/render/` deploys Postgres + web service | `terraform/render/main.tf` | The IaC foundation exists |
| Roles are only `admin \| member` | schema | Director/PM/Engineer must be *derived* |
| `/health` exists, **`/ready` does not** | `app.ts` | MVP requires both |

### Gating decisions

| # | Decision | Chosen | Rejected |
|---|---|---|---|
| 1 | Relationship to `accountability.ts` | **Sensors → judgment.** SQL detects candidates; the graph decides what is worth surfacing, to whom | Subsume it (loses a working, tested detector); run parallel (two systems disagreeing) |
| 2 | Orchestration | **LangGraph JS**, in the monorepo | Python sidecar — second runtime, second image, second Terraform service |
| 3 | Observability | **LangSmith** | Manual instrumentation, which the brief permits but charges for |
| 4 | How the agent reads Ship | **Direct SQL for detection, HTTP API for actions** | HTTP for everything — dies on 100 req/min |

Decision 4 is the load-bearing one and is defended at Q1, Q18, and Q30.

---

# Phase 1 — Define Your Agent

## §1 Agent Responsibility Scoping

### Q1 · What events in Ship should the agent monitor proactively?

**Decision.** Five signal families, all derived from columns that already exist:

| Signal | Derived from |
|---|---|
| Stalled work | `state = 'in_progress'`, `started_at` old, `updated_at` unchanged for N business days |
| Sprint-miss risk | sprint `end_date` near, issues still `todo`/`backlog` on that sprint |
| Review bottleneck | `state = 'in_review'`, `updated_at` unchanged for N business days |
| Load imbalance | `COUNT(*) … GROUP BY properties->>'assignee_id'` against team median |
| Rework churn | `reopened_at` set, or repeated `done → in_progress` in `document_history` |

Detection runs as **SQL against Postgres directly**, not through the HTTP API.

**Why silence is measured on `updated_at`, not on `document_history`.** The obvious reading of
"nothing has happened to this issue" is "no history rows since." That would be wrong here, and
the reason is recorded in the constraints table above: `document_history` covers six
`TRACKED_FIELDS` written from three route files, the bulk-update path bypasses it entirely, and
collaboration content writes are throttled. An issue can therefore change without producing a
history row — and a detector built on history absence would report it as stalled. `updated_at`
is written on every path, so it is the honest silence signal.

`document_history` is still used, but for the one thing it is reliable at: **rework churn**,
where the signal is the presence of `state` transitions rather than their absence. `state` is a
tracked field, so those rows exist when the transition went through a route that logs them.

**Why.** The production rate limit is 100 requests per minute per IP (`app.ts`, audit W3-1),
and every request additionally pays a ~4-query authentication preamble (W4-1). A proactive
scanner polling from one Render service is one IP. At any useful project count it would
exhaust the entire budget — a budget shared with the real users behind the same egress.
Detection is also a natural set query: *"every issue whose state and timestamps satisfy a
predicate."* Expressing that as REST pagination is strictly worse than expressing it as SQL.

**Alternatives.** (a) Poll the REST API — dies on the rate limit, and the audit already
measured that the limiter binds long before the process does. (b) Consume Ship webhooks —
no webhook infrastructure exists in the schema or the routes; it would have to be built, and
it would still need a reconciling scan for events missed while the agent was down.
(c) Postgres `LISTEN`/`NOTIFY` — no triggers exist; adding them puts agent concerns into the
write path of every mutation.

**Why this wins.** It is the only option that respects a measured constraint rather than
assuming it away, and it keeps the agent's failure modes out of Ship's write path. Actions
still go through HTTP (Q3), so the agent never writes to tables directly.

**Consequence to own.** `documents.updated_at` has no index, so the watermark scan seq-scans
today. FleetGraph ships migration `038` adding `(workspace_id, updated_at)`. That is a real
cost of this choice and it is cheaper than the alternatives' costs.

### Q2 · What constitutes a condition worth surfacing?

**Decision.** Two gates, in order. A signal must first cross a **deterministic threshold**
(SQL), then survive an **LLM judgment** pass that asks whether this particular instance is
worth a human's attention right now. Only signals passing both are delivered.

**Why.** These are different questions. "Has this issue sat in `in_progress` for 5 business
days" is a fact and should never cost a token. "Is that worth interrupting the PM, given the
sprint ends tomorrow and the assignee posted a standup explaining it" is a judgment, and it
is exactly what a rule engine gets wrong. Ship already has a rule engine that answers the
first kind of question well (`accountability.ts`, 9 detection types) — and its output is a
flat list with no sense of what matters.

**Alternatives.** (a) Thresholds only — that is `accountability.ts`, and it produces alert
fatigue because everything crossing a line is equally loud. (b) LLM only — every run costs
tokens whether or not anything happened, and the model is asked to do arithmetic on
timestamps, which it is bad at. (c) Static severity weights — a lookup table pretending to
be judgment; it cannot use context like "there is a standup explaining this."

**Why this wins.** The cheap deterministic gate means most runs terminate before any model
call, which is both the cost story (Q32) and the reason the traces differ run to run — a
quiet project and a drifting project take visibly different paths through the graph. A graph
that looks identical on every run is a pipeline, and the brief says so explicitly.

### Q3 · What is the agent allowed to do without human approval?

**Decision.** Autonomous actions are limited to those that are **additive and reversible**:

- Post a comment on a document (`comments` table)
- Log an observation to `document_history` with `automated_by = 'fleetgraph'`
- Create a FleetGraph notification
- Answer a question in on-demand chat

Everything that changes project state — issue state, assignee, priority, sprint membership,
creating or archiving documents — is **proposed, never executed**.

**Why.** `api_tokens` has **no scope column**. A token inherits the full permissions of the
user who created it, so there is no technical ceiling on what an agent token can do. Since
the platform cannot enforce a boundary, the boundary must be enforced in the graph and made
visible. The additive/reversible line is the one a user can always undo without needing to
know what the agent did.

Note the schema already anticipates this: `document_history.automated_by` exists specifically
to mark automated changes, and `logDocumentChange` takes it as a parameter.

**Alternatives.** (a) Full autonomy on a whitelist of "safe" mutations — a wrong reassignment
is invisible until someone notices, and there is no scope to constrain it. (b) Approve
everything including comments — the agent stops being proactive; it becomes a queue of
chores, which is the workflow interruption the brief is arguing against. (c) Confidence
thresholds gating autonomy — a self-reported score is not a safety mechanism.

**Why this wins.** It is the only boundary that holds when the token cannot enforce one, and
it degrades honestly: the worst case is a comment nobody needed.

**Improvement we ship.** Migration `038` also adds `api_tokens.scopes`, and FleetGraph's token
is issued read-only for detection. Defence in depth rather than relying on the graph alone.

### Q4 · What must always require confirmation?

**Decision.** Any state mutation, any notification to someone outside the document's
participants, and any action touching more than one document at once.

The third is the one that is easy to miss. A bulk action is the failure mode where an agent
does the most damage fastest, and Ship's own bulk endpoint (`POST /api/issues/bulk`, up to
100 ids) **bypasses `document_history` entirely** — so an agent-driven bulk update would leave
no audit trail. Until that is fixed, FleetGraph never calls it.

**Why.** Confirmation should track blast radius, not action type. A single comment and a
50-issue reassignment are not the same risk even if both are "writes."

**Alternatives.** (a) Confirm all writes — see Q3. (b) Confirm by document type — orthogonal
to risk. (c) Confirm by predicted impact — requires the model to assess its own blast radius,
which is exactly what you cannot trust it on.

**Why this wins.** Blast radius is observable from the request itself, before the action runs,
without asking the model to self-assess.

### Q5 · How does the agent know who is on a project?

**Decision.** Membership is resolved from `document_associations` joined to `person`
documents, with `properties->>'user_id'` linking to `users`. Role is **derived from
structure**, because Ship has no role column for it:

| Derived role | Derivation |
|---|---|
| Engineer | appears as `properties->>'assignee_id'` on issues in the sprint |
| PM | owns the project or sprint document |
| Director | has direct reports in the `reports-to` org chart, above the project owner |

**Why.** `workspace_memberships.role` is `CHECK (role IN ('admin','member'))` — two values,
neither of which is Director, PM, or Engineer. The brief asks us to think in those roles, so
they have to come from somewhere real. Ship encodes them structurally: ownership, assignment,
and the reporting chain. Deriving is honest; inventing a column would be modelling a fiction.

**Alternatives.** (a) Add a role column — a schema change to the user model to serve one
feature, and it would immediately drift from the associations that actually drive the app.
(b) Ask the LLM to infer role from context — non-deterministic routing for notifications is
a bad trade. (c) Configuration file — goes stale the moment someone joins a project.

**Why this wins.** It reads from the same source of truth the UI already renders, so the
agent's idea of the team can never disagree with what a user sees on screen.

### Q6 · How does the agent know who to notify?

**Decision.** Route by **accountability for the signal**, not by proximity to it — and
therefore **per signal type**, because the accountable party is not the same for all five.
One named recipient per finding:

| Signal | Recipient | Resolves via |
|---|---|---|
| Stalled work | Assignee | `properties->>'assignee_id'` on the issue |
| Review bottleneck | Assignee — see caveat | same |
| Sprint-miss risk | Sprint owner | `properties->>'owner_id'` on the sprint |
| Load imbalance | Sprint owner — **never the overloaded person** | same |
| Rework churn | Project owner | `properties->>'owner_id'` on the project |

Fallback when `owner_id` is null: the document's `created_by` column, then a workspace admin.
**Never nobody** — a finding with no recipient is a finding that silently disappears.

**Why per-signal rather than one ladder.** A single chain of assignee → sprint owner → project
owner breaks on two of the five. Load imbalance is a finding *about* the overloaded person;
notifying them is useless because they cannot fix their own allocation — it has to reach
whoever assigns work. Sprint-miss risk has no single assignee at all; it is a property of the
sprint. Routing has to follow who can act, and that varies by signal.

**Escalation.** A finding that is not acknowledged after **2 business days** escalates one
level up the org chart via `properties->>'reports_to'` on the person document — admin-only to
set, three levels deep in seed data, already exposed through `routes/team.ts`. It escalates
**at most once** and stops at the project owner. A Director never receives an individual
stalled issue; they receive only aggregate signals such as rework churn.

The unit matters and is easy to get wrong: escalation is measured in **business days, not
runs**. At a 3-minute cron, "two runs" would be six minutes — which would escalate a finding
defined by five days of silence almost immediately.

**The caveat, volunteered rather than hidden.** Review bottleneck has no strictly correct
recipient today. **Ship has no reviewer field** — an issue in `in_review` records who it is
assigned to, not who is meant to review it. So the agent tells the assignee their work is
stuck, which is true and useful but not directly actionable by them. The alternatives are
worse: inferring a reviewer from comment history is fabrication, and adding a reviewer column
is a schema change serving one detector. We ship the weaker version and name the limit.

**Alternatives.** (a) Notify all project members — fatigue, and diffusion of responsibility.
(b) One generic ladder for every signal — breaks on load imbalance and sprint-miss, as above.
(c) Let the model choose the recipient — non-deterministic, and unauditable when someone asks
why they were not told.

**Why this wins.** Every notification has exactly one person who can act on it, each hop
resolves to a column that exists and is populated in seed data, and the escalation clock runs
in the same unit as the detectors it serves.

### Q7 · How does the on-demand mode use context from the current view?

**Decision.** The chat component sends the **route parameters**, not the rendered content:
document id, document type, and active tab. A context node in the graph resolves that id into
a scoped state object — the document, its associations, its recent history, its participants
— before any reasoning runs.

Ship's router makes this clean: `documents/:id/*`, `sprints/:id/plan`, `projects/:id`,
`programs/:programId/sprints/:id`. The id in the URL *is* the context.

**Why.** Sending rendered content would mean the agent's view of a document depends on what
the UI happened to render, including truncation and lazy-loaded tabs. Sending the id means
the graph resolves the same authoritative state whether it was invoked from chat or from the
proactive cron — which is what makes "both modes run through the same graph" true rather than
aspirational.

**Alternatives.** (a) Send the visible DOM/editor content — brittle, and leaks presentation
into reasoning. (b) Send the whole workspace and let the model find the relevant part — burns
tokens and invites the model to answer about the wrong document. (c) Require the user to
state context — the brief's core complaint is that users context-switch too much.

**Why this wins.** It is the only option where the proactive and on-demand paths converge on
one context node, and it inherits Ship's existing precedent — `PlanQualityBanner` and
`QualityAssistant` already scope AI to the document in view rather than to a chat session.

---

## §2 Use Case Discovery

### Q8 · Roles: Director, PM, Engineer

Derived as in Q5. Each use case below names which derived role it serves.

### Q9 · The use cases — role, trigger, what the agent detects, what the human decides

Six, exceeding the minimum of five. The compound bullet's four fields are the four columns.

| # | Role | Trigger | Agent detects / produces | Human decides |
|---|---|---|---|---|
| 1 | Engineer (PM on escalation) | `in_progress`, `started_at` > 5 business days, no `document_history` row since | Work that looks active but has not moved; produces a comment naming the issue and the silence window | Blocked, done-but-unmarked, or abandoned |
| 2 | PM | Sprint `end_date` within 2 business days with issues still `todo`/`backlog` | Predicted sprint miss, with the specific issues and their assignees | Descope, reassign, or move the date |
| 3 | PM / Director | Assignee's `in_progress` count exceeds team median by threshold, or a sprint member has zero assigned | Load imbalance before it becomes a miss | Rebalance — the agent proposes, never reassigns |
| 4 | Engineer / PM | `in_review` for > 2 business days with no history change | Review bottleneck — finished work stuck at the gate | Who reviews, or waive it |
| 5 | Director | `reopened_at` set, or repeated `done → in_progress` in history within one sprint | Rework churn as a quality signal, aggregated per project | Whether definition-of-done needs attention |
| 6 | Any | User opens chat on a sprint / issue / project view | Grounded answer about *that* document's real state — no action | Everything; this path is read-only |

Use case 6 is the on-demand mode and is deliberately read-only, which is what makes it safe to
embed everywhere.

### Q10 · Discovered, not invented

**How these were found.** By reading what Ship already detects and finding the complement.
`accountability.ts` implements 9 detection types — standup, week_start, week_issues,
weekly_plan, weekly_retro, weekly_review, project_retro, and two changes-requested variants.
Every one is **process compliance**: did you file the artifact. None of them look at whether
the work itself is moving.

That is the pain point, and it is structural rather than imagined: Ship has columns for
`started_at`, `completed_at`, `cancelled_at`, and `reopened_at`, and nothing in the product
reads them to ask whether work is progressing. All six use cases above are built from columns
that exist and are populated, which is also why each one is testable against real data.

---

## §3 Trigger Model Decision

### Q11 · When does the proactive agent run without a user present?

**Decision.** A **Render cron job every 3 minutes**, running a watermark scan: find documents
in scope changed since the last recorded high-water mark, evaluate detectors against them,
and terminate immediately if nothing crossed a threshold.

**Why.** The detection latency requirement is < 5 minutes from an event appearing in Ship to
the agent surfacing it. A 3-minute interval leaves ~2 minutes of headroom for the graph run
itself, which is comfortably more than it needs (Q30). It runs in its own process, so it is
alive when no user session is.

**Alternatives.** (a) In-process `setInterval` in the API — dies when the web service sleeps
on Render's free plan, and couples agent uptime to API uptime. (b) External scheduler
(GitHub Actions cron) — puts the trigger outside Terraform, and the MVP requires the
deployment to be defined in Terraform. (c) Longer interval — misses the SLA.

**Why this wins.** It is the only option that is both defined in Terraform and independent of
a user session, which are the two hard requirements.

### Q12 · Poll vs. webhook vs. hybrid — tradeoffs

**Decision. Hybrid**, but not the usual meaning: poll for *detection*, event-driven for
*invocation*. The cron poll drives proactive mode; a user action in the UI invokes the same
graph synchronously for on-demand mode.

| Model | Cost | Reliability | Latency |
|---|---|---|---|
| Pure poll | Constant, independent of activity | Survives agent downtime — the watermark catches up | Bounded by interval |
| Pure webhook | Scales with activity | **Ship has no webhook infrastructure**; a missed delivery is lost with no reconciliation | Near-zero |
| Hybrid (chosen) | Poll cost is near-zero when idle (watermark returns no rows) | Watermark reconciles anything missed | 3 min proactive, immediate on-demand |

**Why.** The usual argument against polling is wasted work. That argument does not hold here:
a watermark query against an indexed `(workspace_id, updated_at)` returns zero rows on a quiet
project and the run terminates before any model call. The poll is nearly free precisely
*because* the expensive part is gated behind Q2's first threshold.

The argument for webhooks is latency, and we do not need the latency — the requirement is 5
minutes, not 5 seconds.

**Alternatives considered and rejected.** Building outbound webhooks into Ship: it means
touching the write path of every mutation, and Ship's own bulk endpoint already demonstrates
how easily a write path gets missed — it bypasses `document_history` today. An event emitter
added to routes would acquire the same holes.

**Why this wins.** It buys reliability with a cost that is genuinely near-zero when idle, and
it needs no changes to Ship's write path.

### Q13 · How stale is too stale for your use cases?

**Decision.** 3 minutes for detection, matching the cron interval. But the honest answer is
that **none of the six use cases are latency-sensitive at that scale** — they detect drift
measured in *business days*.

**Why this matters to defend rather than hide.** A stalled issue is defined by five days of
silence; learning about it 3 minutes versus 30 minutes after the threshold crosses changes
nothing for the user. The 5-minute requirement is a system property being tested, not a
property any of these use cases need. We meet it because it is required, and we do not
pretend the use cases demand it.

**Where staleness would actually bite:** the on-demand path, where a user asks a question
about a document they just edited. That path does not poll at all — it reads current state
synchronously, so it is never stale.

**Alternatives.** (a) Tighter interval — more runs, no user-visible benefit. (b) Per-use-case
intervals — real complexity for a benefit measured against thresholds in days.

### Q14 · What does your choice cost at 100 projects? At 1,000?

**Decision and numbers.** The cron is **per-workspace, not per-project** — one scan covers
every project in a workspace, because the watermark query is a single indexed range scan with
project as a grouping, not a loop.

| Scale | Scans/day | LLM calls/day | Note |
|---|---|---|---|
| 100 projects | 480 | ~50–150 | Only projects with a signal reach the model |
| 1,000 projects | 480 | ~200–600 | Scan count is **flat**; only judgment scales |

**Why this is the important property.** The scan count does not grow with project count. What
grows is the number of projects that have something worth judging, which is the thing we
actually want to pay for. The cost curve tracks drift in the portfolio, not the size of it.

The naive design — one cron per project — would be 480 × N runs/day and would hit the API
rate limit at roughly two projects.

**Alternatives.** (a) Per-project scheduling — see above. (b) Per-workspace with in-run
fan-out to a model call per project — makes LLM cost linear in project count for no gain,
since quiet projects have nothing to judge.

**Why this wins.** Flat scan cost with judgment cost proportional to actual drift is the only
shape that survives 1,000 projects, and it falls directly out of decision 4 (SQL detection).

---

# Phase 2 — Graph Architecture

## §4 Node Design

### Q15 · What are your context, fetch, reasoning, action, and output nodes?

**Decision.**

| Layer | Node | Responsibility |
|---|---|---|
| Entry | `trigger_router` | Branch on `proactive` vs `on_demand`; both continue into the same context node |
| Context | `resolve_scope` | Turn a scope reference (workspace, or a document id from the URL) into a concrete target set |
| Fetch (parallel) | `fetch_signals` | Run the five SQL detectors |
| | `fetch_participants` | Resolve people and derived roles (Q5) |
| | `fetch_prior_state` | Load already-surfaced observations for suppression |
| Gate | `triage_gate` | **Conditional.** No signals → terminate quiet |
| Reasoning | `judge_signals` | LLM: which signals matter, severity, recipient, phrasing |
| | `compose_answer` | LLM: on-demand path only — grounded answer from scoped state |
| Action | `route_action` | **Conditional.** Autonomous vs gated (Q3) |
| | `execute_autonomous` | Comment / history entry via Ship HTTP API |
| | `await_approval` | LangGraph `interrupt()`; run suspends on the checkpointer |
| | `execute_approved` | Runs the proposal after a human accepts |
| Output | `deliver` | Write notification, record observation, close the watermark |

### Q16 · Which fetch nodes run in parallel?

**Decision.** All three — `fetch_signals`, `fetch_participants`, `fetch_prior_state` — as a
LangGraph parallel fan-out, joined before `triage_gate`.

**Why.** They are independent reads with no ordering dependency: signals come from the
documents tables, participants from associations and the org chart, prior state from
FleetGraph's own table. Their combined latency becomes the slowest of the three rather than
the sum.

**Alternatives.** (a) Sequential — pays the sum for no benefit. (b) Fetch participants lazily
after triage — saves a query on quiet runs, but participants are needed to *judge* severity
(a stalled issue owned by someone on leave is a different finding), so it would just move the
work later and serialise it behind the model call.

**Why this wins.** It is the standard fan-out for independent reads, and it keeps everything
`judge_signals` needs available the moment the gate opens.

### Q17 · Where are your conditional edges and what triggers each branch?

**Decision.** Four conditional edges. This is the answer to *"a graph that looks identical
across every run is a pipeline."*

| Edge | Condition | Branches |
|---|---|---|
| After `trigger_router` | invocation mode | proactive path / on-demand path |
| After `triage_gate` | signal count = 0 | **terminate quiet** (no tokens spent) / continue to `judge_signals` |
| After `judge_signals` | anything survived judgment | terminate quiet / `route_action` |
| After `route_action` | action class (Q3) | `execute_autonomous` / `await_approval` → suspend |

**Why the second one matters most.** On a healthy project the run ends at `triage_gate` having
spent zero tokens and touched no model. On a drifting project it runs the full path and may
suspend for approval. Those produce visibly different LangSmith traces from the same graph,
which is the observability requirement satisfied by the architecture rather than by
contrivance.

---

## §5 State Management

### Q18 · What state does the graph carry across a session?

**Decision.** A single typed state object threaded through every node:

```
scope          — workspace / project / sprint / document under examination
mode           — 'proactive' | 'on_demand'
actor          — invoking user (on-demand) or the agent identity (proactive)
signals[]      — detector output: type, target, measurement, threshold crossed
participants[] — people in scope with derived roles
suppressed[]   — findings already surfaced and still open
findings[]     — post-judgment: severity, recipient, proposed action
pending        — the proposal awaiting approval, when suspended
messages[]     — conversation turns, on-demand only
```

**Why.** Every node reads from and writes to one object, so a LangSmith trace shows exactly
what each node saw. Keeping `signals` (measured) separate from `findings` (judged) is
deliberate — it makes it visible in the trace where determinism ends and the model begins.

### Q19 · What state persists between proactive runs?

**Decision.** Two new tables in Ship's existing Postgres, plus the LangGraph checkpointer:

| Table | Holds | Purpose |
|---|---|---|
| `fleetgraph_observations` | signal fingerprint, target, first seen, last surfaced, resolution | Suppression + escalation (Q6) |
| `fleetgraph_notifications` | recipient, finding, state, acknowledged | Delivery — Ship has no notifications table |
| LangGraph checkpointer | serialised graph state per thread | Survives the `interrupt()` for human approval |

Plus a watermark per workspace — the `updated_at` high-water mark of the last completed scan.

**Why the checkpointer is not optional.** Human approval can take hours. The Render cron
container exits when the run ends. Without a durable checkpointer the suspended run dies with
the process and the approval has nothing to resume. LangGraph's Postgres checkpointer solves
exactly this and points at the database we already have.

**Alternatives.** (a) In-memory state — cannot survive a cron container exiting; this is the
single strongest argument for a real checkpointer. (b) Redis or Render's key-value store —
worth stating honestly that this is *available*, not hypothetical: `render_keyvalue` and
`render_redis` are both resources in the pinned provider, so it would be a few lines of
Terraform. It still loses, because the state in question is small, relational, and joins to
`documents` and `users` — putting it in a key-value store means giving up those joins and
adding a second backup story for no gain. (c) Store state in Ship's `documents` table —
pollutes the unified document model with agent bookkeeping, which Ship's own philosophy docs
argue against.

**Why this wins.** One database, one backup story, one Terraform resource, and the suppression
table is genuinely relational (joins to documents and users).

### Q20 · How do you avoid redundant API calls?

**Decision.** Four mechanisms, cheapest first:

1. **Watermark** — the scan only considers documents changed since the last completed run.
   A quiet workspace returns zero rows.
2. **Suppression** — a fingerprint of (signal type + target + threshold bucket) is checked
   against `fleetgraph_observations`. An already-surfaced, unresolved finding never reaches
   the model again.
3. **Content hashing** — SHA-256 of the judged input, so re-judging identical state is
   skipped. Ship already uses this exact pattern in `ai-analysis.ts` (`computeContentHash`).
4. **Triage gate** — the conditional edge at Q17; no signals means no model call at all.

**Why.** Together these make the marginal cost of a run on an unchanged project effectively
one indexed query. The expensive resource is model tokens, and every mechanism above exists to
keep work away from the model rather than to make the model faster.

**Alternatives.** (a) Time-based cache only — re-surfaces the same finding when the TTL
expires, which is precisely the alert-fatigue failure. (b) Cache model responses by prompt —
helps a repeated question, does nothing for the proactive path. (c) No dedup, filter at
delivery — pays full token cost to then throw the answer away.

**Why this wins.** Suppression is keyed on the *finding*, not on time, so a finding is
surfaced once and escalated on a schedule rather than repeated on one.

---

## §6 Human-in-the-Loop Design

### Q21 · Which actions require confirmation?

Answered at Q3 and Q4: every state mutation, every multi-document action, every notification
beyond the document's participants. Mechanically this is LangGraph's `interrupt()` at
`await_approval`, with the proposal serialised into the checkpointer.

**Why `interrupt()` rather than a separate approval service.** The suspended run holds its
full state — what it saw, what it judged, what it proposed. When a human approves, execution
resumes in the same graph with the same context and the same trace. An external approval queue
would have to reconstruct all of that, and the reconstruction is where the reasoning and the
action drift apart.

### Q22 · What does the confirmation experience look like in Ship?

**Decision.** In the document the finding is about — not in a notification centre, and not in
a modal. Concretely: a compact banner in the document view, matching the existing
`PlanQualityBanner` pattern, with the finding, the proposed action, and Accept / Dismiss /
Snooze.

**Why.** Ship already solved this problem once. `PlanQualityBanner` renders AI feedback
between the title and the editor, and `QualityAssistant` lives in the properties sidebar —
both are AI surfaces embedded in context, neither is a chatbot. The brief's constraint is the
same: *"chat interface must be embedded in context — no standalone chatbot pages."* Matching
an existing pattern means the agent looks like part of Ship rather than a bolt-on.

There is one deliberate exception: findings whose target is a *set* (use case 3, load
imbalance) surface on the sprint view, because that is the document the decision is about.

**Alternatives.** (a) Notification centre — a second inbox, which is more context-switching,
the exact thing the brief opens by criticising. (b) Modal on load — interrupts before the user
has their bearings. (c) Email — leaves the product entirely.

**Why this wins.** The approval happens where the evidence is visible, so the human can check
the agent's reasoning against the document in front of them before accepting.

### Q23 · What happens if the human dismisses or snoozes?

**Decision.**

| Action | Effect |
|---|---|
| **Accept** | Resume the graph; execute the proposal via the Ship HTTP API; record the outcome |
| **Dismiss** | Mark the observation resolved-by-dismissal. **The same fingerprint never fires again for that target.** Recorded as a judgment error signal |
| **Snooze** | Suppress for a fixed horizon, then **re-run the detector** — if the condition resolved itself, it never returns |

Snooze horizons are offered in **business days**, matching the unit the detectors measure in —
1, 3, or 5 days, defaulting to 3. Not hours: every threshold in Q1 is expressed in business
days, so an hours-scale snooze would wake before the underlying state could plausibly change
and would re-present an identical finding.

**Why dismissal must be permanent for that fingerprint.** A dismissed finding that returns
next week is the single fastest route to users disabling the agent. Dismissal is information:
the agent was wrong, or the human has context the agent lacks. Either way, re-asking is worse
than useless.

**Why snooze re-evaluates rather than re-fires.** A snoozed stalled issue that has since moved
should not come back at all. Re-running the detector at wake time — rather than replaying the
stored finding — means a self-resolving condition disappears silently, which is the correct
behaviour and is only possible because detection is cheap (Q1).

**Alternatives.** (a) Dismiss with a TTL — resurrects rejected findings. (b) Snooze as a
blind re-fire — surfaces conditions that have already resolved. (c) No dismiss, only resolve —
forces the human to fix something to make the agent stop, which is coercive when the agent is
simply wrong.

---

## §7 Error and Failure Handling

### Q24 · What does the agent do when the Ship API is down?

**Decision.** Split by path, because decision 4 means the two halves fail independently.

| Path | If unavailable | Behaviour |
|---|---|---|
| Detection (direct SQL) | Postgres unreachable | Abort the run without advancing the watermark; next run covers the missed window |
| Actions (HTTP API) | API 5xx / unreachable | Circuit breaker opens; findings are recorded and queued, not lost; delivery retries on the next run |
| Judgment (LLM) | provider unreachable | Breaker opens; signals persist unjudged and are judged next run |

**Why not advancing the watermark is the key detail.** The watermark advances only on a
completed run. A crashed or aborted run leaves it where it was, so the next scan re-covers the
same window. That makes the whole proactive path **crash-safe without any retry logic** — the
reconciliation is inherent to the design rather than bolted on.

**Alternatives.** (a) Advance the watermark optimistically and retry failures — a crash
between advancing and delivering loses findings permanently. (b) A dead-letter queue — new
infrastructure to solve a problem the watermark already solves. (c) Fail the whole run if any
dependency is down — a Bedrock outage would then also stop detection, which is unnecessary.

### Q25 · How does it degrade gracefully?

**Decision.** Reuse `api/src/services/circuitBreaker.ts` — it already exists, is tested, and
already wraps Bedrock with 3s connect / 20s request / 3 attempts / 5-failure threshold /
60s cooldown. FleetGraph adds a second breaker instance for the Ship HTTP API.

Degradation ladder:

1. **LLM down** → deterministic signals are still recorded and still visible on-demand; the
   agent loses judgment, not detection.
2. **Ship API down** → findings accumulate; delivery resumes when it returns.
3. **Postgres down** → the agent is fully down; Ship is also fully down, so there is nothing
   to detect.

**Why this ladder.** Each rung keeps the layer beneath it working. The agent never crashes,
never hangs, and never loops — the brief's explicit requirement — because every outbound call
has a bounded timeout and a breaker in front of it.

**Why reuse rather than write.** The existing breaker's own comments document why it was
written: *"a retry makes a single request more likely to succeed, but when the dependency is
down it multiplies the load and multiplies the latency every caller waits through."* That
reasoning applies unchanged. Writing a second one would be duplicating a solved problem.

**Correction (2026-08-04) — rung 1 was the steady state, not the exception.**

The ladder above is right about what each failure costs. It is wrong about which failure was
going to happen. "LLM down" was written as a transient — an outage, an expired role, a bad
minute — and the design leans on that: signals stay unjudged and are judged *next run*.

There was no next run. Bedrock was chosen here because Ship already used it, and that premise
does not survive checking: `terraform/render/*.tf` declared no AWS environment variables at
all, and `api/src/services/ai-analysis.ts:39` already recorded the same thing about the API —
"no AWS credentials at all". Render supplies no instance role, so the ambient credential chain
resolved to nothing on every run, forever.

So the deployed agent sat permanently on rung 1. Every layer behaved exactly as specified:
judgement returned `ai_unavailable`, `makeJudge` threw, the graph routed to `close_quiet`, and
`closeQuiet` correctly held the watermark. The product of all that correct behaviour was an
agent that detects drift every three minutes and notifies nobody. MVP requirement 1 wants one
proactive detection reaching a human end-to-end; there was no path to one.

Nothing caught it because nothing failed loudly. "No findings" is also what a calm project
looks like — the two are indistinguishable from outside, which is precisely the ambiguity the
graph's quiet path is designed to produce cheaply.

**What changed.** The direct Anthropic API is now the primary provider, selected by
`ANTHROPIC_API_KEY` (`agent/src/llm/client.ts`, terraform var `anthropic_api_key`). Bedrock
stays as the fallback and, more importantly, as the mock seam — `BEDROCK_ENDPOINT` still
steers CI and `./start.sh` at the local fake, which is engineering requirement 3 and must keep
working. Precedence is `BEDROCK_ENDPOINT` > `ANTHROPIC_API_KEY` > ambient AWS, so a key
present in a CI environment cannot quietly turn a deterministic suite into a billed one.

The provider was never a requirement — the brief names none — so this costs nothing the
original decision was buying. Everything downstream is untouched: `PromptedModel` is
structural, the breaker fronts `callModel` rather than the client, and judge and answer never
learn which provider replied.

**What stops it recurring.** Two things, because the code change alone would not have been
caught either. `agent/src/llm/client.test.ts` asserts which provider a call would reach,
including the precedence rule. And `cron.ts` now logs `fleetgraph.model` once per process,
before any work, naming the provider and whether it is mocked — so a run that surfaced nothing
because the project is calm is distinguishable in the log from one that surfaced nothing
because there was no credential.

### Q26 · What gets cached and for how long?

**Decision.**

| Cached | TTL | Invalidated by |
|---|---|---|
| Participants + derived roles | 15 min | Membership changes rarely; staleness costs a mis-route at worst |
| Detector results | Not cached | Cheap by construction; caching would add staleness for no gain |
| Judgments | Until the finding resolves | Content hash — same input, same judgment |
| Suppression set | Run lifetime | Reloaded each run from `fleetgraph_observations` |
| OpenAPI-derived tool schemas | Process lifetime | Only change on deploy |

**Why judgments are keyed on content rather than time.** A finding whose underlying state has
not changed has not become more or less true with age. Ship already uses this pattern in
`ai-analysis.ts`, where `content_hash` skips re-analysis of unchanged content.

**Alternatives.** (a) Cache detector output — the query is an indexed range scan; caching
trades correctness for nothing. (b) Global TTL on everything — makes judgments expire and
re-fire, the Q23 failure. (c) No cache — re-resolves the org chart on every run for data that
changes monthly.

---

# Phase 3 — Stack and Deployment

## §8 Deployment Model

### Q27 · Where does the proactive agent run when no user is present?

**Decision.** A **`render_cron_job`** resource in `terraform/render/`, alongside the existing
`render_postgres.ship` and `render_web_service.shipshape`. It runs the same image as the API,
with a different entrypoint.

Verified rather than assumed: `render_cron_job` is one of the 17 resources in
`render-oss/render` **1.9.1**, the version this repo pins exactly in
`terraform/render/versions.tf`. Its required attributes are `name`, `plan`, `region`,
`runtime_source`, and `schedule`; `start_command` is optional — which is precisely the seam
that makes "same image, different entrypoint" work without a second image.

**Why the same image.** Build/release/run separation (Rule 5, carried from Week 4): the image
is built once in CI and promoted by SHA. One image with two entrypoints means the agent and
the API can never be running different versions of the shared types, the circuit breaker, or
the database schema expectations.

**Alternatives.** (a) A separate always-on web service running an internal scheduler — pays
for an idle process 24/7 and adds a second image to keep in sync. (b) In-process scheduler in
the API — dies when the free-plan service sleeps, and couples agent liveness to API liveness.
(c) External cron (GitHub Actions) — the trigger would live outside Terraform, and the MVP
requires the deployment to be defined there.

**Why this wins.** It satisfies the Terraform requirement, survives the destroy-and-redeploy
test as a declared resource, and inherits the existing secret handling — `terraform/render/`
already reads the database URL off the Postgres resource's computed `connection_info` so no
connection string enters a variable, a tfvars file, or the repository.

### Q28 · How is it kept alive?

**Decision.** It is not. The cron job is **not a long-lived process** — it starts, scans,
acts, and exits. Liveness is Render's scheduler, which is declared in Terraform.

For the on-demand path, which does need to be reachable, the graph runs inside the existing
API service — so it inherits the health checking already in place.

**What we add.** `/ready` does not exist today; only `/health` does. The MVP requires both, so
FleetGraph adds `/ready`, distinguishing *process is up* from *dependencies are reachable* —
reporting Postgres connectivity and the circuit-breaker states, which
`getBedrockBreakerStats()` already exposes for exactly this purpose.

**Why a cron rather than a daemon.** A process that exits cannot leak memory, wedge, or drift.
Its failure mode is "did not run," which the scheduler reports, rather than "running but
stuck," which requires a watchdog to detect.

**Alternatives.** (a) Long-running worker with an internal loop — needs liveness probes, a
restart policy, and memory-leak vigilance for no benefit. (b) Serverless function — a fourth
deployment target for the same code.

### Q29 · How does it authenticate with Ship without a user session?

**Decision.** A **Ship API token** (`api_tokens`) issued to a dedicated FleetGraph service
account, passed as `Authorization: Bearer` — the exact mechanism `mcp/server.ts` already uses.
Injected as an environment variable by Terraform; never committed.

**Why.** Ship already solved this. `authMiddleware` checks for a Bearer token before falling
through to session cookies, and `api_tokens` stores a SHA-256 hash with `last_used_at`,
`expires_at`, and `revoked_at`. A revocable, auditable, expiring credential that requires no
new code is strictly better than anything we would invent.

**The problem we own and fix.** `api_tokens` has **no scope column** — a token inherits its
creating user's full permissions (Q3). Migration `038` adds `scopes`, and FleetGraph's
detection token is issued read-only. The action token stays separate and narrower.

**Alternatives.** (a) Service account with a session cookie — sessions time out at 15 minutes;
a cron would spend most of its life re-authenticating. (b) Shared secret header — a second
auth path to secure, bypassing the audited one. (c) mTLS — real infrastructure cost for a
threat model where a revocable bearer token over TLS is appropriate.

---

## §9 Performance

### Q30 · How does your trigger model achieve < 5 minute detection latency?

**Decision and budget.**

| Stage | Budget | Basis |
|---|---|---|
| Worst-case wait for next cron | 180 s | 3-minute interval |
| Container cold start | ~15 s | Same image as the API; measured on Render |
| Watermark scan + detectors | 1 s | Indexed range scan (migration 038) |
| Judgment (LLM) | 20 s | Hard ceiling — the existing Bedrock request timeout, not an estimate |
| Delivery | 1 s | Two inserts |
| **Total worst case** | **217 s = 3 min 37 s** | **83 s of headroom** against the 300 s SLA |

Every term above is a worst case, not an average, and the two largest are bounded by
configuration rather than by measurement: the interval is ours to set, and the model call
cannot exceed 20 s because the existing request timeout kills it first.

**Why the headroom sits where it does.** The dominant term is the polling interval, which is
the one thing fully under our control and independent of any external system. The variable
term — the model call — is bounded at 20 s by the existing Bedrock request timeout, so even a
pathologically slow judgment cannot breach the SLA; it fails fast into `ai_unavailable` and
the signal is judged next run.

**The verification is a timed test run**, per the brief: introduce an event into Ship, start
the clock, assert the agent surfaces it inside the window. That is one of the two required
E2E tests.

**Alternatives.** (a) 1-minute cron — 3× the runs to buy latency no use case needs (Q13).
(b) 5-minute cron — zero headroom; a single cold start breaches. (c) Webhooks for latency —
does not exist in Ship, and would still need the poll for reconciliation.

### Q31 · What is your token budget per invocation?

**Decision.**

| Path | Input | Output | Notes |
|---|---|---|---|
| Quiet proactive run | **0** | **0** | Terminates at `triage_gate` |
| Proactive with signals | ~2,000–4,000 | ~500–1,000 | Signals are pre-measured; the model judges, it does not search |
| On-demand chat turn | ~3,000–6,000 | ~300–800 | Scoped to one document + history |

`max_tokens` is capped at 2048, and input is bounded by `MAX_CONTENT_TEXT_LENGTH` (50 KB) —
both existing limits in `ai-analysis.ts` that we inherit rather than re-derive.

**Why the input is small.** The model never receives raw project data to search through. It
receives *measurements* — "issue X, in_progress, 7 business days, no history since, assignee
Y, sprint ends in 2 days" — because the SQL layer did the finding. That is decision 4 paying
off a second time: it keeps the prompt small and keeps the model out of arithmetic it is bad
at.

**Alternatives.** (a) Send the project state and let the model find problems — an order of
magnitude more input tokens, non-deterministic recall, and it would still need the
deterministic layer for thresholds. (b) Summarise first, then judge — two model calls where
one suffices.

### Q32 · Where are the cost cliffs in your architecture?

**Decision — named honestly, with the mitigation for each.**

| Cliff | Trigger | Mitigation |
|---|---|---|
| **Judging every signal individually** | N model calls per run instead of 1 | Batch all signals for a scope into one judgment call; severity ranking needs to see them together anyway |
| **Suppression failure** | Same finding re-judged every 3 min = 480 calls/day/finding | `fleetgraph_observations` fingerprinting (Q20). **This is the biggest cliff in the design** |
| **On-demand unbounded** | Users chat freely; cost scales with engagement, not drift | Per-user rate limit reusing the existing `checkRateLimit` pattern (120/hr) |
| **Conversation history growth** | Long threads resend full history each turn | Cap at N turns; scope state is re-resolved rather than carried |
| **Watermark reset** | A migration touching `updated_at` en masse makes every document look changed | Detectors are threshold-based, so a mass re-scan finds the same signals and suppression absorbs them — the cliff is one expensive scan, not an alert storm |

**Why suppression is the one to watch.** Every other cliff is bounded by something external —
user behaviour, thread length, deploy frequency. A suppression bug is bounded by nothing: it
turns one finding into 480 model calls a day, silently, and the symptom is a cost graph rather
than an error. It gets a regression test of its own.

---

## Open items

Honest list of what is decided here but not yet proven:

| Item | Status |
|---|---|
| Migration `038` — `(workspace_id, updated_at)` index, `api_tokens.scopes` | Designed, not written |
| `/ready` endpoint | Required by MVP, does not exist yet |
| `render_cron_job` in `terraform/render/` | **Verified** present in provider 1.9.1 with a `start_command` seam; resource not yet written |
| Detection latency budget | Terms are bounded by configuration, but the 15 s cold start is the one real estimate — the timed test run is what proves it |
| LangGraph JS durable `interrupt()` | **Verified 2026-08-03.** See below |
| No reviewer field in Ship | Q6's review-bottleneck routing has no strictly correct recipient. Named, not worked around |
| Bulk endpoint bypasses `document_history` | Ship defect found during this research; FleetGraph avoids the endpoint, does not fix it |

### Closed — LangGraph JS durable `interrupt()`

The one assumption Q19, Q21, Q27 and Q28 all rested on, and the only reason the cron model
works: a run suspended for human approval must survive the container exiting, because approval
takes hours and the cron process does not.

Verified rather than assumed. `@langchain/langgraph` 1.4.8 with
`@langchain/langgraph-checkpoint-postgres` 1.0.4, against a real Postgres. A four-node graph —
detect → judge → `interrupt()` → execute — was run to the interrupt in one process, which then
called `process.exit(0)`; a second, independent process resumed the same thread id.

The execution trail is the evidence:

```
detect@pid:89796 · judge@pid:89796 · resumed@pid:89801 · execute@pid:89801
```

Eight assertions passed. The load-bearing ones: state written before the interrupt survived
intact (signals, findings, and their judged severity); the human's answer reached the resumed
node; execution continued past the interrupt; and **the pre-interrupt nodes did not re-run** —
the graph resumed rather than replaying, which is what makes the approval cheap and the trace
continuous.

Consequence: no design changes. Q21's argument for `interrupt()` over an external approval
queue — that the suspended run keeps its own context and trace — holds in the JS
implementation.
