provider "render" {
  api_key  = var.render_api_key
  owner_id = var.render_owner_id

  # Block until Render reports the deploy live (or failed) instead of returning
  # as soon as the API accepts the request. Without this, `terraform apply`
  # exits successfully while the image is still building, and a CI step that
  # runs a smoke test straight after would hit a service that is not up yet.
  # It also means a failed build fails the apply, which is the behaviour
  # scripts/deploy.sh already has and which a fire-and-forget apply would lose.
  wait_for_deploy_completion = true
}
