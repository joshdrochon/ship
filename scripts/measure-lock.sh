#!/usr/bin/env bash
#
# Exclusive measurement lock.
#
# Implementation Rule 1 (brief p.8) requires before/after measurement "run under
# identical conditions", and p.5 spells that out as "same data volume, same concurrency,
# same hardware". Several improvement lanes run concurrently on one machine, so a
# benchmark taken while five other agents are compiling is not measuring the change —
# it is measuring the load. Two runs taken under different load are not a valid pair no
# matter how carefully the command matches.
#
# This gives a lane a way to say "everyone hold still while I measure."
#
#   scripts/measure-lock.sh acquire <lane-name> [max-wait-seconds]
#   scripts/measure-lock.sh renew <lane-name>      # still working, reset the clock
#   scripts/measure-lock.sh release <lane-name>
#   scripts/measure-lock.sh status
#   scripts/measure-lock.sh wait-quiet [max-wait-seconds]
#
# Typical use inside a lane:
#
#   scripts/measure-lock.sh acquire lane-3 1800   # blocks until it is our turn
#   trap 'scripts/measure-lock.sh release lane-3' EXIT
#   docs/audit/scripts/bench-api.sh > after.json
#   scripts/measure-lock.sh release lane-3
#
# The trap matters. A lane that dies holding the lock would stall every other lane
# until the staleness timeout expires.
#
# Deliberately filesystem-based rather than a daemon: it has to work across git
# worktrees, across separate agent sessions, and survive any one of them dying. `mkdir`
# is atomic on every POSIX filesystem, which is the whole mechanism.

set -euo pipefail

# Shared across worktrees on purpose — the point is mutual exclusion between them.
LOCK_DIR="${SHIP_MEASURE_LOCK:-/tmp/ship-measure.lock}"
STALE_AFTER=1800          # 30 min: a lock older than this is presumed abandoned
QUIET_LOAD_PER_CORE=0.60  # 1-min load average per core below which we call it quiet
QUIET_MAX_WAIT=180

CORES=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

now() { date +%s; }

load1() {
  # macOS and Linux both expose this, formatted differently.
  uptime | sed -E 's/.*load averages?: *//' | awk '{gsub(",",""); print $1}'
}

lock_age() {
  [[ -f "$LOCK_DIR/acquired_at" ]] || { echo 0; return; }
  echo $(( $(now) - $(cat "$LOCK_DIR/acquired_at" 2>/dev/null || now) ))
}

holder() { cat "$LOCK_DIR/holder" 2>/dev/null || echo "unknown"; }

# Age is the ONLY automatic breaker.
#
# Process liveness is deliberately not used. Each agent tool call runs in its own
# shell, so `acquire` and `release` are always different processes — the pid recorded
# at acquire time is dead within milliseconds, by design. An earlier version checked
# `kill -0` on it and concluded every lock was abandoned, which silently defeated the
# whole mechanism: two lanes could benchmark simultaneously while both believed they
# held it exclusively. The pid is still recorded, but only as a diagnostic breadcrumb.
break_stale() {
  local age; age=$(lock_age)
  if (( age > STALE_AFTER )); then
    echo "  breaking stale lock: held by $(holder) for ${age}s (limit ${STALE_AFTER}s)" >&2
    rm -rf "$LOCK_DIR"
    return 0
  fi
  return 1
}

cmd_acquire() {
  local lane="${1:?usage: acquire <lane-name> [max-wait-seconds]}"
  local max_wait="${2:-1800}"
  local waited=0

  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$lane"    > "$LOCK_DIR/holder"
      echo "$$"       > "$LOCK_DIR/pid"
      now             > "$LOCK_DIR/acquired_at"
      hostname        > "$LOCK_DIR/host" 2>/dev/null || true
      echo "[measure-lock] $lane ACQUIRED after ${waited}s"

      # Holding the lock is not the same as the machine being quiet — the lane that
      # just released may still have processes winding down.
      cmd_wait_quiet "$QUIET_MAX_WAIT" || true
      return 0
    fi

    if break_stale; then continue; fi

    if (( waited >= max_wait )); then
      echo "[measure-lock] $lane TIMED OUT after ${waited}s; held by $(holder) for $(lock_age)s" >&2
      echo "  If that lane is dead: scripts/measure-lock.sh release $(holder)" >&2
      return 1
    fi

    if (( waited % 30 == 0 )); then
      echo "[measure-lock] $lane waiting — $(holder) has held it $(lock_age)s"
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done
}

cmd_release() {
  local lane="${1:?usage: release <lane-name>}"
  if [[ ! -d "$LOCK_DIR" ]]; then
    echo "[measure-lock] not held; nothing to release"
    return 0
  fi
  local h; h=$(holder)
  if [[ "$h" != "$lane" && "$lane" != "--force" ]]; then
    # Releasing someone else's lock mid-benchmark corrupts their numbers silently,
    # which is worse than failing here.
    echo "[measure-lock] REFUSING: held by '$h', not '$lane'. Use --force only if that lane is dead." >&2
    return 1
  fi
  rm -rf "$LOCK_DIR"
  echo "[measure-lock] $lane released after $(lock_age)s"
}

# Extend a legitimately long hold.
#
# The staleness timeout has to be short enough that a dead lane does not stall everyone,
# and long enough that a real measurement is never interrupted. Those pull in opposite
# directions, and a paired before/after run — where the lane applies its change between
# two measurements, which is the correct way to satisfy Rule 1 — can easily outlast any
# timeout short enough to be useful.
#
# So: a lane that is still working says so. Call this between the halves of a pair, or
# in a loop alongside a long run. Only the holder may renew.
cmd_renew() {
  local lane="${1:?usage: renew <lane-name>}"
  [[ -d "$LOCK_DIR" ]] || { echo "[measure-lock] not held — nothing to renew" >&2; return 1; }
  local h; h=$(holder)
  if [[ "$h" != "$lane" ]]; then
    echo "[measure-lock] REFUSING: held by '$h', not '$lane'" >&2
    return 1
  fi
  now > "$LOCK_DIR/acquired_at"
  echo "[measure-lock] $lane renewed — ${STALE_AFTER}s from now"
}

cmd_status() {
  if [[ -d "$LOCK_DIR" ]]; then
    echo "HELD by $(holder) for $(lock_age)s (acquired by pid $(cat "$LOCK_DIR/pid" 2>/dev/null || echo '?'))"
    echo "  auto-breaks in $(( STALE_AFTER - $(lock_age) ))s; or: scripts/measure-lock.sh release --force"
  else
    echo "FREE"
  fi
  printf 'load1=%s cores=%s threshold=%s\n' "$(load1)" "$CORES" \
    "$(awk -v c="$CORES" -v p="$QUIET_LOAD_PER_CORE" 'BEGIN{printf "%.2f", c*p}')"
}

# Load average is a lagging indicator, so this is a floor rather than a guarantee.
# It exists to catch the obvious case: measuring 10 seconds after a full build.
cmd_wait_quiet() {
  local max_wait="${1:-$QUIET_MAX_WAIT}"
  local threshold; threshold=$(awk -v c="$CORES" -v p="$QUIET_LOAD_PER_CORE" 'BEGIN{print c*p}')
  local waited=0
  while (( waited < max_wait )); do
    local l; l=$(load1)
    if awk -v l="$l" -v t="$threshold" 'BEGIN{exit !(l < t)}'; then
      (( waited > 0 )) && echo "[measure-lock] machine quiet (load $l < $threshold) after ${waited}s"
      return 0
    fi
    (( waited % 30 == 0 )) && echo "[measure-lock] waiting for quiet: load $l >= $threshold"
    sleep 10
    waited=$(( waited + 10 ))
  done
  echo "[measure-lock] WARNING: load still $(load1) after ${max_wait}s — measuring anyway." >&2
  echo "  Record this in the lane's CHANGES entry; the pair may not satisfy Rule 1." >&2
  return 1
}

case "${1:-}" in
  acquire)    shift; cmd_acquire "$@" ;;
  renew)      shift; cmd_renew "$@" ;;
  release)    shift; cmd_release "$@" ;;
  status)     cmd_status ;;
  wait-quiet) shift; cmd_wait_quiet "$@" ;;
  *)
    sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
