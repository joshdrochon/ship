#!/usr/bin/env bash
#
# PF-706 — run the flag-invariant agent suite in BOTH states, both blocking.
#
#     ./scripts/agent-flag-matrix.sh
#
# PRD p.11: the rewire lands "behind a feature flag so Part 2's tests pass with
# the flag on or off." p.17 §2.6 asks how CI proves it.
#
# CI RUNS THIS. `.gitlab-ci.yml` job `agent-flag-matrix`, stage verify,
# needs: ['build'], allow_failure: false. That sentence is the whole point of the
# header and it was FALSE until 2026-08-15: this script claimed to be the proof
# while `grep -nE "agent-flag-matrix|SHIP_AGENT_VIA_SDK" .gitlab-ci.yml` matched
# nothing in any of the 29 jobs, and `agent-test` ran the suite once at the flag's
# default (OFF). If you move or rename that job, this comment becomes a lie again —
# the grep above is the check.
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
# WHY EXACTLY ONE FILE IS EXCLUDED, AND WHY THE LIST USED TO BE THREE.
# ---------------------------------------------------------------------------
# The exclusion list is the weakest point in a matrix like this: a matrix that
# skips the files that would fail is the same defect class as a test that passes
# whether or not the feature works. So the list is held to one rule — a file is
# excluded only if it has been MEASURED to fail in the other state, and the
# measurement is recorded in docs/l23-flag-matrix.md.
#
# That rule removed two of the three original entries. `act.test.ts` (11) and
# `client.test.ts` (20) were excluded on the argument that they construct the
# flag-off action path directly and are therefore "tests OF the flag-off
# implementation". The argument is tidy and the measurement contradicts its
# premise: run flag-on, both files pass, 11/11 and 20/20. They stub `FetchLike`
# and never reach the composition root, so the flag never touches them. Excluding
# a file that would have passed does not make the matrix safer — it narrows what
# the matrix is allowed to prove, for free.
#
# `cron.test.ts` stays out, and it is the one entry the rule keeps. Its five
# scan tests call `scanWorkspace()` without injecting `db`, so they exercise the
# composition root — the one place the flag lives — and flag-on they fail with
# "SHIP_AGENT_VIA_SDK is on but AGENT_CLIENT_SECRET is not set", the rewired
# agent refusing to run without a credential. That is the design working.
# Supplying a credential does not fix it, it relocates the failure: with
# AGENT_CLIENT_SECRET set the same five fail at "Client credentials exchange
# failed (invalid_client)", because flag-on the composition root needs a running
# API server with a seeded first-party app, which a unit test that starts only a
# Postgres container does not have. Both measurements are in the doc.
#
# The exclusion is DATA, right here, so it is one list a reviewer can read
# rather than a shell expression they have to evaluate in their head.
set -euo pipefail

cd "$(dirname "$0")/.."

# Excluded — see docs/l23-flag-matrix.md. Adding a file here is a claim that it
# has been measured to fail in the other state, and it needs a row in that
# document carrying the measurement. An argument is not enough; the two files
# this list used to carry were removed because theirs did not survive one.
EXCLUDED=(
  "src/entrypoints/cron.test.ts"
)

# The floor for bucket 1. Deliberately BELOW the current count (230) so adding a
# test does not break CI, and deliberately far above zero so a filter that
# matched nothing does.
MIN_BUCKET_1_TESTS=200

EXCLUDES=()
for f in "${EXCLUDED[@]}"; do
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
echo "Excluding (measured to fail in the other state — see docs/l23-flag-matrix.md):"
printf "  %s\n" "${EXCLUDED[@]}"

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
