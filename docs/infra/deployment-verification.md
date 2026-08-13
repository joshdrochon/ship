# Deployment verification log — MVP gate item 10

**Tickets:** PF-628, PF-629, PF-630 · **PRD:** p.2 (gate item 10), p.13, p.17, p.18
**Environment:** `ship-api-prod` (application `ship-api`), account `379484935796`, `us-east-1`

This is the only document in the repo that asserts the deployment works. Everything else
describes configuration. Entries carry the date, the command, and the verbatim result —
including the failures, because four deploys were needed and the three that failed are
where the lessons are.

---

## 2026-08-13T01:00:58Z — PASS

**Deployed version:** `ship-api-58b16c1`
**Commit:** `58b16c11dca110fb6bc256dfbc10d1314d9a6b99`
**Base URL:** `http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com`

```console
$ scripts/verify-deployment.sh http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com \
    58b16c11dca110fb6bc256dfbc10d1314d9a6b99

--- 1. GET /health ---
HTTP 200
body: {"status":"ok","revision":"58b16c11dca110fb6bc256dfbc10d1314d9a6b99"}
  ok — valid JSON
  ok — reports the deployed commit 58b16c11dca110fb6bc256dfbc10d1314d9a6b99

--- 2. GET /api/v1/openapi.json (no Authorization header) ---
HTTP 200
first 400 bytes: {"openapi":"3.1.0","info":{"title":"Ship Public API","version":"1.0.0",...
  ok — parses as JSON, openapi version = 3.1.0
  note — documents 0 path(s)

--- 3. GET /api/v1/__does_not_exist (expect the ApiError envelope) ---
HTTP 401
body: {"code":"unauthorized","message":"Bearer token required.","details":{"reason":"missing"},"request_id":"fe2b4370-..."}
  ok — ApiError envelope with a request_id; the public router is mounted

=================== verdict ===================
PASS — deployed, publicly reachable, and the spec resolves as JSON.
```

**Grader apps present in the deployed database** — from the container's own boot log
(`/aws/elasticbeanstalk/ship-api-prod/var/log/eb-docker/containers/eb-current-app/stdouterr.log`,
stream `i-058cbd2dcb6852ba5`):

```
Running database migrations...
✅ 3 first-party app(s) seeded: ship_app_firstparty_fleetgraph_agent, ship_app_grader_readonly, ship_app_grader_demo
✅ All migrations already applied
```

### What this does and does not establish

| Gate item 10 clause | Status | Evidence |
|---|---|---|
| Deployed and publicly accessible | **MET** | `/health` returns JSON carrying the deployed SHA, from the public internet |
| Published OpenAPI spec URL resolves | **MET** | `GET /api/v1/openapi.json` → 200, valid OpenAPI 3.1.0, **no credentials** |
| At least one OAuth app pre-registered, read-only scopes | **MET, with a caveat below** | Seeded in the deployed database on every `db:migrate`; scopes are `documents:read`, `issues:read`, `sprints:read` |

**The caveat, stated plainly because it would be dishonest to leave the table above
standing alone.** A grader cannot currently *exercise* the pre-registered app end to end
against this deployment, and that is not an infrastructure problem:

- **`POST /oauth/token` returns 404.** The OAuth endpoints are L04/L05's and are **not on
  `pf/integration`**, which is the branch this deployment was built from. There is no way
  to exchange the published `client_id`/`client_secret` for an access token yet.
- **The spec documents 0 paths.** `/api/v1` has no resource routes: L09's and L10's
  `mountResources` work is likewise not on `pf/integration`. The `TODO(L09/L10)` in
  `api/src/app.ts` is still a TODO.

So PF-630's stronger clause — *"a grader using the published `client_id` can read and a
write attempt returns 403"* — **cannot be demonstrated today**, because there is nothing to
read and no token endpoint to read it with. What is proven is that the app rows exist in
the deployed database with read-only scopes, seeded by a mechanism that re-runs on every
deploy.

**This closes the moment L04/L05 and L09/L10 land on the integration branch and are
redeployed.** Nothing in this lane needs to change for that to happen; the deploy path,
the seeding and the spec route are all in place. It should be re-verified, and this log
appended to, after that merge.

---

## Deploy history — including the three failures

Recorded because "it works now" is a much weaker claim than "here is what broke and why."
Full timings in `docs/infra/apply-timing.md`.

| # | Version | Result | Root cause |
|---|---|---|---|
| 1 | `ship-api-aaf6669` | **Silent non-deploy.** EB reported success in 48s; health Green; `curl /health` returned 200 | The bundle contained `docker-compose.yml`, and the EB AL2023 Docker platform prefers it over `Dockerfile`. EB started the **local development Postgres** and no application container. The 200 was the EB sample app, which answers 200 with HTML on every path — including `/api/v1/openapi.json`. |
| 2 | `ship-api-3ffa041` | Build failed | `ssm.ts(108,19): error TS2538` — my own `noUncheckedIndexedAccess` violation, reached AWS because a local `type-check` reported exit 0 while actually printing `sh: tsc: command not found` (no `node_modules` in the worktree) and the real exit code was swallowed by a pipe to `tail`. |
| 3 | `ship-api-ba83dae` | Built, container started, then died | `ERR_MODULE_NOT_FOUND: supertest` — three modules in the production bundle imported a devDependency at module scope. Invisible everywhere except a `--prod` install. Migrations and seeding had already succeeded, so the deploy looked ~90% healthy while returning 5xx. |
| 4 | `ship-api-7706771` → `ship-api-58b16c1` | **PASS** | The supertest fix exposed one more: the spec route was mounted without a `routeMetadata.declare()` record, so `assertEveryRouteDeclaresList` refused to wire the app — PF-228's harness working exactly as designed, at boot rather than in a test. |

**The generalisable lesson from #1, and the reason `scripts/verify-deployment.sh` asserts
on content rather than status codes:** a 200 from `/health` is not evidence of a
deployment. Before this lane, the environment had been Green and serving 200s for hours
with no application on it at all.

**The generalisable lesson from #2 and #3:** validate the artifact you are about to ship,
not one that resembles it. Deploy #4 was preceded by building the exact bundle locally and
booting it against a throwaway Postgres — `docker run` on the same zip — which is what
turned the third failure from a fourth failed deploy into a caught bug:

```console
$ docker run -d --name ship-pf-app -p 8123:80 -e DATABASE_URL=... ship-preflight:58b16c1
$ scripts/verify-deployment.sh http://localhost:8123 58b16c11dca...
PASS — deployed, publicly reachable, and the spec resolves as JSON.
```
