#!/bin/bash
# ---------------------------------------------------------------------------
# PF-622 — provider-pin audit.
#
# PRD p.5: "no unpinned versions permitted."
#
# Asserts two things across every Terraform root and module under terraform/:
#
#   1. Every 'required_providers' entry pins an EXACT version. A '~>', a '>=',
#      or a missing 'version' all fail. The failure this prevents is not
#      hypothetical -- audit finding W8-4 records two roots resolving DIFFERENT
#      random-provider versions from identical configuration in the same
#      session, because '~> 3.6' is a range and ranges move.
#
#   2. Every root that can 'init' has a TRACKED .terraform.lock.hcl. A pin in
#      required_providers constrains the version; the lock file constrains the
#      *checksums*, and only a committed lock file makes 'terraform apply'
#      reproducible on a clean machine.
#
# Scope note, because getting this wrong makes the audit lie in both directions:
# the version check reads ONLY inside required_providers blocks. A naive grep for
# 'version =' also matches resource attributes -- terraform/render/main.tf has
# 'version = var.postgres_version' on a database resource -- and reporting a
# Postgres major version as an unpinned provider is a false positive that trains
# people to ignore the check.
#
# Exits non-zero on any violation so CI can gate on it (PF-624).
#
# Usage: scripts/check-tf-pins.sh [output-file]
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_ROOT="$REPO_ROOT/terraform"
OUT="${1:-}"
FAILURES=0

emit() { if [ -n "$OUT" ]; then printf '%s\n' "$1" | tee -a "$OUT"; else printf '%s\n' "$1"; fi; }

if [ -n "$OUT" ]; then mkdir -p "$(dirname "$OUT")"; : > "$OUT"; fi

emit "PF-622 - Terraform provider-pin audit"
emit "Run date : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
emit "Scope    : terraform/** (root, bootstrap, environments/*, modules/*, render, local-config)"
emit "Rule     : PRD p.5 - no unpinned versions permitted"
emit ""
emit "=================== 1. required_providers version pins ==================="
emit ""

TF_FILES=$(find "$TF_ROOT" -name '*.tf' -not -path '*/.terraform/*' | sort)

# Walk each required_providers block and emit one line per provider entry:
#   <file>|<lineno>|<provider>|<version-or-NONE>
ENTRIES=$(awk '
  FNR==1 { inrp=0; depth=0; inprov=0 }
  {
    line=$0
    if (!inrp && line ~ /required_providers[[:space:]]*{/) { inrp=1; depth=1; next }
    if (inrp) {
      if (!inprov && line ~ /^[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*=[[:space:]]*{/) {
        inprov=1
        name=line; sub(/^[[:space:]]*/,"",name); sub(/[[:space:]]*=.*$/,"",name)
        pstart=FNR; pver="NONE"
        next
      }
      if (inprov) {
        if (line ~ /version[[:space:]]*=/) {
          v=line; sub(/^.*version[[:space:]]*=[[:space:]]*"/,"",v); sub(/".*$/,"",v)
          pver=v; pverline=FNR
        }
        if (line ~ /}/) {
          printf "%s|%s|%s|%s\n", FILENAME, (pver=="NONE"?pstart:pverline), name, pver
          inprov=0
        }
        next
      }
      if (line ~ /}/) { inrp=0 }
    }
  }
' $TF_FILES)

if [ -z "$ENTRIES" ]; then
  emit "  FAIL - no required_providers entries found at all; the audit is checking nothing."
  FAILURES=$((FAILURES + 1))
fi

while IFS='|' read -r file lineno provider version; do
  [ -z "$file" ] && continue
  rel="${file#"$REPO_ROOT/"}"
  if [ "$version" = "NONE" ]; then
    emit "  FAIL  $rel:$lineno  $provider  - no version attribute"
    FAILURES=$((FAILURES + 1))
  elif printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    emit "  ok    $rel:$lineno  $provider  $version"
  else
    emit "  FAIL  $rel:$lineno  $provider  \"$version\"  - not an exact version pin"
    FAILURES=$((FAILURES + 1))
  fi
done <<< "$ENTRIES"

emit ""
emit "=================== 2. tracked .terraform.lock.hcl per root ==================="
emit ""
emit "A root is a directory where you would actually run 'init'. Modules are NOT"
emit "roots: they are consumed by a root and are never locked themselves."
emit ""

ROOTS=(
  "terraform"
  "terraform/bootstrap"
  "terraform/environments/dev"
  "terraform/environments/prod"
  "terraform/environments/shadow"
  "terraform/render"
  "terraform/local-config"
)

for r in "${ROOTS[@]}"; do
  lock="$REPO_ROOT/$r/.terraform.lock.hcl"
  present="no"
  [ -f "$lock" ] && present="yes"
  if git -C "$REPO_ROOT" ls-files --error-unmatch "$r/.terraform.lock.hcl" >/dev/null 2>&1; then
    emit "  ok    $r/.terraform.lock.hcl  (present=$present, tracked=yes)"
  else
    emit "  FAIL  $r/.terraform.lock.hcl  (present=$present, tracked=NO)"
    FAILURES=$((FAILURES + 1))
  fi
done

emit ""
emit "=================== verdict ==================="
if [ "$FAILURES" -eq 0 ]; then
  emit "PASS - every provider is pinned to an exact version and every root has a tracked lock file."
  exit 0
fi
emit "FAIL - $FAILURES violation(s). PRD p.5 permits no unpinned versions."
exit 1
