#!/usr/bin/env bash
#
# Category 6 — paired before/after measurement for all three error-handling gaps
# (W6-9, W6-1, W6-5), both halves inside ONE lock window (Rule 1: "run under identical
# conditions").
#
#   docs/audit/scripts/run-cat6-paired.sh
#
# WHAT THIS DOES, PLAINLY: it regenerates BOTH sides of every Category 6 number, from a
# clean checkout, with no manual steps. Before this existed the Cat 6 scripts only ever
# produced the after-side — each of them measures whatever code is currently checked
# out — so the "before" columns in CHANGES/lane-6.md could not be re-derived by anyone
# who had not been present when they were first taken. That is the gap this closes. It
# is the Category 6 equivalent of run-cat4-paired.sh, and follows it step for step.
#
# In order: take the measurement lock; check out $BASE_SHA's api/src and web/src so the
# app runs WITHOUT any of the three fixes; start the servers on dedicated ports; run the
# three measurement scripts and the two capture scripts; renew the lock; restore HEAD's
# api/src and web/src; restart; re-run all five with identical arguments; release.
#
# $BASE_SHA is 2fbc5a4 — the commit the lane-6 work branched from, i.e. the parent of
# fe41fa1 (W6-9), which is itself the parent of 6f45133 (W6-1) and 8e7af24 (W6-5). One
# base for all three gaps is what makes them a single pair rather than three.
#
# Why one lock window rather than two runs: five lanes share this machine, and a before
# taken under one load and an after taken under another is not a pair. Restoring the
# code between halves rather than re-running later also guarantees the database is in
# the same state for both.
#
# Why `git checkout <sha> -- api/src web/src` and not a worktree: the two halves must
# use the same database, the same seed, the same ports and the same node_modules. It
# does not delete files added after $BASE_SHA (RouteErrorBoundary.tsx, syncStatus.ts,
# useCollaborativeTitle.ts, documentTitle.ts survive on disk), which is harmless —
# nothing in the restored before-code imports them, so they are dead files for the
# duration. The guards below check the IMPORT SITES rather than file existence for
# exactly that reason.
#
# Prerequisites:
#   - PostgreSQL running, and the dev database seeded: `pnpm db:seed`. The two-user
#     tests need alice.chen@ship.local, which only the full seed creates.
#     `pnpm test` TRUNCATES that database (api/src/test/setup.ts), so reseed after any
#     unit-test run.
#   - A clean working tree for api/src and web/src. This script overwrites both and
#     restores them from HEAD; uncommitted work in either would be destroyed.
#
# Output:
#   docs/audit/raw/cat6-w6-9-{before,after}.json          (W6-9 aggregate, RUNS runs)
#   docs/audit/evidence/w6-9/                             (W6-9 screenshots)
#   docs/audit/evidence/w6-5/w6-5-{before,after}.json     (W6-5, three phases)
#   docs/audit/evidence/w6-1/w6-1-{before,after}.json     (W6-1, six routes)
#
# Overridable: RUNS, API_PORT, WEB_PORT, PG_DB, DOC_ID, CAT6_RAW, CAT6_EVIDENCE.
set -uo pipefail
set -m   # own process group per background job, so we can kill the whole tree

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RAW="${CAT6_RAW:-$ROOT/docs/audit/raw}"
EVIDENCE="${CAT6_EVIDENCE:-$ROOT/docs/audit/evidence}"
BASE_SHA="${BASE_SHA:-2fbc5a4}"
RUNS="${RUNS:-5}"
API_PORT="${API_PORT:-3600}"
WEB_PORT="${WEB_PORT:-5673}"
LOCK=/tmp/ship-measure.lock

cd "$ROOT"
mkdir -p "$RAW" "$EVIDENCE/w6-9" "$EVIDENCE/w6-5" "$EVIDENCE/w6-1"

say() { echo "[cat6 $(date +%H:%M:%S)] $*"; }
die() { say "$*"; exit 1; }

# --- database ----------------------------------------------------------------
# The measurement scripts address one wiki document by id. Resolve it the way
# CHANGES/lane-6.md documents, rather than making the operator paste a uuid.
if [ -z "${PG_DB:-}" ]; then
  if [ -f "$ROOT/api/.env.local" ]; then
    PG_DB="$(grep -m1 '^DATABASE_URL=' "$ROOT/api/.env.local" | sed 's|.*/||')"
  fi
fi
[ -n "${PG_DB:-}" ] || die "PG_DB not set and api/.env.local has no DATABASE_URL — run pnpm dev once first"

if [ -z "${DOC_ID:-}" ]; then
  DOC_ID="$(psql -tAq -d "$PG_DB" -c \
    "select id from documents where document_type = 'wiki' and title = 'Project Overview' limit 1" 2>/dev/null)"
fi
[ -n "${DOC_ID:-}" ] || die "no 'Project Overview' wiki document in $PG_DB — run: pnpm db:seed"
say "database=$PG_DB doc=$DOC_ID base=$BASE_SHA runs=$RUNS"

# --- servers -----------------------------------------------------------------
stop_servers() {
  for p in "$API_PORT" "$WEB_PORT"; do
    pids=$(lsof -ti:"$p" 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  done
  sleep 3
}

start_servers() {
  stop_servers
  say "starting servers on api=$API_PORT web=$WEB_PORT"
  ( cd "$ROOT" && \
    PORT=$API_PORT API_PORT=$API_PORT VITE_PORT=$WEB_PORT \
    CORS_ORIGIN="http://localhost:$WEB_PORT" \
    pnpm --parallel --recursive run dev ) > "/tmp/cat6-dev-$1.log" 2>&1 &
  for i in $(seq 1 120); do
    if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
       && curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
      say "servers up after ${i}s"; sleep 3; return 0
    fi
    sleep 1
  done
  say "SERVERS DID NOT COME UP — see /tmp/cat6-dev-$1.log"
  return 1
}

# vite dev serves web/src straight from disk, so restoring the source is enough —
# there is no build step between a checkout and what the browser gets.
restore_code() { git -C "$ROOT" checkout HEAD -- api/src web/src; }

# The W6-1 capture injects a throw into six page files and keeps a .w6-1-bak beside
# each. It must always be reverted, including on a crash, or the injected state is left
# in the working tree.
revert_injection() { node "$ROOT/docs/audit/scripts/inject-render-error.mjs" --revert >/dev/null 2>&1 || true; }

cleanup() {
  say "cleanup"
  stop_servers
  revert_injection
  restore_code
  "$ROOT/scripts/measure-lock.sh" release lane-6 || true
}

# --- guards ------------------------------------------------------------------
# Assert the tree really is in the half we think it is, before spending 20 minutes
# measuring the wrong code. Each marker is the import site of one fix.
assert_before() {
  grep -q useCollaborativeTitle web/src/components/Editor.tsx && die "BEFORE CHECKOUT FAILED (W6-9 still present in Editor.tsx)"
  grep -q applyTitleToRoom api/src/collaboration/index.ts    && die "BEFORE CHECKOUT FAILED (W6-9 still present in collaboration/index.ts)"
  grep -q RouteErrorBoundary web/src/main.tsx                && die "BEFORE CHECKOUT FAILED (W6-1 still present in main.tsx)"
  grep -q "lib/syncStatus" web/src/components/Editor.tsx     && die "BEFORE CHECKOUT FAILED (W6-5 still present in Editor.tsx)"
  return 0
}

assert_after() {
  grep -q useCollaborativeTitle web/src/components/Editor.tsx || die "RESTORE FAILED (W6-9 missing from Editor.tsx)"
  grep -q applyTitleToRoom api/src/collaboration/index.ts     || die "RESTORE FAILED (W6-9 missing from collaboration/index.ts)"
  grep -q RouteErrorBoundary web/src/main.tsx                 || die "RESTORE FAILED (W6-1 missing from main.tsx)"
  grep -q "lib/syncStatus" web/src/components/Editor.tsx      || die "RESTORE FAILED (W6-5 missing from Editor.tsx)"
  return 0
}

# --- one half ----------------------------------------------------------------
# Identical arguments on both halves. Any difference here invalidates the pair.
measure_half() {
  local label="$1"
  export BASE="http://localhost:$WEB_PORT"
  export API="http://localhost:$API_PORT"
  export DOC_ID RUNS

  say "[$label] W6-9 — concurrent title edit, $RUNS runs"
  node docs/audit/scripts/measure-concurrent-edit-suite.mjs \
    --out "$RAW/cat6-w6-9-$label.json" --label "$label" 2>&1 | tail -5

  say "[$label] W6-9 — screenshots"
  node docs/audit/scripts/capture-w6-9.mjs \
    --label "$label" --outdir "$EVIDENCE/w6-9" 2>&1 | tail -3

  say "[$label] W6-5 — reconnect / severed socket"
  node docs/audit/scripts/measure-reconnect-ui.mjs \
    --label "$label" --outdir "$EVIDENCE/w6-5" 2>&1 | tail -5

  # W6-1 needs the injected throw. Apply, capture, revert — in that order, so the
  # injection never outlives this block. The backups are taken from whichever half's
  # source is on disk, so --revert restores that half, not HEAD.
  say "[$label] W6-1 — injecting render error"
  node docs/audit/scripts/inject-render-error.mjs --apply 2>&1 | tail -3 || die "[$label] injection failed"
  say "[$label] W6-1 — six unprotected routes"
  node docs/audit/scripts/capture-w6-1.mjs \
    --label "$label" --outdir "$EVIDENCE/w6-1" 2>&1 | tail -5
  revert_injection
  say "[$label] W6-1 — injection reverted"

  say "[$label] summary"
  node -e "
    const j = require('$RAW/cat6-w6-9-$label.json');
    const s = j.summary ?? j;
    console.log('  W6-9', JSON.stringify(s));
  " 2>/dev/null || say "  (W6-9 aggregate written to $RAW/cat6-w6-9-$label.json)"
}

# --- run ---------------------------------------------------------------------
say "acquiring lock (blocks until free)"
"$ROOT/scripts/measure-lock.sh" acquire lane-6 5400 || die "LOCK ACQUIRE FAILED"
trap cleanup EXIT INT TERM
say "lock held"

renew() { "$ROOT/scripts/measure-lock.sh" renew lane-6 2>/dev/null || date +%s > "$LOCK/acquired_at"; say "lock renewed"; }

# ---------------------------------------------------------------- BEFORE
say "checking out pre-fix api/src and web/src from $BASE_SHA"
git -C "$ROOT" checkout "$BASE_SHA" -- api/src web/src || die "checkout of $BASE_SHA failed"
assert_before
say "before-code in place"

start_servers before || exit 1
measure_half before
stop_servers
renew

# ---------------------------------------------------------------- AFTER
say "restoring HEAD api/src and web/src"
restore_code
assert_after
say "after-code in place"

start_servers after || exit 1
measure_half after
stop_servers

say "git status (api/src and web/src must be clean)"
git -C "$ROOT" status --short api/src web/src

say "COMPLETE — raw in $RAW, evidence in $EVIDENCE"
