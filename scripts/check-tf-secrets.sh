#!/usr/bin/env bash
#
# Every sensitive Terraform variable must be passed by the deploy workflow.
#
# ── The bug this exists to catch ─────────────────────────────────────────────
# `terraform/render/variables.tf` declares `anthropic_api_key` with
# `default = null`, and main.tf/cron.tf omit the environment variable entirely
# when it is null. Null therefore does not mean "leave the running service
# alone" — it means "remove ANTHROPIC_API_KEY from it".
#
# `.github/workflows/deploy.yml` did not pass that variable. Arming the workflow
# would have stripped the model credential off a healthy deployment on the next
# apply. The service would have stayed up, /health would have stayed green, and
# every judgement would have returned `ai_unavailable` — the same silent failure
# 11c4a67 fixed, reintroduced by the deploy path rather than the code.
#
# Nothing in `terraform plan`, `tflint`, or a type-check catches this. The plan
# is correct; it correctly plans to delete the variable.
#
# ── What it checks ───────────────────────────────────────────────────────────
# For each `variable "x" { ... sensitive = true ... }` in variables.tf, assert
# that `TF_VAR_x:` appears in deploy.yml. It does not check the value — that is
# the preflight's job at run time, and this must pass with no credentials
# present so it can run on any fork and in any pull request.
#
#   ./scripts/check-tf-secrets.sh          # exits 1 on the first omission
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARS="$ROOT/terraform/render/variables.tf"
FLOW="$ROOT/.github/workflows/deploy.yml"

for f in "$VARS" "$FLOW"; do
  [ -f "$f" ] || { echo "check-tf-secrets: missing $f" >&2; exit 1; }
done

# awk over the variable blocks: remember the name at `variable "x" {`, and when a
# `sensitive = true` shows up before the block closes at column 0, print it.
sensitive=$(awk '
  /^variable[[:space:]]+"/ { name = $2; gsub(/"/, "", name); insensitive = 0; next }
  /^}/                     { name = ""; next }
  name && /sensitive[[:space:]]*=[[:space:]]*true/ { print name; name = "" }
' "$VARS")

[ -n "$sensitive" ] || { echo "check-tf-secrets: parsed zero sensitive variables — the awk broke, not the config" >&2; exit 1; }

missing=0
count=0
while IFS= read -r v; do
  [ -n "$v" ] || continue
  count=$((count + 1))
  if ! grep -qE "^[[:space:]]*TF_VAR_${v}:" "$FLOW"; then
    echo "MISSING  TF_VAR_${v} is not passed by deploy.yml"
    echo "         variables.tf declares it sensitive. If its default is null, an apply"
    echo "         will REMOVE it from the running service rather than leave it alone."
    missing=1
  fi
done <<< "$sensitive"

if [ "$missing" -eq 1 ]; then
  echo
  echo "Add the missing TF_VAR_* to BOTH env blocks in deploy.yml — the deploy job"
  echo "and rollback-on-failed-ci. A rollback that drops a credential is still an outage."
  exit 1
fi

echo "check-tf-secrets: all $count sensitive variables are passed by deploy.yml"
