#!/usr/bin/env bash
#
# Assert that a test run actually executed tests.
#
# The failure this catches: a run that does no work and exits in a way that reads like
# a result. A Playwright filter matching zero spec files, a vitest path typo, a shell
# quoting mistake that collapses several paths into one unmatchable pattern — all of
# these produce a fast exit that a human or an agent skimming output will file as
# "tests ran, some failed" or worse, "tests passed".
#
# This repo already guards the in-file version of the same problem:
# scripts/check-empty-tests.sh catches `test()` bodies containing only TODO comments,
# because those pass silently. There was no guard for the invocation-level version,
# which is how a zero-test run got mistaken for a failing run during Phase 2.
#
# Usage — wrap any test command:
#
#   scripts/assert-tests-ran.sh <expected-minimum> -- <command...>
#
#   scripts/assert-tests-ran.sh 1  -- pnpm exec playwright test e2e/backlinks.spec.ts
#   scripts/assert-tests-ran.sh 60 -- pnpm exec playwright test e2e/a.spec.ts e2e/b.spec.ts
#   scripts/assert-tests-ran.sh 450 -- pnpm test
#
# Exit codes:
#   0                  tests ran, count >= expected minimum, command succeeded
#   1                  the command failed on its own terms (real test failures)
#   2                  ZERO tests ran, or fewer than expected — the run is void
#
# Exit 2 is the point. It is distinct from 1 so "the run was void" can never be
# confused with "tests ran and failed", which is the whole failure mode.
#
# Passing an expected minimum matters. A filter that silently matches 3 of 7 intended
# spec files still "ran tests" — only a count tells you it ran the RIGHT ones. Take the
# number from a known-good run and use it.

set -uo pipefail

EXPECTED="${1:?usage: assert-tests-ran.sh <expected-minimum> -- <command...>}"
shift
[[ "${1:-}" == "--" ]] && shift
[[ $# -gt 0 ]] || { echo "assert-tests-ran: no command given" >&2; exit 2; }

OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT

"$@" 2>&1 | tee "$OUT"
CMD_STATUS="${PIPESTATUS[0]}"

# Strip ANSI so the counters below match on coloured output.
CLEAN=$(sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$OUT")

count_of() { grep -oE "$1" <<<"$CLEAN" | grep -oE '[0-9]+' | tail -1; }

# Playwright: "  848 passed (12.7m)" / "  8 failed" / "  13 flaky"
# vitest:     "  Tests  461 passed (461)"  — the parenthesised total is the run size
PASSED=$(count_of '[0-9]+ passed'  || true)
FAILED=$(count_of '[0-9]+ failed'  || true)
FLAKY=$(count_of  '[0-9]+ flaky'   || true)
VITEST_TOTAL=$(grep -oE 'Tests +[0-9]+ (passed|failed)[^(]*\(([0-9]+)\)' <<<"$CLEAN" \
  | grep -oE '\(([0-9]+)\)$' | tr -d '()' | tail -1 || true)

TOTAL=$(( ${PASSED:-0} + ${FAILED:-0} + ${FLAKY:-0} ))
[[ -n "${VITEST_TOTAL:-}" ]] && (( VITEST_TOTAL > TOTAL )) && TOTAL="$VITEST_TOTAL"

# Playwright says this outright when a filter matches nothing.
if grep -qiE 'No tests found|no test files found' <<<"$CLEAN"; then
  echo >&2
  echo "assert-tests-ran: VOID RUN — the runner reported no tests found." >&2
  echo "  The filter matched zero files. This is NOT a test failure." >&2
  echo "  Common cause: an unquoted shell variable holding several paths. zsh does not" >&2
  echo "  word-split unquoted expansions, so the whole string becomes one pattern." >&2
  echo "  Inline the paths, or use an array: \"\${PATHS[@]}\"" >&2
  exit 2
fi

if (( TOTAL == 0 )); then
  echo >&2
  echo "assert-tests-ran: VOID RUN — parsed zero tests from the output." >&2
  echo "  Command exited ${CMD_STATUS}, but nothing ran. This is NOT a test failure." >&2
  exit 2
fi

if (( TOTAL < EXPECTED )); then
  echo >&2
  echo "assert-tests-ran: SHORT RUN — ${TOTAL} tests ran, expected at least ${EXPECTED}." >&2
  echo "  The filter matched fewer files than intended. Treat this as void, not as a pass:" >&2
  echo "  a subset that happens to be green tells you nothing about the rest." >&2
  exit 2
fi

echo "assert-tests-ran: ${TOTAL} tests executed (>= ${EXPECTED}); command exit ${CMD_STATUS}"
exit "$CMD_STATUS"
