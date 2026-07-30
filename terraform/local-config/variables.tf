variable "output_dir" {
  description = <<-EOT
    Directory the generated files are written to.

    Defaults to `generated/` inside this module so a plain `terraform apply`
    cannot clobber a developer's working `api/.env.local`. To render straight
    into the repo instead:

      terraform apply -var 'output_dir=../..'
  EOT
  type        = string
  default     = "generated"

  validation {
    condition     = length(trimspace(var.output_dir)) > 0
    error_message = "output_dir must not be empty."
  }
}

variable "environment" {
  description = "Which environment these files describe. Drives ports, URLs, and log level."
  type        = string
  default     = "local"

  validation {
    condition     = contains(["local", "dev", "shadow", "prod"], var.environment)
    error_message = "environment must be one of: local, dev, shadow, prod."
  }
}

variable "api_port" {
  description = "Port the Express API listens on. Must match the Render service's port for prod parity."
  type        = number
  default     = 3000

  validation {
    condition     = var.api_port > 1023 && var.api_port < 65536
    error_message = "api_port must be an unprivileged TCP port (1024-65535)."
  }
}

variable "web_port" {
  description = "Port the Vite dev server listens on."
  type        = number
  default     = 5173
}

variable "database_url" {
  description = <<-EOT
    PostgreSQL connection string written into the API env file.

    Marked sensitive so it is redacted from plan output and from the console.
    Terraform still records it in state and in any saved plan IN PLAINTEXT —
    `sensitive` controls display, not storage. `.gitignore` covers `*.tfstate*`
    and `tfplan` at any depth for exactly that reason.
  EOT
  type        = string
  sensitive   = true
  default     = "postgresql://localhost/ship_local"
}

variable "session_secret" {
  description = <<-EOT
    Session signing secret. Leave null and a 48-character random one is
    generated and held in state. Supply your own for prod, where the secret must
    outlive this state file — rotating it invalidates every live session at once
    (see the SSM row of the audit's blast-radius table).
  EOT
  type        = string
  sensitive   = true
  default     = null
}

variable "log_level" {
  description = "Application log level written into app.config.json."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["debug", "info", "warn", "error"], var.log_level)
    error_message = "log_level must be one of: debug, info, warn, error."
  }
}

variable "git_sha" {
  description = <<-EOT
    Commit SHA stamped into the deploy manifest, for artifact provenance
    (implementation rule 5: the artifact CI produced is the artifact that runs).

    Supply it explicitly rather than shelling out — Terraform has no way to read
    git state, and an `external` data source here would make `plan` depend on the
    working tree being a git checkout.

      terraform apply -var "git_sha=$(git rev-parse HEAD)"
  EOT
  type        = string
  default     = "unknown"
}
