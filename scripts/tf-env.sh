#!/usr/bin/env bash
# Source this — do not execute it.
#
#   . scripts/tf-env.sh
#   cd terraform/render && terraform plan
#
# Exports what `terraform/render` needs and nothing else, reading every value
# out of `.env` at the repo root. `.env` is gitignored, and no value is ever
# echoed: a helper that prints a token to make itself feel useful is how tokens
# end up in scrollback, in a screen recording, and in a bug report.
#
# The split matters. TF_HTTP_* authenticate the *state backend* (GitLab).
# TF_VAR_* are inputs to the *configuration* (Render, the registry, the app).
# Getting one without the other fails in two different and confusing ways:
# missing TF_HTTP_PASSWORD gives a 401 during `init`, missing TF_VAR_* gives an
# interactive prompt during `plan` that hangs a CI job forever.
set -a

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "tf-env: $REPO_ROOT/.env not found." >&2
  echo "tf-env: see terraform/render/README.md for the keys it must contain." >&2
  set +a
  return 1 2>/dev/null || exit 1
fi

# shellcheck disable=SC1091
. "$REPO_ROOT/.env"

# ── State backend (GitLab) ───────────────────────────────────────────────────
# GitLab accepts any non-empty username when the password is a personal access
# token, but sending the real one keeps the audit log readable.
TF_HTTP_USERNAME="${GITLAB_USERNAME:-joshrochon}"
TF_HTTP_PASSWORD="$GITLAB_TOKEN"

# ── Configuration inputs (Render, registry, app) ─────────────────────────────
TF_VAR_render_api_key="$RENDER_API_KEY"
TF_VAR_render_owner_id="$RENDER_OWNER_ID"
TF_VAR_session_secret="$SESSION_SECRET"
TF_VAR_anthropic_api_key="${ANTHROPIC_API_KEY:-}"
TF_VAR_langchain_api_key="${LANGCHAIN_API_KEY:-}"
TF_VAR_registry_username="${REGISTRY_USERNAME:-joshdrochon}"
TF_VAR_registry_token="${REGISTRY_TOKEN:-$GH_TOKEN}"
TF_VAR_ship_api_token="${SHIP_API_TOKEN:-}"

set +a

# Report presence, never value. Anything listed as MISSING will either prompt
# interactively or 401, depending on which half it belongs to.
#
# The model and Ship tokens are in this list for a reason discovered the hard way.
# `variables.tf` defaults them to null, and null does not mean "leave the running
# service alone" — main.tf and cron.tf omit the variable entirely when it is null,
# so the provider REMOVES it from the live service. A local `terraform apply` run
# without them would strip ANTHROPIC_API_KEY off a healthy deployment: service up,
# /health green, every judgement returning ai_unavailable.
#
# `.github/workflows/deploy.yml` is protected from this by
# `scripts/check-tf-secrets.sh`. Nothing protected a laptop, so this does.
_tf_env_report() {
  # `eval` rather than `${!name}`: this file is SOURCED, so it runs in the user's
  # interactive shell, and the shell here is zsh. Indirect expansion is spelled
  # `${!name}` in bash and `${(P)name}` in zsh, and neither works in the other —
  # the bash form gave `bad substitution` in zsh, which is how this was found.
  # `eval` with the value quoted is the one form both accept.
  local missing=0 name value
  for name in TF_HTTP_PASSWORD TF_VAR_render_api_key TF_VAR_render_owner_id \
              TF_VAR_session_secret TF_VAR_registry_token \
              TF_VAR_anthropic_api_key TF_VAR_ship_api_token TF_VAR_langchain_api_key; do
    eval "value=\${$name:-}"
    if [ -z "$value" ]; then
      echo "  MISSING  $name" >&2
      missing=1
    fi
  done
  value=""
  if [ "$missing" -eq 0 ]; then
    echo "tf-env: all required values present." >&2
  else
    echo "tf-env: incomplete — see terraform/render/README.md." >&2
  fi
}
_tf_env_report
unset -f _tf_env_report
