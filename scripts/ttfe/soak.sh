#!/usr/bin/env bash
#
# PF-606 — the 20-run soak, actually run and recorded.
#
#   scripts/ttfe/soak.sh [runs]
#
# p.9 measures flake "over 20 consecutive CI runs" and reads any flake as a bug
# in the drill or the platform. This runs the drill N times against ONE commit,
# each appending to `test-results/ttfe-series.jsonl`, and then asserts 20 of 20
# via `check-series.mjs --soak`.
#
# ── The rule this script exists to keep ────────────────────────────────────
# A failing run is NOT re-run to clear it. It stays in the series, the soak
# fails, and the diagnosis names either the drill or the platform. That is what
# the PRD's own gloss demands, and it is the only version of this number that
# means anything. The script therefore never retries and never filters.
#
# The series is truncated first, deliberately: a soak is a claim about N
# consecutive runs of one commit, and leaving earlier runs of other commits in
# the window would make it a claim about something else. The old series is moved
# aside rather than deleted.
set -uo pipefail

RUNS="${1:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SERIES="test-results/ttfe-series.jsonl"
mkdir -p test-results
if [[ -f "$SERIES" ]]; then
  mv "$SERIES" "test-results/ttfe-series.$(date -u +%Y%m%dT%H%M%SZ).jsonl"
fi

COMMIT="$(git rev-parse HEAD)"
echo "ttfe soak: $RUNS run(s) against $COMMIT"
echo "ttfe soak: uptime at start — $(uptime)"

failed=0
for ((i = 1; i <= RUNS; i++)); do
  printf '\n── run %d/%d ──────────────────────────────────────────────\n' "$i" "$RUNS"
  if ! pnpm drill ttfe; then
    failed=$((failed + 1))
    echo "ttfe soak: run $i FAILED — recorded, not re-run (p.9)"
  fi
done

echo
echo "ttfe soak: $((RUNS - failed))/$RUNS passed"
echo "ttfe soak: uptime at end — $(uptime)"
node scripts/ttfe/check-series.mjs --soak
