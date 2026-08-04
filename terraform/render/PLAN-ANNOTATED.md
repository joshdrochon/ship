# The FleetGraph deployment plan, resource by resource

Companion to `plan-output.txt`, which is the verbatim `terraform plan` from empty
state. MVP requirement 8. This file answers, for each of the three resources: what
it creates, why it has to exist, and what breaks if it does not.

The plan is `3 to add, 0 to change, 0 to destroy` — the whole system, from nothing,
in one command. That number is the requirement, not a summary of it: a deployment
that cannot be recreated from an empty state is a deployment nobody can roll back.

---

## The shape of the graph

Terraform prints the three resources alphabetically, which is the reverse of the
order they are created in. The real order comes from the references in `env_vars`:

```
render_postgres.ship
   │  connection_info.internal_connection_string
   ├──────────────────────────────► render_web_service.shipshape
   │                                    │  url
   └──────────────────────────────► render_cron_job.fleetgraph ◄──┘
```

Nothing declares `depends_on`. Every edge above is inferred from an attribute
reference, which is the point — a `depends_on` is a claim a human maintains, and an
attribute reference is a fact the graph derives. Create order is database, then web
service, then cron; destroy order is exactly reversed, so the cron stops before the
database it reads disappears.

The cron depends on *both* of the others. That is the one structural thing this
change adds to the stack, and it is what makes the "same image" guarantee mechanical
rather than aspirational.

---

## `render_postgres.ship` — the database

**What it creates.** A managed PostgreSQL 16 instance in `oregon` on the `free`
plan, named `ship-db`.

**Why it is needed.** Two consumers now, not one. The API stores documents, sessions
and `api_tokens` here; the agent stores its LangGraph checkpoints here, which is what
lets a run suspended for human approval survive the cron container exiting. Approval
takes hours and a cron process takes seconds — without durable checkpoints, the
proactive agent could detect and judge but could never wait for an answer.

**Without it.** The API fails at boot. The agent's first checkpoint write throws and
every scheduled run dies in the same place, three minutes apart, forever.

**What the plan is telling you that is easy to skim past:**

- `database_name` and `database_user` are `(known after apply)` rather than the
  literals you might expect. That is deliberate and it is defended in `main.tf`:
  Render disambiguates the name on create, so asking for `ship` returns
  `ship_<suffix>`, and because the attribute forces replacement, a literal here
  would plan a destroy of a healthy database on *every subsequent run*. This was
  measured, not predicted — an earlier draft produced
  `Plan: 1 to import, 1 to add, 0 to change, 1 to destroy`.
- `connection_info = (sensitive value)`. The connection string is never typed, never
  a variable, never an output. It is read off this resource and handed to the two
  consumers inside the graph.
- `plan = "free"`, which Render deletes 30 days after creation, along with the data.
  The `postgres_plan_expiry_warning` output says so in words on every apply. The
  `prevent_destroy` lifecycle rule in `main.tf` does not appear in this plan at all,
  because it only bites on a *destroy*, and this plan destroys nothing — which is
  precisely when you would want to be reminded it is there.

---

## `render_web_service.shipshape` — the API and the on-demand agent

**What it creates.** A single-instance Docker web service running
`ghcr.io/joshdrochon/ship` at commit `4cbc804`, health-checked at `/health`.

**Why it is needed.** It serves the app, and — relevant to FleetGraph — it is where
the *on-demand* half of the agent runs. Proactive mode is the cron below; context-aware
chat is a synchronous request against this service. Both invoke the same graph. One
of them needed a long-lived HTTP process, and this is the one that already existed.

**Without it.** No app, and no on-demand mode. The cron would still fire, still
detect, and have nowhere to deliver to — `SHIP_API_URL` is this resource's `url`.

**What the plan is telling you:**

- `runtime_source.image`, not `runtime_source.docker`. Render pulls an image CI already
  built, tested and pushed; it does not clone and compile. Implementation Rule 5.
  `digest = (known after apply)` is the receipt — Render resolves the tag to an
  immutable digest and records which bytes it actually ran.
- `num_instances = 1`, and the variable refuses anything else. The collaboration
  server keeps Yjs document state in module-level `Map`s, so a second instance would
  serve divergent documents to two editors. This is a known limit, written down
  rather than discovered in production.
- `max_shutdown_delay_seconds = 60`, so WebSocket connections drain instead of being
  cut mid-keystroke.
- `env_vars` lists three keys and no more. `SESSION_SECRET` renders as a bare
  `(sensitive value)` rather than the `{generate_value, value}` shape the other two
  have, because it takes the `generate_value = true` branch — Render mints it, so a
  clean-machine apply needs exactly one credential rather than two.

---

## `render_cron_job.fleetgraph` — the proactive agent

The new resource. Everything above already existed; this is what this change adds.

**What it creates.** A scheduled job on the `starter` plan in `oregon`, running the
**same image at the same tag as the web service**, with `start_command` overriding
the image's entrypoint, on `*/3 * * * *`.

**Why it is needed.** The requirement is that the agent acts when no user is present.
Nothing else in the stack can do that. The web service sleeps on Render's free plan,
so an in-process `setInterval` would stop running exactly when nobody is looking —
which is the only situation the proactive agent exists for. A GitHub Actions cron
would work, but it would move the trigger outside Terraform, and the deployment is
required to be defined here.

**Without it.** FleetGraph is a chatbot. Every use case that depends on noticing
something before a human asks — the stalled issue, the review bottleneck, the sprint
that will not land — has no mechanism at all.

### The four lines that carry the design

**`schedule = "*/3 * * * *"`** — three minutes, and the number is derived rather than
picked. The requirement is under 5 minutes from an event landing in Ship to the agent
surfacing it. The interval is the dominant term in that budget:

| Term | Worst case | Bounded by |
|---|---|---|
| Wait for the next run | 180 s | this line |
| Container cold start | 15 s | measurement — the one real estimate here |
| Watermark scan + detectors | 1 s | an indexed `(workspace_id, updated_at)` range scan |
| Judgment (one LLM call) | 20 s | the existing Bedrock request timeout, not a guess |
| Delivery | 1 s | two inserts |
| **Total** | **217 s** | **83 s of headroom against 300 s** |

Five minutes leaves zero headroom — one cold start breaches. One minute triples the
run count to buy latency no detector needs; they measure drift in business days. The
`agent_detection_latency_budget` output recomputes this table's first two columns from
whatever `agent_cron_schedule` is actually set to, so widening the interval surfaces
in the plan instead of quietly consuming the margin.

The cost of polling this often is near zero when nothing is happening: a run whose
watermark query returns no rows terminates at the triage gate having made no model
call.

**`start_command = "node /app/agent/dist/entrypoints/cron.js"`** — the same-image seam,
and the single most consequential line in the file. The image's own `CMD` migrates,
seeds, then starts an HTTP server; a cron container running that would bind a port,
serve nothing, never exit, and be killed at the job timeout — recording a failure
every three minutes. Overriding the command is what turns identical bytes into a
process that scans, acts, and exits.

The alternative is a second image built from an agent-only Dockerfile, and it is worse
for a reason unrelated to build minutes. The agent and the API share code: `shared/`
types, the document schema they both read, the migration set, the circuit breaker. Two
images means two tags, and two tags can drift. The resulting failure is the worst kind
— the cron reads a column the deployed API has not migrated yet, nothing errors at
deploy time, and it surfaces at 03:00 in a scheduled run nobody is watching. With one
image that state is unrepresentable: a single `-var image_tag=<sha>` moves both
services or neither.

The plan proves it rather than asserting it. `image_url` and `tag` are character-for-
character identical between `render_cron_job.fleetgraph` and
`render_web_service.shipshape`, because both read the same two variables.

**`DATABASE_URL` and `SHIP_API_URL`** — both resource references, neither a literal.
`DATABASE_URL` is `render_postgres.ship.connection_info.internal_connection_string`,
the private-network address, so the credential never traverses the public internet and
never enters a variable, a tfvars file, or this repository. `SHIP_API_URL` is
`render_web_service.shipshape.url`, which on a fresh apply *nobody knows yet* — it is
`(known after apply)` in this very plan. A literal would force a two-pass apply and
would go stale silently if the service were ever recreated. These two references are
also what create the dependency edges drawn at the top of this file.

**`plan = "starter"`, not `"free"`.** The only place the cron cannot copy the web
service. Render offers no free instance type for cron jobs and bills them by runtime
against a $1/month floor. Copying `var.service_plan`'s default across would look
right, validate clean, plan clean, and fail at apply against Render's API — so
`var.agent_cron_plan` rejects `free` explicitly, with an error message that says why
it is rejected here and valid there.

---

## What is in state, measured

Ticket FG-193 asks whether a secret lands in `terraform.tfstate` beyond what the
provider itself requires. Asserting "no" would be easy and wrong. Here is what was
actually checked.

There is no `terraform.tfstate` to inspect — nothing has been applied. The closest
available evidence is a saved plan file, whose `planned_values` block is the shape
state takes after apply. One was written to `/tmp` with distinguishable placeholder
strings in every credential variable, converted with `terraform show -json`, searched
for those strings, and deleted.

**Found — and unavoidable:**

| Value | Where |
|---|---|
| `SHIP_API_TOKEN` | `planned_values…render_cron_job.fleetgraph.values.env_vars.SHIP_API_TOKEN.value` |
| `LANGCHAIN_API_KEY` | same, `…env_vars.LANGCHAIN_API_KEY.value` |

Both plaintext. This is the floor, not a defect: Terraform has to send these to
Render's API, so it has to hold them, and holding them means state. `main.tf` already
documents the identical exposure for `registry_token`. The mitigations are the ones
that apply to any provider-managed secret — treat the state file as a credential,
keep it out of git (`terraform/.gitignore` covers `*.tfstate`, verified with
`git check-ignore`), and rotate through Ship's `api_tokens` revocation path rather
than by editing state.

**Found — and specific to the plan *file*, not to state:**

`render_api_key`, `render_owner_id`, `ship_api_token` and `langchain_api_key` all
appear plaintext under the JSON's top-level `variables` block. State has no
`variables` section, so these do not reach `terraform.tfstate` — but a saved
`-out` plan file carries every one of them. That is audit finding W8-1 in its
original form: a committed `terraform/environments/shadow/tfplan` that leaked an
account identifier and a named IAM principal.

This is why `plan-output.txt` was produced by redirecting stdout rather than by
`terraform show`-ing a saved plan. `terraform plan` stdout contains no credential
value at all — verified by grepping the committed file for each placeholder, which
matched nothing but the string `SHIP_API_TOKEN`, a variable *name*.

**Fixed along the way.** The first plan of this file rendered the cron's entire
environment as `+ env_vars = (sensitive value)` — one opaque line, hiding `NODE_ENV`,
`DATABASE_URL` and `SHIP_API_URL` along with the one actual secret, while the web
service's rendered key by key. The cause was structural, not a marking: `main.tf`'s
`optional_env` idiom filters nulls inside a for-expression, so copying it made the
map's *shape* depend on whether a sensitive variable was set, and Terraform then marks
the whole collection sensitive. Gating on `nonsensitive(var.langchain_api_key != null)`
instead makes the shape depend on a boolean — whether tracing is on, which is already
a published output and not a secret — while each value stays sensitive. The plan now
shows four named keys with four redacted values, which is what a reviewer needs: the
ability to check *what* the agent is given without being shown *what it is*.

---

## What this plan does not prove

Honest limits, so nobody reads more into a clean plan than it earns.

- **It has never been applied.** `plan` against an empty state validates the
  configuration and the provider schema. It does not validate that Render accepts a
  3-minute schedule, that the `starter` plan is spelled the way the API expects, or
  that the image pulls.
- **The credentials were placeholders.** Legitimate here — the render provider makes
  no API call during plan for a create-only graph with no data sources, so the output
  is identical to one produced with a live key — but it means nothing about the
  configuration was checked *against Render*.
- **`start_command` names a file that does not exist yet.** `agent/src/entrypoints/cron.ts`
  is unwritten, and the `Dockerfile`'s runtime stage copies `api/dist`, `shared/dist`
  and `web/dist` but not `agent/dist`. Terraform cannot see either fact. Applied today
  this plan would succeed and every scheduled run would fail on `Cannot find module` —
  which is why the command is a documented variable rather than a hardcoded string, and
  why both preconditions are written into `var.agent_start_command`'s description
  instead of being left for someone to rediscover from a log.
- **The latency budget is arithmetic, not a measurement.** Four of its five terms are
  bounded by configuration; the 15-second cold start is a real estimate. The timed E2E
  test — introduce an event, start the clock, assert the agent surfaces it inside the
  window — is what turns the table into evidence.
