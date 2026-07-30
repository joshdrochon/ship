#!/usr/bin/env bash
set -uo pipefail
D=/private/tmp/claude-501/-Users-joanmiguel-Desktop-Developer-ship/2eeea81e-b929-4df6-ae12-c71fbf14b33b/scratchpad
cd /Users/joanmiguel/Desktop/Developer/ship-worktrees/ship-lane-5
run() {
  echo "===== $1 $(date +%T) ====="
  PLAYWRIGHT_WORKERS=1 npx playwright test \
    e2e/accountability-week.spec.ts \
    e2e/weekly-accountability.spec.ts \
    --retries=0 --reporter=line > "$D/$1.log" 2>&1
  echo "$1 exit=$?"
  if ! grep -qE "[0-9]+ passed" "$D/$1.log"; then echo "$1 ABORT: zero tests ran"; return 1; fi
  grep -E "[0-9]+ passed|[0-9]+ failed" "$D/$1.log" | tail -2
  if grep -qE "^\s+\[chromium\] › e2e/weekly-accountability.spec.ts:(78|94)" "$D/$1.log"; then
    echo "  >> the 201-vs-200 test FAILED"; else echo "  >> the 201-vs-200 test passed"; fi
}
git stash push -q -- e2e/weekly-accountability.spec.ts && echo "stashed fix (pre state)"
run W78-PRE
git stash pop -q && echo "restored fix (post state)"
run W78-POST
git status --short e2e/
