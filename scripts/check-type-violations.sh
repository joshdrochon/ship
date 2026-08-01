#!/usr/bin/env bash
#
# Fail when the type-safety violation count rises above a committed ceiling.
#
# The failure this catches, which has already happened once in this repository:
# Category 1's target is a whole-repo aggregate (-25% of the 1009-violation baseline,
# so a ceiling of 756). Lane 1 measured 744 in isolation and 753 after the first
# integration. Merging Category 4 then took the integrated tree to 758 -- over the
# ceiling, target missed -- because that lane's new test mocks added 17 `as any`.
#
# The lane that broke it had no idea it was spending another lane's budget, and nothing
# reported the problem: `pnpm type-check`, `pnpm lint`, `pnpm build` and 553 unit tests
# were all green at 758. The regression was found by re-measuring by hand.
#
# That is the shape of an unowned target: any change can break it, only the integrated
# number counts, and no gate observes it. docs/improvements.md section 1 named it --
# "a thin margin on such a target is not a near-miss, it is an unowned liability" --
# and then nothing was built to own it. This is that thing.
#
# The ceiling RATCHETS. When the count drops, commit the new lower number, and it can
# never silently drift back up. Raising it is a deliberate, reviewable edit to a tracked
# file rather than an invisible side effect of a merge.
#
# Usage:
#   scripts/check-type-violations.sh            # check against the committed ceiling
#   scripts/check-type-violations.sh --update   # lower the ceiling to the current count
#
# Exit codes:
#   0  count is at or below the ceiling
#   1  count exceeds the ceiling
#   2  the run was void -- counter missing, unreadable, or produced no number.
#      Distinct from 1 so "we could not measure" can never be read as "we measured
#      and it was fine". Same reasoning as scripts/assert-tests-ran.sh.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COUNTER="$REPO/docs/audit/scripts/count-type-violations.py"
CEILING_FILE="$REPO/docs/audit/type-violations-ceiling.txt"

die_void() { echo "check-type-violations: $1" >&2; exit 2; }

[ -f "$COUNTER" ]      || die_void "counter not found at docs/audit/scripts/count-type-violations.py"
[ -f "$CEILING_FILE" ] || die_void "ceiling file not found at docs/audit/type-violations-ceiling.txt"

ceiling="$(grep -vE '^\s*#|^\s*$' "$CEILING_FILE" | head -1 | tr -dc '0-9')"
[ -n "$ceiling" ] || die_void "ceiling file contains no number"

output="$(python3 "$COUNTER" 2>&1)" || die_void "counter exited non-zero:
$output"

# The counter prints a fixed-width table; TOTAL is the second-to-last column of the
# final row. Parsed rather than recomputed so the gate and the audit can never disagree
# about what a violation is.
count="$(printf '%s\n' "$output" | awk '/^TOTAL/ { print $(NF-1) }')"

case "$count" in
  ''|*[!0-9]*) die_void "could not parse a total from the counter output:
$output" ;;
esac

if [ "${1:-}" = "--update" ]; then
  if [ "$count" -gt "$ceiling" ]; then
    echo "refusing to raise the ceiling: $ceiling -> $count" >&2
    echo "--update only lowers it. Raising is a deliberate edit to $CEILING_FILE." >&2
    exit 1
  fi
  printf '%s\n' "$count" > "$CEILING_FILE.num"
  # Preserve the explanatory header, replace only the number.
  {
    grep -E '^\s*#' "$CEILING_FILE"
    cat "$CEILING_FILE.num"
  } > "$CEILING_FILE.tmp"
  mv "$CEILING_FILE.tmp" "$CEILING_FILE"
  rm -f "$CEILING_FILE.num"
  echo "ceiling lowered: $ceiling -> $count"
  exit 0
fi

printf '%s\n' "$output"
echo

if [ "$count" -gt "$ceiling" ]; then
  cat >&2 <<EOF
FAIL  type-safety violations: $count, ceiling $ceiling (+$((count - ceiling)))

Category 1's target is a whole-repo aggregate, so this can be broken by a change that
has nothing to do with type safety -- most often \`as any\` in new test mocks. See
api/src/test/queryResult.ts for the typed pg helper that removes that need.

Find what moved:
  python3 docs/audit/scripts/count-type-violations.py --by-file -n 20

If the increase is genuinely justified, raise the number in
docs/audit/type-violations-ceiling.txt in the same commit, with the reason in the
message. Do not raise it to make a pipeline green.
EOF
  exit 1
fi

if [ "$count" -lt "$ceiling" ]; then
  echo "PASS  type-safety violations: $count, ceiling $ceiling ($((ceiling - count)) of headroom)"
  echo "      The ceiling ratchets — lower it with: scripts/check-type-violations.sh --update"
else
  echo "PASS  type-safety violations: $count, exactly at the ceiling"
fi
