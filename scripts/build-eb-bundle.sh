#!/bin/bash
# ---------------------------------------------------------------------------
# PF-628 — build the Elastic Beanstalk source bundle.
#
# The EB Docker platform builds the Dockerfile ON THE INSTANCE from a source
# bundle, so the bundle is the artifact. It is produced from `git archive HEAD`
# rather than from the working tree, which buys two things:
#
#   - only TRACKED files ship. No node_modules, no dist/, no .env.local, no
#     stray .tfstate. This is a correctness property, not tidiness: the working
#     tree of a monorepo mid-session contains credentials.
#   - the bundle is exactly reproducible from a commit SHA.
#
# Provenance (Implementation Rule 5, "tag each artifact with the git commit
# SHA"). The Dockerfile declares `ARG GIT_SHA=unknown` and bakes it into a LABEL
# and into ENV GIT_SHA, which /health reports. EB gives no way to pass
# --build-arg, so the bundle's own copy of the Dockerfile has the default
# rewritten to the real SHA. The substitution happens on the exported copy only;
# the tracked Dockerfile is never modified.
#
# Usage: scripts/build-eb-bundle.sh [output-zip]
# Prints the SHA and the bundle path.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
OUT="${1:-$REPO_ROOT/.eb-bundles/ship-api-$SHORT.zip}"
case "$OUT" in /*) ;; *) OUT="$REPO_ROOT/$OUT" ;; esac

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: working tree is dirty. The bundle ships HEAD ($SHORT), NOT your"
  echo "         uncommitted changes. Commit first if you meant to deploy them."
  git status --short
  echo
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "Exporting tracked files at $SHORT ..."
git archive HEAD | tar -x -C "$STAGE"

# ---------------------------------------------------------------------------
# The docker-compose files MUST NOT ship in the bundle.
#
# This is not tidiness, it is the difference between deploying and not. The
# Elastic Beanstalk AL2023 Docker platform picks its build mode by looking at
# what is in the bundle root, and `docker-compose.yml` WINS over `Dockerfile`.
# Ship one and EB never builds the image at all -- it runs the compose file.
#
# Observed, not theorised: version ship-api-aaf6669 deployed in 48 seconds
# (a full monorepo build cannot), reported "Instance deployment completed
# successfully", and the eb-engine log showed `postgres-1 | ... database system
# is ready to accept connections`. EB had started the LOCAL DEVELOPMENT Postgres
# from docker-compose.yml, with no application container anywhere, and the
# environment went Degraded on an ELB health check against a port nothing was
# listening on. Nothing in the event stream says "I ignored your Dockerfile".
#
# Removing them from the bundle is correct rather than a workaround: these three
# files describe a local development stack (a Postgres for `pnpm dev`, a mock
# server), and none of them has any business running on the deployed instance,
# which uses Aurora.
# ---------------------------------------------------------------------------
COMPOSE_FOUND=$(find "$STAGE" -maxdepth 1 -name 'docker-compose*.yml' -o -maxdepth 1 -name 'docker-compose*.yaml' | sort)
if [ -n "$COMPOSE_FOUND" ]; then
  echo "Removing docker-compose files from the bundle (EB would run them instead of the Dockerfile):"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    echo "  - $(basename "$f")"
    rm -f "$f"
  done <<< "$COMPOSE_FOUND"
fi

# Belt and braces: a Dockerrun.aws.json would also override the Dockerfile.
if [ -f "$STAGE/Dockerrun.aws.json" ]; then
  echo "  - Dockerrun.aws.json (also overrides the Dockerfile)"
  rm -f "$STAGE/Dockerrun.aws.json"
fi

if [ ! -f "$STAGE/Dockerfile" ]; then
  echo "ERROR: no Dockerfile in the bundle. EB would have nothing to build."
  exit 1
fi

# Bake the SHA into the bundle's Dockerfile so /health can report it.
if ! grep -q '^ARG GIT_SHA=' "$STAGE/Dockerfile"; then
  echo "ERROR: Dockerfile has no 'ARG GIT_SHA=' line to substitute."
  exit 1
fi
sed -i.bak "s/^ARG GIT_SHA=.*/ARG GIT_SHA=$SHA/" "$STAGE/Dockerfile"
rm -f "$STAGE/Dockerfile.bak"
echo "Baked GIT_SHA=$SHA into the bundle Dockerfile."

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
( cd "$STAGE" && zip -q -r "$OUT" . -x '*.git*' )

echo "SHA:    $SHA"
echo "Bundle: $OUT"
echo "Size:   $(du -h "$OUT" | cut -f1)"
