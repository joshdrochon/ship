#!/usr/bin/env bash
#
# Category 4 — paired before/after query-count measurement, both halves inside ONE lock
# window (Rule 1: "run under identical conditions").
#
#   docs/audit/scripts/run-cat4-paired.sh
#
# What it does, in order: take the measurement lock; check out $BASE_SHA's api/src so the
# app runs WITHOUT the throttle; start the servers on dedicated ports; run
# measure-queries.mjs and explain-cat4.sh; renew the lock; restore HEAD's api/src; restart;
# re-run both tools; release.
#
# Why one window rather than two runs: the lock exists because five lanes share this
# machine, and a before taken under one load and an after taken under another is not a
# pair. Restoring the code between halves rather than re-running later also guarantees the
# database is in the same state for both.
#
# Why the lock is renewed between halves: a correct paired run looks exactly like an
# abandoned lock to the 30-minute staleness breaker. `renew` rewrites acquired_at.
# (measure-lock.sh has no `renew` subcommand; writing acquired_at is what one would do.)
#
# Prerequisites: PostgreSQL logging as measure-queries.mjs requires, and ship_lane_4
# seeded AND augmented — `pnpm db:seed && node docs/audit/scripts/augment-seed.mjs`.
# `pnpm test` truncates that database, so reseed after any unit-test run.
#
# Output: $CAT4_OUT (default docs/audit/raw/).
set -uo pipefail
set -m   # own process group per background job, so we can kill the whole tree

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRATCH="${CAT4_OUT:-$ROOT/docs/audit/raw}"
BASE_SHA=c398a9c
API_PORT=3400
WEB_PORT=5473
LOCK=/tmp/ship-measure.lock

cd "$ROOT"

say() { echo "[cat4 $(date +%H:%M:%S)] $*"; }

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
    pnpm --parallel --recursive run dev ) > "/tmp/cat4-dev-$1.log" 2>&1 &
  for i in $(seq 1 120); do
    if curl -sf "http://localhost:$API_PORT/health" >/dev/null 2>&1 \
       && curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
      say "servers up after ${i}s"; sleep 3; return 0
    fi
    sleep 1
  done
  say "SERVERS DID NOT COME UP — see $SCRATCH//tmp/cat4-dev-$1.log"
  return 1
}

restore_code() { git -C "$ROOT" checkout HEAD -- api/src; }

cleanup() {
  say "cleanup"
  stop_servers
  restore_code
  "$ROOT/scripts/measure-lock.sh" release lane-4 || true
}

say "acquiring lock (blocks until free)"
"$ROOT/scripts/measure-lock.sh" acquire lane-4 3600 || { say "LOCK ACQUIRE FAILED"; exit 1; }
trap cleanup EXIT INT TERM
say "lock held"

renew() { date +%s > "$LOCK/acquired_at"; say "lock renewed"; }

# ---------------------------------------------------------------- BEFORE
say "checking out pre-throttle auth.ts from $BASE_SHA"
git -C "$ROOT" checkout "$BASE_SHA" -- api/src
grep -q touchSessionActivity api/src/middleware/auth.ts && { say "BEFORE CHECKOUT FAILED"; exit 1; }

start_servers before || exit 1
say "measuring BEFORE"
PG_DB=ship_lane_4 BASE="http://localhost:$WEB_PORT" \
  node docs/audit/scripts/measure-queries.mjs --out "$SCRATCH/cat4-lane4-before.json" 2>&1 | tail -5
PG_DB=ship_lane_4 docs/audit/scripts/explain-cat4.sh > "$SCRATCH/cat4-explain-before.txt" 2>&1
say "BEFORE done"
node -e "const j=require('$SCRATCH/cat4-lane4-before.json');for(const[k,v]of Object.entries(j.flows))console.log(' ',k,v.total_queries)"

stop_servers
renew

# ---------------------------------------------------------------- AFTER
say "restoring throttled auth.ts"
restore_code
grep -q touchSessionActivity api/src/middleware/auth.ts || { say "RESTORE FAILED"; exit 1; }

start_servers after || exit 1
say "measuring AFTER"
PG_DB=ship_lane_4 BASE="http://localhost:$WEB_PORT" \
  node docs/audit/scripts/measure-queries.mjs --out "$SCRATCH/cat4-lane4-after.json" 2>&1 | tail -5
PG_DB=ship_lane_4 docs/audit/scripts/explain-cat4.sh > "$SCRATCH/cat4-explain-after.txt" 2>&1
say "AFTER done"
node -e "const j=require('$SCRATCH/cat4-lane4-after.json');for(const[k,v]of Object.entries(j.flows))console.log(' ',k,v.total_queries)"

say "COMPLETE"
