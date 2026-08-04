# Use ECR Public Node.js image (Docker Hub is blocked in government environments)
# ---------------------------------------------------------------------------
# Stage 1 — build
#
# The previous single-stage image expected shared/dist and api/dist to already
# exist, because scripts/deploy.sh compiled them on the developer's machine and
# zipped them alongside. That works for the Elastic Beanstalk path and nowhere
# else: any host that clones the repo (Render, CI, a fresh checkout) has no
# dist/ — it is gitignored — and the build dies at COPY.
#
# Building inside the image makes the artifact reproducible from source alone,
# which is what Implementation Rule 5 asks for: the artifact produced in CI must
# be the artifact that runs in production.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:20-slim AS builder

WORKDIR /app

# Disable SSL strict mode for government VPN environments (MUST be before any npm commands)
RUN npm config set strict-ssl false
RUN npm install -g pnpm@9.15.4 && pnpm config set strict-ssl false

# Manifests first so dependency install caches independently of source changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY web/package.json ./web/
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/

# Full install — devDependencies are needed to compile TypeScript
RUN pnpm install --frozen-lockfile --ignore-scripts

# Source
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY api/ ./api/
COPY agent/ ./agent/

# Order is a dependency chain, not a preference: shared emits the types api's
# tsconfig references, and the agent imports the circuit breaker from api/dist
# (a built .d.ts — a cross-package .ts import is a hard tsc error under
# `rootDir: ./src`). Reordering these breaks the build in a way whose error
# message points at the wrong package.
RUN pnpm build:shared && pnpm --filter @ship/api build && pnpm --filter @ship/agent build

# Frontend, served from the same origin as the API. Same-origin is required, not
# preferred: the session cookie is sameSite:'strict', so a frontend on another
# domain could never send it. VITE_API_URL stays empty so the client uses
# relative URLs and hits whatever host is serving it.
COPY web/ ./web/
RUN pnpm --filter @ship/web build
RUN test -f web/dist/index.html || (echo "web build produced no index.html" && exit 1)

# Fail loudly here rather than at container start
RUN test -f api/dist/index.js || (echo "api build produced no dist/index.js" && exit 1) \
 && test -f api/dist/db/schema.sql || (echo "schema.sql missing from api/dist/db" && exit 1) \
 && test -d api/dist/db/migrations || (echo "migrations missing from api/dist/db" && exit 1) \
 && test -f agent/dist/entrypoints/cron.js || (echo "agent build produced no cron entrypoint" && exit 1)

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# Production dependencies only; nothing from the toolchain carries over.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:20-slim

# Provenance. Implementation Rule 5: "Tag each artifact with the git commit SHA."
#
# A registry tag alone is not enough — a tag is a pointer someone can move, and
# it is invisible from inside a running container. This bakes the SHA into the
# image three ways so the question "which commit is actually running?" has an
# answer at every layer:
#
#   LABEL org.opencontainers.image.revision  → `docker inspect`, without running it
#   ENV GIT_SHA                              → the process, and therefore /health
#   the registry tag                         → set by CI, see .github/workflows/ci.yml
#
# The default is literally `unknown`, not empty. `docker build .` with no
# --build-arg — local dev, scripts/deploy.sh before this change, anyone poking at
# the Dockerfile — still produces a working image; it just reports honestly that
# nobody told it what commit it came from. A blank value would be
# indistinguishable from a value that failed to propagate.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision="$GIT_SHA"
LABEL org.opencontainers.image.source="https://github.com/joshdrochon/ship"
ENV GIT_SHA=$GIT_SHA

WORKDIR /app

RUN npm config set strict-ssl false
RUN npm install -g pnpm@9.15.4 && pnpm config set strict-ssl false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/
COPY agent/package.json ./agent/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

COPY --from=builder /app/shared/dist/ ./shared/dist/
COPY --from=builder /app/api/dist/ ./api/dist/
COPY --from=builder /app/web/dist/ ./web/dist/

# The agent ships in the same image as the API, and the Render cron job selects
# it with a start_command override (terraform/render/cron.tf). One image, two
# entrypoints.
#
# Two images would mean two builds, two registry pushes, and a class of bug
# where the cron runs a different commit than the API it is reading from — which
# is exactly the kind of skew that produces a finding nobody can reproduce.
COPY --from=builder /app/agent/dist/ ./agent/dist/

EXPOSE 80

ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV PORT=80

# Start: migrate, then seed, then serve.
#
# `;` not `&&` between migrate and seed deliberately — migrate exits non-zero on
# a database that already has the schema, and that must not stop the server.
#
# Seeding on boot is safe: seed.js checks for every record before inserting and
# logs "already exists" rather than duplicating. It guarantees a deployed demo
# instance always has a working login and realistic data, at the cost of a few
# hundred milliseconds on cold start.
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js; node dist/db/seed.js; node dist/index.js"]
