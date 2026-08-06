# FleetGraph — Ticket Board

Working checklist for the Week 5 FleetGraph build. Not a graded deliverable — the graded
files are `PRESEARCH.md` and `FLEETGRAPH.md`. This is the execution plan behind them, and the
import source for Linear.

| | |
|---|---|
| **Source of truth** | `GFA_Week_5_FleetGraph_Updated.pdf` — extracted to `.claude/prd/` (gitignored), sha `2e9d2409…` |
| **Architecture decisions** | `PRESEARCH.md` — every ticket below traces to a Q there |
| **Branch** | `feat/fleetgraph-presearch` off `main` @ `1ca148f` |
| **MVP** | **Tuesday 11:59 PM** — §M tickets |
| **Early Submission** | Thursday 11:59 PM — §E tickets |
| **Final** | Sunday noon — §F tickets |

**Deployment decision (locked):** Terraform builds a fresh Render environment from zero; the
API-created service retires. `url` and `slug` are Render-computed, so the required
destroy-and-redeploy test produces a new URL under any approach. Week 4 is already graded, so
nothing depends on the old one.

**Reversibility note:** `FG-021` (the data-access boundary) is what keeps "one database" a
two-way door. Every cross-boundary join goes through that module. If joins spread inline
across node code, splitting the database later stops being feasible — see `PRESEARCH.md` Q19.

---

## Working process

Authority is split, and nothing is maintained by hand in both places:

| | Owns |
|---|---|
| **This file** | What tickets *exist* — the definition |
| **Linear** | What state they are *in* — the live board |

**Never hand-edit a checkbox below.** They are generated from Linear by
`scripts/linear-import.mjs --sync`. Editing one by hand creates drift that looks like
progress; that is precisely what happened on 2026-08-03, when ten M0 tickets were checked
here and left in Backlog on the board for an hour.

```bash
# add newly written tickets to Linear (idempotent — skips what exists)
node scripts/linear-import.mjs

# claim work / complete it — accepts ids and inclusive ranges
node scripts/linear-import.mjs --set "In Progress" FG-050-FG-052
node scripts/linear-import.mjs --set Done FG-050,FG-051

# pull state back into the checkboxes below
node scripts/linear-import.mjs --sync

# check the board against git history — run before every commit
node scripts/linear-import.mjs --verify

# any command takes --dry-run
```

Single-ticket moves during normal work can go through the Linear MCP server directly —
that is what it is good at. `--set` exists for the batch case, because Linear's MCP writes
one issue per call and work tends to complete in batches.

### Closing a ticket requires a commit

`--sync` only guarantees that this file matches the board. It cannot tell whether the board
matches reality — it would faithfully propagate a ticket closed with nothing behind it, and
then both would agree and neither would be right.

`--verify` is the check that compares the board against something not derived from it: every
ticket marked Done must be named in a **`Closes:` trailer** on a commit. It exits non-zero
when one is not, so a false close fails rather than passes quietly.

```
Closes: FG-040..FG-049
Closes: FG-050, FG-052
```

A trailer, not the message body, because prose cannot distinguish a claim from a mention.
The first version of this check grepped the whole message and immediately reported
`FG-222..FG-227` as closed — they appear in a commit only as *"(FG-222..FG-227) needs those
states executable"*, describing future work.

**Only mark In Progress what is actually being worked on now.** Claiming a whole section up
front makes the board say seventeen things are underway when one is.

---

## Requirement traceability

The nine MVP requirements from the brief (p.3), and the tickets that satisfy each.

| # | MVP requirement | Tickets |
|---|---|---|
| 1 | Graph running, ≥1 proactive detection end-to-end | M2, M3, M5 |
| 2 | LangSmith tracing, ≥2 trace links, different execution paths | M9 |
| 3 | `FLEETGRAPH.md` — Agent Responsibility + Use Cases (≥5) | M11 |
| 4 | Graph outline — node types, edges, branching conditions | M11 |
| 5 | ≥1 human-in-the-loop gate implemented | M6 |
| 6 | Running against real Ship data, no mocked responses | M5, M10 |
| 7 | Agent chat **and** notifications accessible in the UI | M7, M8 |
| 8 | Deployed via Terraform, `/health` + `/ready`, annotated plan, destroy test | M10 |
| 9 | Trigger model documented and defended | M11 |

---

# §M · MVP — due Tuesday 11:59 PM

## M0 · Foundations

- [x] **FG-001** Create branch `feat/fleetgraph-mvp` off `main`
- [x] **FG-002** Commit `PRESEARCH.md` (currently uncommitted)
- [x] **FG-003** Commit `TICKETS.md`
- [x] **FG-004** Commit the `.claude/CLAUDE.md` E2E test-DB lifecycle correction
- [x] **FG-005** Add workspace package `agent/` to `pnpm-workspace.yaml`
- [x] **FG-006** `agent/package.json` — name `@ship/agent`, type module, matching Node engine
- [x] **FG-007** `agent/tsconfig.json` extending the root config (do **not** repeat `web/`'s mistake of not extending)
- [x] **FG-008** Install `@langchain/langgraph`, `@langchain/core` in `agent/`
- [x] **FG-009** Install `@langchain/aws` (Bedrock, reuses existing credentials path)
- [x] **FG-010** Install `langsmith`
- [x] **FG-011** Install `@langchain/langgraph-checkpoint-postgres`
- [x] **FG-012** Add `agent/` to root `pnpm build`, `type-check`, `lint`, `test` scripts
- [x] **FG-013** Verify `pnpm type-check` passes with the new package empty
- [x] **FG-014** Add `agent/src/index.ts` stub exporting nothing, to prove the build wiring
- [x] **FG-015** **Spike:** confirm LangGraph JS `interrupt()` state survives a process exit with the Postgres checkpointer — **PASSED** 2026-08-03, langgraph 1.4.8 / checkpoint-postgres 1.0.4. 8/8 assertions; pre-interrupt nodes did not re-run
- [x] **FG-016** Record the spike result in `PRESEARCH.md` open items

## M1 · Data layer

- [x] **FG-017** Migration `038_fleetgraph.sql` — create file, register in migration order
- [x] **FG-018** `038`: index `documents (workspace_id, updated_at)` — the watermark scan seq-scans without it (`PRESEARCH.md` Q1)
- [x] **FG-019** `038`: `api_tokens.scopes` column, nullable text[], default null = full permissions (backward compatible)
- [x] **FG-020** `038`: table `fleetgraph_observations` — id, workspace_id, fingerprint, signal_type, target_id, target_type, first_seen_at, last_surfaced_at, resolution, resolved_at, snooze_until
- [x] **FG-021** `038`: unique index on `(workspace_id, fingerprint)` — the suppression key. **This is the cost cliff from Q32; get it right**
- [x] **FG-022** `038`: table `fleetgraph_notifications` — id, workspace_id, observation_id, recipient_user_id, title, body, state, acknowledged_at, created_at
- [x] **FG-023** `038`: table `fleetgraph_watermarks` — workspace_id PK, last_scanned_at, last_run_completed_at
- [x] **FG-024** `038`: indexes for notification lookup by recipient + state
- [x] **FG-025** Run `038` against local dev, verify it applies cleanly
- [x] **FG-026** Verify `038` rolls back cleanly on failure (migrations run in a transaction)
- [x] **FG-027** Re-run `038` to confirm idempotency (`IF NOT EXISTS` everywhere)
- [x] **FG-028** `EXPLAIN ANALYZE` the watermark query before and after the index; record both
- [x] **FG-029** `agent/src/data/boundary.ts` — **the single module holding every query that joins agent tables to Ship tables.** Keeps the one-database decision reversible
- [x] **FG-030** Header comment in `boundary.ts` pointing at `PRESEARCH.md` Q19 and stating the reversal path
- [x] **FG-031** `boundary.ts`: `getWatermark(workspaceId)`
- [x] **FG-032** `boundary.ts`: `setWatermark(workspaceId, ts)` — only called on a completed run (Q24 crash-safety)
- [x] **FG-033** `boundary.ts`: `loadSuppressionSet(workspaceId)`
- [x] **FG-034** `boundary.ts`: `recordObservation(...)`
- [x] **FG-035** `boundary.ts`: `resolveObservation(id, resolution)`
- [x] **FG-036** `boundary.ts`: `createNotification(...)`
- [x] **FG-037** `agent/src/data/pool.ts` — Postgres pool, reads `DATABASE_URL`, bounded connection count (Render free tier caps connections)
- [x] **FG-038** Unit test: watermark round-trip
- [x] **FG-039** Unit test: suppression fingerprint uniqueness constraint rejects duplicates

## M2 · Detectors

- [x] **FG-040** `agent/src/detectors/types.ts` — `Signal` shape: type, target_id, target_type, measurement, threshold, fingerprint
- [x] **FG-041** `agent/src/detectors/fingerprint.ts` — deterministic fingerprint from (signal_type, target_id, threshold bucket)
- [x] **FG-042** Unit test: same input → same fingerprint; different bucket → different fingerprint
- [x] **FG-043** `agent/src/detectors/businessDays.ts` — reuse `api/src/utils/business-days.ts` rather than reimplementing
- [x] **FG-044** Verify business-days util is importable across packages, or promote to `shared/`
- [x] **FG-045** **Detector 1 — stalled work.** `state='in_progress'`, `started_at` older than N business days, `updated_at` unchanged since
- [x] **FG-046** Detector 1: use `updated_at`, **not** `document_history` absence — history has coverage holes (`PRESEARCH.md` Q1)
- [x] **FG-047** Detector 1: threshold as config constant, default 5 business days
- [x] **FG-048** Detector 1: exclude archived and soft-deleted documents
- [x] **FG-049** Detector 1: unit test against fixture data
- [x] **FG-050** **Detector 2 — sprint-miss risk.** Sprint `end_date` within 2 business days, issues still `todo`/`backlog`
- [x] **FG-051** Detector 2: resolve sprint→issue via `document_associations` (relationship_type `sprint`), not legacy columns
- [x] **FG-052** Detector 2: unit test
- [x] **FG-053** **Detector 3 — review bottleneck.** `state='in_review'`, `updated_at` unchanged N business days
- [x] **FG-054** Detector 3: threshold constant, default 2 business days
- [x] **FG-055** Detector 3: unit test
- [x] **FG-056** **Detector 4 — load imbalance.** `COUNT(*) GROUP BY properties->>'assignee_id'` vs team median
- [x] **FG-057** Detector 4: define "team" as sprint participants, not the whole workspace
- [x] **FG-058** Detector 4: guard against a team of 1 (median is meaningless)
- [x] **FG-059** Detector 4: unit test
- [x] **FG-060** **Detector 5 — rework churn.** `reopened_at` set, or repeated `done → in_progress` in `document_history`
- [x] **FG-061** Detector 5: this is the one detector that legitimately reads `document_history` — `state` is a tracked field
- [x] **FG-062** Detector 5: unit test
- [x] **FG-063** `agent/src/detectors/index.ts` — run all five, return `Signal[]`
- [x] **FG-064** All detectors accept a watermark and scope only to documents changed since
- [x] **FG-065** Integration test: all five detectors against a seeded database
- [x] **FG-066** Verify a quiet workspace returns zero signals (the triage-gate path)

## M3 · Graph core

- [x] **FG-067** `agent/src/graph/state.ts` — the typed state object from `PRESEARCH.md` Q18
- [x] **FG-068** State: keep `signals` (measured) separate from `findings` (judged) — the trace must show where determinism ends
- [x] **FG-069** `agent/src/graph/nodes/triggerRouter.ts`
- [x] **FG-070** `agent/src/graph/nodes/resolveScope.ts` — workspace scope (proactive) or document id (on-demand)
- [x] **FG-071** `resolveScope`: on-demand path resolves the document, its associations, recent history, participants
- [x] **FG-072** `agent/src/graph/nodes/fetchSignals.ts`
- [x] **FG-073** `agent/src/graph/nodes/fetchParticipants.ts`
- [x] **FG-074** `fetchParticipants`: derive roles structurally — assignee / owner / reports_to (`PRESEARCH.md` Q5)
- [x] **FG-075** `agent/src/graph/nodes/fetchPriorState.ts`
- [x] **FG-076** Wire the three fetch nodes as a parallel fan-out (Q16)
- [x] **FG-077** `agent/src/graph/nodes/triageGate.ts` — **conditional edge**, terminates on zero signals
- [x] **FG-078** `agent/src/graph/nodes/judgeSignals.ts`
- [x] **FG-079** `agent/src/graph/nodes/composeAnswer.ts` — on-demand, read-only
- [x] **FG-080** `agent/src/graph/nodes/routeAction.ts` — **conditional edge** on blast radius
- [x] **FG-081** `agent/src/graph/nodes/executeAutonomous.ts`
- [x] **FG-082** `agent/src/graph/nodes/awaitApproval.ts` — `interrupt()`
- [x] **FG-083** `agent/src/graph/nodes/executeApproved.ts`
- [x] **FG-084** `agent/src/graph/nodes/deliver.ts` — notify, record observation, advance watermark
- [x] **FG-085** `agent/src/graph/index.ts` — assemble nodes and edges
- [x] **FG-086** Wire conditional edge 1: trigger mode
- [x] **FG-087** Wire conditional edge 2: `signals.length === 0` → terminate quiet
- [x] **FG-088** Wire conditional edge 3: `findings.length === 0` → terminate quiet
- [x] **FG-089** Wire conditional edge 4: action class → autonomous vs gated
- [x] **FG-090** Configure the Postgres checkpointer against the Ship database
- [x] **FG-091** Verify checkpointer tables are created on first run
- [x] **FG-092** Unit test: quiet run terminates at `triageGate` with **zero** LLM calls
- [x] **FG-093** Unit test: run with signals reaches `judgeSignals`
- [x] **FG-094** Unit test: state object is fully populated at `deliver`
- [x] **FG-272** **Bug.** `resolveScope` mapped `field: r.field_name` after the SELECT was corrected to `field`, so every on-demand history entry reached the answer prompt as `undefined`. The query stopped throwing, so the test stayed green. The regression test asserts the value, not the absence of an exception.
- [ ] **FG-273** **Bug, two of them.** (a) `closeQuiet` advanced the watermark on an `ai_unavailable` run, closing a window whose signals were never judged — contradicting `judgeSignals`' own header. (b) `awaitApproval` stored a computed `pending_thread_id` unrelated to the checkpointer's real thread, so the approval endpoint would have resumed an id that does not exist. Invisible to the graph tests, which compile without a checkpointer.

## M4 · Judgment

- [x] **FG-095** `agent/src/llm/client.ts` — `ChatBedrockConverse` via `@langchain/aws`
- [x] **FG-096** Reuse `BEDROCK_ENDPOINT` env override so CI hits the existing mock (stable fakes requirement) — override is wired; **blocked on FG-271**, the mock does not answer the endpoint the client calls
- [ ] **FG-271** Add a `/converse` expectation to both Bedrock fakes. `ChatBedrockConverse` calls `POST /converse`; `mocks/bedrock-expectations.json` and `e2e/fixtures/mock-bedrock.ts` only answer `POST /model/*/invoke` and 404 everything else, so CI cannot exercise judgement at all. The response must be Converse-shaped and carry a `toolUse` block, because `withStructuredOutput` binds the schema as a tool. Engineering requirement 3.
- [x] **FG-097** Wrap the LLM call in the existing `CircuitBreaker` from `api/src/services/circuitBreaker.ts`
- [x] **FG-098** Promote `circuitBreaker.ts` to `shared/` or import cross-package — do not duplicate it
- [x] **FG-099** Explicit timeouts matching the existing values: 3s connect, 20s request, 3 attempts
- [x] **FG-100** `agent/src/llm/prompts/judge.ts` — the judgment system prompt
- [x] **FG-101** Judge prompt receives **measurements**, never raw project data (`PRESEARCH.md` Q31)
- [x] **FG-102** Judge prompt output schema: severity, recipient, worth_surfacing, phrasing
- [x] **FG-103** Structured-output parsing with a validation fallback to `ai_unavailable`
- [x] **FG-104** Batch all signals for a scope into **one** judgment call (Q32 cost cliff)
- [x] **FG-105** `agent/src/llm/prompts/answer.ts` — on-demand grounded-answer prompt
- [x] **FG-106** Answer prompt is explicitly read-only; no tool access
- [x] **FG-107** Content-hash cache on judgment input, reusing the `computeContentHash` pattern
- [x] **FG-108** Unit test: judgment with a mocked LLM returns parsed findings
- [x] **FG-109** Unit test: circuit-open returns `ai_unavailable` without calling the provider

## M5 · Trigger

- [x] **FG-110** `agent/src/entrypoints/cron.ts` — the proactive entrypoint
- [x] **FG-111** Cron: read watermark → run graph → advance watermark **only on completion** (Q24)
- [x] **FG-112** Cron: exit non-zero on failure so the scheduler reports it
- [x] **FG-113** Cron: advisory lock per workspace so a proactive run and an on-demand run cannot race
- [x] **FG-114** Cron: structured log line per run — signals found, findings surfaced, tokens spent
- [x] **FG-115** Cron: bounded total runtime, exits rather than hanging
- [x] **FG-116** Add `agent:cron` script to `agent/package.json`
- [x] **FG-117** Dockerfile: ensure `agent/` is built into the image
- [x] **FG-118** Verify the same image can run either entrypoint (`start_command` override)
- [x] **FG-119** End-to-end local run: seed → mutate an issue → cron detects it
- [x] **FG-120** Verify a second immediate run detects **nothing** (suppression works)
- [x] **FG-121** Verify a crashed run does not advance the watermark
- [ ] **FG-274** Wire the real Ship action client into the cron, replacing the FG-122 placeholder. Resolved per run so a missing `SHIP_API_TOKEN` degrades commenting rather than killing the process before detection happens.
- [ ] **FG-277** **Bug.** The deployed cron would have traced nothing. LangChain uploads traces on a background queue that dies when a cron container exits, so the run succeeds and LangSmith stays empty. Fixed in code and in `terraform/render/cron.tf`. Measured: same run, 0 sessions without the flag, trace with it.
- [ ] **FG-278** **Bug.** `resetCheckpointer()` dropped the cached `PostgresSaver` without closing its pool, so `cron.test.ts` stopped its container on live connections. 162 assertions passed, 8 unhandled `57P01` fired after the summary, exit 1 — CI would have read red on a fully green run.
- [ ] **FG-279** **The API-to-graph seam does not exist.** `agentBridge.ts:91` throws `agent_not_wired`; the three approval routes persist a decision and hardcode `resumed: false`; nothing loads the checkpointer or issues `Command({ resume })`. Chat UI, route, Zod schema, rate limit and visibility filter are all real — the call at the centre is a stub. **Blocked on FG-280.**
- [ ] **FG-280** **Decision + move: break the api↔agent build cycle.** `agent/` imports `CircuitBreaker` from `api/dist` by relative path, so `api/` importing `agent/dist` would make neither buildable. Fix is to promote `circuitBreaker.ts` into `shared/` (the option FG-098 named first), leaving a re-export in `api/` for back-compat. Additive and reversible. Needs a human call — it changes package structure.
- [ ] **FG-281** **Bug.** `makeJudge` flattened `ai_unavailable` to `[]`, so the graph read an unreachable model as "nothing worth surfacing", routed to `close_quiet`, and advanced the watermark — closing a scan window whose signals were never judged. `closeQuiet`'s own guard never saw the outcome because the status died a layer below. FG-121 passed throughout: its fake judge threw, the real one did not.
- [ ] **FG-282** **Bug.** `makeAnswer` flattened `ai_unavailable` to its notice text, so the graph set `outcome: 'answered'` with a non-empty answer and the chat endpoint replied 200 — the UI rendered a service notice as a normal assistant message instead of using its `ai_unavailable` state. Second instance of the FG-281 seam bug. There were no `makeAnswer` tests at all.
- [ ] **FG-283** **Bug.** The FG-280 breaker move missed `agent/src/actions/client.ts`, which still imported from `api/dist` — so the build cycle was never actually broken. Type-checks and 774 unit tests all passed on stale incremental artifacts; only a clean `pnpm build:api` (via E2E global-setup) revealed it, along with TS5055 and TS2742.
- [ ] **FG-275** Fix the `Closes:` trailer block. A blank line before `Co-Authored-By` splits it, git parses only the last paragraph, and fourteen commits' worth of closures were inert. `--verify` caught it.
- [ ] **FG-276** `scripts/check-api-coverage.sh` scanned `api/src/routes/*.ts` only, so directory route modules (`routes/fleetgraph/index.ts`) read as missing endpoints. Fixed to scan `*/index.ts` and take the mount name from the directory.

## M6 · Actions and human-in-the-loop

- [x] **FG-122** `agent/src/actions/client.ts` — Ship HTTP API client using a bearer `api_token`
- [x] **FG-123** Action client: explicit timeout + retry with backoff
- [x] **FG-124** Action client: second `CircuitBreaker` instance for the Ship API
- [x] **FG-125** Action client: **never** calls `POST /api/issues/bulk` — it bypasses `document_history` (`PRESEARCH.md` Q4)
- [x] **FG-126** Autonomous action: post a comment via the comments API
- [x] **FG-127** Autonomous action: log to `document_history` with `automated_by='fleetgraph'`
- [x] **FG-128** Classify actions by blast radius — additive/reversible vs state mutation (Q3)
- [x] **FG-129** Gated action: serialise the proposal into the checkpointer
- [x] **FG-130** Gated action: create a notification pointing at the pending approval
- [x] **FG-131** Resume path: accept → `executeApproved` → record outcome
- [x] **FG-132** Resume path: dismiss → mark resolved-by-dismissal, **fingerprint never fires again**
- [x] **FG-133** Resume path: snooze → set `snooze_until` in business days (1/3/5, default 3)
- [x] **FG-134** Snooze wake **re-runs the detector**, does not replay the stored finding (Q23)
- [x] **FG-135** Unit test: dismissed fingerprint is suppressed on the next run
- [x] **FG-136** Unit test: snoozed finding that self-resolves never returns
- [x] **FG-137** Integration test: full interrupt → resume cycle across a process restart

## M7 · API endpoints

- [x] **FG-138** `GET /api/fleetgraph/notifications` — current user's notifications
- [x] **FG-139** `POST /api/fleetgraph/notifications/:id/acknowledge`
- [x] **FG-140** `POST /api/fleetgraph/approvals/:id/accept`
- [x] **FG-141** `POST /api/fleetgraph/approvals/:id/dismiss`
- [x] **FG-142** `POST /api/fleetgraph/approvals/:id/snooze` — body carries the horizon
- [x] **FG-143** `POST /api/fleetgraph/chat` — on-demand invocation, body carries document id + type + tab
- [x] **FG-144** Chat endpoint sends **route params**, never rendered content (`PRESEARCH.md` Q7)
- [x] **FG-145** Register all six paths with OpenAPI per `/ship-openapi-endpoints`
- [x] **FG-146** Zod schemas for every request body
- [x] **FG-147** All endpoints behind `authMiddleware`
- [x] **FG-148** Visibility filtering — a user must not see notifications about documents they cannot read
- [x] **FG-149** Rate limit the chat endpoint, reusing the `checkRateLimit` pattern (Q32)
- [x] **FG-150** `GET /ready` — **required by MVP, does not exist today**
- [x] **FG-151** `/ready` reports Postgres connectivity
- [x] **FG-152** `/ready` reports circuit-breaker state via `getBedrockBreakerStats()`
- [x] **FG-153** `/ready` returns 503 when a dependency is unreachable, 200 otherwise
- [x] **FG-154** Route tests for all endpoints

## M8 · UI

- [x] **FG-155** `web/src/components/fleetgraph/AgentBanner.tsx` — approval surface, modelled on `PlanQualityBanner`
- [x] **FG-156** Banner renders between title and editor, matching the existing pattern (Q22)
- [x] **FG-157** Banner: finding text, proposed action, Accept / Dismiss / Snooze
- [x] **FG-158** Banner: snooze offers 1 / 3 / 5 business days, default 3
- [x] **FG-159** Banner: optimistic update, rollback on failure
- [x] **FG-160** `web/src/hooks/useFleetGraphNotifications.ts`
- [x] **FG-161** Set-scoped findings (load imbalance) surface on the **sprint** view, not per-issue (Q22)
- [x] **FG-162** `web/src/components/fleetgraph/AgentChat.tsx` — contextual chat
- [x] **FG-163** Chat is embedded in the document view — **no standalone chatbot page** (brief constraint)
- [x] **FG-164** Chat passes document id + type + active tab from route params
- [x] **FG-165** Chat renders streaming or progressive response
- [x] **FG-166** Chat: empty state naming what it can answer about *this* document
- [x] **FG-167** Chat: error state when the agent is unavailable, reusing the `ai_unavailable` pattern
- [x] **FG-168** Mount chat in `UnifiedDocumentPage`
- [x] **FG-169** Mount banner in `UnifiedDocumentPage`
- [x] **FG-170** Notification indicator in the icon rail or dashboard
- [x] **FG-171** Notification list view — recipient's open findings
- [x] **FG-172** Keyboard accessible: banner actions reachable and operable by keyboard
- [x] **FG-173** Focus states visible on all new interactive elements
- [x] **FG-174** Both surfaces respect the existing 4-panel layout
- [x] **FG-175** Component tests for banner and chat

## M9 · Observability

- [x] **FG-176** LangSmith env vars — `LANGCHAIN_TRACING_V2`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT`
- [x] **FG-177** Add LangSmith key to `.env` (never committed) and to Terraform as a secret var
- [x] **FG-178** Verify traces appear for a local proactive run
- [x] **FG-179** Verify traces appear for a local on-demand run
- [x] **FG-180** Name graph nodes so traces are readable
- [x] **FG-181** **Capture trace link 1** — quiet run terminating at `triageGate`, zero tokens
- [x] **FG-182** **Capture trace link 2** — full run reaching an action, human gate hit
- [x] **FG-183** Confirm the two traces show visibly different paths (MVP requirement 2)
- [x] **FG-184** Make both trace links shareable/public
- [x] **FG-185** Record both links in `FLEETGRAPH.md`

## M10 · Deployment

- [x] **FG-186** `terraform/render/cron.tf` — `render_cron_job` resource
- [x] **FG-187** Cron resource: `name`, `plan`, `region`, `runtime_source`, `schedule` (all required)
- [x] **FG-188** Cron resource: `start_command` overriding the entrypoint — the same-image seam
- [x] **FG-189** Cron schedule `*/3 * * * *` — 3 minutes, per `PRESEARCH.md` Q11
- [x] **FG-190** Cron env vars: `DATABASE_URL` via resource reference, never typed
- [x] **FG-191** Cron env vars: `SHIP_API_TOKEN`, `LANGCHAIN_API_KEY` as Terraform secret vars, uncommitted
- [x] **FG-192** Variables + outputs for the new resource
- [x] **FG-193** Confirm no secret lands in `terraform.tfstate` beyond what the provider requires
- [x] **FG-194** `terraform validate` passes
- [x] **FG-195** `terraform fmt` clean
- [x] **FG-196** **`terraform plan` from empty state — save the raw output**
- [x] **FG-197** Annotate the plan output, resource by resource (MVP requirement 8)
- [ ] **FG-198** `terraform apply` — first real deployment
- [ ] **FG-199** Verify `/health` returns the expected revision SHA
- [ ] **FG-200** Verify `/ready` returns 200 with dependencies up
- [ ] **FG-201** Verify the cron job appears in Render and fires on schedule
- [ ] **FG-202** Verify seed data populated automatically on boot (`Dockerfile:111`)
- [ ] **FG-203** **Script the destroy-and-redeploy cycle** so it is re-runnable, not hand-performed
- [ ] **FG-204** **Run destroy-and-redeploy — early, not at the deadline.** Capture full output
- [ ] **FG-205** Verify the rebuilt environment is functional: health, ready, cron, seed, UI
- [ ] **FG-206** Record the new service URL everywhere it is referenced
- [ ] **FG-207** Retire the old API-created Render service and database
- [ ] **FG-208** Update `CREDENTIALS.md` with the new service id and URL
- [ ] **FG-209** Timed latency test: introduce an event, assert the agent surfaces it inside 5 minutes (MVP requirement 6 + performance goal)

## M11 · FLEETGRAPH.md

- [x] **FG-210** Create `FLEETGRAPH.md` at repo root
- [x] **FG-211** **Agent Responsibility** section — port from `PRESEARCH.md` Q1–Q7
- [x] **FG-212** **Graph Diagram** — Mermaid, both modes, all nodes, edges, conditional branches
- [x] **FG-213** **Use Cases** — the table of six, with role / trigger / detects / human decides
- [x] **FG-214** **Trigger Model** — port from `PRESEARCH.md` §3, with the tradeoffs defended
- [x] **FG-215** Graph outline in prose: node types, edges, branching conditions (requirement 4)
- [x] **FG-216** Retry strategy and fallback behaviour documented (engineering requirement)
- [x] **FG-217** Rollback trigger and procedure documented (engineering requirement)
- [x] **FG-218** Embed both LangSmith trace links
- [x] **FG-219** Cross-check every MVP checkbox against the brief, one at a time
- [x] **FG-220** Verify no claim in `FLEETGRAPH.md` is unverified against the code

---

# §E · Early Submission — due Thursday 11:59 PM

## E1 · Test Cases section

- [x] **FG-221** `FLEETGRAPH.md` Test Cases table — Ship state, expected output, trace link, per use case
- [x] **FG-222** Test case 1: stalled work — construct the state, run, capture trace
- [x] **FG-223** Test case 2: sprint-miss risk
- [x] **FG-224** Test case 3: load imbalance
- [x] **FG-225** Test case 4: review bottleneck
- [x] **FG-226** Test case 5: rework churn
- [x] **FG-227** Test case 6: on-demand contextual answer
- [x] **FG-228** Each test case names the exact seed mutation that produces the trigger state

## E2 · Regression tests

- [x] **FG-229** Regression test per use case — the brief requires one for **every** agent behaviour
- [x] **FG-230** Regression: suppression does not re-surface a dismissed finding — Covered by `agent/src/actions/suppression.test.ts` — "never fires again, and the measurement is still there underneath" and "stays dismissed on the run after that, and the one after that". No new test written; a second copy of an existing assertion is maintenance cost with no coverage gain.
- [x] **FG-231** Regression: watermark does not advance on failure — Covered by `agent/src/entrypoints/cron.test.ts` — "FG-121 — a failed run does NOT advance the watermark", and its stronger sibling "FG-121 holds for the REAL judge" added under FG-281.
- [x] **FG-232** Regression: quiet run spends zero tokens — Covered by `agent/src/graph/index.test.ts` — "FG-092 — a quiet run terminates at the triage gate with ZERO model calls", and `suppression.test.ts` "a suppressed finding costs zero tokens".
- [x] **FG-233** Regression: bulk endpoint is never called
- [x] **FG-234** Regression: agent never mutates state without approval
- [x] **FG-235** All regression tests run in CI
- [ ] **FG-236** CI failure triggers automatic rollback — do not allow a failing build to remain deployed
- [x] **FG-237** Document the rollback trigger and procedure in `FLEETGRAPH.md`

## E3 · E2E tests

- [x] **FG-238** E2E: event introduced into Ship → agent surfaces it within the latency window
- [x] **FG-239** E2E: user invokes chat from a context-aware view → receives a grounded response
- [x] **FG-240** Both E2E tests run in CI (explicit brief requirement)
- [x] **FG-241** E2E tests use stable fakes for the LLM, not the live provider
- [x] **FG-242** Seed fixtures updated in `e2e/fixtures/isolated-env.ts` for agent scenarios
- [x] **FG-243** Respect the spec-file DB reset boundary — no cross-file state assumptions
- [x] **FG-244** Use `test.fixme()` for anything unimplemented, never an empty test

## E4 · Mocks and CI

- [x] **FG-245** Extend `mocks/bedrock-expectations.json` with judgment responses
- [x] **FG-246** Verify the whole agent suite passes with no network access
- [x] **FG-247** Add the agent package to the CI matrix
- [x] **FG-248** Type-check, lint, and test gates cover `agent/`
- [x] **FG-249** Confirm `scripts/assert-tests-ran.sh` covers the agent suite (void-run detection)

## E5 · Architecture Decisions section

- [x] **FG-250** `FLEETGRAPH.md` Architecture Decisions — framework choice
- [x] **FG-251** Node design rationale
- [x] **FG-252** State management approach
- [x] **FG-253** Deployment model
- [x] **FG-254** Each decision states the alternatives and why they lost

## E6 · Developer documentation

- [x] **FG-255** `CHANGES.md` — what was built, written for the next engineer, not the grader
- [x] **FG-256** `CHANGES.md` — how to run and test locally
- [x] **FG-257** `CHANGES.md` — how to roll it back if it fails
- [x] **FG-258** README section covering the agent
- [x] **FG-259** `./start.sh` starts the agent alongside the app (Rule 6 — one-command local start)

---

# §F · Final Submission — due Sunday noon

- [ ] **FG-260** Cost Analysis — actual dev spend, input/output token breakdown
- [ ] **FG-261** Cost Analysis — total invocations during development
- [ ] **FG-262** Production projections at 100 / 1,000 / 10,000 users
- [ ] **FG-263** State the assumptions: proactive runs per project per day, on-demand per user per day, average tokens per invocation
- [ ] **FG-264** Cost per run, estimated runs per day
- [ ] **FG-265** Demo video, 3–5 minutes
- [ ] **FG-266** Demo shows both modes and a human gate
- [ ] **FG-267** Final pass: every brief requirement checked against the artifact
- [ ] **FG-268** Merge to `main` via MR — no direct pushes

---

## Tooling added mid-flight

Not part of the original decomposition. Recorded here so every commit's `Closes:` trailer
names a real ticket.

- [x] **FG-269** `linear-import.mjs --verify` — fail a ticket closed with no `Closes:` trailer behind it
- [x] **FG-270** `/project-progress` skill — completion and remaining work in claude-hours

---

## Counts

| Bucket | Tickets |
|---|---|
| §M · MVP — Tuesday | 220 |
| §E · Early — Thursday | 39 |
| §F · Final — Sunday | 9 |
| **Total** | **268** |

## Sequencing risks

| Risk | Mitigation |
|---|---|
| `FG-015` (LangGraph JS durable `interrupt()`) fails | It is the **first** substantive ticket for a reason. If it fails, M6 changes shape and we need the time |
| Destroy-and-redeploy breaks at the deadline | `FG-204` runs early with room to fix, and `FG-203` makes it repeatable |
| Suppression bug burns tokens silently | `FG-021` and `FG-230` — the cost cliff from Q32 gets a constraint and a regression test |
| One-database decision becomes irreversible | `FG-029`/`FG-030` — all cross-boundary joins in one module, with the reversal path written at the seam |
