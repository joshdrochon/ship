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

# Full install — devDependencies are needed to compile TypeScript
RUN pnpm install --frozen-lockfile --ignore-scripts

# Source
COPY tsconfig.json ./
COPY shared/ ./shared/
COPY api/ ./api/

# shared must build first; api's tsconfig references its emitted types
RUN pnpm build:shared && pnpm --filter @ship/api build

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
 && test -d api/dist/db/migrations || (echo "migrations missing from api/dist/db" && exit 1)

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# Production dependencies only; nothing from the toolchain carries over.
# ---------------------------------------------------------------------------
FROM public.ecr.aws/docker/library/node:20-slim

WORKDIR /app

RUN npm config set strict-ssl false
RUN npm install -g pnpm@9.15.4 && pnpm config set strict-ssl false

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json ./api/
COPY shared/package.json ./shared/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

COPY --from=builder /app/shared/dist/ ./shared/dist/
COPY --from=builder /app/api/dist/ ./api/dist/
COPY --from=builder /app/web/dist/ ./web/dist/

EXPOSE 80

ENV NODE_ENV=production
ENV VITE_APP_ENV=production
ENV PORT=80

# Start the application (run migrations first to ensure schema exists)
WORKDIR /app/api
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
