# ShipShape on Render — render-oss/render
#
# One `terraform apply` stands up the whole deployment: a managed PostgreSQL
# instance, a web service built from the repo's root Dockerfile, and the wiring
# between them. It replaces `scripts/deploy.sh` (220 lines, Elastic Beanstalk)
# and `scripts/deploy-frontend.sh` (72 lines, S3 + CloudFront invalidation).
# The mapping, step by step, is in README.md.
#
# Two resources:
#
#   render_postgres.ship          managed PostgreSQL 16
#   render_web_service.shipshape  Docker web service, 1 instance
#
# The database URL is never typed anywhere. It is read off the postgres
# resource's computed `connection_info` and handed to the service as an
# environment variable, so the two cannot disagree and no connection string
# enters a variable, a tfvars file, or this repository. The AWS path solves the
# same problem with an SSM parameter that a human writes by hand
# (scripts/deploy.sh, /ship/{env}/DATABASE_URL).

locals {
  # Env vars that only exist when configured. Terraform's `merge` drops nothing,
  # so build the optional half first and filter nulls out of it — setting these
  # to "" instead would make api/src/services/caia.ts see a configured-but-empty
  # base URL and fail inside a request rather than at boot.
  optional_env_values = {
    APP_BASE_URL = var.app_base_url
    CORS_ORIGIN  = var.cors_origin
    CDN_DOMAIN   = var.cdn_domain
  }

  optional_env = {
    for k, v in local.optional_env_values : k => { value = v }
    if v != null
  }

  # The web service needs the model too, and it did not have it.
  #
  # `cron.tf` gained ANTHROPIC_API_KEY when the provider moved off Bedrock, and
  # this file did not — so the deployed API had exactly three environment
  # variables (DATABASE_URL, NODE_ENV, SESSION_SECRET) and no way to reach a
  # model. `POST /api/fleetgraph/chat` answered every request with
  # `503 {"error":"ai_unavailable","reason":"agent_unreachable"}`, verified
  # against the live deployment.
  #
  # That is MVP requirement 7 (brief p.3), "agent chat and notifications are
  # accessible in the UI": the panel mounts and the endpoint exists, but the
  # answer never arrives. Two services run the same image and only one was given
  # what the image needs — the same omission as the Bedrock one, one service over.
  #
  # Tracing goes here for a second reason. Requirement 2 asks for two shared
  # trace links showing DIFFERENT execution paths, and the on-demand path is the
  # other one — a proactive cron run and a chat invocation traverse different
  # nodes of the same graph. Untraced, that link cannot be produced at all.
  #
  # LANGCHAIN_CALLBACKS_BACKGROUND is deliberately absent here, unlike in
  # cron.tf. The API is a long-lived process, so the background upload queue does
  # drain; forcing synchronous callbacks would put trace uploads on the request
  # path and charge every chat response for them.
  agent_env_values = {
    ANTHROPIC_API_KEY    = var.anthropic_api_key
    LANGCHAIN_API_KEY    = var.langchain_api_key
    LANGCHAIN_TRACING_V2 = var.langchain_api_key == null ? null : "true"
    LANGCHAIN_PROJECT    = var.langchain_api_key == null ? null : var.langchain_project
  }

  agent_env = {
    for k, v in local.agent_env_values : k => { value = v }
    if v != null
  }

  # Supplied secret if there is one, otherwise let Render generate it. Rendered
  # as two different shapes because `generate_value` and `value` are mutually
  # exclusive in the provider's env var schema.
  session_env = var.session_secret == null ? { generate_value = true } : { value = var.session_secret }

  # A registry credential exists only when one was asked for. Public ghcr.io
  # packages are anonymously pullable, so the default path creates no credential
  # resource at all and stores no token in Terraform state.
  registry_credential_enabled = var.registry_username != null && var.registry_token != null
  registry_credential_id      = local.registry_credential_enabled ? render_registry_credential.ghcr[0].id : null
}

# ---------------------------------------------------------------------------
# Registry credential — optional
#
# Only needed if the ghcr.io package is private. GitHub packages default to
# private when first published, and making one public is a one-time click in the
# package settings; do that and this resource is never created.
#
# `count` rather than a null-safe expression because the alternative is storing
# a credential with empty strings, which the API rejects. Note the token lands in
# terraform.tfstate — the same exposure any provider-managed secret has, and the
# reason the public-package path is the default rather than the fallback.
# ---------------------------------------------------------------------------
resource "render_registry_credential" "ghcr" {
  count = local.registry_credential_enabled ? 1 : 0

  name     = "${var.service_name}-ghcr"
  registry = "GITHUB"
  username = var.registry_username

  # A GitHub PAT with `read:packages`. Read, not write — Render only pulls.
  auth_token = var.registry_token
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
resource "render_postgres" "ship" {
  name         = var.database_name
  plan         = var.database_plan
  region       = var.render_region
  version      = var.postgres_version
  disk_size_gb = var.disk_size_gb

  # `database_name` and `database_user` are deliberately not set.
  #
  # They are optional+computed, and Render disambiguates the database name on
  # create — ask for "ship" and you get "ship_<suffix>". A literal here therefore
  # never matches what comes back, and the attribute forces replacement, so the
  # config would plan a destroy of a healthy database on every run. Measured,
  # not assumed: an import plan of the live instance against an earlier draft of
  # this file reported
  #     ~ database_name = "ship_<suffix>" -> "ship" # forces replacement
  #     Plan: 1 to import, 1 to add, 0 to change, 1 to destroy.
  # and prevent_destroy below is what stopped it. Letting Render name the
  # database costs nothing: DATABASE_URL is read off connection_info, so no
  # human ever types the name.

  # The database is the one resource here whose replacement is unrecoverable —
  # Render deletes the volume with the instance, and this plan is `free`, which
  # has no backups. Make Terraform refuse rather than obey.
  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Web service
# ---------------------------------------------------------------------------
resource "render_web_service" "shipshape" {
  name   = var.service_name
  plan   = var.service_plan
  region = var.render_region

  # Promote, do not rebuild. Implementation Rule 5.
  #
  # This was `runtime_source.docker`, which hands Render a repo URL and a branch
  # and has Render's builder run the Dockerfile itself. That is a third,
  # independent build of the same source — alongside GitLab CI's and GitHub
  # Actions' — and none of the three promoted either of the others. Whatever
  # Render happened to compile is what ran in production, and nothing recorded
  # which commit that was.
  #
  # `runtime_source.image` deploys an image that already exists. The one CI
  # built, tested and pushed. Render pulls the tag and runs it; there is no
  # builder, no clone, no second compile, and no way for what runs to differ from
  # what was verified. A deploy becomes:
  #
  #     terraform apply -var image_tag=<sha>
  #
  # and `curl $(terraform output -raw service_url)/health` reports that same sha
  # back, because the Dockerfile baked it in. Rollback is the same command with
  # an older sha — see docs/artifact-lifecycle.md.
  #
  # Second thing this fixes, which is a Category 8 finding rather than a Rule 5
  # one: the docker source required the Render account to have completed a
  # GitHub OAuth consent for a private repo, which Terraform cannot do and a
  # browser must. That is why terraform/render/README.md said "one credential and
  # one prior consent" instead of the brief's "deployable using only `terraform
  # apply`". Pulling a published image needs no repo connection at all, so the
  # qualification goes away.
  runtime_source = {
    image = {
      image_url = var.image_repository
      tag       = var.image_tag

      # Null when the package is public, which is the default and needs no
      # credential. A private ghcr.io package needs a PAT; see
      # render_registry_credential.ghcr below.
      registry_credential_id = local.registry_credential_id
    }
  }

  # /health is an unauthenticated 200 handler. Render polls it after each deploy
  # and rolls back to the previous instance if it never passes, which is the one
  # safety property the Elastic Beanstalk script has no equivalent of — it
  # uploads a bundle and returns. The live service has this unset (`""`), so
  # setting it here is a change, not a transcription.
  health_check_path = "/health"

  num_instances = var.num_instances

  # File uploads need durable storage. `api/src/routes/files.ts:421` writes to S3 only
  # when `S3_UPLOADS_BUCKET` is set *and* NODE_ENV=production; otherwise it falls through
  # to the container filesystem at /app/api/uploads. On Render that filesystem is
  # ephemeral, so without this the bytes are discarded on every deploy while the `files`
  # rows persist in Postgres — the UI lists attachments that 404. That is silent data
  # loss of exactly the W6-9 class: the user is never told.
  #
  # A disk rather than S3 because the alternative is a long-lived AWS key pair in Render's
  # environment for one feature, on a repo that has already leaked an account identifier
  # once (W8-1). See CHANGES/lane-8.md, "Storage".
  #
  # null on the `free` plan, which does not support disks. A disk also pins the service to
  # a single instance, which costs nothing here: `num_instances` is already validated to
  # exactly 1 because the collaboration server holds Yjs state in module-level Maps.
  disk = var.uploads_disk_size_gb == null ? null : {
    name       = "${var.service_name}-uploads"
    mount_path = "/app/api/uploads"
    size_gb    = var.uploads_disk_size_gb
  }

  # Give the process time to drain WebSocket connections. The collaboration
  # server holds long-lived sockets (api/src/collaboration/index.ts); the
  # default kills them at once, so an editor mid-keystroke loses the buffered
  # Yjs update rather than flushing it.
  max_shutdown_delay_seconds = 60

  env_vars = merge(
    {
      NODE_ENV = { value = "production" }

      # Private-network address. Never leaves Render's network, unlike the
      # external string, which is why this one and not that one.
      DATABASE_URL = { value = render_postgres.ship.connection_info.internal_connection_string }

      # api/src/app.ts:43 throws at boot if this is missing under NODE_ENV
      # =production. Generated by Render when var.session_secret is null, so a
      # clean-machine apply needs exactly one credential: the API key.
      SESSION_SECRET = local.session_env
    },
    local.optional_env,
    local.agent_env,
  )
}
