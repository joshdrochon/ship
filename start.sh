#!/usr/bin/env bash
#
# One-command local start.
#
# Implementation Rule 6 (brief p.9): "Write a script (e.g. ./start.sh or a Makefile
# target) that starts the full composed system locally — app, database, and any mock
# external services — with a single command from a clean checkout. This script must be
# documented in the README cold-start guide and must work without any manual setup steps
# beyond installing dependencies."
#
#   ./start.sh              start everything, wait until healthy, print URLs
#   ./start.sh --clean      destroy volumes first (fresh database, re-seeded)
#   ./start.sh --logs       follow logs after starting
#   ./start.sh --down       stop everything
#   ./start.sh --no-mocks   skip the mock Bedrock service
#   ./start.sh --no-agent   skip the FleetGraph scan
#
# The FleetGraph agent is a one-shot cron process, not a server — ./start.sh runs one
# scan and moves on. See the "FleetGraph: one scan, not a service" block below.
#
# Why this exists rather than `pnpm dev`: `pnpm dev` runs the API and web server on the
# host and requires a PostgreSQL that the developer installed and started themselves.
# That is not a clean-checkout path — it fails on a machine without local PostgreSQL,
# which is exactly the case Rule 6 is about. This script needs only Docker.

set -euo pipefail

COMPOSE_FILE="docker-compose.local.yml"
MOCK_FILE="docker-compose.mocks.yml"

# Own compose project, deliberately.
#
# Both docker-compose.yml and docker-compose.local.yml declare a service named
# `postgres`. Under the default project name (the directory, "ship") they resolve to the
# same container name, so bringing one up RECREATES the other's container — silently
# moving the database from port 5432 to 5433 and breaking `pnpm dev` on the host.
# A separate project name gives this stack its own containers and its own volume, so the
# containerised path and the host path coexist instead of fighting.
COMPOSE_PROJECT="ship-local"
CLEAN=0
FOLLOW_LOGS=0
DOWN=0
WITH_MOCKS=1
WITH_AGENT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    --logs) FOLLOW_LOGS=1; shift ;;
    --down) DOWN=1; shift ;;
    --no-mocks) WITH_MOCKS=0; shift ;;
    --no-agent) WITH_AGENT=0; shift ;;
    # Prints the header block above, however long it happens to be. A fixed line
    # range drifts the moment anyone edits the header — it already had, and was
    # printing three lines of shell as if they were documentation.
    -h|--help) awk 'NR>2 && /^#/ { sub(/^# ?/, ""); print; next } NR>2 { exit }' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; echo "Try: $0 --help" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

# --- prerequisites -----------------------------------------------------------
# Checked up front with actionable messages. A compose failure 40 seconds in with a
# wall of Go stack trace is not a usable error for someone on their first checkout.

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Docker is not installed.

  macOS:  brew install --cask docker   (then launch Docker.app)
  Linux:  https://docs.docker.com/engine/install/

Docker is the only prerequisite — Node, pnpm, and PostgreSQL all run inside containers.
EOF
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop (or dockerd) and retry." >&2
  exit 1
fi

# `docker compose` (v2, plugin) vs `docker-compose` (v1, standalone).
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "Neither 'docker compose' nor 'docker-compose' is available. Install Compose v2." >&2
  exit 1
fi

FILES=(-p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE")
if [[ $WITH_MOCKS -eq 1 && -f "$MOCK_FILE" ]]; then
  FILES+=(-f "$MOCK_FILE")
fi

# --- --down ------------------------------------------------------------------

if [[ $DOWN -eq 1 ]]; then
  echo "Stopping the stack..."
  "${DC[@]}" "${FILES[@]}" down
  echo "Stopped. Data volume kept — use --clean on the next start to discard it."
  exit 0
fi

# --- --clean -----------------------------------------------------------------

if [[ $CLEAN -eq 1 ]]; then
  echo "Removing containers and volumes (the database will be recreated and re-seeded)..."
  "${DC[@]}" "${FILES[@]}" down -v
fi

# --- start -------------------------------------------------------------------

echo "Building and starting: postgres, api, web$([[ $WITH_MOCKS -eq 1 ]] && echo ', mock-bedrock')"
echo "First run compiles images and takes a few minutes. Later runs are cached."
echo

"${DC[@]}" "${FILES[@]}" up --build -d

# --- wait for readiness ------------------------------------------------------
# compose's `depends_on: service_healthy` gets Postgres right, but the API still has to
# run migrations and seed before it answers. Poll /health rather than sleeping a fixed
# interval, so a slow first boot does not produce a false failure.

API_URL="http://localhost:3000/health"
WEB_URL="http://localhost:5173"
DEADLINE=$((SECONDS + 180))

printf 'Waiting for the API to become healthy '
until curl -fsS "$API_URL" >/dev/null 2>&1; do
  if (( SECONDS >= DEADLINE )); then
    echo
    echo "API did not become healthy within 180s." >&2
    echo "Last 40 lines of API logs:" >&2
    "${DC[@]}" "${FILES[@]}" logs --tail=40 api >&2 || true
    echo >&2
    echo "The stack is still running. Investigate with:" >&2
    echo "  ${DC[*]} ${FILES[*]} logs -f api" >&2
    exit 1
  fi
  printf '.'
  sleep 2
done
echo ' ready'

printf 'Waiting for the web server '
until curl -fsS "$WEB_URL" >/dev/null 2>&1; do
  if (( SECONDS >= DEADLINE )); then
    echo
    echo "Web server did not respond within the deadline. API is up; check web logs:" >&2
    "${DC[@]}" "${FILES[@]}" logs --tail=40 web >&2 || true
    exit 1
  fi
  printf '.'
  sleep 2
done
echo ' ready'

# --- FleetGraph: one scan, not a service -------------------------------------
#
# The agent's proactive entrypoint (`agent/src/entrypoints/cron.ts`) is a ONE-SHOT
# process: it scans every workspace, writes what it found, and exits. In production a
# Render cron job invokes it every three minutes (terraform/render/cron.tf); there is no
# long-running agent server anywhere, deliberately — a cron container that exits between
# runs is why the LangGraph checkpointer has to be in Postgres, which is the property the
# human-approval interrupt depends on.
#
# So "start the agent" cannot mean "leave it running". It means: run one scan, so a
# developer who typed ./start.sh has a system where FleetGraph has actually executed
# rather than one where it merely could. Re-run it any time with the command printed
# below; nothing in the app depends on it having run.
#
# It is best-effort and never fails the start. The app is the product; the scan is a
# report about the app.
#
# KNOWN LIMITATION, stated rather than hidden: this runs on the HOST, so it needs
# `pnpm install` and a built `api/dist` (the agent imports the circuit breaker from
# `api/dist` by relative path — see agent/src/llm/client.ts:54). Everything else in this
# script needs only Docker. It cannot run inside the api container because
# `Dockerfile.dev` builds api + shared only and never produces `agent/dist`. Making this
# Docker-only means adding an `agent` service to docker-compose.local.yml built from the
# production `Dockerfile`, which does build the agent in the right order.
# When the host cannot run it, the scan is skipped with the reason and the commands.

AGENT_STATUS="skipped (--no-agent)"

run_fleetgraph_scan() {
  if [[ ! -d node_modules ]]; then
    AGENT_STATUS="skipped — run 'pnpm install', then 'pnpm build:api'"
    return 0
  fi
  if [[ ! -f api/dist/services/circuitBreaker.js ]]; then
    # Named explicitly because the error you get otherwise is a module-not-found
    # on a relative path into api/dist, which reads like a broken checkout.
    AGENT_STATUS="skipped — api/dist missing; run 'pnpm build:api' (api builds before agent)"
    return 0
  fi

  echo
  echo "Running one FleetGraph scan (one-shot; there is no agent server)..."

  # DATABASE_URL is this stack's Postgres, not whatever the developer has exported.
  #
  # BEDROCK_ENDPOINT is deliberately NOT pointed at the mock. mocks/bedrock-expectations.json
  # answers Converse with an empty judgment list, so a mocked run reports success and
  # produces no finding — indistinguishable from a healthy project, while proving nothing.
  # With no AWS credentials the scan says `ai_unavailable`, the signals persist unjudged,
  # and the next run judges them. That is the designed degradation and it should be
  # visible.
  if DATABASE_URL="postgresql://ship:ship_dev_password@localhost:5433/ship_dev" \
       pnpm --filter @ship/agent agent:cron; then
    AGENT_STATUS="one scan completed (see the fleetgraph.scan line above)"
  else
    AGENT_STATUS="scan exited non-zero — the app is unaffected, see the log above"
  fi
}

if [[ $WITH_AGENT -eq 1 ]]; then
  run_fleetgraph_scan
fi

# Report what actually got seeded, so "it started" and "it has data" are not confused.
SEEDED=$("${DC[@]}" "${FILES[@]}" exec -T postgres \
  psql -U ship -d ship_dev -tAc "SELECT count(*) FROM documents;" 2>/dev/null || echo "?")

cat <<EOF

  Ship is running.

  Web            $WEB_URL
  API            http://localhost:3000
  Health         $API_URL
  Swagger UI     http://localhost:3000/api/docs/
  PostgreSQL     localhost:5433  (db: ship_dev, user: ship, password: ship_dev_password)
EOF

if [[ $WITH_MOCKS -eq 1 && -f "$MOCK_FILE" ]]; then
  echo "  Mock Bedrock   http://localhost:4599   (AI analysis returns canned responses)"
fi

cat <<EOF

  Login          dev@ship.local  /  admin123
  Documents      $SEEDED seeded
  FleetGraph     $AGENT_STATUS

  Logs           ${DC[*]} ${FILES[*]} logs -f
  Stop           ./start.sh --down
  Reset data     ./start.sh --clean
  Scan again     DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5433/ship_dev \\
                   pnpm --filter @ship/agent agent:cron

EOF

if [[ $FOLLOW_LOGS -eq 1 ]]; then
  "${DC[@]}" "${FILES[@]}" logs -f
fi
