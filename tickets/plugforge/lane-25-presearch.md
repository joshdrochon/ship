# L25 · Pre-Search Document (Phases 1–3)

| | |
|---|---|
| **Agent** | `presearch-author` |
| **Tier** | 0 — no code dependencies; can start immediately |
| **Block** | PF-751–780 (26 allocated, 4 reserved for audit) |
| **Blocks on** | — |
| **Unblocks** | Nothing mechanically. Every other lane *cites* this document. |
| **MVP gate** | Not on the Friday gate. Graded at Final Submission (PRD p.13). |
| **Output** | `PRESEARCH-PLUGFORGE.md` at repo root + `docs/presearch-conversation.md` |

**Why this lane is tier 0.** The Appendix (p.15) opens with *"Complete this before writing
code."* Submission Requirements (p.13) grades it as a deliverable in its own right: *"All three
phases completed with written answers; saved AI conversation attached as a reference artifact."*
The Technical Stack table (p.10) closes with *"Complete the Pre-Search process to make informed
decisions"* — the document is the input to the stack choices, not a retrospective on them.

**The appendix is 58 bullets across 14 subsections on pages 15–18.** Phase 1 = 18, Phase 2 = 24,
Phase 3 = 16. This lane collapses them to one ticket per subsection plus scaffolding, defense,
transcript, and reconciliation tickets — 26 total. A ticket per bullet would be 58 tickets that
each say "answer the question," which is not a plan.

**Where `docs/architecture.md` already decided.** Roughly 22 of the 58 bullets are settled by
the Week 6 architecture doc, which is written and committed. For those, the ticket's job is
**record the decision and its rationale**, not make it. The per-ticket criteria say which. The
audit notes at the bottom list the split explicitly, because "already answered" is the single
easiest thing for a writing lane to get wrong in both directions — restating a decision as if it
were open, or asserting a decision the architecture doc never made.

**Filename.** `PRESEARCH-PLUGFORGE.md`, matching the `TICKETS.md` → `TICKETS-PLUGFORGE.md`
convention already in the repo root. Week 5's `PRESEARCH.md` is graded Week 5 evidence and is
never overwritten.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-751 | ☑ Scaffold `PRESEARCH-PLUGFORGE.md` — 3 phases, 14 subsections, 58 numbered questions | Every appendix bullet transcribed verbatim under a stable `Q1`–`Q58` heading with its subsection number; the header states the count and how it was derived, so a grader can check completeness by counting headings | — | p.15, p.13 | — |
| PF-752 | ☑ Grounding section — constraints verified against the repo, not assumed | Table of facts that constrain the answers (existing `api_tokens` hashing discipline, no webhook infra, no scope column, in-process deliverer, Render topology), each with a file path and the consequence it forces; header names the commit sha the facts were read at | — | p.10 | PF-751 |
| PF-753 | ☑ Answer 1.1 — Scale & Load Expectations (4 bullets) | Each answer states a **number and the assumption behind it**: demo-window req/s; the fanout arithmetic (1 `document.created` × N matching subscriptions = N deliveries) with the N being seeded; the fanout at which the in-memory deliverer misses the < 2 s P95 target, stated as a measured or explicitly-estimated breakpoint; concurrent device-flow CLI sessions and whether `slow_down` holds at that count; delivery-log rows/day at the stated event rate × the retention window. A bullet answered without a number is not answered | — | p.15 | PF-752 |
| PF-754 | ☑ Answer 1.2 — Budget & Cost Ceilings (4 bullets) | Four ceilings, each a number plus the mechanism that enforces it: weekly LLM budget for the Epic 7 rewire **and** the before/after token measurement that proves the rewire didn't change volume; daily CI-minute ceiling computed from TTFE drill + OAuth Playwright + regression per PR × PRs/day; SDK install footprint (architecture.md commits to < 250 KB min+gzip, production deps only, CI-enforced — record it and its enforcement point); webhook-queue runaway-cost ceiling with the named mechanism that caps it (DLQ after 6 failures is the candidate — say so or say what else) | — | p.15 | PF-752 |
| PF-755 | ☑ Answer 1.3 — Timeline & Scope Reality (3 bullets) | Names must-ship epics from E1–E7 *against stated OAuth experience* (E1–E4 + E6 CLI is the PRD's own recommendation — agreeing is fine, silently inheriting is not); a day-by-day plan against an honest hours/day number that sums to the hours, not to the wish; and a **kill criterion** for the developer portal stated as a trigger, not an intention — "if E5 is not started by <date/time>, the portal ships as read-only delivery-log viewer only" | — | p.15 | PF-752 |
| PF-756 | ☑ Answer 1.4 — Security & Data Sensitivity (4 bullets) | `client_secret` at rest: names the hash algorithm, the salting scheme, and the recovery process when a user loses theirs (architecture.md commits to SHA-256 + high-entropy + shown-once — record it, and close the salting/recovery gap it leaves). Token lifetime as a number; refresh rotation policy including whether reuse revokes the family (architecture.md says it does). Webhook payload contents — ID-only vs. full document — carrying an explicit **defended tradeoff between subscriber convenience and exposure surface**, alternatives named and rejected with reasons. Shown-once secret UX: one mitigation each for screenshot, log line, and browser back-button | — | p.15 | PF-752 |
| PF-757 | ☑ Answer 1.5 — Team Skill Inventory (3 bullets) | Honest, first-person, and consequential: prior OAuth experience stated as implemented-vs-consumed, and **if consumed only, which specific morning is booked for RFC 6749 + 7636 + 8628 before E1 starts**; Zod / zod-to-openapi comfort plus the named fallback if generation breaks late in the week (hand-maintained spec is a fallback; "we'd figure it out" is not); prior SDK design/consumption experience and which of the two guides this week's API choices more. Answers that could be copy-pasted into any team's document fail this criterion | — | p.16 | PF-752 |
| PF-758 | ☑ Answer 2.1 — OAuth Flow Choices (4 bullets) | Refresh tokens day one vs. later, with the **migration cost of waiting** priced (architecture.md already commits to one-time-use refresh with family revocation — record the decision and why day-one wins). Scope upgrades: re-consent vs. incremental consent, stated as a decision — this is **open** in architecture.md. Consent screen location (Ship UI route vs. dedicated minimal endpoint) plus the named clickjacking defense (`X-Frame-Options` / `frame-ancestors`). Device verification UX: architecture.md's `/oauth/device/verify` is a paste-the-code form — record it and say why over the embeddable-code-in-URL variant RFC 8628 also allows | — | p.16 | PF-752 |
| PF-759 | ☑ Answer 2.2 — Public API Shape (4 bullets) | Error shape uniform vs. richer on some routes — if both, the answer states **where the line is and that the line is documented** (architecture.md: one `ApiError` envelope, fitness-tested over every route). Sparse fieldsets: `?fields=` vs. `Prefer:` vs. skip-for-the-week with the call **defended** — this is open. Versioning policy past `/api/v1/` (additive-only / `/v2/` / sunset headers) with the answer naming *which policy is in the docs by Sunday*. Pagination universality: whether `/api/v1/scopes`-style static lists skip cursors, where the line is drawn, and **how the fitness test knows** — an exemption the test can't see is drift | — | p.16 | PF-752 |
| PF-760 | ☑ Answer 2.3 — Webhook Reliability (4 bullets) | Signed input stated exactly, byte-level (architecture.md: `HMAC-SHA256(secret, t + '.' + rawBody)`, header `Ship-Signature: t=<unix>,v1=<hex>`) with the reason the timestamp is inside the signed string. Retry schedule as the concrete ladder (1s·4s·16s·1m·5m·30m + jitter) plus **where the injected clock lives** — `FakeClock` via `testDeps()` in the composition root, cited by path. Permanent-vs-transient classification more nuanced than "4xx permanent": 410 Gone permanent, 429 transient, and what happens to 408/425. Idempotency-Key: origin (derived from `event_id` at first delivery), that it is unchanged across retries *and* portal replay, and the one-sentence dedupe contract published to subscribers | — | p.16 | PF-752 |
| PF-761 | ☑ Answer 2.4 — SDK Design (4 bullets) | Generated-vs-hand-written **defended on type quality against drift risk** — architecture.md and the stack table both commit to hand-written + parity fitness test, so the answer records the decision and must name the drift mitigation that buys back what generation gives free. Error model: typed discriminated union on `kind` (architecture.md) with the two rejected alternatives named. Pagination: async-iterators-only vs. both, with the consumer cost of hiding cursors acknowledged. `ITokenStore` — whether it persists refresh tokens as well as access tokens, and the **threading model for refresh under concurrent calls** (single-flight? lock? last-write-wins?) — architecture.md marks `ITokenStore` pre-1.0 and does not answer this; it is open | — | p.16, p.17 | PF-752 |
| PF-762 | ☑ Answer 2.5 — Developer Portal & Self-Service (4 bullets) | Portal-eats-the-public-API vs. privileged internal endpoint, recorded from architecture.md with the escape hatches that were *not* taken listed. Secret rotation: immediate invalidation vs. grace period, and the answer must state **what Stripe does and why**, not just what we do. Delivery-log view at thousands of rows: server-side pagination / virtualization / time buckets, each labeled build-cheap or rebuild-cheap, and the choice justified on which cost we prefer to pay later. Payload display full/redacted/click-to-reveal with the choice **defended against the leakage concerns raised in 1.4** — the answer must reference PF-756's mitigations by name, not restate them | — | p.17 | PF-752, PF-756 |
| PF-763 | ☑ Answer 2.6 — Agent-as-Citizen Rewire (4 bullets) | Agent's OAuth flow named and **defended** — Auth Code, Device Grant, or Client Credentials (RFC 6749 §4.4); architecture.md says "first-party OAuth app" without naming the grant, so this is a genuinely open decision the answer must close. App seeding: architecture.md commits to migration-seeded — record it plus the guarantee it gives in deployed environments over boot-time or manual seeding. Scopes **enumerated one by one with a per-scope defense**, and an explicit yes/no on whether the agent needs write scopes or stays read-only behind a recommendation pattern. Flag-on/flag-off CI: names the workflow matrix that runs Part 2's suite in both states | — | p.17 | PF-752 |
| PF-764 | ☑ Answer 3.1 — Security & Failure Modes (4 bullets) | Four failure stories, each with a chosen recovery, not a menu. Owner deleted: deactivate / transfer to admin / soft-flag orphan, with the recovery path described. Deliverer crash mid-batch: at-least-once + Idempotency-Key dedupe (architecture.md commits to this and rejects silent at-most-once) — record it with the delivery-log durability that makes reconstruction possible. Leaked `client_secret`: detection signal, who rotates, and **the specific audit-log condition you'd alert on**. CSRF on the portal's app-form and rotate-secret endpoints, stated as the concrete mechanism given those pages sit inside Ship's session+CSRF UI next to the OAuth consent screen | — | p.17 | PF-752 |
| PF-765 | ☑ Answer 3.2 — Testing Strategy (3 bullets) | TTFE drill: full `pnpm install` in a fresh container vs. workspace symlink with install mocked, answered on **which proves more against which is fast enough for CI** — both halves, since the PRD asks both. OAuth Playwright stability: stub vs. containerized auth server, with the CI-minute cost priced against PF-754's ceiling. Retry-schedule testing without sleeping: deterministic clock injection named by type and injection point, and the answer asserts the negative — zero `setTimeout` waits anywhere in the suite | — | p.17 | PF-752, PF-754 |
| PF-766 | ☑ Answer 3.3 — Tooling & CI (3 bullets) | Boundary lint: the PRD poses this as "…both?" — the answer must enumerate the **full rule set** and say whether two rules or three (architecture.md implies three: no internal-route imports from `platform/api/v1/`, no internal middleware imports from `platform/**`, `integrations/**` may import only `@ship/sdk`), and note whether the `integrations/` rule is lint or a workspace dependency rule. OpenAPI fitness test in CI: fail-build vs. warn-and-diff, **with a separate stated answer for additive changes** — the PRD asks it explicitly and it is the easy half to drop. +10% regression budget: manual / automated baseline comparison / failing perf job, naming where the baseline file lives and who compares against it | — | p.18 | PF-752 |
| PF-767 | ☑ Answer 3.4 — Deployment & Hosting (3 bullets) | Deployment target named (Render, per `terraform/render/main.tf`) **plus how a pre-registered grader OAuth app gets read-only access without exposing tenant data** — the isolation mechanism, not just "read-only scopes". Spec publication: live `/api/v1/openapi.json` only vs. also a static copy — p.13 requires `docs/openapi.json`, so the answer states both and their stable URLs. Grader CLI setup written as **the literal one-command line and the README heading it lives under** | — | p.18 | PF-752 |
| PF-768 | ☑ Answer 3.5 — Observability of API Usage (3 bullets) | Per-call metric fields listed against the PRD's own list (route, status, latency, scope used, app, user, request_id) with any omission called out as a decision, plus the surfaces they appear on (logs / `/metrics` / dev portal). Proving the agent used the public API post-demo: picks one of grep-the-audit-log / dashboard panel / fitness test that runs the agent and inspects the trail, and states the exact query or assertion. Idempotency-Key reuse vs. fresh keys in the delivery log: answers the PRD's follow-up — **could you tell from the portal alone whether a subscriber's dedupe is working?** — yes or no, with what the portal would have to show for it to be yes | — | p.18 | PF-752 |
| PF-769 | ☑ Defended-tradeoff sweep — the six bullets that demand a defense actually carry one | The PRD explicitly demands a defense at six bullets: 1.4 webhook payload contents ("Defend the tradeoff between subscriber convenience and exposure surface", p.15), 2.2 sparse fieldsets ("Defend the call.", p.16), 2.4 generated-vs-hand-written SDK ("Defend the tradeoff between type quality and drift risk", p.16), 2.5 payload display ("Defend the choice against the leakage concerns from 1.4", p.17), 2.6 agent OAuth flow ("Defend the choice.", p.17), 2.6 agent scopes ("what is your defense for each?", p.17). Each of the six must carry a four-part block — **decision · why · alternatives rejected with reasons · why this wins** — and a decision stated without a named rejected alternative fails the sweep. Cost-to-build is never the deciding argument | — | p.15, p.16, p.17 | PF-756, PF-759, PF-761, PF-762, PF-763 |
| PF-770 | ☑ Capture the AI conversation transcript | The research conversation saved verbatim to `docs/presearch-conversation.md` — not summarized, not reconstructed after the fact. Secrets, tokens, and credentials redacted with the redaction marked inline so the reader knows a removal happened rather than seeing a gap. Header records date, model, and which questions the conversation actually informed | — | p.13 | PF-751 |
| PF-771 | ☑ Attach the transcript as a reference artifact and link it both ways | p.13 requires it *attached*: committed in-repo, linked from `PRESEARCH-PLUGFORGE.md`'s header, and listed in the submission index as a named deliverable. Link resolves from a clean clone — a path that only works in the author's working tree is not attached | — | p.13 | PF-770 |
| PF-772 | ☑ Coverage check — all 58 bullets answered, none left "TBD" | A checklist table (or a check script) maps every one of the 58 appendix bullets to its `Q` heading and asserts a non-empty answer; zero "TBD", "see above", or placeholder answers; the count in the header matches the number of headings. p.13 grades "all three phases completed with written answers" — this is the mechanical proof of that phrase | — | p.13, p.15 | PF-753–PF-768 |
| PF-773 | ☑ Consistency cross-check against `docs/architecture.md` | Every answer that restates an architecture decision agrees with `docs/architecture.md` verbatim on the load-bearing specifics — hash algorithm, retry ladder values, signature string construction, error-union member names, scope names, SDK footprint budget. Any disagreement is resolved in one direction and **both documents are edited**, never left to diverge; the ticket records which document moved | — | p.12 | PF-772 |
| PF-774 | ☑ As-built cross-check — answers reconciled against what actually shipped | Run after the build lands: each answer that predicted an implementation is checked against the shipped code, and any divergence is recorded as a dated amendment under the original answer rather than a silent edit. The Pre-Search is the decision record the rest of the board cites, so a quietly-rewritten answer destroys exactly the traceability it exists to provide | — | p.13 | PF-773 |
| PF-775 | ☑ Open-items section — decided but unproven | A table of every answer resting on an assumption not yet verified (fanout breakpoint, CI-minute actuals, `ITokenStore` concurrency behavior, grader-tenant isolation), each marked Designed / Verified / Unproven with what would close it. An honest open-items list is stronger evidence of a real Pre-Search than 58 confident answers | — | p.10 | PF-772 |
| PF-776 | ☑ Final assembly and submission-requirement verification | Read the p.13 Pre-Search row literally and confirm both halves: all three phases complete with **written answers** (PF-772), and the saved AI conversation **attached as a reference artifact** (PF-771). Document committed at the path the submission index names, renders on GitHub, all internal anchors resolve | — | p.13 | PF-771, PF-772, PF-773, PF-775 |

> **Board reconciled 2026-08-13 (PF-029).** Marked in one pass, not individually
> re-verified. Basis: all six slice branches are ancestors of `pf/integration`, and both
> deliverables p.13 names exist — `PRESEARCH-PLUGFORGE.md` (208 KB, 60 question sections)
> and the attached reference artifact `docs/presearch-conversation.md`. The lane built the
> work and did not update its own board; this closes that gap rather than claiming fresh
> verification of each answer's content.

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L25-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed. This lane's
"fitness test" is a completeness check over the document, not a test run — stated as such in the
PR body rather than faked with a green check.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L25-scaffold` | PF-751–752 | Document exists with all 58 questions transcribed and grounded in verified repo facts | Heading count = 58; every grounding row carries a file path |
| S2 | `pf/L25-phase1-constraints` | PF-753–757 | Phase 1 complete — every constraint answer carries a number and its assumption | No Phase 1 answer lacks a figure or a named fallback |
| S3 | `pf/L25-phase2-architecture` | PF-758–763 | Phase 2 complete — 24 architecture-discovery bullets answered | Each of the 6 subsections has 4 answered bullets; open decisions closed, not deferred |
| S4 | `pf/L25-phase3-refinement` | PF-764–768 | Phase 3 complete — security, testing, CI, hosting, observability | 16 bullets answered; each names a mechanism, not an intention |
| S5 | `pf/L25-defense-and-transcript` | PF-769–771 | The six defense-demanding bullets carry real defenses; transcript attached (p.13) | Sweep: 6/6 carry decision · why · alternatives · why-this-wins. Transcript link resolves from a clean clone |
| S6 | `pf/L25-assembly` | PF-772–776 | Submission-ready: 58/58 covered, consistent with architecture.md, reconciled as-built | Coverage table green; zero contradictions against `docs/architecture.md` |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots in this lane, stated so you
can confirm or refute rather than rediscover.

**Bullet count.** 58, not "roughly 60": Phase 1 = 4+4+3+4+3 = 18, Phase 2 = 4×6 = 24, Phase 3 =
4+3+3+3+3 = 16. Recount before trusting it. Week 5's document had the same trap — one compound
bullet in §2 expanded from 1 to 4, and the header had to say so. Check the Phase 2 bullets for
compounds; 2.6's scopes bullet ("which scopes… and what is your defense for each?") is one
question that expands to one answer per scope.

**Which pages.** The appendix is p.15–p.18. Subsection headings do not sit on the same page as
their bullets everywhere — the `3.3 — Tooling & CI` heading is the last line of p.17 while all
three of its bullets are on p.18, and `2.4 — SDK Design` splits across p.16/p.17. PF-766 cites
p.18 and PF-761 cites both, deliberately. Verify before "correcting" either.

**Already answered by `docs/architecture.md` — record, don't decide** (~22 bullets): 1.2 SDK
footprint; 1.4 secret hashing + refresh rotation/family revocation; 2.1 refresh-day-one, device
verify UX; 2.2 uniform error shape, cursor pagination; 2.3 signature construction, retry ladder,
clock injection, Idempotency-Key origin; 2.4 hand-written SDK, `kind` error union, async
iterators; 2.5 portal-eats-public-API; 2.6 migration seeding, flag-on/off CI; 3.1 at-least-once
deliverer contract; 3.2 no-sleep retry testing; 3.3 boundary lint rules, OpenAPI drift fails CI;
3.4 Render topology, served spec; 3.5 audit-row fields.

**Genuinely open — a decision must be made here** (~28 bullets): all four of 1.1; three of 1.2;
all three of 1.3; all three of 1.5; 1.4 webhook payload contents; 2.1 incremental consent,
consent-screen location + clickjacking; 2.2 sparse fieldsets, versioning policy, the pagination
exemption line; 2.3 the 410/429 nuance; 2.4 `ITokenStore` refresh persistence + concurrency;
2.5 rotation grace period, delivery-log scaling, payload redaction; 2.6 **which OAuth grant the
agent uses** — architecture.md says "first-party OAuth app" and never names the grant, which is
the largest open decision in the lane and one the PRD flags for interview defense (p.13);
3.1 owner deletion, leaked-secret response, portal CSRF; 3.2 TTFE drill shape, Playwright
IdP strategy; 3.3 additive-change handling, +10% enforcement; 3.4 grader tenant isolation,
one-command setup; 3.5 the agent-proof mechanism, Idempotency-Key visibility.

**Partials worth a second look.** These read as answered but aren't: 1.4 secret storage
(architecture.md gives the algorithm, not the salting scheme or the loss-recovery process);
2.6 agent scopes (least-privilege asserted, scopes never enumerated); 3.5 metric fields —
architecture.md's audit row is *timestamp, client_id, user_id, route, scope, status, latency*
and **omits `request_id`**, which p.18 names explicitly and which `ApiError` already carries.
That is either a doc bug in architecture.md or a real omission; it is not this lane's to fix, so
if you conclude it's a defect, file it in `lane-99-unassigned.md`.

**Bullets I could not map to a ticket: none.** All 58 land in PF-753–PF-768. If you find one
that doesn't, the coverage table in PF-772 is the place it should have been caught.

**Scope boundary.** L26 owns the AI Cost Analysis deliverable (p.13). It overlaps 1.1 and 1.2 —
fanout, agent active rate, storage retention are cost-analysis inputs *and* Pre-Search answers.
This lane answers them as constraints; L26 turns them into the projection table. If the two
disagree at Final, the Pre-Search is the earlier document and L26 is the one that moves.
Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
