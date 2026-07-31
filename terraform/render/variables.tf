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
  default     = "free"

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
