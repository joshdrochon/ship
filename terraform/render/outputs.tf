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

output "replaces" {
  description = "The manual deploy steps this configuration supersedes (requirement 8.6)."
  value = [
    "scripts/deploy.sh <env>          — build, zip, upload to S3, create an Elastic Beanstalk application version, update the environment",
    "scripts/deploy-frontend.sh <env> — build web/, sync to S3, invalidate CloudFront",
  ]
}
