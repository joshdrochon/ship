#!/bin/bash
# ---------------------------------------------------------------------------
# PF-628 / PF-629 / PF-648 — verify MVP gate item 10 against the DEPLOYED
# instance.
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
# ── PF-648: three assertions that were verified BY HAND and never encoded ──
#
# PF-648 was found at audit -- the deployed build was stale, so gate item 10
# passed over a spec advertising zero paths. Its acceptance was not "measure it
# again", it was *"a check that runs against the live URL"* asserting three
# specific things. Those three were then verified by hand on 2026-08-13 and the
# ticket was closed, which left the check itself unwritten: a one-off curl
# session proves the state of one afternoon and cannot be re-run by a grader or
# by CI. Encoded here, as checks 2b, 3 and 1c:
#
#   2b  the DEPLOYED spec's `paths` SET equals the COMMITTED docs/openapi.json's
#       -- set equality, not a count. Counts matching while the members differ
#       is precisely the stale-build shape this ticket exists to catch.
#   3   POST /oauth/token answers an OAuth PROTOCOL error (RFC 6749 §5.2: a 4xx
#       carrying an `error` field) rather than 404. 404 means the route is not
#       mounted, which is what a build predating L04 looks like.
#   1c  /health reports a real commit SHA. `revision: "unknown"` is the
#       Dockerfile's honest fallback for a build that came through no CI
#       (api/src/app.ts:84) -- so it is a TRUE answer to a question gate item 10
#       needs a different answer to. Unknown fails this check even when no
#       expected SHA is pinned, because nothing else in the repo anchors a
#       deployment claim to a commit.
#
# Usage: scripts/verify-deployment.sh <base-url> [expected-sha] [output-file]
# ---------------------------------------------------------------------------
set -uo pipefail

BASE="${1:-http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com}"
EXPECTED_SHA="${2:-}"
OUT="${3:-}"
FAILURES=0

# The committed spec, resolved relative to this script rather than to $PWD, so
# the check means the same thing from CI, from a worktree, and from a clone.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMITTED_SPEC="${COMMITTED_SPEC:-$REPO_ROOT/docs/openapi.json}"

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

  # --- 1c. PF-648 — /health must report a real commit SHA -------------------
  # Unconditional. The old check only ran when a SHA was passed in, so the
  # common case -- nobody pins one -- silently asserted nothing at all, and
  # `revision: "unknown"` sailed through as "ok, valid JSON".
  REVISION=$(printf '%s' "$HBODY" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("revision",""))' 2>/dev/null)
  emit "  revision: ${REVISION:-<field absent>}"
  if [ -z "$REVISION" ]; then
    emit "  FAIL — /health carries no 'revision' field; nothing anchors this deployment to a commit"
    FAILURES=$((FAILURES + 1))
  elif [ "$REVISION" = "unknown" ]; then
    emit "  FAIL — revision is 'unknown'. The image was built with no --build-arg GIT_SHA,"
    emit "         so this deployment cannot be tied to a commit. See docs/artifact-lifecycle.md."
    FAILURES=$((FAILURES + 1))
  elif [ -n "$EXPECTED_SHA" ]; then
    # Prefix match: CI passes a full 40-char SHA, humans pass a short one.
    case "$EXPECTED_SHA" in
      "$REVISION"*) emit "  ok — reports the deployed commit $REVISION" ;;
      *)
        case "$REVISION" in
          "$EXPECTED_SHA"*) emit "  ok — reports the deployed commit $REVISION" ;;
          *)
            emit "  FAIL — reports $REVISION, expected $EXPECTED_SHA"
            FAILURES=$((FAILURES + 1))
            ;;
        esac
        ;;
    esac
  else
    emit "  ok — reports commit $REVISION (no expected SHA pinned, so identity is not checked)"
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

    # --- 2b. PF-648 — deployed path SET == committed path SET --------------
    # This is the assertion PF-648 was opened over. The stale build answered
    # 200 with `paths: {}` and PF-629's "the spec resolves" went green over it,
    # which is why "resolves" was never the right test. Set equality both ways:
    # a path the deployment serves but the repo does not know about is drift in
    # the other direction and is just as much a lie about what was shipped.
    emit "--- 2b. deployed spec paths == committed docs/openapi.json paths ---"
    if [ ! -f "$COMMITTED_SPEC" ]; then
      emit "  FAIL — committed spec not found at $COMMITTED_SPEC; cannot compare"
      FAILURES=$((FAILURES + 1))
    else
      DIFF=$(printf '%s' "$SBODY" | COMMITTED_SPEC="$COMMITTED_SPEC" python3 -c '
import json, os, sys
live = set((json.load(sys.stdin).get("paths") or {}).keys())
with open(os.environ["COMMITTED_SPEC"]) as fh:
    committed = set((json.load(fh).get("paths") or {}).keys())
if not live:
    print("EMPTY the deployed spec advertises ZERO paths")
elif live == committed:
    print("EQUAL %d path(s), sets identical" % len(live))
else:
    print("DIFFER live=%d committed=%d" % (len(live), len(committed)))
    for p in sorted(committed - live):
        print("  missing from deployment: %s" % p)
    for p in sorted(live - committed):
        print("  served but not committed: %s" % p)
' 2>&1)
      case "$DIFF" in
        EQUAL*)
          emit "  ok — $DIFF"
          ;;
        *)
          emit "  FAIL — $DIFF"
          FAILURES=$((FAILURES + 1))
          ;;
      esac
    fi
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

# --- 4. PF-648 — the OAuth token endpoint is MOUNTED -----------------------
# The stale build answered 404 here, so a grader could reach the deployment and
# exercise no flow at all. The pass condition is a PROTOCOL error, not a
# success: an empty POST has no grant_type and no credentials, so RFC 6749 §5.2
# says 400 with an `error` field -- `invalid_client` or `invalid_request`. A
# 404 means no route; a 200 would mean the endpoint mints tokens for an
# unauthenticated empty body, which would be a far worse finding than a stale
# build. Both fail.
emit "--- 4. POST /oauth/token (empty body — expect an OAuth protocol error, not 404) ---"
TCODE=$(curl -s -o /tmp/.t.$$ -w '%{http_code}' -m 25 -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  "$BASE/oauth/token" 2>/dev/null)
TBODY=$(cat /tmp/.t.$$ 2>/dev/null); rm -f /tmp/.t.$$
TERR=$(printf '%s' "$TBODY" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null)
emit "HTTP $TCODE"
emit "body: $(printf '%s' "$TBODY" | head -c 300)"

if [ "$TCODE" = "404" ]; then
  emit "  FAIL — 404. The token endpoint is not mounted; this build predates L04."
  FAILURES=$((FAILURES + 1))
elif [ "$TCODE" = "200" ]; then
  emit "  FAIL — 200 to an unauthenticated empty body. The endpoint is not rejecting anything."
  FAILURES=$((FAILURES + 1))
elif [ -z "$TERR" ]; then
  emit "  FAIL — HTTP $TCODE but no OAuth 'error' field (RFC 6749 §5.2); not a protocol error"
  FAILURES=$((FAILURES + 1))
else
  emit "  ok — protocol error '$TERR' at HTTP $TCODE; the token endpoint is mounted and rejecting"
fi
emit ""

emit "=================== verdict ==================="
if [ "$FAILURES" -eq 0 ]; then
  emit "PASS — deployed, publicly reachable, and the spec resolves as JSON."
  exit 0
fi
emit "FAIL — $FAILURES check(s) failed. MVP gate item 10 is NOT met."
exit 1
