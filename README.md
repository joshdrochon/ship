<p align="center">
  <a href="https://github.com/US-Department-of-the-Treasury/ship">
    <img src="web/public/icons/blue/android-chrome-512x512.png" alt="Ship logo" width="120">
  </a>
</p>

<h1 align="center">Ship</h1>

<p align="center">
  <strong>Project management that helps teams learn and improve</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/US-Department-of-the-Treasury/ship/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
  <img src="https://img.shields.io/badge/Section_508-target-lightgrey.svg" alt="Section 508 — target, not a certification">
  <img src="https://img.shields.io/badge/WCAG_2.1_AA-target-lightgrey.svg" alt="WCAG 2.1 AA — target, not a certification">
</p>

---

> **Which week are you grading?**
>
> | Week | Start here | Deployment |
> |---|---|---|
> | **Week 6 — PlugForge** (platform, OAuth, SDK, webhooks) | **[SUBMISSION-PLUGFORGE.md](SUBMISSION-PLUGFORGE.md)** | AWS — `https://d258p92d3n1ebe.cloudfront.net/` |
> | Week 5 — ShipShape audit & improvements | [SUBMISSION.md](SUBMISSION.md) | Render — `https://shipshape-fkub.onrender.com` |
>
> Both deployments are live and they are **different applications**. The Render service
> runs Week 5's `main` and has no `/api/v1` at all; `SUBMISSION.md` and `CREDENTIALS.md`
> describe it correctly and are not Week 6 documents. This README describes the product.

---

## For graders — the deployed instance (Week 6)

<!-- PF-631 (L21), corrected by L26. PRD p.13 requires credentials in the README; p.18
     asks for a one-command path to the deployed instance. -->

**Everything below points at the live AWS deployment. Nothing here needs a local
checkout, a database, or a build.**

| | |
|---|---|
| **Start here / base URL** | `https://d258p92d3n1ebe.cloudfront.net` |
| **OpenAPI spec** | `<base>/api/v1/openapi.json` — public, no credentials required |
| **Health** | `<base>/health` — reports the deployed commit SHA |
| **Dev portal** | `<base>/portal` |
| **Regression budget (p.2 item 9)** | [`docs/regression-paired-runs.md`](docs/regression-paired-runs.md) — P95 vs Part 1, largest +4.3% against a +10% budget |
| **API origin (no TLS, `curl` only)** | `http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com` |

**Use the CloudFront URL.** It serves the frontend from S3 and proxies `/api/**` and
`/health` to the Elastic Beanstalk origin, so one host covers the UI, the dev portal and
the public API over TLS.

**The EB origin is not a browser URL.** It answers `curl` correctly, but `helmet` sends
`upgrade-insecure-requests` and the environment has no TLS listener, so a browser
requests the page's own assets over `https` against a port that is not there and renders
a white screen. It is listed because one path genuinely needs it — see the warning below.

> ✅ **`/oauth/*` routes through CloudFront. This warning used to say it did not; that
> is fixed and re-measured.** `terraform/s3-cloudfront.tf` carries an ordered cache
> behaviour for `/oauth/*` pointing at the EB origin with all methods allowed, so the
> CloudFront URL is the *only* one a grader needs. Re-measured 2026-08-15 from outside
> the project, by origin header rather than by inference:
>
> ```
> POST https://d258p92d3n1ebe.cloudfront.net/oauth/device/code   → 200 application/json
> GET  https://d258p92d3n1ebe.cloudfront.net/oauth/device/verify → 302, server: nginx
> ```
>
> The `server: nginx` on the second is the point: that is the API's own response, not
> the S3 SPA shell that used to shadow it. `ship login` completes against the CloudFront
> host, and the `verification_uri` the device-code response hands back now resolves to a
> working consent page. History in `SUBMISSION-PLUGFORGE.md` §9 and L99 F160.

> **Read `docs/infra/grader-access.md` §6 before relying on any of these.** That
> section carries the dated `curl` output proving what actually answers, and it is the
> only place in this repo that asserts the deployment is up. A URL in a table is a
> configuration claim, not evidence — this project has already published one dead URL
> (`.claude/CLAUDE.md` still names the retired `eba-xsaqsg9h` CNAME, which no longer
> resolves) and the whole point of the verification log is that it cannot happen
> silently again.

### Pre-registered OAuth apps

Two apps are seeded for graders. They live in a **dedicated workspace** owned by a
dedicated user, not the primary account — so a token issued to either sees that
workspace and nothing else (p.18, *"without exposing your tenant's data"*).

| App | `client_id` | Scopes | Use it for |
|---|---|---|---|
| Grader (read-only) | `ship_app_grader_readonly` | `documents:read`, `issues:read`, `sprints:read` | Everything read-only. This is the app MVP gate item 10 refers to. |
| Grader demo (write) | `ship_app_grader_demo` | read + write | `ship docs create` and the rest of the five-line story. |

**Why there are two, and which to use when.** The gate requires the pre-registered app
to be **read-only** (p.2), but the headline demo is `ship login` → `ship docs create` →
`ship webhooks tail`. Those two requirements are in direct tension: a grader following
the demo with the read-only app gets a `403`, which looks like a broken product and is
in fact the security property working. So the read-only app is the gate app, and the
demo app exists so the demo is reproducible. **Use the demo app for anything that
writes.** (Recorded as L99 decision D12.)

The `client_id` values are not secret and are published above deliberately. The
`client_secret` values are not in git — read them from the deployed environment's
parameter store:

```bash
aws ssm get-parameter --name /ship/dev/GRADER_CLIENT_SECRET \
  --with-decryption --query Parameter.Value --output text
aws ssm get-parameter --name /ship/dev/DEMO_CLIENT_SECRET \
  --with-decryption --query Parameter.Value --output text
```

### One command

Point the CLI at the deployed instance and confirm it answers:

```bash
export SHIP_API_URL=https://d258p92d3n1ebe.cloudfront.net
curl -s "$SHIP_API_URL/api/v1/openapi.json" | head -c 200
```

> **`SHIP_API_URL` is for the `curl` examples on this page only — the CLI does not
> read it.** The CLI resolves its instance as `--base-url` → **`SHIP_BASE_URL`** →
> the SDK's built-in default, and that default is now this deployment, so
> `ship login` with no flags reaches the right place. To be explicit, either
> export `SHIP_BASE_URL=https://d258p92d3n1ebe.cloudfront.net` or pass
> `--base-url` once on `login` — it is persisted to `~/.ship/config.json` and no
> later command needs the flag.

`/oauth/*` works against the same host — no second URL, no EB origin. `ship login` and
everything under it go through CloudFront:

```bash
curl -s -X POST "$SHIP_API_URL/oauth/device/code" \
  -d 'client_id=ship_app_grader_demo&scope=documents:read'
```

That returns a real `device_code`, `user_code` and `verification_uri`; open the
`verification_uri` in a browser to approve. The EB origin
(`http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com`) still answers and is
kept above as a fallback, but nothing requires it any more.

### Verifying the deployment yourself

One script checks every claim on this page, and it asserts on **content**, not on status
codes — the Elastic Beanstalk sample application returns HTTP 200 with an HTML page on
every path, including `/api/v1/openapi.json`, so a `200` proves nothing on its own:

```bash
scripts/verify-deployment.sh "$SHIP_API_URL"
```

---

## What is Ship?

Ship is a project management tool that combines documentation, issue tracking, and plan-driven weekly workflows in one place. Instead of switching between a wiki, a task tracker, and a spreadsheet, everything lives together.

**Built by the U.S. Department of the Treasury** for government teams, but useful for any organization that wants to work more effectively.

---

## How to Use Ship

Ship has four main views, each designed for different questions:

| View | What it answers |
|------|-----------------|
| **Docs** | "Where's that document?" — Wiki-style pages for team knowledge |
| **Issues** | "What needs to be done?" — Track tasks, bugs, and features |
| **Projects** | "What are we building?" — Group issues into deliverables |
| **Teams** | "Who's doing what?" — See workload across people and weeks |

### The Basics

1. **Create documents** for anything your team needs to remember — meeting notes, specs, onboarding guides
2. **Create issues** for work that needs to get done — assign them to people and track progress
3. **Group issues into projects** to organize related work
4. **Write weekly plans** to declare what you intend to accomplish each week

Everyone on the team can edit documents at the same time. You'll see other people's cursors as they type.

---

## The Ship Philosophy

### Everything is a Document

In Ship, there's no difference between a "wiki page" and an "issue" at the data level. They're all documents with different properties. This means:

- You can link any document to any other document
- Issues can have rich content, not just a title and description
- Projects and weeks are documents too — they can contain notes, decisions, and context

### Plans Are the Unit of Intent

Ship is plan-driven: each week starts with a written plan declaring what you intend to accomplish and ends with a retro capturing what you learned. Issues are a trailing indicator of what was done, not a leading indicator of what to do.

1. **Plan (Weekly Plan)** — Before the week, write down what you intend to accomplish and why
2. **Execute (The Week)** — Do the work; issues track what was actually done
3. **Reflect (Weekly Retro)** — After the week, write down what actually happened and what you learned

This isn't paperwork for paperwork's sake. Teams that skip retrospectives repeat the same mistakes. Teams that write things down learn and improve.

### Learning, Not Compliance

Documentation requirements in Ship are visible but not blocking. You can start a new week without finishing the last retro. But the system makes missing documentation obvious — it shows up as a visual indicator that escalates from yellow to red over time.

The goal isn't to check boxes. It's to capture what your team learned so you can get better.

---

## Getting Started

### Cold start — one command

From a clean checkout, this is the whole thing:

```bash
git clone <your-fork-url> ship && cd ship
./start.sh
```

**Docker is the only prerequisite.** Node, pnpm, and PostgreSQL all run inside
containers, so you do not need any of them installed on the host. The script builds the
images, starts PostgreSQL, runs migrations, seeds sample data, starts a mock Bedrock so
the AI features work without AWS credentials, waits until everything answers a health
check, then prints the URLs and how many documents got seeded.

First run takes a few minutes while images build. Later runs are cached and take seconds.

```bash
./start.sh              # start everything and wait until healthy
./start.sh --clean      # discard the database volume and re-seed from scratch
./start.sh --logs       # start, then follow logs
./start.sh --down       # stop everything (data volume kept)
./start.sh --no-mocks   # skip the mock Bedrock service
./start.sh --no-agent   # skip the one FleetGraph scan
./start.sh --help
```

If a service does not come up, the script prints that container's last 40 log lines and
leaves the stack running so you can inspect it.

### Alternative: run on the host

Faster hot-reload, but you have to supply Node 20+, pnpm, and a running PostgreSQL
yourself. Use `./start.sh` if you just want it working.

<details>
<summary>Host setup steps</summary>

Prerequisites: [Node.js](https://nodejs.org/) 20+, [pnpm](https://pnpm.io/), and
[Docker](https://www.docker.com/) for the database.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp api/.env.example api/.env.local
cp web/.env.example web/.env

# 3. Start the database
docker compose up -d

# 4. Run migrations, then seed
pnpm db:migrate
pnpm db:seed

# 5. Start the application
pnpm dev
```

Two things to know about this path:

- **`pnpm db:migrate` can exit 0 while applying only some migrations.** If the app
  behaves as though a column is missing, check that `schema_migrations` has as many rows
  as there are files in `api/src/db/migrations/`.
- **`pnpm test` truncates whatever database `DATABASE_URL` points at** — including this
  one. Re-run `pnpm db:seed` after any unit-test run. `./start.sh` is unaffected; its
  database is a separate container on port 5433.

</details>

### Open the App

Once it's running, open your browser to:

**http://localhost:5173**

Log in with the demo account:
- **Email:** `dev@ship.local`
- **Password:** `admin123`

### What's Running

| Service | URL | Description |
|---------|-----|-------------|
| Web app | http://localhost:5173 | The Ship interface |
| API server | http://localhost:3000 | Backend services |
| Swagger UI | http://localhost:3000/api/docs | Interactive API documentation |
| OpenAPI spec | http://localhost:3000/api/openapi.json | OpenAPI 3.0 specification |
| PostgreSQL | localhost:5433 (`./start.sh`) · localhost:5432 (`docker compose up -d`) | Database (via Docker) |
| Mock Bedrock | http://localhost:4599 | `./start.sh` only — canned AI analysis responses, skipped with `--no-mocks` |

The two paths deliberately use different ports so they can run side by side.
`./start.sh` brings up `docker-compose.local.yml`, which maps Postgres to **5433**. The
host path in the section above uses `docker-compose.yml`, which maps it to **5432** — the
port `api/.env.example` points at.

`./start.sh` always binds 3000 and 5173. `pnpm dev` does not: `scripts/dev.sh` scans for
the first free ports from 3000 and 5173 upward so multiple worktrees can run at once, and
prints the pair it picked. Check that output rather than assuming 3000/5173.

### The FleetGraph agent

FleetGraph is a project-intelligence agent that reads Ship's data, decides what a human
needs to know, and says it in the document the finding is about. It lives in `agent/` as
its own workspace package.

**It is a cron process, not a server.** One run scans every workspace, writes what it
found, and exits — in production a Render cron job invokes it every three minutes. There
is nothing to leave running, which is why `./start.sh` runs a single scan rather than
starting a service.

```bash
# 1. The app and its database
./start.sh

# 2. Configure the agent (gitignored — never commit it)
cp agent/.env.example agent/.env

# 3. Build the API first. The agent imports Ship's circuit breaker from api/dist,
#    so this is a real ordering requirement, not a suggestion.
pnpm build:api

# 4. Run one scan. agent/.env is NOT auto-loaded — source it yourself.
set -a && . ./agent/.env && set +a
pnpm --filter @ship/agent agent:cron
```

A run prints one JSON line. `"outcome":"quiet_no_signals"` means the detectors found
nothing and the run cost no model tokens, which is the common case and the reason a
three-minute schedule is affordable.

```bash
pnpm --filter @ship/agent test   # 146 tests against a testcontainer Postgres
```

Two things worth knowing before you debug anything:

- **Judgement needs AWS credentials.** Without them a scan reports `ai_unavailable`,
  the signals persist unjudged, and the next run judges them. `signals: 1, findings: 0`
  is the signature — the detector worked, the model did not run.
- **`LANGCHAIN_TRACING_V2` must be the literal string `"true"`.** `"1"` silently
  disables tracing. Every run's first log line reports which it is.

`agent/.env.example` documents every variable and why it exists. Operational detail —
the full build order, how to make a detector fire, and how to roll the agent back layer
by layer — is in [CHANGES.md](./CHANGES.md), "FleetGraph — the agent".

### Common Commands

```bash
pnpm dev          # Start everything
pnpm dev:web      # Start just the web app
pnpm dev:api      # Start just the API
pnpm db:seed      # Reset database with sample data
pnpm db:migrate   # Run database migrations
pnpm test         # Run API unit tests (vitest)
pnpm test:e2e     # Run the Playwright end-to-end suite
```

---

## Technical Details

### Architecture

Ship is a monorepo with four packages:

- **web/** — React frontend with TipTap editor for real-time collaboration
- **api/** — Express backend with WebSocket support
- **shared/** — TypeScript types used by both
- **agent/** — FleetGraph, the project-intelligence agent (a LangGraph graph plus a cron
  entrypoint). Depends on `api/dist`; nothing depends on it.

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React, Vite, TailwindCSS |
| Editor | TipTap + Yjs (real-time collaboration) |
| Backend | Express, Node.js |
| Database | PostgreSQL |
| Real-time | WebSocket |

### Design Decisions

- **Everything is a document** — Single `documents` table with a `document_type` field
- **Server is truth** — Offline-tolerant, syncs when reconnected
- **Boring technology** — Well-understood tools over cutting-edge experiments
- **E2E testing** — ~870 Playwright tests covering real user flows

See [docs/application-architecture.md](docs/application-architecture.md) for more.

### Repository Structure

```
ship/
├── api/                    # Express backend
│   ├── src/
│   │   ├── routes/         # REST endpoints
│   │   ├── collaboration/  # WebSocket + Yjs sync
│   │   └── db/             # Database queries
│   └── package.json
│
├── web/                    # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Route pages
│   │   └── hooks/          # Custom hooks
│   └── package.json
│
├── agent/                  # FleetGraph agent
│   ├── src/
│   │   ├── detectors/      # SQL signal detection, no model involved
│   │   ├── graph/          # LangGraph nodes, edges, Postgres checkpointer
│   │   ├── llm/            # Batched judgement behind api/'s circuit breaker
│   │   ├── actions/        # The only writes back into Ship
│   │   └── entrypoints/    # cron.ts — one-shot proactive scan
│   └── package.json
│
├── shared/                 # Shared TypeScript types
├── e2e/                    # Playwright E2E tests
└── docs/                   # Architecture documentation
```

---

## Testing

```bash
# Run the API unit tests (vitest)
pnpm test

# Run every package's unit tests (api + web)
pnpm test:all

# Run all E2E tests
pnpm test:e2e

# Run E2E tests in the Playwright UI
pnpm test:e2e:ui

# Run a specific E2E test file
pnpm test:e2e e2e/documents.spec.ts
```

Ship uses Playwright for end-to-end testing. The suite is 72 spec files in `e2e/`; the
last recorded full run executed **871 tests** — see
`docs/audit/raw/cat5-e2e-integration-final.txt`. `pnpm test` is unit tests only; it does
not run E2E.

`pnpm test` truncates whatever database `DATABASE_URL` points at. Re-run `pnpm db:seed`
afterwards if you were using that database for development.

---

## Deployment

Ship supports multiple deployment patterns:

| Environment | Approach | Terraform stack |
|-------------|----------|-----------------|
| **Local** | Docker Compose via `./start.sh` | — |
| **Dev** | AWS Elastic Beanstalk + S3/CloudFront | `terraform/environments/dev` |
| **Shadow (UAT)** | AWS Elastic Beanstalk + S3/CloudFront | `terraform/environments/shadow` |
| **Production** | AWS Elastic Beanstalk + S3/CloudFront, `us-east-1` commercial | `terraform/environments/prod` |

The AWS environments are Terraform-managed under `terraform/`; a Render stack also exists
at `terraform/render/`. Deploys run through `./scripts/deploy.sh <env>` (API) and
`./scripts/deploy-frontend.sh <env>` (web). See [DEPLOYMENT.md](./DEPLOYMENT.md) for the
full procedure.

### Docker

The Dockerfiles live at the repo root, not inside `api/` and `web/`, because both images
build from the workspace root so they can resolve `shared/`.

```bash
# Build the production API image (multi-stage, builds from source)
docker build -f Dockerfile -t ship-api .

# Build the web dev-server image
docker build -f Dockerfile.web -t ship-web .

# Run the full local stack (postgres + api + web) with Docker Compose
pnpm docker:up          # docker compose -f docker-compose.local.yml up --build
pnpm docker:down        # stop
pnpm docker:clean       # stop and drop the data volume
```

`docker-compose.local.yml` uses `Dockerfile.dev` for the API. `Dockerfile` is the
production image, which is what the Elastic Beanstalk and Render deploys build.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required (in production, loaded from SSM if unset) |
| `SESSION_SECRET` | Cookie signing secret | Required in production; dev falls back to an insecure default |
| `CORS_ORIGIN` | Allowed frontend origin | `http://localhost:5173` |
| `PORT` | API server port | `3000` |
| `BEDROCK_ENDPOINT` | Redirects the Bedrock client at a mock. Unset in production, where the SDK resolves the real regional endpoint | Unset |

The FleetGraph agent reads its own set — `DATABASE_URL`, `SHIP_API_TOKEN`,
`LANGCHAIN_*`, `BEDROCK_ENDPOINT`, `FLEETGRAPH_WORKSPACE_ID`. They are documented, with
the reason for each, in `agent/.env.example`. Copy it to `agent/.env` (gitignored) and
fill it in; nothing in the agent loads that file automatically, so source it before
running.

---

## Security

- **No external telemetry** — No Sentry, PostHog, or third-party analytics
- **Session timeout** — 15-minute idle timeout (government standard)
- **Audit logging** — Track all document operations

**One external request, and it is not optional today.** All application code, styles, and
images are served from your own infrastructure — there is no CDN-hosted JavaScript and no
runtime dependency on a third party. The exception is web fonts: `web/index.html` loads
Inter from `fonts.googleapis.com` (with a `preconnect` to `fonts.gstatic.com`), so every
page load reaches out to Google. In a closed or air-gapped network the request simply
fails and the browser falls back to the system font stack declared in
`web/src/index.css`, but the request is still attempted. Remove the three font `<link>`
tags in `web/index.html` if that is unacceptable in your environment.

> **Reporting Vulnerabilities:** See [SECURITY.md](./SECURITY.md) for our vulnerability disclosure policy.

---

## Accessibility

Ship targets Section 508 and WCAG 2.1 AA. The last full scan
(`docs/audit/scripts/measure-a11y.py`, 17 pages, axe-core + Lighthouse + Tab traversal)
measured:

- **10 outstanding critical/serious axe nodes** under the WCAG 2.1 AA + Section 508 tag
  set — 9 `color-contrast` on `/my-week` (worst 2.09:1 against the 4.5:1 threshold) and
  1 `aria-allowed-attr` on the weekly plan document
- **Lighthouse accessibility 100 on 15 of 17 pages**, 98 on `/login`, 96 on `/my-week`
- **Keyboard navigation** — every page exposes a skip link and a `main` landmark, but
  Tab traversal still leaves some elements unreachable on the docs home, projects list,
  and document editors
- **Visible focus indicators** throughout

Raw results are in `docs/audit/raw/cat7-phase2-after.txt`; the full analysis is in
[docs/audit/audit-report.md](./docs/audit/audit-report.md) under Category 7. The
conformance claim is not yet clean — treat the badges above as the target, not a
certification.

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## Documentation

- [Application Architecture](./docs/application-architecture.md) — Tech stack and design decisions
- [Unified Document Model](./docs/unified-document-model.md) — Data model and sync architecture
- [Document Model Conventions](./docs/document-model-conventions.md) — Terminology and patterns
- [Week Documentation Philosophy](./docs/week-documentation-philosophy.md) — Why weekly plans and retros work the way they do
- [Accountability Philosophy](./docs/accountability-philosophy.md) — How Ship enforces accountability
- [Accountability Manager Guide](./docs/accountability-manager-guide.md) — Using approval workflows
- [Contributing Guidelines](./CONTRIBUTING.md) — How to contribute
- [Security Policy](./SECURITY.md) — Vulnerability reporting

---

## License

[MIT License](./LICENSE)
