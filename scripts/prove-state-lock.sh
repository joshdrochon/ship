#!/bin/bash
# ---------------------------------------------------------------------------
# PF-621 — prove the state lock holds.
#
# L99 finding F32: this configuration had NO state locking of any kind. The fix
# (`use_lockfile = true` in every backend block) is only worth the commit if it
# is demonstrated, so this script runs two Terraform operations against the same
# state at the same time and captures what the second one says.
#
# The acceptance criterion is "two concurrent applies where the second reports a
# lock error instead of both writing state". This runs two `plan`s rather than
# two `apply`s on purpose: `plan` takes the same exclusive state lock through the
# same code path, and it cannot mutate the graded infrastructure if the guard it
# is testing turns out not to work. Proving a safety mechanism should not require
# betting the environment on the mechanism.
#
# `-lock-timeout=0` on the second run is what makes the result deterministic
# rather than a race: Terraform's default is to retry for a while, which would
# turn "the lock works" into "the lock works, eventually, sometimes".
#
# Usage: scripts/prove-state-lock.sh [output-file]
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/terraform"
OUT="${1:-$REPO_ROOT/docs/infra/state-lock-proof.txt}"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

mkdir -p "$(dirname "$OUT")"

{
  echo "PF-621 — Terraform state locking proof"
  echo "Run date : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Root     : terraform/ (the graded root, PF-616)"
  echo "Backend  : s3, use_lockfile = true (S3 conditional-write locking)"
  echo "Terraform: $(cd "$TF_DIR" && terraform version | head -1)"
  echo
  echo "Method: two concurrent operations against one state. Process A takes the"
  echo "lock; process B is started while A still holds it, with -lock-timeout=0"
  echo "so it fails immediately instead of retrying."
  echo
  echo "==================== process A (holds the lock) ===================="
} > "$OUT"

cd "$TF_DIR" || exit 1

# A: start first and let it take the lock.
terraform plan -input=false -no-color -lock-timeout=60s > "$SCRATCH/a.log" 2>&1 &
A_PID=$!

# Give A enough time to acquire the lock before B tries. The lock is taken at the
# very start of the run, before refresh, so this is comfortably long enough.
sleep 4

# B: must be refused.
terraform plan -input=false -no-color -lock-timeout=0 > "$SCRATCH/b.log" 2>&1
B_EXIT=$?

wait $A_PID
A_EXIT=$?

{
  echo "exit code: $A_EXIT"
  echo "--- tail ---"
  tail -5 "$SCRATCH/a.log"
  echo
  echo "==================== process B (concurrent, -lock-timeout=0) ===================="
  echo "exit code: $B_EXIT"
  echo "--- verbatim output ---"
  cat "$SCRATCH/b.log"
  echo
  echo "==================== verdict ===================="
} >> "$OUT"

if [ "$A_EXIT" -eq 0 ] && [ "$B_EXIT" -ne 0 ] && grep -qi "state lock\|Lock Info\|ConditionalRequestConflict" "$SCRATCH/b.log"; then
  echo "PASS — A completed, B was refused the state lock. Locking is in effect." >> "$OUT"
  echo "PASS — see $OUT"
  exit 0
fi

echo "FAIL — expected A to succeed and B to be refused with a lock error." >> "$OUT"
echo "       A exit=$A_EXIT  B exit=$B_EXIT" >> "$OUT"
echo "FAIL — see $OUT"
exit 1
