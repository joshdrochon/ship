#!/usr/bin/env bash
#
# Safe E2E runner. F162.
#
# `.claude/CLAUDE.md` mandates `/e2e-test-runner` and that skill DOES NOT EXIST.
# The instruction it carried is real and load-bearing: `pnpm test:e2e` streams
# hundreds of tests to stdout and the volume crashes an agent session. So the
# rule stayed enforceable only by memory, which is how it eventually gets broken.
# This script is the thing the instruction should have pointed at.
#
# It runs Playwright DETACHED with all output to a log file, and prints the
# counters from test-results/summary.json instead. Nothing streams.
#
# Usage:
#   scripts/e2e-run.sh                  # full suite
#   scripts/e2e-run.sh --last-failed    # only what failed last time
#   scripts/e2e-run.sh e2e/auth.spec.ts # one spec
#   scripts/e2e-run.sh --status         # poll a run already going
#   scripts/e2e-run.sh --failures       # list failing specs + their error logs
#
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RESULTS=test-results
# The log and pidfile live OUTSIDE test-results/ because Playwright clears that
# directory at the start of a run — the first version put them inside it and the
# log was gone by the time anyone looked, which is the opposite of the point.
RUNDIR=.e2e-run
LOG="$RUNDIR/e2e-run.log"
PIDFILE="$RUNDIR/e2e-run.pid"

status() {
  if [ ! -f "$RESULTS/summary.json" ]; then
    echo "no summary yet — the run may still be starting"
    return
  fi
  python3 - "$RESULTS/summary.json" <<'PY'
import json, sys, time
s = json.load(open(sys.argv[1]))
done = s.get('passed',0) + s.get('failed',0) + s.get('skipped',0)
tot  = s.get('total',0)
age  = int(time.time() - s.get('ts',0)/1000) if s.get('ts') else -1
print(f"  {done}/{tot} done   passed {s.get('passed',0)}   "
      f"failed {s.get('failed',0)}   skipped {s.get('skipped',0)}"
      + (f"   (summary {age}s old)" if age >= 0 else ""))
PY
}

failures() {
  echo "failing specs:"
  if [ -d "$RESULTS/errors" ]; then
    ls -1 "$RESULTS/errors" 2>/dev/null | sed 's/^/  /' || echo "  none"
  else
    echo "  no error logs"
  fi
}

case "${1:-}" in
  --status)   status; exit 0 ;;
  --failures) failures; exit 0 ;;
esac

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "a run is already going (pid $(cat "$PIDFILE")). --status to poll it."
  exit 1
fi

mkdir -p "$RUNDIR"
rm -rf "$RESULTS/errors"

# Detached, with all output to a file — the volume is what breaks agent sessions.
#
# `setsid` is coreutils and is NOT on macOS, where this repo is developed; the
# first version used it and died with "setsid: command not found" AFTER
# reporting a pid, so the caller polled a run that had never started. `nohup`
# does the same job (immune to SIGHUP, detached from the terminal) and is on
# both platforms.
nohup pnpm exec playwright test "$@" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

echo "started (pid $(cat "$PIDFILE")), log: $LOG"
echo "poll with: scripts/e2e-run.sh --status"
