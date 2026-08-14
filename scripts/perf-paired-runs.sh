#!/usr/bin/env bash
#
# Paired A/B latency runs for MVP gate item 9 (PRD p.2).
#
# WHY THIS EXISTS, and why one `pnpm baseline:compare` is not enough:
#
# `compare-baseline` measures the current tree once and compares it to a stored
# baseline captured at some earlier moment. On a contended developer machine the
# run-to-run variance of that single measurement is comparable to the +10% budget
# itself, so the verdict flips. Measured, not asserted: four consecutive 50-trial
# comparisons of the SAME tree against the SAME baseline gave WITHIN / OVER /
# WITHIN / WITHIN.
#
# This script instead re-measures BOTH sides, alternating, in the same session.
# Alternation is the point: whatever the machine is doing drifts across the run,
# and interleaving makes that drift land on both sides instead of on whichever
# side happened to be measured during a Spotlight index.
#
# Requires a Week 5 (Part 1) worktree with this repo's current perf harness
# copied into it — both sides MUST run identical measurement code or the
# comparison measures the harness. See docs/regression-paired-runs.md.
#
# Usage:
#   scripts/perf-paired-runs.sh <part1-worktree> <pairs>
#
set -euo pipefail

WT=${1:?usage: perf-paired-runs.sh <part1-worktree> <pairs>}
PAIRS=${2:-10}
SHIP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${PERF_PAIRED_OUT:-$SHIP/docs/perf-paired-runs.txt}"

: "${BASELINE_DATABASE_URL:?set BASELINE_DATABASE_URL (Part 1 schema)}"
: "${CURRENT_DATABASE_URL:?set CURRENT_DATABASE_URL (current schema)}"

# Pin the limiter identically on both sides. Part 1 defaults its test ceiling to
# 10_000/min and the current tree to 1_000_000; at 25 trials x 60 samples x 6
# routes the Part 1 default is exceeded and the run measures the 429 path. That
# is a difference between the trees which is NOT the thing under test, so it is
# held constant rather than measured.
export API_RATE_LIMIT_MAX=${API_RATE_LIMIT_MAX:-100000000}
export SESSION_SECRET=${SESSION_SECRET:-paired-run-secret-32-bytes-long-ok}
export NODE_ENV=test
export PERF_TRIALS=${PERF_TRIALS:-25}

: > "$OUT"
echo "# paired latency runs — $PAIRS pairs, PERF_TRIALS=$PERF_TRIALS" >> "$OUT"

for i in $(seq 1 "$PAIRS"); do
  ( cd "$WT" && DATABASE_URL="$BASELINE_DATABASE_URL" \
      pnpm --filter @ship/api exec tsx src/scripts/measure-baseline.ts 2>/dev/null ) \
    | grep -E "^  GET" | sed "s/^/BASE /" >> "$OUT"

  ( cd "$SHIP" && DATABASE_URL="$CURRENT_DATABASE_URL" \
      pnpm --filter @ship/api exec tsx src/scripts/measure-baseline.ts 2>/dev/null ) \
    | grep -E "^  GET" | sed "s/^/CURR /" >> "$OUT"

  echo "  pair $i/$PAIRS" >&2
done

# NOTE: measure-baseline.ts WRITES docs/baseline-part1.json in whichever tree it
# runs in, so this loop clobbers the committed baseline in $SHIP. Restore it from
# the Part 1 worktree afterwards — `git checkout docs/baseline-part1.json` also
# works and is what CI should do.
echo "  wrote $OUT (restore docs/baseline-part1.json before committing)" >&2

python3 - "$OUT" <<'PY'
import re, statistics as st, sys
from collections import defaultdict
data = defaultdict(lambda: defaultdict(list))
for line in open(sys.argv[1]):
    m = re.match(r'(BASE|CURR)\s+(GET \S+)\s+p95\s+([\d.]+) ms', line.strip())
    if m: data[m.group(2)][m.group(1)].append(float(m.group(3)))
print(f"\n{'route':<30}{'base':>8}{'curr':>8}{'delta':>9}")
print("-"*56)
over = 0
for route, d in data.items():
    bm, cm = st.median(d['BASE']), st.median(d['CURR'])
    delta = (cm - bm) / bm * 100
    over += delta > 10
    print(f"{route:<30}{bm:>8.2f}{cm:>8.2f}{delta:>+8.1f}%")
print(f"\nroutes over +10%: {over}")
sys.exit(1 if over else 0)
PY
