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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    --logs) FOLLOW_LOGS=1; shift ;;
    --down) DOWN=1; shift ;;
    --no-mocks) WITH_MOCKS=0; shift ;;
    -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

  Logs           ${DC[*]} ${FILES[*]} logs -f
  Stop           ./start.sh --down
  Reset data     ./start.sh --clean

EOF

if [[ $FOLLOW_LOGS -eq 1 ]]; then
  "${DC[@]}" "${FILES[@]}" logs -f
fi
