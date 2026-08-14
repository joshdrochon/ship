#!/bin/bash
# ---------------------------------------------------------------------------
# PF-628 / PF-629 — verify MVP gate item 10 against the DEPLOYED instance.
#
# Written because the first "successful" deploy of this environment was not one.
# EB reported `Instance deployment completed successfully`, health read Green,
# and `curl /health` returned HTTP 200 -- from the Elastic Beanstalk Docker
# SAMPLE APPLICATION, which answers 200 with an HTML page on EVERY path,
# including /api/v1/openapi.json.
#
# So a status-code check is not a verification, it is a way to be confidently
# wrong. Every assertion here is on CONTENT:
#
#   /health                 must be JSON, and must report the SHA we deployed
#   /api/v1/openapi.json    must PARSE as JSON and carry an `openapi` version
#                           field -- an HTML page cannot fake that
#   an unknown /api/v1 path must return the ApiError envelope, which proves the
#                           public router is mounted rather than something else
#                           happening to answer
#
# Usage: scripts/verify-deployment.sh <base-url> [expected-sha] [output-file]
# ---------------------------------------------------------------------------
set -uo pipefail

BASE="${1:-http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com}"
EXPECTED_SHA="${2:-}"
OUT="${3:-}"
FAILURES=0

emit() { if [ -n "$OUT" ]; then printf '%s\n' "$1" | tee -a "$OUT"; else printf '%s\n' "$1"; fi; }

if [ -n "$OUT" ]; then mkdir -p "$(dirname "$OUT")"; : > "$OUT"; fi

emit "==============================================================================="
emit "MVP gate item 10 verification — deployed, publicly accessible, spec resolves"
emit "==============================================================================="
emit "Run date : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
emit "Base URL : $BASE"
emit "Expected : ${EXPECTED_SHA:-<not pinned>}"
emit ""

# --- 1. /health ------------------------------------------------------------
emit "--- 1. GET /health ---"
HCODE=$(curl -s -o /tmp/.h.$$ -w '%{http_code}' -m 25 "$BASE/health" 2>/dev/null)
HBODY=$(cat /tmp/.h.$$ 2>/dev/null); rm -f /tmp/.h.$$
emit "HTTP $HCODE"
emit "body: $(printf '%s' "$HBODY" | head -c 600)"

if [ "$HCODE" != "200" ]; then
  emit "  FAIL — expected 200"
  FAILURES=$((FAILURES + 1))
elif printf '%s' "$HBODY" | grep -qi '<!DOCTYPE html\|Elastic Beanstalk'; then
  emit "  FAIL — HTML, not JSON. This is the EB sample application, not Ship."
  FAILURES=$((FAILURES + 1))
elif ! printf '%s' "$HBODY" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  emit "  FAIL — body is not valid JSON"
  FAILURES=$((FAILURES + 1))
else
  emit "  ok — valid JSON"
  if [ -n "$EXPECTED_SHA" ]; then
    if printf '%s' "$HBODY" | grep -q "$EXPECTED_SHA"; then
      emit "  ok — reports the deployed commit $EXPECTED_SHA"
    else
      emit "  FAIL — does not report the deployed commit $EXPECTED_SHA"
      FAILURES=$((FAILURES + 1))
    fi
  fi
fi
emit ""

# --- 2. public OpenAPI spec ------------------------------------------------
emit "--- 2. GET /api/v1/openapi.json (no Authorization header) ---"
SCODE=$(curl -s -o /tmp/.s.$$ -w '%{http_code}' -m 25 "$BASE/api/v1/openapi.json" 2>/dev/null)
SBODY=$(cat /tmp/.s.$$ 2>/dev/null); rm -f /tmp/.s.$$
emit "HTTP $SCODE"
emit "first 400 bytes: $(printf '%s' "$SBODY" | head -c 400)"

if [ "$SCODE" != "200" ]; then
  emit "  FAIL — expected 200 without credentials (MVP gate item 10)"
  FAILURES=$((FAILURES + 1))
elif printf '%s' "$SBODY" | grep -qi '<!DOCTYPE html\|Elastic Beanstalk'; then
  emit "  FAIL — HTML, not a spec. EB sample application."
  FAILURES=$((FAILURES + 1))
else
  OPENAPI_VER=$(printf '%s' "$SBODY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("openapi",""))' 2>/dev/null)
  if [ -n "$OPENAPI_VER" ]; then
    emit "  ok — parses as JSON, openapi version = $OPENAPI_VER"
    PATHCOUNT=$(printf '%s' "$SBODY" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("paths",{}) or {}))' 2>/dev/null)
    emit "  note — documents $PATHCOUNT path(s)"
  else
    emit "  FAIL — parses but carries no 'openapi' field; not an OpenAPI document"
    FAILURES=$((FAILURES + 1))
  fi
fi
emit ""

# --- 3. the public router is really mounted --------------------------------
emit "--- 3. GET /api/v1/__does_not_exist (expect the ApiError envelope) ---"
NCODE=$(curl -s -o /tmp/.n.$$ -w '%{http_code}' -m 25 "$BASE/api/v1/__does_not_exist" 2>/dev/null)
NBODY=$(cat /tmp/.n.$$ 2>/dev/null); rm -f /tmp/.n.$$
emit "HTTP $NCODE"
emit "body: $(printf '%s' "$NBODY" | head -c 400)"
# The ApiError envelope is `{code, message, details?, request_id}` -- keyed on
# `code`, NOT on `error`. An earlier version of this check grepped for `"error"`
# and reported a WARN against a perfectly correct envelope, which is the same
# class of mistake as trusting a 200: a check that is wrong about what success
# looks like is worse than no check, because it teaches you to ignore it.
if printf '%s' "$NBODY" | grep -q '"code"' && printf '%s' "$NBODY" | grep -q '"request_id"'; then
  emit "  ok — ApiError envelope with a request_id; the public router is mounted"
else
  emit "  WARN — no ApiError envelope. Something other than the v1 router may be answering."
fi
emit ""

emit "=================== verdict ==================="
if [ "$FAILURES" -eq 0 ]; then
  emit "PASS — deployed, publicly reachable, and the spec resolves as JSON."
  exit 0
fi
emit "FAIL — $FAILURES check(s) failed. MVP gate item 10 is NOT met."
exit 1
