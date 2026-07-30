#!/usr/bin/env bash
# Lane-5 remaining evidence, one lock window.
#   H-PRE / H-POST : six-file set WITHOUT project-weeks.spec.ts.
#     Falsifiable prediction from the heatmap RCA: project-weeks leaves a week-15
#     allocation that the pre-fix assertion survives on by luck (DIAG showed buttons=1
#     coming from it). Remove that spec and the pre-fix heatmap test should find zero
#     Weekly Plan buttons and FAIL. If it passes, my RCA for :69 is wrong and I say so.
#   FULL : one full-suite post-fix run, for collateral damage and for my-week:63,
#     whose dominant cause (WebSocket connection budget) a 49-test run cannot exhaust.
# bash, not zsh. No variable ever holds a multi-word file list.
set -uo pipefail

D=/private/tmp/claude-501/-Users-joanmiguel-Desktop-Developer-ship/2eeea81e-b929-4df6-ae12-c71fbf14b33b/scratchpad
REPO=/Users/joanmiguel/Desktop/Developer/ship-worktrees/ship-lane-5
cd "$REPO"

restore() {
  git checkout HEAD -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts 2>/dev/null || true
}

check_ran() { # $1=tag $2=min-passed
  if ! grep -qE "[0-9]+ passed" "$D/$1.log"; then
    echo "$1 ABORT: no 'N passed' line — zero tests executed or the run died"
    grep -E "No tests found|Error:" "$D/$1.log" | head -3; return 1
  fi
  local n; n=$(grep -oE "[0-9]+ passed" "$D/$1.log" | tail -1 | grep -oE "^[0-9]+")
  if [ "${n:-0}" -lt "$2" ]; then echo "$1 ABORT: only $n passed, expected >= $2"; return 1; fi
  return 0
}

report() { # $1=tag
  grep -E "[0-9]+ passed|[0-9]+ failed|[0-9]+ flaky" "$D/$1.log" | tail -3
  echo "-- failures --"
  grep -E "^\s+\[chromium\] › e2e/" "$D/$1.log" | sed 's/^ *//' | sort -u
}

six() { # $1=tag
  echo "===== $1  six-file (no project-weeks)  1-worker  $(date +%T)  load=$(sysctl -n vm.loadavg) ====="
  PLAYWRIGHT_WORKERS=1 npx playwright test \
    e2e/accountability-week.spec.ts \
    e2e/manager-reviews-visual.spec.ts \
    e2e/my-week-stale-data.spec.ts \
    e2e/request-changes-ui.spec.ts \
    e2e/status-overview-heatmap.spec.ts \
    e2e/weekly-accountability.spec.ts \
    --retries=0 --reporter=line > "$D/$1.log" 2>&1
  echo "$1 exit=$?"
  check_ran "$1" 30 || return 1
  report "$1"
}

scripts/measure-lock.sh acquire lane-5 2400 || exit 1
trap 'restore; scripts/measure-lock.sh release lane-5' EXIT
echo "=== LOCK ACQUIRED $(date +%T) load=$(sysctl -n vm.loadavg) ==="

git checkout 767aa2f -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts || exit 1
if git diff --quiet HEAD -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts; then
  echo "ABORT: pre-fix checkout was a no-op"; exit 1
fi
echo "pre-fix specs in place"
six H-PRE

restore
if ! git diff --quiet HEAD -- e2e/my-week-stale-data.spec.ts e2e/status-overview-heatmap.spec.ts; then
  echo "ABORT: failed to restore post-fix specs"; exit 1
fi
echo "post-fix specs restored"
six H-POST

echo "===== FULL  full suite post-fix  4-worker  $(date +%T)  load=$(sysctl -n vm.loadavg) ====="
PLAYWRIGHT_WORKERS=4 pnpm test:e2e > "$D/FULL.log" 2>&1
echo "FULL exit=$?"
if check_ran FULL 800; then
  report FULL
  echo "-- my three (post-fix line numbers) --"
  grep -E "my-week-stale-data.spec.ts:(100|139)|status-overview-heatmap.spec.ts:153" "$D/FULL.log" \
    | grep -E "^\s+\[chromium\] › " | sed 's/^ *//' | sort -u
  echo "  (nothing above = all three passed)"
fi

echo "=== git status e2e/ (must be empty) ==="
git status --short e2e/
echo "ALL DONE $(date +%T)"
