#!/usr/bin/env bash
# Locked pre/post pair for lane-5. Runs against whatever checkout contains this script.
#
#   docs/audit/scripts/lane5-locked-pair.sh
#
# Logs are written to $LANE5_SCRATCH (default $TMPDIR/ship-lane5).
# Deliberately bash, not zsh, and no shell variable ever holds a multi-word file list —
# unquoted $VAR does not word-split in zsh, which silently produced a zero-test run twice.
set -uo pipefail

# Repo root and log directory are derived, never hardcoded. The original pinned an
# absolute path under one machine's home directory and one agent's scratch directory,
# so the script could not be run from a fresh clone at all — which is the whole point
# of committing a measurement script (Rule 1: the numbers must be re-derivable).
#
# Same derivation as run-cat4-paired.sh: the script's own location, which works from a
# worktree, a clone, or a symlink, and does not require the caller to be inside the
# repo. `git rev-parse --show-toplevel` is the fallback for the case where this file
# has been copied somewhere else.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd)"
if [ ! -d "$REPO/.git" ] && [ ! -f "$REPO/.git" ]; then
  REPO="$(git rev-parse --show-toplevel)"
fi
# Logs go to a scratch directory outside the repo so a run never dirties git status.
D="${LANE5_SCRATCH:-${TMPDIR:-/tmp}/ship-lane5}"
mkdir -p "$D"
cd "$REPO"

restore() {
  git checkout HEAD -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts 2>/dev/null || true
}

runset() {
  local tag="$1"
  echo "===== $tag  1-worker  $(date +%T)  load=$(sysctl -n vm.loadavg) ====="
  PLAYWRIGHT_WORKERS=1 npx playwright test \
    e2e/accountability-week.spec.ts \
    e2e/manager-reviews-visual.spec.ts \
    e2e/my-week-stale-data.spec.ts \
    e2e/project-weeks.spec.ts \
    e2e/request-changes-ui.spec.ts \
    e2e/status-overview-heatmap.spec.ts \
    e2e/weekly-accountability.spec.ts \
    --retries=0 --reporter=line > "$D/$tag.log" 2>&1
  echo "$tag exit=$?"

  # Guard: a run that executed zero tests is not a result. (scripts/assert-tests-ran.sh
  # on lane-0 does this properly with a distinct exit 2; not merged here mid-run.)
  if ! grep -qE "[0-9]+ passed \(" "$D/$tag.log"; then
    echo "$tag ABORT: no 'N passed' line — zero tests executed or the run died"
    grep -E "No tests found|Error:" "$D/$tag.log" | head -3
    return 1
  fi
  local total
  total=$(grep -oE "[0-9]+ passed \(" "$D/$tag.log" | grep -oE "^[0-9]+")
  if [ "${total:-0}" -lt 40 ]; then
    echo "$tag ABORT: only $total tests passed, expected ~46+"
    return 1
  fi

  grep -E "[0-9]+ passed \(|[0-9]+ failed" "$D/$tag.log" | tail -3
  echo "-- MY THREE --"
  for t in "my-week-stale-data.spec.ts:28" "my-week-stale-data.spec.ts:63" \
           "my-week-stale-data.spec.ts:100" "my-week-stale-data.spec.ts:139" \
           "status-overview-heatmap.spec.ts:69" "status-overview-heatmap.spec.ts:153"; do
    if grep -qE "^\s+\[chromium\] › e2e/$t" "$D/$tag.log"; then echo "  FAILED: $t"; fi
  done
  echo "  (no FAILED lines above = all three passed)"
  echo "-- ALL FAILURES --"
  grep -E "^\s+\[chromium\] › " "$D/$tag.log" | tail -8
}

scripts/measure-lock.sh acquire lane-5 2400 || exit 1
trap 'restore; scripts/measure-lock.sh release lane-5' EXIT
echo "=== LOCK ACQUIRED $(date +%T) load=$(sysctl -n vm.loadavg) ==="

# --- PRE-FIX ---
git checkout 767aa2f -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts || exit 1
if git diff --quiet HEAD -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts; then
  echo "ABORT: checkout of pre-fix specs did not change anything"; exit 1
fi
echo "pre-fix specs in place: $(git diff --stat HEAD -- e2e/ | tail -1)"
runset PRE1

# --- POST-FIX ---
restore
if ! git diff --quiet HEAD -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts; then
  echo "ABORT: failed to restore post-fix specs"; exit 1
fi
echo "post-fix specs restored"
runset POST1
runset POST2

echo "=== git status e2e/ (must be empty) ==="
git status --short e2e/
echo "LOCKED PAIR DONE $(date +%T)"
