#!/usr/bin/env bash
#
# Every live URL a reader is invited to click must actually answer.
#
# ── The bug this exists to catch ─────────────────────────────────────────────
# `SUBMISSION.md` opened with **Live application:** https://shipshape-70uo…,
# and named the same host again in its deliverables table. That service was
# deleted during the lane-8 teardown — "Both hand-made resources deleted
# (HTTP 204 each)" — and replaced by the Terraform-created `shipshape-7buc`.
# Both lines survived the move. For the whole window between the teardown and
# this script, the first link in the submission returned 404.
#
# Nothing else could have caught it. `check-api-coverage.sh` reads route files,
# `check-tf-secrets.sh` reads Terraform, CI compiles and type-checks. None of
# them resolve a URL, and the requirements hook skips Markdown by design. The
# only way to know a documented link is dead is to ask it.
#
# ── What it checks ───────────────────────────────────────────────────────────
# Every `shipshape-*.onrender.com` and `smith.langchain.com/public/…` URL in
# tracked Markdown must return HTTP 200.
#
# Two distinctions the script is careful about:
#
#   A 404 fails; a timeout does not. A 404 is the server answering that the
#   thing is gone, which is the defect. A connection timeout is the network
#   having a bad day, and a doc check that goes red on someone's flaky wifi
#   gets disabled within a week. Unreachable hosts warn and are counted, so a
#   run where everything timed out cannot be mistaken for a clean one.
#
#   The allowlist is scoped by file, not by URL. `docs/audit/` and `CHANGES/`
#   legitimately quote the dead `70uo` host — they are the record of the
#   teardown that killed it, and rewriting them would be falsifying history.
#   Scoping each exemption to its file means the same dead URL reappearing in
#   `SUBMISSION.md` still fails, which is the regression actually worth
#   preventing. A blanket URL allowlist would have permitted the original bug.
#
#   ./scripts/check-doc-links.sh            # exits 1 on the first dead link
#   ./scripts/check-doc-links.sh --list     # print what would be checked
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$ROOT/scripts/doc-links-allowlist.txt"
PATTERN='https://(shipshape-[a-z0-9]+\.onrender\.com|smith\.langchain\.com/public/[a-f0-9-]+/r)'
LIST_ONLY=${1:-}

# `path::url` per line, so an exemption cannot leak to another file.
allowed() {
  [ -f "$ALLOWLIST" ] || return 1
  grep -qxF "$1::$2" "$ALLOWLIST"
}

# Collected as `path::url` pairs, deduped — the same URL in one file is one check.
pairs=$(
  git ls-files '*.md' | while read -r f; do
    # `|| true` because a file with no links exits 1 from grep, and under
    # `set -e` that killed the whole command substitution silently.
    grep -ohE "$PATTERN" "$f" 2>/dev/null | sed "s|^|$f::|" || true
  done | sort -u
)

if [ -z "$pairs" ]; then
  echo "check-doc-links: no live URLs found in tracked Markdown — pattern is probably wrong" >&2
  exit 1
fi

if [ "$LIST_ONLY" = "--list" ]; then
  echo "$pairs"
  exit 0
fi

dead=0
skipped=0
unreachable=0
checked=0

while IFS= read -r pair; do
  file=${pair%%::*}
  url=${pair#*::}

  if allowed "$file" "$url"; then
    printf '  skip  %-58s %s (allowlisted)\n' "$url" "$file"
    skipped=$((skipped + 1))
    continue
  fi

  # --max-time bounds the whole request. `curl` writes 000 when it never got
  # an HTTP response at all, which is the timeout case, not the dead case.
  code=$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo 000)
  checked=$((checked + 1))

  case "$code" in
    200)
      printf '  ok    %-58s %s\n' "$url" "$file"
      ;;
    000)
      printf '  WARN  %-58s %s (unreachable — not counted as dead)\n' "$url" "$file" >&2
      unreachable=$((unreachable + 1))
      ;;
    *)
      printf '  DEAD  %-58s %s (HTTP %s)\n' "$url" "$file" "$code" >&2
      dead=$((dead + 1))
      ;;
  esac
done <<< "$pairs"

echo
echo "check-doc-links: $checked checked · $dead dead · $unreachable unreachable · $skipped allowlisted"

if [ "$dead" -gt 0 ]; then
  echo >&2
  echo "A documented link returns an error. Either the resource moved — in which case" >&2
  echo "update every reference to it — or the reference is history, in which case add" >&2
  echo "the exact 'path::url' line to scripts/doc-links-allowlist.txt with a reason." >&2
  exit 1
fi

exit 0
