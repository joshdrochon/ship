#!/usr/bin/env bash
set -uo pipefail
# Derived, not hardcoded — see the note in lane5-locked-pair.sh. Logs go to
# $LANE5_SCRATCH (default $TMPDIR/ship-lane5), where lane5-gen-evidence.sh reads them.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd)"
if [ ! -d "$REPO/.git" ] && [ ! -f "$REPO/.git" ]; then
  REPO="$(git rev-parse --show-toplevel)"
fi
D="${LANE5_SCRATCH:-${TMPDIR:-/tmp}/ship-lane5}"
mkdir -p "$D"
cd "$REPO"
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
