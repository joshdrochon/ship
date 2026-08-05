# ---------------------------------------------------------------------------
# Credentials
#
# Neither of these has a default, deliberately. A default is how a real value
# ends up in a tracked file: audit finding W8-1 is a committed
# terraform/environments/shadow/tfplan carrying the AWS account ID and a named
# IAM principal. Supply both from the environment:
#
#   set -a; source .env; set +a     # exports TF_VAR_render_api_key etc.
#
# `.env` is gitignored (root .gitignore line 12). Nothing in terraform/render/
# reads it directly — Terraform picks up TF_VAR_-prefixed variables itself.
# ---------------------------------------------------------------------------

variable "render_api_key" {
  description = "Render API key (rnd_...). Set TF_VAR_render_api_key; never a default, never a committed tfvars file."
  type        = string
  sensitive   = true
}

variable "render_owner_id" {
  description = "Render owner/team id (tea-... or usr-...) that owns the service. Set TF_VAR_render_owner_id."
  type        = string
  # No default: it identifies the account the api_key operates on. Treated like
  # the AWS account ID that W8-1 leaked — not a password, but not repo content.
}

# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------

variable "render_region" {
  description = "Render region for both the web service and the database. They must match for the internal (private-network) database URL to resolve."
  type        = string
  default     = "oregon"
}

# ---------------------------------------------------------------------------
# Source — a published image, not a git ref
#
# `repo_url`, `branch`, `dockerfile_path` and `auto_deploy` used to live here.
# They are gone because Render no longer builds anything: it pulls the image CI
# already built and verified. Implementation Rule 5 — the artifact produced in CI
# must be the artifact that runs in production, and a `branch` here would make
# Render produce a fourth one.
# ---------------------------------------------------------------------------

variable "image_repository" {
  description = "Registry path of the published image, without a tag. Pushed by .github/workflows/ci.yml. The GitLab instance runs no container registry (jwt/auth returns 'registry not enabled'), which is why this is ghcr.io."
  type        = string
  default     = "ghcr.io/joshdrochon/ship"

  validation {
    condition     = !strcontains(var.image_repository, ":")
    error_message = "image_repository must not include a tag — set the tag with var.image_tag."
  }
}

variable "image_tag" {
  description = "Git commit SHA of the image to run. No default, deliberately: a deploy is a decision about which commit goes live, and a default would let one happen by omission. Get it from the CI job summary, or `git rev-parse HEAD` for a commit CI has already published."
  type        = string

  validation {
    # 7 to 40 lowercase hex — an abbreviated or full commit SHA, matching what
    # CI tags with ($CI_COMMIT_SHA / github.sha). Floating tags are refused on
    # purpose: `latest` deploys whatever moved there last, which is exactly the
    # "what is actually running?" question this whole change exists to answer.
    condition     = can(regex("^[0-9a-f]{7,40}$", var.image_tag))
    error_message = "image_tag must be a git commit SHA (7-40 lowercase hex). Floating tags like 'latest' are refused — pin the commit."
  }
}

# ---------------------------------------------------------------------------
# Registry authentication — only for a private package
#
# Both null by default. A public ghcr.io package pulls anonymously, so the
# default apply creates no credential and writes no token into state. Set both to
# keep the package private.
# ---------------------------------------------------------------------------

variable "registry_username" {
  description = "GitHub username for pulling a private ghcr.io package. Null (the default) means the package is public and needs no credential. Set TF_VAR_registry_username."
  type        = string
  default     = null
}

variable "registry_token" {
  description = "GitHub PAT with read:packages, for a private ghcr.io package. Read scope only — Render pulls, it never pushes. Set TF_VAR_registry_token; never a default, never a committed tfvars file. Lands in terraform.tfstate, which is why the public-package path is the default."
  type        = string
  sensitive   = true
  default     = null
}

# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------

variable "service_name" {
  description = "Render web service name."
  type        = string
  default     = "shipshape"
}

variable "service_plan" {
  description = "Render instance plan. `free` costs nothing and sleeps after 15 minutes idle; `starter` is the first paid tier."
  type        = string

  # `starter`, not `free`, and the difference is measured rather than assumed. On
  # `free` Render sleeps the service after 15 minutes idle, and the wake-up was
  # timed against the live instance:
  #
  #   cold  31.3 s
  #   warm   0.15 s
  #
  # 31 seconds is what anyone arriving at a link that has been quiet gets — which
  # is the failure the deployment exists to prevent. `starter` does not sleep.
  #
  # The default carries it rather than a -var flag or a tfvars file, because the
  # brief (p.3) requires re-applying "from the Terraform config alone". A plan
  # supplied on the command line is not in the config, and the environment that
  # came back would quietly be the sleeping one.
  default = "starter"

  validation {
    condition     = contains(["free", "starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra"], var.service_plan)
    error_message = "service_plan must be a Render instance plan slug."
  }
}

variable "uploads_disk_size_gb" {
  description = <<-EOT
    Size of the persistent disk mounted at the uploads directory, in GB. `null` (the
    default) attaches no disk, which is the only thing the `free` plan supports —
    Render disks require `starter` or above.

    With no disk, `api/src/routes/files.ts` writes uploads to the container filesystem
    (`UPLOADS_DIR`, resolving to /app/api/uploads), which Render discards on every
    deploy, restart and instance move. The `files` rows survive in Postgres, so the UI
    keeps listing attachments whose bytes are gone. Set this to attach a disk instead.
  EOT
  type        = number
  default     = null

  validation {
    condition     = var.uploads_disk_size_gb == null || var.uploads_disk_size_gb >= 1
    error_message = "uploads_disk_size_gb must be null (no disk) or at least 1 GB."
  }
}

variable "num_instances" {
  description = "Instance count. Pinned to 1: the collaboration server keeps Yjs document state in module-level Maps (api/src/collaboration/index.ts), so two instances would serve divergent documents. See README, 'What this does not solve'."
  type        = number
  default     = 1

  validation {
    condition     = var.num_instances == 1
    error_message = "num_instances must be 1 until Yjs collaboration state is moved out of process memory."
  }
}

variable "database_name" {
  description = "Render Postgres instance name."
  type        = string
  default     = "ship-db"
}

variable "database_plan" {
  description = "Render Postgres plan. `free` expires 30 days after creation — Render deletes it. Anything that must outlive a month needs `basic_256mb` or larger."
  type        = string
  default     = "free"
}

variable "postgres_version" {
  description = "Major PostgreSQL version. 16 matches what the app is developed against."
  type        = string
  default     = "16"
}

variable "disk_size_gb" {
  description = "Database disk size in GB. Null means 'whatever the plan gives you' — the free plan has no configurable disk, and setting a literal there produced a diff against a live free instance that reported no disk size at all."
  type        = number
  default     = null
}

# ---------------------------------------------------------------------------
# Application configuration
#
# All three default to null and are omitted from env_vars when null, rather than
# being set to "". The app treats an empty string as configured-but-blank and
# fails deep in a request handler; unset is the case it actually handles.
# ---------------------------------------------------------------------------

variable "app_base_url" {
  description = "Public URL of the deployed app. Read by api/src/services/caia.ts to derive the OAuth redirect URI, and by admin-credentials. Unset on the first apply because the service URL is only known afterwards — set it from `terraform output service_url` on the second."
  type        = string
  default     = null
}

variable "cors_origin" {
  description = "Allowed CORS origin. Optional here because the Docker image serves web/dist from the API process (api/src/app.ts:250), so browser traffic is same-origin and never preflights."
  type        = string
  default     = null
}

variable "cdn_domain" {
  description = "CloudFront domain for uploaded files (api/src/routes/files.ts:253). Only needed if the AWS asset path is in use; the Render deployment does not require it."
  type        = string
  default     = null
}

variable "session_secret" {
  description = "Express session secret. Left null so the provider generates one on create (generate_value = true), which is what keeps a clean-machine apply down to one credential. Supply a value only when sessions must survive the service being recreated."
  type        = string
  sensitive   = true
  default     = null
}

# ---------------------------------------------------------------------------
# FleetGraph agent — render_cron_job.fleetgraph
#
# The cron job runs the same image as the web service, so nothing here selects a
# source: image_repository, image_tag and the registry credential are shared. What
# is separate is the schedule, the instance plan, the entrypoint, and the agent's
# own two credentials. See cron.tf.
# ---------------------------------------------------------------------------

variable "agent_cron_name" {
  description = "Render cron job name. Distinct from service_name because the two are separate Render services sharing one image; naming both 'shipshape' would make the dashboard ambiguous about which one failed."
  type        = string
  default     = "fleetgraph-agent"
}

variable "agent_cron_plan" {
  description = "Render instance plan for the cron job. Unlike service_plan this cannot be `free` — Render offers no free instance type for cron jobs and bills them by runtime with a $1/month floor. `starter` is the smallest that exists; the job is a watermark query plus at most one bounded model call, so it is not sized by load."
  type        = string
  default     = "starter"

  validation {
    # `free` is excluded deliberately rather than by omission. It is a valid slug
    # for a web service, so copying var.service_plan's default across would look
    # right, plan clean, and fail only at apply against Render's API.
    condition     = contains(["starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra"], var.agent_cron_plan)
    error_message = "agent_cron_plan must be a paid Render instance plan slug. Render has no free tier for cron jobs, so `free` is rejected here even though it is valid for service_plan."
  }
}

variable "agent_cron_schedule" {
  description = "Cron expression, UTC. Every 3 minutes — PRESEARCH.md Q11/Q30. The interval is the dominant term in the < 5 minute detection budget (180 s of a 217 s worst case against a 300 s SLA), so widening it is a decision about breaching the requirement, not a tuning knob."
  type        = string
  default     = "*/3 * * * *"

  validation {
    # Five whitespace-separated fields. Deliberately shallow: this catches the
    # typo class (a four-field or six-field expression, a stray quote) without
    # pretending to validate cron semantics, which Render's scheduler owns.
    condition     = can(regex("^\\S+( +\\S+){4}$", var.agent_cron_schedule))
    error_message = "agent_cron_schedule must be a 5-field cron expression, e.g. \"*/3 * * * *\"."
  }
}

variable "agent_start_command" {
  description = <<-EOT
    Command the cron container runs instead of the image's CMD. This override is
    the whole "same image, two entrypoints" seam (cron.tf).

    The default invokes the compiled agent entrypoint directly, by absolute path,
    for two reasons. The image's final WORKDIR is /app/api, so a relative command
    resolves in the wrong workspace package. And the runtime stage installs with
    `--prod`, so `tsx` — which agent/package.json's `agent:cron` script uses to run
    TypeScript from source — is not present in the deployed image. `pnpm agent:cron`
    is the local development form; `node agent/dist/entrypoints/cron.js` is the
    deployed one.

    Two preconditions this depends on, neither of which lives in terraform/:
      - agent/src/entrypoints/cron.ts exists and compiles to dist/
      - the Dockerfile's runtime stage copies agent/dist/ and agent/package.json
        alongside api/dist/ and shared/dist/
    Until both hold, `terraform apply` succeeds and every scheduled run fails at
    "Cannot find module" — which is why this is a variable with a documented
    default rather than a hardcoded string.
  EOT
  type        = string
  default     = "node /app/agent/dist/entrypoints/cron.js"
}

# ---------------------------------------------------------------------------
# Agent credentials
#
# Same rule as render_api_key at the top of this file: no defaults, no committed
# tfvars. Supply from the environment.
#
#   set -a; source .env; set +a     # exports TF_VAR_ship_api_token etc.
# ---------------------------------------------------------------------------

variable "ship_api_token" {
  description = "Ship API token (an `api_tokens` row) for the FleetGraph service account, sent as `Authorization: Bearer`. No default: the cron authenticates as a real, revocable principal, and a default would either be a placeholder that fails at runtime or a real token in a tracked file. Set TF_VAR_ship_api_token. Issue it read-only — see PRESEARCH.md Q29 on migration 038 adding `api_tokens.scopes`."
  type        = string
  sensitive   = true
}

variable "langchain_api_key" {
  description = "LangSmith API key for tracing agent runs. Null (the default) disables tracing entirely — the key and LANGCHAIN_TRACING_V2 are both omitted from the cron's environment rather than set empty, because a blank key fails on the first span instead of never starting a tracer. Set TF_VAR_langchain_api_key to turn tracing on."
  type        = string
  sensitive   = true
  default     = null
}

variable "langchain_project" {
  description = "LangSmith project the deployed cron's traces land in. Unset, LangChain uses its default project and deployed runs mix with every local experiment — which does not break tracing but makes a specific run unfindable, and MVP requirement 2 (brief p.3) asks for two shared trace links showing different execution paths. Named per environment so a local run (fleetgraph-local) and the deployed cron never collide."
  type        = string
  default     = "fleetgraph-prod"
}

variable "anthropic_api_key" {
  description = "Anthropic API key for judgement and on-demand answers. Null (the default) leaves the cron with no model credential, which is what this file previously did unintentionally: PRESEARCH.md Q25 chose Bedrock expecting an ambient AWS credential chain, and Render supplies no instance role, so every judgement returned ai_unavailable and the agent could detect but never surface. Omitted rather than set empty when null, so the agent falls back to the Bedrock path and degrades honestly instead of failing on a blank key. Set TF_VAR_anthropic_api_key."
  type        = string
  sensitive   = true
  default     = null
}
