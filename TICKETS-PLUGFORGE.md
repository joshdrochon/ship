# PlugForge — Ticket Spine (Week 6)

Lane index, dependency graph, and agent assignments for the Week 6 platform build.
Individual tickets live in `tickets/plugforge/lane-NN-*.md` — this file is the spine, not the board.

| | |
|---|---|
| **Source of truth** | `GFA_Week_6_PlugForge.pdf` — vendored + extracted to `.claude/prd/` (gitignored), sha `81a3788d…`, 18pp |
| **Architecture decisions** | `docs/architecture.md` (already written — required Final deliverable) |
| **Prior-week precedent** | `TICKETS.md` (Week 5 FleetGraph, 285 tickets / 22 lanes) |
| **Ticket prefix** | `PF-NNN`, allocated in blocks per lane (see Allocation) |

## Deadlines

| Checkpoint | Deadline | Notes |
|---|---|---|
| Architectural Defense | Mon 10 Aug 1:00 PM CT | passed — confirm the plan-reading challenge cannot recur at Final or interview |
| MVP | **Fri 14 Aug 11:59 AM CT** | rescheduled from Tue; hard gate, all 10 items required |
| Early Submission | Thu 13 Aug 11:59 PM CT | ⚠ now precedes MVP — confirm |
| Final Submission | Sun 16 Aug | PRD self-conflicts: 11:59 **AM** (p.1) vs 11:59 **PM** (p.12) |

## Conventions

**Ticket shape.** One row per ticket. Every ticket carries a PRD page reference; a ticket that
cannot cite one is scope creep and gets cut at audit.

```
| ID | Title | Acceptance criterion | Advances | PRD | Deps |
```

**`Advances` is the PRD's acceptance criterion, not ours.** p.12 requires each PR description to
name *"which acceptance criterion that slice advances."* The PRD never defines the term, so the
taxonomy below is ours — but every entry points at something the PRD actually grades:

| Prefix | Source | Cite as |
|---|---|---|
| `MVP-N` | MVP gate checkboxes, p.2 (`MVP-TF` = the Terraform item) | `MVP-1`…`MVP-10`, `MVP-TF` |
| `TS-N` | The eight Testing Scenarios, p.5 — keep the PRD's own numbering, which starts at 2 | `TS-2`…`TS-9` |
| `CTR` | Core Technical Requirements tables, p.2–5 — graded requirements that are not gate items | `CTR:<row name>` |
| `PERF` | Performance Targets — p.6, and the Signature Challenge table spanning p.8–9 | `PERF:<metric>` |
| `INT` | The "Implement at Least 5" integrations menu, p.8 — the CLI row is must-ship | `INT:<integration>` |
| `SUB` | Submission Requirements, p.12 and p.13 — the table spans both pages | `SUB:<deliverable>` |

`CTR`, `PERF`, `INT` and `SUB` exist because MVP + TS alone leave genuinely graded work uncited.
Each was added after a lane author hit the gap and refused to force a false match — the IAM
least-privilege exercise (p.5), the Pre-Search Document (p.12), the rate-limit header and
regression-budget targets (p.6), and the must-ship CLI on the integrations menu (p.8). If a lane
hits another kind of graded requirement with no prefix that fits, add one here rather than
dashing real work or bending an existing prefix.

The `Acceptance criterion` column stays — it is the local, checkable condition — but it is *not*
what a PR cites. A ticket that advances nothing gets `—`, and that is a real signal: it is
plumbing, and no PR should claim graded credit for it.

**Status.** `☐` open · `◐` in progress · `☑` done · `✂` cut (with reason) · `⚑` blocked.

**Audit provenance.** Tickets appended by the per-lane audit pass are prefixed
`**Found from audit:**` in the Title column, so the original scope and the audit delta stay
distinguishable forever. Audit agents never edit or delete an existing ticket — they append,
and raise a `⚑` on anything they believe is wrong.

**Cross-lane findings.** An auditor reading the full PRD will surface gaps belonging to other
lanes. Those go to `tickets/plugforge/lane-99-unassigned.md`, never into the auditor's own lane.
Without this rule, 26 auditors each reading 18 pages produce 26 copies of the same finding.

**Page citations come from `.claude/prd/page-N.txt` — never `full.txt`.** `pdftotext -layout`
reflows the whole-document extraction differently from the per-page one, so line position in
`full.txt` does not map to a page number. Verify every citation with
`grep -l "<phrase>" .claude/prd/page-*.txt` before writing it. The `Stop` hook
(`verify-prd-citations.py`) checks quoted text against the page cited and will flag drift.

**Traceability.** Every MVP checkbox and every Testing Scenario in the PRD must be reachable
from at least one ticket. The matrix at the bottom of this file is the proof, and it is what
the audit pass verifies first.

## Branching & PR Discipline — graded

PRD p.12, Submission Requirements: *"Public; per-slice branches preserved; each PR description
lists which acceptance criterion that slice advances and confirms the fitness test passed."*

Four obligations, all graded artifacts:

| Obligation | Rule |
|---|---|
| Repo public | Confirmed before Final; verified in L26 |
| Per-slice branches | One branch per slice, named `pf/LNN-<slug>` — lane-prefixed so 26 parallel agents never collide |
| Branches **preserved** | Merged branches are **never deleted**. They are submission evidence. |
| PR description | Must name the acceptance criterion the slice advances (ticket IDs + criterion text) **and** confirm the fitness test passed |

**What a "slice" is.** The PRD uses the term for a testable vertical increment, not a ticket —
Build Strategy §5 (p.10) calls "event registry → event bus → subscriptions → signer → deliverer
→ delivery log → replay" *seven slices*. So a slice is a group of tickets in one lane that lands
one working increment. Default **3–6 slices per lane**; each lane file declares its own slice
boundaries in a `## Slices` section. One PR per slice — not per ticket (650 PRs) and not per
lane (too coarse to name a single acceptance criterion).

**PR bodies are generated, not written.** Every ticket carries an acceptance criterion and a PRD
page reference precisely so the PR body assembles from ticket metadata. The PR template
(PF-024) enforces the required fields; CI (PF-026) fails a PR whose body is missing either.

> ⚠ **Do not run `repo-cleanup`, `git branch -d`, or any merged-branch pruning before Final
> Submission.** The cleanup skill deletes merged branches by default. Branch preservation is a
> graded requirement — pruning destroys the evidence and it is not recoverable from the remote
> once both sides are gone.

**Enforcement — verified end-to-end 2026-08-12**, by pushing a probe branch and attempting to
delete it at each layer:

| Layer | Mechanism | Result |
|---|---|---|
| Agent | `.claude/hooks/guard-graded-branches.py` (PreToolUse on Bash) | blocked |
| Any local git caller | `.husky/pre-push` — zero-SHA local ref = deletion | blocked |
| Server | GitLab protected branch `pf/*`, force push off | `remote rejected … You can only delete protected branches using the web interface` |

The server layer is the only real guarantee — the two local layers are fast feedback and both
carry an `ALLOW_GRADED_BRANCH_OPS=1` override. With **both overridden**, GitLab still refused.
Residual: a Maintainer can delete through the GitLab web UI. That is the intended bar —
deliberate human action, not a stray command.

## Lanes

Agent names are the identities the parallel build fans out to. `Tier` is dependency depth —
all lanes in a tier can run concurrently; a tier cannot start until the tier above it lands the
specific tickets named in `Blocks on`.

| Lane | Name | Agent | Tier | Blocks on | Est. |
|---|---|---|---|---|---|
| L01 | Foundations & Public/Internal Boundary | `platform-foundations` | 0 | — | 26 |
| L21 | Terraform, IAM Least-Privilege & Drift | `infra-terraform` | 0 | — | 30 |
| L25 | Pre-Search Document (Phases 1–3) | `presearch-author` | 0 | — | 26 |
| L02 | OAuth App Registry & Secret Lifecycle | `oauth-apps` | 1 | L01 | 24 |
| L03 | Scope Registry & Authorization | `scopes-authz` | 1 | L01 | 20 |
| L07 | ApiError Shape & Error Middleware | `api-errors` | 1 | L01 | 18 |
| L04 | Authorization Code + PKCE | `oauth-authcode` | 2 | L02, L03 | 28 |
| L05 | Device Authorization Grant | `oauth-device` | 2 | L02, L03 | 24 |
| L06 | Token Lifecycle & Refresh Rotation | `oauth-tokens` | 2 | L02 | 26 |
| L08 | Public Router & Cursor Pagination | `api-v1-router` | 2 | L01, L03, L07 | 24 |
| L09 | Resource: Documents | `resource-documents` | 3 | L06, L08 | 22 |
| L11 | Rate Limiting | `ratelimit` | 3 | L08 | 20 |
| L12 | Public Audit Trail | `audit-trail` | 3 | L08 | 18 |
| L10 | Resources: Issues, Sprints, Me | `resource-rest` | 4 | L09 | 26 |
| L13 | OpenAPI 3.1 Generation & Parity | `openapi-gen` | 4 | L09 | 28 |
| L14 | Event Registry & Event Bus | `events-bus` | 4 | L09 | 22 |
| L15 | Webhook Subscriptions & HMAC Signing | `webhooks-signing` | 5 | L14 | 26 |
| L17 | SDK Core: Client, Errors, Token Store | `sdk-core` | 5 | L10, L13 | 24 |
| L16 | Retry, DLQ, Delivery Log & Replay | `webhooks-delivery` | 6 | L15 | 32 |
| L18 | SDK Resources, Auth Helpers & Verifier | `sdk-surface` | 6 | L10, L15, L17 | 28 |
| L19 | CLI Reference Integration (must-ship) | `cli-integration` | 7 | L18 | 26 |
| L22 | Developer Portal | `dev-portal` | 7 | L16, L12 | 28 |
| L20 | TTFE Drill & CI Harness | `ttfe-drill` | 8 | L19, L16 | 24 |
| L23 | Agent-as-Citizen Rewire (Epic 7) | `agent-rewire` | 8 | L18 | 26 |
| L24 | Secondary Integrations (5-of-7) | `integrations-extra` | 8 | L18 | 28 |
| L26 | Docs, Cost Analysis & Submission | `submission-artifacts` | 9 | all | 30 |
| L99 | Unassigned (audit findings) | — | — | — | — |

**26 lanes · ~654 tickets estimated.** Higher than the 500-600 you floated. The overage is
concentrated in three places the epic list doesn't name: Terraform/IAM (L21, 30), the
Pre-Search appendix (L25, 26 — ~60 PRD questions collapsed to 26 tickets), and submission
artifacts (L26, 30). Final count falls out of the lane files, not this estimate.

**Measured 2026-08-15: 684 tickets across 27 lane files** (the 26 lanes above plus `L99`,
the findings register, which is not a lane). The `Est.` column above is left
as written — it records what was estimated, which is its whole purpose, and rewriting it
would destroy that. But the estimate is now 30 short, and 12 lanes undercount while none
overcounts (L16 32→34, L20 24→26, L23 26→28 are the largest); so **cite 684, not ~654, if
this table is ever read as a current inventory.** Reproduce with
`python3 scripts/check-plugforge-tickets.py`, which counts a row as a ticket only when it
matches `^\|\s*PF-\d{3}\s*\|` under a live `\| ID \|` header — a raw `☑`/`◐`/`☐` tally does
**not** agree with it.

## Critical Path

Nine tiers deep. Parallelism widens each tier; it does not shorten the chain.

```
L01 foundations
 └─ L02 oauth apps ─┬─ L04 authcode+PKCE ─┐
                    ├─ L05 device grant ──┤
                    └─ L06 tokens ────────┴─ L09 documents ─┬─ L13 openapi ─ L17 sdk core ─┐
 └─ L07 apierror ── L08 v1 router ────────────────────────  ├─ L14 event bus ─ L15 signing ─┤
                                                            └─ L10 resources               │
                                                                                            │
                        L18 sdk surface ◄───────────────────────────────────────────────────┘
                         ├─ L19 CLI ─ L20 TTFE drill
                         ├─ L23 agent rewire
                         └─ L24 integrations
                        L16 delivery ─ L22 portal
                                        └─ L26 submission
```

**MVP gate cuts across tiers 0–4 only.** L16, L19–L26 are all post-MVP. The Friday gate needs
L01–L14 landed, nothing more.

## Sequencing Risks

Per your instruction — where a lane running early causes another to fail, we serialize and eat
the time rather than parallelize and debug it.

| Risk | Lanes | Mitigation |
|---|---|---|
| OpenAPI generated before route metadata is stable → SDK parity test locks in a wrong spec | L13 → L17/L18 | L13 ships against `documents` only (PRD Build Strategy §4 is explicit). L10 resources land *after* the generator proves out. |
| Event bus publishing from the route layer instead of the domain layer — an architecture error the PRD calls out by name | L14 | L14 tickets assert the publish site is in `utils/document-crud.ts`, never `api/v1/`. Audit checks every publish call site. |
| Lint boundary rule added after cross-imports exist → retrofit instead of enforcement | L01 | PRD Build Strategy §2 (p.10): rule ships Day 1 "before you have any cross-imports to lint." L01 blocks all of tier 1. |
| Rate limiter attached before audit middleware → 429s never audited | L11, L12 | Middleware order is fixed in L08's composition-root ticket; L11/L12 slot into declared positions. |
| Agent rewire behind a flag, but Part 2 suite only run with flag on | L23 | CI matrix runs both states. Non-negotiable per PRD Epic 7 (p.10). |
| Terraform destroy-redeploy run against the live grader instance | L21 | Drill runs on a throwaway workspace. The Week 5 board hit exactly this. |

## MVP Gate → Lane Traceability

The ten hard-gate items, mapped. Anything unmapped is a hole in this spine.

| # | MVP requirement (PRD p.2) | Lane |
|---|---|---|
| 1 | OAuth app registration, secret hashed, raw shown once | L02 |
| 2 | Auth Code + PKCE end-to-end via Playwright | L04 |
| 3 | Bearer middleware on `/api/v1/*`, distinct 401 codes | L06, L08 |
| 4 | `documents` GET list / GET id / POST, each declaring scope | L09, L03 |
| 5 | `ApiError` shape, fitness-tested across all routes | L07 |
| 6 | ScopeRegistry scopes-as-data, 403 names missing scope | L03 |
| 7 | OpenAPI 3.1 generated, served, schema-validated | L13 |
| 8 | SDK skeleton, `new ShipClient({token}).me()` typed | L17 |
| 9 | Regression suite green, P95/bundle/queries ≤ +10% | L26 |
| 10 | Deployed, public spec URL, pre-registered grader app | L21 |
| + | Terraform: pinned, annotated plan, destroy-redeploy | L21 |

## Testing Scenario → Lane Traceability

The PRD's eight named test scenarios (p.5). These are what graders run.

| # | Scenario | Lane |
|---|---|---|
| 2 | PKCE flow in Playwright, wrong verifier → `invalid_grant` (negative mandatory) | L04 |
| 3 | Device grant from test CLI, slow-down honored, token works on `/api/v1/me` | L05, L10 |
| 4 | Fitness test: every route has OpenAPI entry, scope, ApiError, pagination | L13 |
| 5 | Validate spec against OpenAPI 3.1 schema; every method has typed SDK call | L13, L18 |
| 6 | Subscribe via SDK → create doc → signed POST < 2s → verify → tamper → reject | L15, L18 |
| 7 | 500×3 then 200; assert retry waits 1s/4s/16s; 4th attempt logged success | L16 |
| 8 | 6 failures → DLQ → visible in portal → replay → original idempotency key | L16, L22 |
| 9 | TTFE drill: clean container → install → login → create → verified webhook | L20 |

## Allocation

ID blocks, reserved so lanes can be authored in parallel without collision.

| Lane | Block | Lane | Block |
|---|---|---|---|
| L01 | PF-001–030 | L14 | PF-391–420 |
| L02 | PF-031–060 | L15 | PF-421–450 |
| L03 | PF-061–085 | L16 | PF-451–490 |
| L04 | PF-086–120 | L17 | PF-491–520 |
| L05 | PF-121–150 | L18 | PF-521–555 |
| L06 | PF-151–185 | L19 | PF-556–585 |
| L07 | PF-186–210 | L20 | PF-586–615 |
| L08 | PF-211–240 | L21 | PF-616–650 |
| L09 | PF-241–270 | L22 | PF-651–685 |
| L10 | PF-271–300 | L23 | PF-686–715 |
| L11 | PF-301–325 | L24 | PF-716–750 |
| L12 | PF-326–350 | L25 | PF-751–780 |
| L13 | PF-351–390 | L26 | PF-781–820 |
| | | L99 | PF-900+ |

Blocks are deliberately sparse — audit appends land inside the owning lane's block rather than
at the end of the file, so IDs stay grouped by lane after the audit pass.
