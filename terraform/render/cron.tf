# FleetGraph proactive agent — Render cron job
#
# ---------------------------------------------------------------------------
# One image, two entrypoints
# ---------------------------------------------------------------------------
#
# This resource runs the *same* image as render_web_service.shipshape. Same
# `image_repository`, same `image_tag`, same registry credential. The only thing
# that differs is `start_command`, which is the entire seam.
#
# The alternative is a second image built from an agent-only Dockerfile. It is
# worse for a reason that has nothing to do with build minutes:
#
#   The agent and the API share code — shared/ types, the document schema they
#   both read, the Bedrock circuit breaker, the migration set. Two images means
#   two tags, and two tags means the pair can drift. The failure that produces is
#   the worst kind: the cron reads a column the deployed API has not migrated
#   yet, or judges against an enum the API no longer emits, and nothing errors at
#   deploy time. It errors at 03:00 in a scheduled run nobody is watching.
#
#   With one image, that state is unrepresentable. `terraform apply -var
#   image_tag=<sha>` moves the web service and the cron to the same commit in one
#   plan, or moves neither. There is no ordering to get wrong and no window where
#   they disagree.
#
# This is Implementation Rule 5 (build/release/run separation) applied to a second
# runtime rather than restated for it: CI builds and verifies one artifact, and
# both processes that run in production are that artifact. See PRESEARCH.md Q27.
#
# The Dockerfile makes this cheap. It already seeds on boot and it bakes GIT_SHA
# into the image, so a cron container is self-describing in exactly the way the
# web container is — `GIT_SHA` inside the agent process is the same value
# /health reports for the API, and if they ever differ, something deployed out of
# band.

locals {
  # LangSmith tracing is opt-in. Same intent as main.tf's `optional_env`: omit the
  # variables entirely rather than setting "" — an empty API key is a
  # configured-but-broken tracer that fails on the first span, where unset is a
  # tracer that never starts.
  #
  # `nonsensitive` on the gate, and it is load-bearing rather than tidy.
  # main.tf's version filters nulls with `if v != null` inside a for-expression,
  # which is fine there because app_base_url and friends are not sensitive. Do the
  # same here and the *shape* of the map depends on a sensitive value, so Terraform
  # marks the whole collection sensitive — and `terraform plan` then prints
  #
  #     + env_vars = (sensitive value)
  #
  # for the entire block, hiding NODE_ENV, DATABASE_URL, SHIP_API_URL and the key
  # names alongside the one secret. Measured, not assumed: that is exactly what the
  # first plan of this file produced, against a web service whose env_vars rendered
  # key by key. A reviewer could not tell from the plan what the cron's environment
  # contained.
  #
  # Deciding the shape from a nonsensitive boolean restores that. Whether tracing is
  # on is not itself a secret — it is already published as an output — and the key's
  # value stays sensitive because the variable is.
  agent_tracing_enabled = nonsensitive(var.langchain_api_key != null)

  # LANGCHAIN_TRACING_V2 is derived rather than its own variable: supplying a key
  # and forgetting the flag is a silent no-op, and there is no case where you want
  # one without the other.
  agent_optional_env = local.agent_tracing_enabled ? {
    LANGCHAIN_API_KEY    = { value = var.langchain_api_key }
    LANGCHAIN_TRACING_V2 = { value = "true" }
    # A cron container exits when the scan ends. LangChain uploads traces on a
    # background queue that dies with the process, so without this the deployed
    # agent runs correctly and traces nothing. Verified locally: same run, same
    # workspace, zero sessions without it and a trace with it.
    LANGCHAIN_CALLBACKS_BACKGROUND = { value = "false" }

    # Without this the deployed cron logged, on every run:
    #
    #   "LANGCHAIN_PROJECT is unset — runs will land in the LangSmith default
    #    project, mixed in with everything else"
    #
    # Traces still uploaded, so nothing looked broken. But MVP requirement 2
    # (brief p.3) asks for two shared trace links showing different execution
    # paths, and a link is only useful if the run behind it can be found. Landing
    # deployed runs in the default project alongside every local experiment is
    # how they stop being findable.
    #
    # Named per environment rather than hardcoded, so a local run
    # (`fleetgraph-local`, see agent/.env.example) and the deployed cron never
    # share a project and get mistaken for each other.
    LANGCHAIN_PROJECT = { value = var.langchain_project }
  } : {}

  # Same nonsensitive-boolean trick, same reason: the presence of a model key is
  # not itself a secret, and deciding the map's shape from a sensitive value
  # would collapse the whole env_vars block in the plan output again.
  agent_model_key_set = nonsensitive(var.anthropic_api_key != null)

  # Without this the deployed agent detects and notifies nobody.
  #
  # Not a hypothetical. This file previously declared no model credential of any
  # kind, on the assumption — PRESEARCH.md Q25 — that Bedrock's ambient AWS
  # credential chain would supply one. Render provides no instance role, so the
  # chain resolves to nothing, every judgement returned `ai_unavailable`, and
  # `closeQuiet` correctly refused to advance the watermark. The result was a
  # cron that ran every 3 minutes and could never surface a finding.
  #
  # Empty when unset rather than defaulted, so the failure stays the honest one:
  # the agent still runs and still detects, judgement degrades, and the health
  # endpoint reports `provider: bedrock` with no credentials rather than
  # pretending a key exists.
  agent_model_env = local.agent_model_key_set ? {
    ANTHROPIC_API_KEY = { value = var.anthropic_api_key }
  } : {}
}

resource "render_cron_job" "fleetgraph" {
  name = var.agent_cron_name

  # Render charges cron jobs by runtime with a $1/month floor and offers no free
  # instance type for them, unlike web services. `free` is therefore not a
  # default we could have carried over from var.service_plan — see the validation
  # on var.agent_cron_plan.
  plan = var.agent_cron_plan

  # Same region as the database, not incidentally. render_postgres's
  # `internal_connection_string` resolves on Render's private network only within
  # a region; a cross-region cron would get a hostname it cannot reach and would
  # fail at connect time, per run, forever. Sharing var.render_region with the web
  # service is what makes that unrepresentable.
  region = var.render_region

  # ---------------------------------------------------------------------------
  # The artifact — identical to the web service's, by construction
  # ---------------------------------------------------------------------------
  runtime_source = {
    image = {
      image_url = var.image_repository
      tag       = var.image_tag

      # Null when the ghcr.io package is public, which is the default. Shared with
      # the web service through the same local, so a private package needs the
      # credential configured once, not twice.
      registry_credential_id = local.registry_credential_id
    }
  }

  # ---------------------------------------------------------------------------
  # The entrypoint override — the seam described at the top of this file
  # ---------------------------------------------------------------------------
  #
  # The image's own CMD migrates, seeds, then starts the HTTP server. A cron
  # container must not do that: it would bind a port, serve nothing, and never
  # exit, so Render would kill it at the job timeout and record a failure every
  # three minutes. Overriding the command is what turns the same bytes into a
  # process that scans, acts, and exits.
  start_command = var.agent_start_command

  # ---------------------------------------------------------------------------
  # Schedule — every 3 minutes
  # ---------------------------------------------------------------------------
  #
  # PRESEARCH.md Q11 and Q30. The requirement is < 5 minutes from an event
  # appearing in Ship to the agent surfacing it, and the polling interval is the
  # dominant term in that budget:
  #
  #   worst-case wait for the next run  180 s   ← this line
  #   container cold start               15 s
  #   watermark scan + detectors          1 s
  #   judgment (LLM)                     20 s   ← bounded by the Bedrock timeout
  #   delivery                            1 s
  #   ────────────────────────────────────────
  #   worst case                        217 s   against a 300 s SLA
  #
  # 5 minutes would leave zero headroom — a single cold start breaches. 1 minute
  # triples the run count to buy latency no use case needs; the detectors measure
  # drift in business days (Q13). 3 minutes is the interval that meets the
  # requirement with 83 seconds of margin and does not pay for margin nobody uses.
  #
  # The cost of the interval is near zero when nothing is happening: the run is a
  # watermark query against an indexed (workspace_id, updated_at) and terminates
  # at the triage gate with no model call at all when it returns no rows.
  schedule = var.agent_cron_schedule

  env_vars = merge(
    {
      NODE_ENV = { value = "production" }

      # Read off the Postgres resource, never typed. Identical expression to the
      # web service's, which is the point: the two processes cannot end up
      # pointed at different databases, and no connection string exists in a
      # variable, a tfvars file, or this repository. Terraform derives the
      # dependency edge from this reference, so the database is created before
      # the cron job and destroyed after it.
      DATABASE_URL = { value = render_postgres.ship.connection_info.internal_connection_string }

      # Also a resource reference rather than a literal. The agent talks to Ship
      # over HTTP with a bearer token (Q29), so it needs the API's address — and
      # on a fresh apply nobody knows that address until Render assigns it. A
      # literal here would mean a two-pass apply and a URL that silently goes
      # stale if the service is ever recreated.
      SHIP_API_URL = { value = render_web_service.shipshape.url }

      # An `api_tokens` row issued to a dedicated FleetGraph service account,
      # passed as `Authorization: Bearer` — the mechanism authMiddleware already
      # honours ahead of session cookies. A cron cannot hold a session: Ship
      # expires them after 15 minutes of inactivity, so a service account with a
      # cookie would spend most of its life re-authenticating. The token is
      # revocable, expiring, and audited via last_used_at, which a shared-secret
      # header would not be.
      SHIP_API_TOKEN = { value = var.ship_api_token }
    },
    local.agent_optional_env,
    local.agent_model_env,
  )
}
