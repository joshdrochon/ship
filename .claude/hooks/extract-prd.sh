#!/bin/bash
# Extract the current source-of-truth brief into per-page text the citation hook
# checks against, and record which document it came from.
#
#   .claude/hooks/extract-prd.sh ~/Downloads/GFA_Week_5_Whatever.pdf "Week 5"
#
# Re-run this whenever the brief changes. The hook re-hashes the recorded PDF on
# every check, so a stale extraction is reported rather than silently trusted.
set -euo pipefail

PDF="${1:-}"
LABEL="${2:-}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/prd"

if [ -z "$PDF" ]; then
  if [ -f "$OUT/source.json" ]; then
    PDF=$(python3 -c "import json;print(json.load(open('$OUT/source.json'))['path'])")
    echo "No PDF given; re-extracting current source: $PDF"
  else
    echo "Usage: $0 <path-to-brief.pdf> [label]" >&2
    exit 1
  fi
fi

[ -f "$PDF" ] || { echo "PDF not found: $PDF" >&2; exit 1; }
command -v pdftotext >/dev/null || { echo "pdftotext not installed (brew install poppler)" >&2; exit 1; }

PDF="$(cd "$(dirname "$PDF")" && pwd)/$(basename "$PDF")"
LABEL="${LABEL:-$(basename "$PDF" .pdf)}"

mkdir -p "$OUT"
rm -f "$OUT"/page-*.txt

PAGES=$(pdfinfo "$PDF" 2>/dev/null | awk '/^Pages:/{print $2}')
[ -n "$PAGES" ] || { echo "Could not read page count from $PDF" >&2; exit 1; }

for p in $(seq 1 "$PAGES"); do
  pdftotext -f "$p" -l "$p" -layout "$PDF" "$OUT/page-$p.txt"
done
pdftotext -layout "$PDF" "$OUT/full.txt"

SHA=$(shasum -a 256 "$PDF" | awk '{print $1}')
python3 - "$OUT/source.json" "$PDF" "$SHA" "$PAGES" "$LABEL" <<'PY'
import json, sys, datetime
out, path, sha, pages, label = sys.argv[1:6]
json.dump({
    "label": label,
    "path": path,
    "sha256": sha,
    "pages": int(pages),
    "extracted_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
}, open(out, "w"), indent=2)
open(out, "a").write("\n")
PY

echo "Source of truth: $LABEL"
echo "  $PDF"
echo "  sha256 $SHA"
echo "  $PAGES pages -> $OUT"
