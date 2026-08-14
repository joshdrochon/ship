#!/bin/bash
# ---------------------------------------------------------------------------
# PF-623 — capture a `terraform plan` against real credentials, verbatim, under
# a header naming run date, provider version and account alias.
#
# PRD p.5 requires that `terraform plan` run cleanly. "Cleanly" is checked here
# as "exit 0 with no Error: lines", not as "produced output" -- a plan that
# errors still prints plenty.
#
# Read-only. Never applies. Safe to run from CI (PF-624).
#
# Usage: scripts/capture-tf-plan.sh <output-file>
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/terraform"
OUT="${1:-$REPO_ROOT/docs/infra/plan-baseline-w6.txt}"
# The script cd's into terraform/ to run the plan, so a relative output path
# passed on the command line would land in the wrong directory (or, as it did
# first time, fail to open at all while the script still printed PASS).
case "$OUT" in
  /*) ;;
  *) OUT="$REPO_ROOT/$OUT" ;;
esac
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

mkdir -p "$(dirname "$OUT")"
cd "$TF_DIR" || exit 1

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")
CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo "unknown")
ALIAS=$(aws iam list-account-aliases --query 'AccountAliases[0]' --output text 2>/dev/null || echo "None")

terraform plan -input=false -no-color -lock-timeout=120s > "$SCRATCH/plan.txt" 2>&1
PLAN_EXIT=$?

{
  echo "==============================================================================="
  echo "PF-623 - terraform plan against real credentials"
  echo "==============================================================================="
  echo "Run date        : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Root            : terraform/  (the graded root -- see docs/infra/topology.md)"
  echo "Terraform       : $(terraform version | head -1)"
  echo "Provider (aws)  : $(grep -A2 'hashicorp/aws' versions.tf | grep version | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
  echo "Provider (rand) : $(grep -A2 'hashicorp/random' versions.tf | grep version | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
  echo "Account alias   : $ALIAS"
  echo "Account id      : $ACCOUNT_ID"
  echo "Caller          : $CALLER_ARN"
  echo "Backend         : s3://<state-bucket>/ship/terraform.tfstate (use_lockfile=true)"
  echo "plan exit code  : $PLAN_EXIT"
  echo "==============================================================================="
  echo
  cat "$SCRATCH/plan.txt"
} > "$OUT"

if [ "$PLAN_EXIT" -ne 0 ] || grep -qE '^(Error|╷)' "$SCRATCH/plan.txt"; then
  # A lone '╷' also opens Warning blocks, so only fail on a real Error:.
  if grep -qE '^Error' "$SCRATCH/plan.txt" || [ "$PLAN_EXIT" -ne 0 ]; then
    echo "FAIL - plan did not run cleanly (exit $PLAN_EXIT). See $OUT"
    exit 1
  fi
fi

echo "PASS - plan ran cleanly (exit 0). Captured to $OUT"
grep -E '^Plan:|^No changes' "$OUT" | head -3
exit 0
