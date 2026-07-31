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

> **Reviewing the ShipShape audit and improvements?** Start at
> **[SUBMISSION.md](SUBMISSION.md)** — it maps every deliverable to its file, lists the
> measured before/after for all eight categories, and shows how to reproduce each number.
> This README describes the product; that file describes the work done to it.

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

Ship is a monorepo with three packages:

- **web/** — React frontend with TipTap editor for real-time collaboration
- **api/** — Express backend with WebSocket support
- **shared/** — TypeScript types used by both

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
