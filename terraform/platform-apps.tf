# ---------------------------------------------------------------------------
# PF-625 / PF-630 — secrets for the first-party OAuth apps.
#
# L02 seeds three OAuth apps from the environment on every `db:migrate`
# (api/src/db/platformApps.ts). The secrets are read, never generated, and
# `assertPlatformAppSecrets()` THROWS in production when any is absent -- so a
# deploy without these three produces an environment where the grader's
# credentials do not exist. That is MVP gate item 10 failing quietly, which is
# the exact failure this file prevents.
#
#   AGENT_CLIENT_SECRET   FleetGraph Agent   (first-party, Epic 7)
#   GRADER_CLIENT_SECRET  Grader (read-only) (gate item 10, p.2 / p.13)
#   DEMO_CLIENT_SECRET    Grader demo        (D12 -- write-scoped, see below)
#
# WHY SSM PARAMETERS AND NOT EB ENVIRONMENT VARIABLES.
# ---------------------------------------------------------------------------
# PF-625's wording is "wired into the EB environment's option settings". Doing
# that literally would mean `value = random_password.x.result` on an
# `aws:elasticbeanstalk:application:environment` setting -- which writes the
# plaintext secret into the environment's configuration, where it is readable by
# anyone with `elasticbeanstalk:DescribeConfigurationSettings` and shows in the
# console in clear text. The application already has a better path: it reads its
# secrets from SSM at boot (`api/src/config/ssm.ts`), the parameters are
# SecureString, and the instance role's inline policy is already scoped to
# `parameter/${project}/${environment}/*` -- so these need NO IAM change, which
# is what PF-625 asks to be called out either way.
#
# They land under the existing `/${project_name}/${environment}/` prefix
# deliberately, for that reason.
#
# WHY random_password AND NOT A HUMAN-CHOSEN VALUE.
# ---------------------------------------------------------------------------
# These are machine credentials with no memorability requirement. Generating
# them in Terraform keeps them out of git entirely and makes rotation a
# `-replace` away. They ARE recoverable -- from SSM or from state -- which is
# necessary and is the difference between these and a `client_secret` shown once
# to a user: the README has to publish the grader's secret (p.13), so a value
# nobody can read back would defeat the deliverable.
# ---------------------------------------------------------------------------

resource "random_password" "agent_client_secret" {
  length  = 48
  special = false # base62 keeps it safe to paste into a shell, a URL and a .env
}

resource "random_password" "grader_client_secret" {
  length  = 48
  special = false
}

resource "random_password" "demo_client_secret" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "agent_client_secret" {
  name        = "/${var.project_name}/${var.environment}/AGENT_CLIENT_SECRET"
  description = "client_secret for the FleetGraph Agent OAuth app (first-party). Seeds on every db:migrate via seedPlatformApps()."
  type        = "SecureString"
  value       = random_password.agent_client_secret.result

  tags = {
    Name = "${var.project_name}-agent-client-secret"
  }
}

resource "aws_ssm_parameter" "grader_client_secret" {
  name        = "/${var.project_name}/${var.environment}/GRADER_CLIENT_SECRET"
  description = "client_secret for the read-only grader OAuth app. Published in the README per PRD p.13."
  type        = "SecureString"
  value       = random_password.grader_client_secret.result

  tags = {
    Name = "${var.project_name}-grader-client-secret"
  }
}

resource "aws_ssm_parameter" "demo_client_secret" {
  name        = "/${var.project_name}/${var.environment}/DEMO_CLIENT_SECRET"
  description = "client_secret for the write-scoped grader demo app (L99 D12). Lets a grader run `ship docs create` from the README."
  type        = "SecureString"
  value       = random_password.demo_client_secret.result

  tags = {
    Name = "${var.project_name}-demo-client-secret"
  }
}

# Outputs are marked sensitive so they do not print in CI logs, and are read
# deliberately with `terraform output -raw` when the README is being written.
output "grader_client_secret" {
  description = "client_secret for the read-only grader app (PF-630/PF-631). Read with: terraform output -raw grader_client_secret"
  value       = random_password.grader_client_secret.result
  sensitive   = true
}

output "demo_client_secret" {
  description = "client_secret for the write-scoped demo app (D12). Read with: terraform output -raw demo_client_secret"
  value       = random_password.demo_client_secret.result
  sensitive   = true
}
