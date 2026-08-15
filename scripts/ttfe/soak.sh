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
#
# ── Where it runs, and why the distinction is written into the artifact ────
# p.9 says "CI runs". Run from `ttfe-soak` in .gitlab-ci.yml this is a CI soak;
# run from a laptop it is a local one, and the two are not interchangeable
# evidence. Rather than leave that to whoever quotes the number later, the script
# stamps `test-results/ttfe-soak.json` with the context it detected and, in CI,
# the job and pipeline that produced it. An artifact that does not say what
# produced it gets quoted as whichever kind of run the reader needed.
set -uo pipefail

RUNS="${1:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SERIES="test-results/ttfe-series.jsonl"
SOAK_RECORD="test-results/ttfe-soak.json"
mkdir -p test-results
if [[ -f "$SERIES" ]]; then
  mv "$SERIES" "test-results/ttfe-series.$(date -u +%Y%m%dT%H%M%SZ).jsonl"
fi

# The same precedence `commitSha()` in the drill uses, so the SHA on this record
# and the SHA on every series line cannot disagree.
COMMIT="${CI_COMMIT_SHA:-$(git rev-parse HEAD)}"
CONTEXT="local"
[[ -n "${CI:-}" ]] && CONTEXT="ci"

# `uptime` lives in procps and is not guaranteed inside a slim CI image. A
# missing load reading must not be the thing that fails a soak.
load_line() { uptime 2>/dev/null || echo 'uptime unavailable'; }

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "ttfe soak: $RUNS run(s) against $COMMIT  [context: $CONTEXT]"
echo "ttfe soak: uptime at start — $(load_line)"

failed=0
for ((i = 1; i <= RUNS; i++)); do
  printf '\n── run %d/%d ──────────────────────────────────────────────\n' "$i" "$RUNS"
  # Wrapped exactly as the `ttfe` job wraps it: a drill that executes zero stages
  # exits 2 — VOID RUN — rather than reading as a pass that never happened. The
  # window-length check in check-series.mjs catches this too, but only after 20
  # runs; this names it on the run it happened in.
  if ! scripts/assert-tests-ran.sh 3 -- pnpm drill ttfe; then
    failed=$((failed + 1))
    echo "ttfe soak: run $i FAILED — recorded, not re-run (p.9)"
  fi
done

echo
echo "ttfe soak: $((RUNS - failed))/$RUNS passed"
echo "ttfe soak: uptime at end — $(load_line)"

cat > "$SOAK_RECORD" <<JSON
{
  "_": "PF-606 — provenance for the 20-run soak. p.9 grades flake over CI runs, so 'context' is part of the result, not metadata about it.",
  "context": "$CONTEXT",
  "runs": $RUNS,
  "passed": $((RUNS - failed)),
  "failed": $failed,
  "commit": "$COMMIT",
  "startedAtIso": "$STARTED_AT",
  "finishedAtIso": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "producedBy": "scripts/ttfe/soak.sh $RUNS",
  "ciJobId": "${CI_JOB_ID:-}",
  "ciJobUrl": "${CI_JOB_URL:-}",
  "ciPipelineId": "${CI_PIPELINE_ID:-}",
  "ciRef": "${CI_COMMIT_REF_NAME:-}",
  "series": "test-results/ttfe-series.jsonl"
}
JSON
echo "ttfe soak: wrote $SOAK_RECORD"

node scripts/ttfe/check-series.mjs --soak
