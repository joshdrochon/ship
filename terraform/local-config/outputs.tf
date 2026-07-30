output "rendered_files" {
  description = "Every file this configuration manages, with the permissions it enforces."
  value = {
    api_env         = { path = local_sensitive_file.api_env.filename, mode = "0600" }
    web_env         = { path = local_file.web_env.filename, mode = "0644" }
    app_config      = { path = local_file.app_config.filename, mode = "0644" }
    deploy_manifest = { path = local_file.deploy_manifest.filename, mode = "0644" }
  }
}

output "app_config_sha256" {
  description = <<-EOT
    Content hash of the rendered app.config.json.

    This is the value drift detection turns on: the local provider's Read stores
    a hash and compares it on refresh. If someone edits the file by hand this
    output changes, and `terraform plan` reports the resource as gone.
  EOT
  value       = local_file.app_config.content_sha256
}

output "api_base_url" {
  description = "API base URL the rendered files agree on."
  value       = local.api_base_url
}

output "session_secret" {
  description = <<-EOT
    The session secret written into the API env file.

    Marked sensitive, so `terraform output` redacts it and CI logs cannot leak
    it. Read it deliberately with `terraform output -raw session_secret`.
  EOT
  value       = local.session_secret
  sensitive   = true
}
