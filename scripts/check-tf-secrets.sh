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

# ── Second check: the boot path's environment must reach the service that boots ──
#
# The first check proves a variable reaches Terraform. It cannot prove the right
# SERVICE receives it, and that gap has now produced the same bug three times:
#
#   1. cron.tf gained ANTHROPIC_API_KEY when the provider moved off Bedrock and
#      main.tf did not — the deployed API answered every chat with
#      503 ai_unavailable while /health stayed green.
#   2. LANGCHAIN_* the same way, one service over.
#   3. SHIP_API_TOKEN reached the cron that USES it but not the web service that
#      SEEDS it. Every cron run detected, judged, and 401'd at delivery, with
#      nothing in either service's log saying why — neither was doing anything
#      wrong on its own.
#
# A first draft of this check asserted only that each variable was referenced by
# *some* resource. That does not catch any of the three: in every case the
# variable was wired to one service and missing from the other, so a
# reference-anywhere test passes while the bug is live. Verified rather than
# assumed — reverting main.tf still returned exit 0.
#
# So the rule is narrower and actually checkable: `Dockerfile:137` runs
# `migrate; seed; serve` in the WEB service, so every environment variable the
# seed path reads must appear in main.tf. It is the one place where which
# service needs which variable is a fact about the code rather than a judgement.
SEED_SRC="$ROOT/api/src/db"
MAIN="$ROOT/terraform/render/main.tf"
boot_missing=0
boot_checked=0

# Env vars the seed path reads. `seed.ts` runs at container start; anything it
# reaches for has to be in the booting service's environment or it silently
# takes its absent-branch.
seed_envs=$(grep -ohE 'process\.env\.[A-Z_][A-Z0-9_]*' "$SEED_SRC"/seed.ts "$SEED_SRC"/seedAgentToken.ts 2>/dev/null \
  | sed 's/process\.env\.//' | sort -u)

while IFS= read -r e; do
  [ -n "$e" ] || continue
  # DATABASE_URL and NODE_ENV are set unconditionally in main.tf's literal block.
  boot_checked=$((boot_checked + 1))
  if ! grep -qE "^[[:space:]]*${e}[[:space:]]*=" "$MAIN"; then
    echo "BOOT-GAP ${e} is read by the seed path but is not in the web service's env"
    echo "         Dockerfile:137 runs \`migrate; seed; serve\` there. Absent, the seed"
    echo "         takes its no-op branch and whatever depends on it fails elsewhere."
    boot_missing=1
  fi
done <<< "$seed_envs"

if [ "$boot_missing" -eq 1 ]; then
  echo
  echo "Add it to local.agent_env_values in main.tf. Then check whether cron.tf"
  echo "needs it too — one service having it is exactly how this bug recurs."
  exit 1
fi

echo "check-tf-secrets: all $boot_checked seed-path env vars reach the web service"
