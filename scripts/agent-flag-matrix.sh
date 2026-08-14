#!/usr/bin/env bash
#
# PF-706 — run the flag-invariant agent suite in BOTH states, both blocking.
#
#     ./scripts/agent-flag-matrix.sh
#
# PRD p.11: the rewire lands "behind a feature flag so Part 2's tests pass with
# the flag on or off." p.17 asks how CI proves it. This is the proof.
#
# ---------------------------------------------------------------------------
# THE TWO ANTI-VACUITY GUARDS, AND WHY THEY ARE NOT OPTIONAL.
# ---------------------------------------------------------------------------
# A matrix that runs zero tests in one leg is green and means nothing. L99's F28
# records that a zero-stage run in this repo's CI reads as a pass, so:
#
#   1. Each leg asserts a MINIMUM test count. A filter that silently matched
#      nothing would otherwise be indistinguishable from a suite that passed.
#   2. The two legs must run the SAME file set. A leg that quietly skipped the
#      flag-sensitive files would pass for the wrong reason, which is the exact
#      failure this script exists to catch in the code it is testing.
#
# ---------------------------------------------------------------------------
# WHY BUCKET 2 IS EXCLUDED RATHER THAN RUN TWICE.
# ---------------------------------------------------------------------------
# `act.test.ts` and `client.test.ts` construct the flag-off action path directly
# and assert its HTTP shapes; `cron.test.ts` exercises the composition root,
# which is the one place the flag lives. They are tests OF the flag-off
# implementation. Running them flag-on would not be a stronger check — it would
# be a test of something they are not about, and it would fail for a reason that
# is the design working (see docs/l23-flag-matrix.md).
#
# The exclusion is DATA, right here, so it is one list a reviewer can read
# rather than a shell expression they have to evaluate in their head.
set -euo pipefail

cd "$(dirname "$0")/.."

# Bucket 2 — see docs/l23-flag-matrix.md. Adding a file here is a claim that it
# tests a transport rather than a behaviour, and it needs a row in that document.
BUCKET_2=(
  "src/actions/act.test.ts"
  "src/actions/client.test.ts"
  "src/entrypoints/cron.test.ts"
)

# The floor for bucket 1. Deliberately BELOW the current count (191) so adding a
# test does not break CI, and deliberately far above zero so a filter that
# matched nothing does.
MIN_BUCKET_1_TESTS=150

EXCLUDES=()
for f in "${BUCKET_2[@]}"; do
  EXCLUDES+=(--exclude "$f")
done

run_leg() {
  local state="$1" value="$2"
  # Progress to STDERR: stdout is captured by the caller to read the count file
  # path back, so anything printed there is swallowed rather than shown.
  echo "" >&2
  echo "── bucket 1, SHIP_AGENT_VIA_SDK=${state} ─────────────────────────────" >&2

  local report
  report="$(mktemp)"

  (
    cd agent
    SHIP_AGENT_VIA_SDK="$value" npx vitest run \
      "${EXCLUDES[@]}" \
      --reporter=json --outputFile="$report" \
      --reporter=default
  )

  # `readFileSync`, not `require()` — the repo is `"type": "module"` and
  # `require` of a .json path throws `ERR_REQUIRE_ESM`-adjacent noise that reads
  # as a test failure rather than as a script bug. Found by running it.
  local passed total
  total="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$report','utf8')).numTotalTests)")"
  passed="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$report','utf8')).numPassedTests)")"

  if [ "$total" -lt "$MIN_BUCKET_1_TESTS" ]; then
    echo "FAIL: leg ${state} ran ${total} tests, expected at least ${MIN_BUCKET_1_TESTS}." >&2
    echo "      A leg that runs (almost) nothing is green and meaningless — L99 F28." >&2
    exit 1
  fi
  if [ "$passed" -ne "$total" ]; then
    echo "FAIL: leg ${state} — ${passed}/${total} passed." >&2
    exit 1
  fi

  echo "ok   leg ${state}: ${passed}/${total}" >&2
  echo "$total" > "${report}.count"
  echo "${report}.count"
}

echo "PF-706 — the agent flag matrix"
echo "Excluding bucket 2 (transport-specific, one state by construction):"
printf '  %s\n' "${BUCKET_2[@]}"

OFF_COUNT_FILE="$(run_leg off 0 | tail -1)"
ON_COUNT_FILE="$(run_leg on 1 | tail -1)"

OFF_COUNT="$(cat "$OFF_COUNT_FILE")"
ON_COUNT="$(cat "$ON_COUNT_FILE")"

if [ "$OFF_COUNT" -ne "$ON_COUNT" ]; then
  echo ""
  echo "FAIL: the two legs ran different numbers of tests (${OFF_COUNT} vs ${ON_COUNT})."
  echo "      Both legs must run the SAME file set — a leg that skipped the"
  echo "      flag-sensitive files would pass for the wrong reason."
  exit 1
fi

echo ""
echo "PF-706 ok — bucket 1 is green in BOTH states, ${OFF_COUNT} tests per leg."
