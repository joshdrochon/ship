# Outputs are deliberately identifiers and URLs only.
#
# `render_postgres.ship.connection_info` is available and is NOT exposed here:
# every output lands in terraform.tfstate in plaintext and is printed by
# `terraform output` with no redaction unless marked sensitive, and a marked
# sensitive output is still plaintext in state. Nothing downstream needs the
# connection string — the web service reads it through a resource reference
# inside the graph, which never surfaces it.

output "service_url" {
  description = "Public HTTPS URL of the deployed app. Feed this back in as -var app_base_url on the second apply."
  value       = render_web_service.shipshape.url
}

output "deployed_image" {
  description = "The exact artifact this service runs. Rule 5's audit trail: compare it against `curl $(terraform output -raw service_url)/health`, which reports the SHA the running process was built from. If the two disagree, the apply has not finished or something deployed out of band."
  value       = "${var.image_repository}:${var.image_tag}"
}

output "verify_deployed_revision" {
  description = "Copy-paste check that the running container is the artifact this configuration names."
  value       = "curl -sf ${render_web_service.shipshape.url}/health   # expect {\"status\":\"ok\",\"revision\":\"${var.image_tag}\"}"
}

output "service_id" {
  description = "Render service id (srv-...). What `terraform import` needs to adopt an existing service."
  value       = render_web_service.shipshape.id
}

output "service_slug" {
  description = "Render slug, the subdomain of the onrender.com URL."
  value       = render_web_service.shipshape.slug
}

output "postgres_id" {
  description = "Render Postgres id (dpg-...)."
  value       = render_postgres.ship.id
}

output "postgres_plan_expiry_warning" {
  description = "Render deletes a free-plan database 30 days after creation, along with its data."
  value       = var.database_plan == "free" ? "database_plan is 'free' — Render deletes this instance and its data 30 days after creation" : "database_plan is '${var.database_plan}' — no automatic expiry"
}

# ---------------------------------------------------------------------------
# FleetGraph agent
#
# Same rule as above: identifiers and derived facts only. SHIP_API_TOKEN and
# LANGCHAIN_API_KEY are not outputs and must not become outputs — an output is
# plaintext in state and printed unredacted by `terraform output` unless marked
# sensitive, and even marked sensitive it is still plaintext in the state file.
# ---------------------------------------------------------------------------

output "agent_cron_id" {
  description = "Render cron job id (crn-...). What `terraform import` needs to adopt an existing job, and what the Render dashboard URL is keyed on when a run fails."
  value       = render_cron_job.fleetgraph.id
}

output "agent_cron_slug" {
  description = "Render slug for the cron job."
  value       = render_cron_job.fleetgraph.slug
}

output "agent_same_image_check" {
  description = "The cron job and the web service run one artifact, not two. This is that claim rendered as a string you can compare against `deployed_image` — they are built from the same two variables, so they cannot disagree unless someone edits cron.tf to break the seam."
  value       = "${var.image_repository}:${var.image_tag}"
}

output "agent_detection_latency_budget" {
  description = "Worst-case detection latency implied by the configured schedule, against the 5-minute requirement. Recomputed from var.agent_cron_schedule's interval rather than hardcoded, so widening the schedule shows up here instead of quietly eating the headroom. Non-`*/N` expressions cannot be reduced to an interval and report as unknown."
  value = (
    can(regex("^\\*/([0-9]+) \\* \\* \\* \\*$", var.agent_cron_schedule))
    ? format(
      "%s → worst-case wait %ss + 37s run budget (cold start, scan, judgment, delivery) = %ss against a 300s SLA",
      var.agent_cron_schedule,
      tonumber(regex("^\\*/([0-9]+) \\* \\* \\* \\*$", var.agent_cron_schedule)[0]) * 60,
      tonumber(regex("^\\*/([0-9]+) \\* \\* \\* \\*$", var.agent_cron_schedule)[0]) * 60 + 37,
    )
    : "${var.agent_cron_schedule} → not a fixed-interval expression; latency budget must be derived by hand"
  )
}

output "agent_tracing_enabled" {
  description = "Whether LangSmith tracing is wired into the cron's environment. Reports the boolean, never the key."

  # The same local the cron's env_vars gate uses, so the output cannot disagree
  # with what was actually wired in. See cron.tf for why the taint is stripped
  # there rather than the output being marked sensitive: a sensitive output is
  # still plaintext in state, so marking it would hide a boolean and protect
  # nothing.
  value = local.agent_tracing_enabled
}

output "replaces" {
  description = "The manual deploy steps this configuration supersedes (requirement 8.6)."
  value = [
    "scripts/deploy.sh <env>          — build, zip, upload to S3, create an Elastic Beanstalk application version, update the environment",
    "scripts/deploy-frontend.sh <env> — build web/, sync to S3, invalidate CloudFront",
  ]
}
