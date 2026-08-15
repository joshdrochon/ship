# Per-Epic Write-up — PlugForge (Week 6)

PRD p.13, Submission Requirements: *"Before → fix → after → proof. For Epic 6, proof is the
TTFE drill passing in CI. For Epic 7, proof is the agent's audit-log rows showing OAuth app
authentication."*

Seven epics, four headings each, in that order. Every **Proof** is a command with its output,
a CI job id, or pasted rows — never a description of work. Two proofs are the ones p.13 names
specifically: **Epic 6's is unmet and says so** (§Epic 6), **Epic 7's is produced here from a
live run** (§Epic 7).

---

## How the epics are numbered

The PRD never prints a numbered epic list. It fixes exactly two numbers, both on **p.11**:

| Anchor | p.11, verbatim |
|---|---|
| Epic 6 | *"Iterate by having the CLI **(E6)** consume the SDK as you build it."* |
| Epic 7 | *"Developer portal + agent rewire **(Epic 7)**."* — the eighth Priority Order item |

So the numbering below is p.11's Priority Order list with items 2 and 3 collapsed (both are the
Day-1 boundary work), which puts the CLI at 6 and the portal + agent rewire at 7 — exactly where
the PRD's own two labels land. That derivation is stated rather than assumed because it is the
one structural choice in this document that the PRD does not make for us.

| Epic | p.11 Priority Order item | Lanes | Where the code lives |
|---|---|---|---|
| E1 | 1 — OAuth foundation first | L02–L06 | `api/src/platform/oauth/`, `apps/`, `scopes/` |
| E2 | 2 + 3 — public/internal boundary, `ApiError` | L01, L07–L12 | `api/src/platform/api/v1/`, `ratelimit/`, `audit/` |
| E3 | 4 — OpenAPI generated from route metadata | L13 | `api/src/platform/openapi/` |
| E4 | 5 — webhooks end-to-end | L14–L16 | `api/src/platform/webhooks/` |
| E5 | 6 — SDK skeleton + resource clients + auth helpers | L17, L18 | `sdk/` |
| E6 | 7 — CLI reference integration (+ the TTFE drill) | L19, L20 | `integrations/cli/`, `scripts/ttfe/` |
| E7 | 8 — developer portal + agent rewire | L22, L23 | `web/src/pages/portal/`, `agent/src/data/citizenReader.ts` |

Rate limiting and the audit trail sit under E2: p.4 groups them with the SDK and the portal, but
both attach to the public request path built in items 2–3 and neither has a Priority Order item
of its own.

**The "before" in every section is one tree:** `5455f4e` on `main` — the Week 5 / Part 2 state.
Measured, not remembered:

```
$ git ls-tree 5455f4e --name-only | grep -E '^(sdk|integrations)$'      # (no output)
$ git ls-tree 5455f4e api/src/ --name-only | grep platform              # (no output)
```

---

## Reproducing any of this

Postgres is Docker (`ship-test-pg`, port 5432). Every number below was produced on branch
`pf/L26-per-epic-writeup` off `pf/integration` at `94f083e`, 2026-08-15.

```bash
docker exec ship-test-pg psql -U ship -d postgres -c 'CREATE DATABASE ship_wf_l26;'
export DATABASE_URL='postgresql://ship:…@localhost:5432/ship_wf_l26'
export AGENT_CLIENT_SECRET='<your own>'          # absent → no app row seeded, by design
pnpm --filter @ship/api db:migrate                # 61 migrations, then seedPlatformApps
pnpm build:shared && pnpm --filter @ship/sdk build && pnpm --filter @ship/agent build
```

**Build order matters and the documented order is wrong.** `pnpm --filter @ship/agent build`
fails with `Exit status 2` when `sdk/dist` is absent; building the SDK first fixes it. The
brief's order (shared → agent → sdk) was run first and failed. Recorded as F202.

---

## Epic 1 — OAuth foundation

#### Before

Ship had no OAuth of any kind. Two ways in: a session cookie (`api/src/middleware/`,
15-minute idle timeout) and `api_tokens`, a bearer table whose columns at `5455f4e` are
`id, user_id, workspace_id, name, token_hash, token_prefix, last_used_at, expires_at,
revoked_at, created_at` — **no scope column**. A token was all-or-nothing over the whole
workspace, and nothing in the schema could express otherwise.

#### Fix

`api/src/platform/oauth/` — three grants against one issuance site (`issue.ts`):
Authorization Code + PKCE (RFC 7636, S256), Device Authorization Grant (RFC 8628), and Client
Credentials (RFC 6749 §4.4, added by L23 for the agent). Refresh tokens are one-time-use with
family revocation on replay. `api/src/platform/apps/` holds `oauth_apps` with the secret hashed
and shown exactly once; `api/src/platform/scopes/` holds the seven scopes as data plus the
`require(scope)` middleware factory.

#### After

A wrong `code_verifier` returns `400 invalid_grant`. A replayed refresh token revokes
its whole family, and the live access token with it. Insufficient scope returns `403` naming the
missing scope in `details.missing_scope` — the envelope is flat, `code` is `forbidden`, and the
scope name lives in `details` (L99 F145). A public client cannot use Client Credentials at all,
which matters because `client_id` values are published in the README.

#### Proof

```
$ pnpm --filter @ship/api exec vitest run \
    src/platform/oauth/{endToEnd,authCodeGrant,deviceGrant,deviceScenario,rotation,bearer,mvpGate3}.test.ts \
    src/platform/apps/secrets.test.ts src/platform/scopes

 Test Files  8 passed (8)
      Tests  140 passed (140)
```

Exit 0. `mvpGate3.test.ts` is MVP gate item 3 (bearer validation on every `/api/v1/*` route);
`rotation.test.ts` carries the stolen-refresh-token case; `deviceScenario.test.ts` is p.5's
Testing Scenario 3 including the `slow_down` response.

---

## Epic 2 — Public/internal boundary, `ApiError`, resources, pagination, rate limit, audit

#### Before

One surface: `/api/*`, session + CSRF, error bodies whatever each route happened to
send. No versioning, no cursor pagination, no per-call record of who called what.

#### Fix

`api/src/platform/api/v1/` as a fresh router sharing no middleware with `api/src/routes/`.
`ApiError {code, message, details?, request_id}` on every public failure. Opaque base64 cursors
over `{id, timestamp}`. `ratelimit/` (token bucket, `X-RateLimit-*`, 429 + `Retry-After`) and
`audit/` (every public call recorded with client_id, user_id, route, scope, status, latency,
request_id). The boundary is enforced by ESLint `no-restricted-imports` plus a fence-checker that
asserts the rules actually fire.

#### After

Both surfaces call the same domain services; auth, scope, throttle, audit and webhook
publication attach only at the public layer, and the internal stack is unchanged
(`internalShapeUnchanged.test.ts`). A cross-import fails the build rather than being caught in
review.

#### Proof

```
$ node scripts/check-boundary-lint.mjs
  ok  PF-010  platform → middleware    1 violation(s) caught
  ok  PF-011  integrations → server    2 violation(s) caught
  ok  PF-558  integrations/cli → api/src 1 violation(s) caught
  ok  PF-692  agent → api/src          2 violation(s) caught
  …
  ok  control api/src/platform/webhooks/bus.ts — clean, so the fences are not rejecting everything
11 fences verified, positive control clean, workspace deps clean.
```

```
$ pnpm --filter @ship/api exec vitest run \
    src/platform/api/v1/{routeFitness,errorMiddleware,errors,pagination,paginationAssertion,responseContract,internalShapeUnchanged}.test.ts \
    src/platform/ratelimit/{headers,limiter}.test.ts \
    src/platform/audit/{recordContract,fieldFidelity,orderAndDurability}.test.ts

 Test Files  1 failed | 11 passed (12)
      Tests  1 failed | 203 passed (204)
```

**The one failure is not a platform defect and is not glossed over:** `errors.test.ts > PF-188 …
pins validation_failed → 422 (our call, recorded in docs/architecture.md)` — a documentation-latch
assertion that reads `docs/architecture.md` for the sentence recording the decision. The trim that
made Submission row 4 Ready moved that sentence to `docs/architecture-appendix.md`. It is one of
63 tests in that state repo-wide; the whole set is quantified in §Not proved, and it is filed as
F200.

---

## Epic 3 — OpenAPI 3.1, generated

#### Before

`api/src/openapi/` existed for the *internal* API and was hand-maintained. Nothing
described `/api/v1` because `/api/v1` did not exist.

#### Fix

`api/src/platform/openapi/` walks route metadata — Zod schemas declared adjacent to each
handler — and emits OpenAPI 3.1 in-process at `/api/v1/openapi.json`. A static copy is committed
at `docs/openapi.json`. Parity is a fitness test in both directions: every route has a spec entry,
every spec operation has a typed SDK call.

#### After

The spec cannot drift silently. Adding a route without a schema fails `specParity`;
adding a spec operation the SDK does not expose fails `sdkSurfaceParity`.

#### Proof

```
$ pnpm --filter @ship/api exec vitest run src/platform/openapi
 ✓ src/platform/openapi/registry.test.ts (17 tests)
 ✓ src/platform/openapi/schemaValidation.test.ts (8 tests)
 ✓ src/platform/openapi/specParity.test.ts (16 tests)
 ✓ src/platform/openapi/staticCopy.test.ts (4 tests)
 ✓ src/platform/openapi/route.test.ts (10 tests)
 ✓ src/platform/openapi/sdkSurfaceParity.test.ts (126 tests)
 ✓ src/platform/openapi/operations.test.ts (21 tests)
 ✓ src/platform/openapi/schemaAdjacency.test.ts (4 tests)
 Test Files  8 passed (8)
```

206 tests, 0 failed, exit 0. `schemaValidation.test.ts` validates the generated document against
the OpenAPI 3.1 JSON schema — p.5's Testing Scenario 5.

---

## Epic 4 — Webhooks: signing, retries, DLQ, replay

#### Before

Nothing left Ship. A document write updated a row and notified connected editors over
the collaboration socket; no external system could learn about it.

#### Fix

`api/src/platform/webhooks/`: event registry as data, `IEventBus` published from the
**domain** layer (never the route layer), subscription matcher, HMAC-SHA256 signer emitting
`Ship-Signature: t=<unix>,v1=<hex>`, `IWebhookDeliverer`, retry scheduler on the 1s/4s/16s/1m/5m/30m
ladder with jitter, delivery log, DLQ after six attempts, and replay carrying the original
`Idempotency-Key`. Every timing test injects a `Clock` — no `setTimeout` waits.

#### After

One event produces one delivery per matching subscription, each signed at send time
with that subscription's current secret. `Idempotency-Key` is derived from `event_id` **and**
`subscription_id`, persisted on the attempt-1 row and read back thereafter, so it survives retries
and replay.

#### Proof

```
$ pnpm --filter @ship/api exec vitest run \
    src/platform/webhooks/{testingScenario6,testingScenario7and8,signer,signatureVectors,dlqAndReplay,retryScheduler,bus,publishFitness}.test.ts

 Test Files  8 passed (8)
      Tests  156 passed (156)
```

Exit 0. `testingScenario6` and `testingScenario7and8` are p.5's Testing Scenarios 6, 7 and 8
verbatim — signed delivery within 2 s and tamper rejection; 500/500/500/200 with the ladder
observed; six failures into the DLQ and a replay that keeps its idempotency key.

Two files under `src/platform/webhooks/` are red — `architectureDoc.test.ts` (17) and
`retryClockFitness.test.ts` (1) — both documentation latches, both in the F200 set.

---

## Epic 5 — The typed SDK

#### Before

`sdk/` did not exist at `5455f4e`. Any consumer would have written its own `fetch`
calls against session-cookie routes.

#### Fix

`sdk/` as a workspace package `@ship/sdk`: four resource clients (`documents`, `issues`,
`sprints`, `webhooks`), `deviceLogin()` / `authorizationCodeFlow()` / `clientCredentials()`,
pluggable `ITokenStore` (in-memory, file at `~/.ship/credentials.json` mode 0600, browser), async-
iterator pagination that never exposes a cursor, a five-member discriminated error union, and
`verifyWebhook(headers, rawBody, secret, toleranceSec?)`.

#### After

A consumer switches exhaustively on `error.kind`; no stack trace crosses the boundary;
`for await (const doc of client.documents.iterate())` walks pages with no cursor in any consumer
signature. Surface stability is declared per export (stable vs pre-1.0) and pinned by a test.

#### Proof

```
$ pnpm --filter @ship/sdk test
 Test Files  2 failed | 14 passed (16)
      Tests  5 failed | 282 passed (287)
```

All five failures are in `fitness.test.ts` and `surfaceStability.test.ts`, and all five assert on
`docs/architecture.md` prose — the F200 set again; both files are red **only** on their
documentation checks, and every other assertion in them passed. Every behavioural file is green,
including
`pagination.test.ts` (async iterator), `webhooks.test.ts` (verifier: tampered body fails, expired
timestamp fails), `errors.parity.test.ts`, `installSize.test.ts` (the <250 KB budget) and
`verifyLatency.test.ts` (the <1 ms budget). The spec↔SDK direction is Epic 3's
`sdkSurfaceParity.test.ts`, 126 tests, green.

---

## Epic 6 — CLI reference integration and the TTFE drill

#### Before

No CLI, no drill. `integrations/` did not exist at `5455f4e`. Nobody had measured how
long a stranger takes to get from nothing to a verified signed webhook, so p.6's headline claim had
no number behind it.

#### Fix

`integrations/cli/` — `ship login` (device flow), `ship docs create`, `ship webhooks tail`
— importing **only** `@ship/sdk`, fenced by the boundary checker in Epic 2. `pnpm drill ttfe`
(`scripts/ttfe/drill.mjs` → `integrations/cli/tests/ttfe.drill.ts`) provisions a throwaway Postgres,
applies the migrations, boots `api/src/index.ts` on a free port, packs and installs the SDK tarball,
and runs the six stages, recording elapsed milliseconds per stage into `test-results/ttfe.json`.
Every threshold lives in one file, `ttfe.thresholds.json`.

#### After

The whole loop is one test with six stages, no stage skippable; stage 6 verifies the
signature of the bytes that actually arrived rather than a re-signed fixture. Two CI jobs exist,
`ttfe` and `ttfe-controls`, both `allow_failure: false`.

#### Proof

The local run passes; **the CI proof p.13 asks for does not exist.**

Local, this branch, 2026-08-15:

```
$ pnpm drill ttfe
TTFE (fast)
  stage                    elapsed
  ────────────────────────────────
  install                  1348 ms
  login                    5083 ms
  register subscription      27 ms
  create document            46 ms
  receive webhook             0 ms
  verify signature            1 ms
  ────────────────────────────────
  TOTAL                    6505 ms
 ✓ tests/ttfe.drill.ts (3 tests) 17405ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
ttfe: job wall clock 18.9 s

$ node scripts/ttfe/check-series.mjs
  pass rate            1/1
  totalMs P95          6505 ms  (budget 60000)
  event→POST P95       14 ms  (budget 2000)
  load-certified runs  1/1
ttfe series check OK
```

6 505 ms against p.8's 60 000 ms budget, `loadRatio` 0.634 so the timing is load-certified.

**p.13 does not ask for that. It asks for the drill passing *in CI*, and it has never done so.**

| Check | Result |
|---|---|
| `ttfe` job runs found on GitLab (`joshrochon/ship`) | **30+, across every branch and `main`** |
| Passing runs | **zero** |
| Most recent, pipeline **20166** / `pf/integration` | job **66185** `ttfe` — **failed**, job **66186** `ttfe-controls` — **failed** |

Both traces end the same way:

```
$ pnpm --filter @ship/cli exec tsc -p tsconfig.drill.json
$ node scripts/ttfe/check-fitness.mjs
ttfe fitness OK — 15 file(s): no sleeps, retry: 0, no Playwright, one thresholds file
$ docker pull postgres:16
/usr/bin/bash: line 196: docker: command not found
ERROR: Job failed: exit code 127
```

The drill's own fitness gate passes; the job dies on the line before the drill starts. The GitLab
runner image has **no `docker` binary**, and `.gitlab-ci.yml` declares **no `dind` service** for
these two jobs — deliberately, per the comment above the `ttfe` job, because `docker:27-dind`
"never attached to this runner's job network" and broke `agent-test`. So the drill needs
testcontainers, testcontainers needs a Docker socket, and the runner offers neither path.

**Epic 6's graded proof is therefore UNMET.** It is a runner/image change (a Docker-enabled
executor, or a socket mount, or a self-hosted runner that has one) — infrastructure, not code, and
not something this lane can fabricate. The local run above is offered as what *is* true, labelled
as what it is. Ticket **PF-808 stays ◐** until a job id exists.

`integrations/cli` itself is green: `pnpm --filter @ship/cli test` → **7 files, 58 tests passed**,
exit 0. (Re-measured 2026-08-15. The earlier "3 files, 41 tests" was true when written and had
gone stale by four files.)

---

## Epic 7 — Developer portal and the agent as a platform citizen

p.11's eighth item is two things. The portal is the short half and the rewire is *"the
architectural payoff"* — so the portal is disposed of first, and the rest of the section is the
rewire, which is what p.13 grades.

**The portal.** `web/src/pages/portal/PortalPage.tsx` lists apps, registers them, reveals and
rotates `client_secret` once, manages subscriptions, browses the delivery log and replays failed
deliveries. It reaches `/api/v1` through `@ship/sdk`'s `ShipClient` and adds no privileged route —
`web/src/lib/portalClient.ts:2`, with `portalTransport.test.ts` failing the build on a direct
`fetch('/api/v1…')`. That test is the portal's *entire* automated coverage: **1 file, 6 tests**,
green, and no e2e spec exists for it. p.4 grades six portal capabilities; six passing transport
assertions do not cover them, and that gap is real rather than hidden here (F204).

### The agent rewire

#### Before

FleetGraph was a privileged insider, and the schema is the evidence. It read Ship's
database directly (`agent/src/data/pool.ts`, `boundary.ts`, every file under `agent/src/detectors/`)
and wrote through `SHIP_API_TOKEN`, an `api_tokens` row — the table that at `5455f4e` has no scope
column at all. Its read surface was the entire database, bounded only by the fact that its own SQL
happened to be narrow, and no audit row anywhere said what it had done.

#### Fix

Four pieces (`docs/l23-epic7-writeup.md` carries the long form):

1. `grant_type=client_credentials` (RFC 6749 §4.4) — `api/src/platform/oauth/clientCredentialsGrant.ts`,
   gated to **first-party** and **confidential** apps. Both gates matter: a client-credentials token
   has no consenting human, and `authenticateClient` authenticates a *public* app on `client_id`
   alone — a value printed in the README.
2. `ShipClient.clientCredentials()` in `@ship/sdk`, not hand-rolled in the agent.
3. `agent/src/data/citizenReader.ts` — a `Queryable` router: recognised statements go to the public
   API, `fleetgraph_*` statements to the agent's own pool, **anything else throws by table name**.
   Zero changed signatures under `detectors/**`.
4. `SHIP_AGENT_VIA_SDK`, default off, read in exactly one non-test module.

#### After

The agent holds three scopes — `documents:read`, `issues:read`, `sprints:read` — and no
write scope. Its two former write actions became recommendation rows in `fleetgraph_notifications`.
Every Ship-data read it makes goes through the public API except three tables named and asserted in
`SQL_EXCEPTIONS`. That is the bounded claim; the unqualified one would be false.

#### Proof

The audit rows, from a live server.

Booted `api/src/index.ts` against `ship_wf_l26` on `:3131`, minted a token with the seeded agent
app's own secret, made four reads and one deliberate write, then read the trail back.

**1. The token.** `POST /oauth/token`, `grant_type=client_credentials`:

```json
{ "access_token": "ship_at_…<redacted>", "token_type": "Bearer",
  "expires_in": 3600, "scope": "documents:read issues:read sprints:read" }
```

No `refresh_token` — RFC 6749 §4.4.3 forbids one, and the grant honours it.

**2. The calls.** `GET /api/v1/me` → 200 · `/documents` → 200 · `/issues` → 200 · `/sprints` → 200 ·
`POST /api/v1/documents` → **403** (the agent holds no write scope; the platform refuses
independently of the agent's own refusal).

**3. The rows.** Query from [`docs/l23-epic7-proof.sql`](l23-epic7-proof.sql), run verbatim:

```
$ docker exec ship-test-pg psql -U ship -d ship_wf_l26 -c "SELECT occurred_at, client_id, user_id,
    method || ' ' || route AS call, scope_used, status, latency_ms, request_id
  FROM public_api_calls WHERE client_id = 'ship_app_firstparty_fleetgraph_agent'
  ORDER BY occurred_at DESC LIMIT 50;"

        occurred_at         |              client_id               | user_id |          call          |   scope_used    | status | latency_ms |              request_id
----------------------------+--------------------------------------+---------+------------------------+-----------------+--------+------------+--------------------------------------
 2026-08-15 06:05:54.44+00  | ship_app_firstparty_fleetgraph_agent |         | POST /api/v1/documents | documents:write |    403 |   3.912833 | 508fcd42-ca72-4b04-b6dc-5368f2c4ed75
 2026-08-15 06:05:54.424+00 | ship_app_firstparty_fleetgraph_agent |         | GET /api/v1/sprints    | sprints:read    |    200 |   2.834875 | 60feb3b8-b4c0-45fe-bd4b-69a53aba9352
 2026-08-15 06:05:54.413+00 | ship_app_firstparty_fleetgraph_agent |         | GET /api/v1/issues     | issues:read     |    200 |   2.851041 | 754d4f7b-4e4f-4b30-8f42-a75fe3541bbe
 2026-08-15 06:05:54.402+00 | ship_app_firstparty_fleetgraph_agent |         | GET /api/v1/documents  | documents:read  |    200 |      4.292 | e08ee6a6-2e0f-4006-bcb1-6799f510a614
 2026-08-15 06:05:54.389+00 | ship_app_firstparty_fleetgraph_agent |         | GET /api/v1/me         |                 |    200 |   4.954042 | 50d0e572-e955-44c5-b3b5-2a1d925d0d4c
(5 rows)
```

Read the columns, because they are the epic:

- **`client_id` is the agent's own OAuth app** on every row — `ship_app_firstparty_fleetgraph_agent`,
  a fixed constant in `api/src/db/platformApps.ts`, not a per-environment value. This is p.13's
  literal requirement: audit-log rows showing OAuth app authentication.
- **`user_id` is NULL on every row.** Client credentials binds no user; nobody approved these calls
  interactively.
- **`scope_used` is the granted read scope, and NULL on `/me`** — `/me` declares no scope because
  none of p.3's seven names the authenticated identity (L99 F146; PF-709's wording is one route off
  and the shipped assertion says so).
- **The 403 is deliberate.** It is the platform enforcing read-only, and the refusal is *in the
  trail*. The `api_tokens` design this replaced could not have expressed the boundary, let alone
  recorded its enforcement.

**4. The counter-checks**, same run:

```
 calls | failures | distinct_routes | distinct_users | distinct_scopes
-------+----------+-----------------+----------------+-----------------
     5 |        1 |               4 |              0 |               4

$ … SELECT DISTINCT user_id … WHERE client_id = 'ship_app_firstparty_fleetgraph_agent'
      AND user_id IS NOT NULL;
 (0 rows)
```

`distinct_users = 0` is the number to look at: a non-zero value would mean some *other* grant is
minting tokens for this app, which is what the first-party-and-confidential gate exists to prevent.

**5. What the rows cannot prove, and what covers it.** These rows prove *some* calls went through
the front door. They cannot prove *every* action did — a missing call writes no row, and no query
sees an absence. That half is the fitness test, which runs a detector under the flag and asserts
the table invariant for the same run:

```
$ pnpm --filter @ship/api exec vitest run \
    src/platform/api/v1/agentCitizenFitness.test.ts \
    src/platform/oauth/agentAppCitizen.test.ts \
    src/platform/oauth/clientCredentials.test.ts
 ✓ src/platform/oauth/clientCredentials.test.ts (22 tests)
 ✓ src/platform/api/v1/agentCitizenFitness.test.ts (12 tests)
 ✓ src/platform/oauth/agentAppCitizen.test.ts (16 tests)
 Test Files  3 passed (3)
```

50 tests, 0 failed, exit 0. **One honest caveat:** `agentCitizenFitness.test.ts` is green here and
green in CI job **66183**, but it **failed in CI job 66027** (pipeline 20124) on
*"a full flag-on detector run produces audit rows, and the count is NOT ZERO — expected 0 to be
greater than 0"*. Same commit family, opposite result: it is flaky in CI and the cause is not
diagnosed. Filed as F201. The rows above are a live capture and do not depend on it.

---

## What this document does not prove

Three things, stated here rather than left for a grader to find.

**1. Epic 6's CI proof is unmet.** Detailed above with job ids and the trace. `pnpm drill ttfe`
passes locally in 6.5 s; it has never run to completion in CI because the runner has no Docker.
Board state: **PF-808 ◐**, not ☑.

**2. 63 tests are red repo-wide, and every one of them is a documentation latch.** Not a platform
regression — the count moved when a *document* moved:

| Tree | `test` job | Result |
|---|---|---|
| pipeline 20124, the commit before the architecture trim | 66027 | **1 failed · 2912 passed** |
| pipeline 20133, the trim merge `c8f85c8` | 66075 | **14 failed · 2855 passed** |
| this branch at `94f083e`, locally | — | **58 failed · 2855 passed** (api) + **5 failed · 282 passed** (sdk) |

**All 14 failing api files and both failing sdk files read `docs/architecture.md`** and assert on
prose that the row-4 trim moved into `docs/architecture-appendix.md` — checked file by file, not
inferred from the names (`webhooks/architectureDoc`, `oauth/architectureDoc`, `oauth/pkceDiagramLatch`,
`oauth/deviceVerify`, `oauth/deviceSeam`, `audit/queryAndProof`, `audit/retention`,
`ratelimit/decisions`, `webhooks/retryClockFitness`, `api/v1/{routeMetadata,errors,consumerContract}`,
`__tests__/platform-layout`, `routes/apps`, sdk `fitness`, sdk `surfaceStability`). CI's most recent
run shows one extra failure that is **not** a doc latch —
`src/routes/fleetgraph/fleetgraph.test.ts > POST /approvals/:id/accept (FG-140)` — which passed
locally and is not attributed here.

The trim was correct — p.13 caps the document at 1–2 pages — and the latches were correct too;
nobody re-pointed them. Filed as **F200**; the fix is a one-line path change per file, not a rewrite.

**3. Two proofs in this document are single runs on a loaded machine.** L99 F80 measured per-route
P95 spreads up to 6.0× on this hardware. The TTFE number carries its own `loadRatio` (0.634,
certified) and the audit-row latencies are not offered as performance figures at all.

---

## Ticket state after this document

| Ticket | State | Why |
|---|---|---|
| PF-807 — four headings, every epic | ☑ | Seven epics, `before → fix → after → proof` in that order, every proof an artifact |
| PF-808 — Epic 6 proof in CI | ◐ | No passing `ttfe` job exists; runner has no Docker (jobs 66185/66186, exit 127) |
| PF-809 — Epic 7 audit rows | ☑ | Live rows above, plus the query file and the fitness run |
