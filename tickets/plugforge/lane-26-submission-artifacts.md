# L26 · Docs, Cost Analysis & Submission

| | |
|---|---|
| **Agent** | `submission-artifacts` |
| **Tier** | 9 — last; blocks on every other lane |
| **Block** | PF-781–820 (35 allocated, PF-816–820 reserved for audit) |
| **Blocks on** | All lanes. Mechanically: L01 (PR discipline + baseline), L13 (spec), L21 (deployment), L25 (Pre-Search) |
| **Unblocks** | — |
| **MVP gate** | Item 9 — *"Existing Playwright regression suite passes on main; P95 latency, bundle size, and per-route query counts within +10% of the Part 1 baseline"* (p.2). Everything else here is graded at Final. |
| **Output** | `SUBMISSION-PLUGFORGE.md`, `docs/ai-cost-analysis.md`, `docs/per-epic-writeup.md`, `docs/three-discoveries.md`, reconciliation edits to `docs/architecture.md`, and a CI regression-budget job |

**What this lane is.** The Submission Requirements table (p.12–p.13) is ten rows. Nine other
lanes produce the artifacts those rows point at; this lane is what turns "the artifact exists"
into "the deliverable is submitted." Its acceptance criteria are therefore mostly *checks* —
the observable condition is what makes an artifact complete, not what makes it written.

**Where the Submission Requirements table actually lives.** The heading, the deadline line, and
the first two rows (GitHub Repository, Demo Video) are on **p.12**; the remaining eight rows
(Pre-Search through Social Post) are on **p.13**. The Required Documentation nine-section
Section/Content table is also **p.12**, under a heading whose last line sits on p.11. Every
citation below was grep-checked against `.claude/prd/page-N.txt`; L25 cites p.13 for
Submission Requirements and is right about its own row and wrong about the heading — both
halves are true and neither should be "corrected" at audit.

**Three rows this lane does not author.** Pre-Search (L25), OpenAPI generation (L13), and
deployment (L21). PF-812, PF-813 and PF-814 are submission-readiness checks over their output,
deliberately not re-statements of their work. If a check here starts describing *how* to build
the artifact, it has drifted into another lane.

**`docs/architecture.md` already exists and already covers all nine required sections.** So the
architecture-document work is verification and reconciliation. `lane-99-unassigned.md`
§ *Documentation drift* logs four places (G1–G4) where the document contradicts the code; each
gets its own reconciliation ticket, and G3's fix already belongs to L21 PF-647 — PF-790 verifies
that landing rather than redoing it.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-781 | ☐ `SUBMISSION-PLUGFORGE.md` — one row per Submission Requirements deliverable | Exactly **ten** rows, named verbatim from the PRD table (GitHub Repository, Demo Video, Pre-Search Document, Architecture Document, OpenAPI Spec, AI Cost Analysis, Per-Epic Write-up, Three Discoveries, Deployed Application, Social Post); each row carries the owning lane, the artifact path or URL, and a Ready / Not-ready state. A grader checks completeness by counting rows, and a row with no resolvable path is Not-ready by definition | — | p.12, p.13 | — |
| PF-782 | ☐ Resolve the Final Submission deadline contradiction — **by asking, not by assuming** | p.1 Project Overview says Sunday **11:59 AM CT**; p.12 Submission Requirements says Sunday **11:59 PM CT**. Ticket closes when a grader's answer is recorded in `SUBMISSION-PLUGFORGE.md` with the date asked, the channel, and the answer. Until then the board plans against the **earlier** time and says so explicitly — an unrecorded assumption that PM wins is a twelve-hour bet on a document that disagrees with itself | — | p.1, p.12 | PF-781 |
| PF-783 | ☐ Repo state audit — public, and every per-slice branch still on the remote | Two mechanical checks recorded with output: (a) the repo resolves over HTTPS from a logged-out client, not just from an authenticated one; (b) `git ls-remote --heads origin 'pf/*'` returns a branch for every slice declared in every lane file's `## Slices` section, count matching. p.12 grades *"Public; per-slice branches preserved"* — a merged-and-deleted branch is unrecoverable evidence loss | SUB:GitHub Repository | p.12 | PF-025 |
| PF-784 | ☐ PR-body compliance sweep across every merged PR | For each merged PR: the body names the acceptance criterion the slice advances (ticket IDs **and** criterion text) and confirms the fitness test passed — and the named fitness test resolves to a real test or check that has a passing run. PF-026 enforces the *sections exist* at PR time; this is the submission-time check that the content is true. Output is a table of PR number → criterion → fitness test → pass evidence, with zero unresolved rows | SUB:GitHub Repository | p.12 | PF-024, PF-026 |
| PF-785 | ☐ Branch-name and slice-mapping reconciliation | Every remote branch matches `pf/LNN-<slug>` with `LNN` resolving to a real lane file, and the slice map is bijective: each declared slice has exactly one merged PR, each merged PR maps to exactly one declared slice. Orphans in either direction are listed and resolved before Final — a PR with no slice cannot name what it advances, and a slice with no PR is undelivered work the index will claim as Ready | SUB:GitHub Repository | p.12 | PF-023, PF-783 |
| PF-786 | ☐ Nine required sections present, correctly named, and inside the length limit | A check asserts `docs/architecture.md` carries all nine headings from the p.12 Section/Content table — Module Layout, SOLID Rationale, Composition Root, Public/Internal Boundary, OAuth Flows, Webhook Pipeline, SDK Surface, Agent-as-Citizen, Failure Modes — and no required section is missing. p.13 caps it at *1–2 pages*: the ticket states how pages were measured (rendered output, not source lines) and the resulting number. The file today is 192 source lines with five mermaid diagrams, so the measurement is not optional | SUB:Architecture Document | p.12, p.13 | — |
| PF-787 | ☐ Per-section content contract — each section carries the artifact its row demands | Nine checklist rows, each citing the line where the demanded element appears: Module Layout = tree covering all eight named modules with one sentence each; SOLID = one paragraph per principle **with a file path**; Composition Root = annotated pseudo-code **plus** the in-memory test wiring as a sibling; Public/Internal Boundary = a sequence diagram; OAuth Flows = two sequence diagrams marking where PKCE is validated and where rotation happens; Webhook Pipeline = the full chain with the signature site and Idempotency-Key origin marked; SDK Surface = stable vs pre-1.0 explicitly marked; Agent-as-Citizen = before/after diagram with the audit-log payoff marked; Failure Modes = one paragraph each for all four named scenarios. A section present but missing its demanded element fails the row | SUB:Architecture Document | p.12 | PF-786 |
| PF-788 | ☐ Reconcile G1 — the doc claims the agent's OAuth app is **seeded by migration** | `docs/architecture.md` line ~178 asserts migration seeding; the repo seeds through `seed.ts`. p.17 only *asks* the question, so the commitment is ours and it is new work. Ticket closes when one of two states is true and recorded: the migration seeding shipped, or the doc says `seed.ts` — plus, either way, the doc answers p.17's real question (*what guarantees the app exists in deployed environments*). Leaving both documents in disagreement is not a third option | SUB:Architecture Document | p.17 | PF-787 |
| PF-789 | ☐ Reconcile G2 — the audit-field list omits `request_id` | `docs/architecture.md` line ~18 lists *timestamp, client_id, user_id, route, scope, status, latency*. p.18 names `request_id` explicitly and the `ApiError` interface (p.7) already carries it. Ticket closes when the doc's field list, the shipped audit-row columns, and p.18's list agree — or when the omission is stated as a decision with its reason. Silent divergence between a graded doc and a graded interface is the failure mode | SUB:Architecture Document | p.18, p.7 | PF-787 |
| PF-790 | ☐ Reconcile G3 — *"the Terraform delta is env-group entries only"* | L21 PF-647 owns the edit; this ticket owns the verification. `terraform/render/main.tf` declares no `render_env_group` — env vars are an inline map on the web service. Closes when a reviewer diffing the Deployment Topology paragraph against the shipped config finds no discrepancy, and the zero-new-resources claim it sits next to is sourced from the PRD (PF-621) rather than from our own document | SUB:Architecture Document | p.5, p.12 | PF-622, PF-787 |
| PF-791 | ☐ Reconcile G4 — the doc never names the agent's OAuth grant type | It says *"first-party OAuth app"* and stops. p.17 asks which flow — Authorization Code, Device Grant, or Client Credentials (RFC 6749 §4.4) — and demands the choice be defended; p.13's interview topics put the agent's citizenship on the record. Closes when Agent-as-Citizen names one grant, cites the RFC section, and states the rejected alternatives, so the question is answerable from the document alone. Tracked as D5 in `lane-99-unassigned.md` — the decision is the user's; the recording is this ticket's | SUB:Architecture Document | p.17, p.13 | PF-787 |
| PF-792 | ☐ Reconcile the two diagrams that describe composition the code does not yet have | Public/Internal Boundary names `documentService (utils/document-crud.ts)` as the shared seam — F8: that file has no create/update/delete and write SQL is inline in the route files. Composition Root's pseudo-code mounts `/api/v1/openapi.json` **after** `app.use('/api/v1', v1)` and under a blanket `router.use(bearerAuth)` — F11: as drawn, the spec route 404s and 401s. Closes when both diagrams match the shipped wiring, including middleware order, and a reader tracing either diagram against `api/src/app.ts` lands on real code | SUB:Architecture Document | p.12 | PF-403, PF-365, PF-366, PF-213 |
| PF-793 | ☐ As-built sweep of the load-bearing specifics | After the build lands, every concrete value the doc asserts is checked against shipped code and named in a table with its source line: hash algorithm, retry-ladder values, the exact signed string and header format, the five `kind` error-union members, the scope names, the cursor envelope keys, the SDK footprint budget, the signature tolerance seconds. Any divergence is resolved in one direction and the ticket records **which document moved**. This runs after L25 PF-773 and in the opposite direction — PF-773 aligns the Pre-Search to the architecture doc; this aligns the architecture doc to the code | SUB:Architecture Document | p.12, p.13 | PF-787, PF-773 |
| PF-794 | ☐ Scaffold `docs/ai-cost-analysis.md` — three halves, and the headline claim proven | Three sections named from the p.13 row itself: **tracked dev spend**, **production projections table**, **explicit assumptions**. The document opens by proving rather than asserting p.9's headline discipline — *"the platform itself does zero AI work"* / p.11's *"The platform never invokes the LLM"* — with a named mechanical check (no module under `api/src/platform/**` imports an LLM client) and its output pasted in. An assertion with no check behind it is the one claim in this document a grader can falsify in thirty seconds | SUB:AI Cost Analysis | p.13, p.9, p.11 | — |
| PF-795 | ☐ Dev spend — LLM during the Epic 7 rewire, with before/after token volume | Per-day spend recorded across the rewire days (p.9: *"track per-day spend while migrating direct service calls to SDK calls"*), plus the measurement that answers p.9's actual demand: token counts per agent turn over the same fixture prompt set, flag-off vs flag-on, stated as absolute numbers and a percentage delta. The claim *"the rewire does not change token volume"* is then either confirmed with that delta or refuted with it — a rewire that moved token volume and said nothing is the failure this bullet exists to catch | SUB:AI Cost Analysis | p.9 | — |
| PF-796 | ☐ Dev spend — CI compute across the three metered jobs | Three separate numbers, none folded into a total: **TTFE drill** — measured seconds per run, timed on Day 1 *and* at Final (p.9 asks for the Day-1 number explicitly), × runs per PR × PRs per day → weekly CI minutes and dollars at the runner's posted rate; **OAuth Playwright browser launches** — an instrumented count per suite run, not an estimate, converted to compute minutes; **OpenAPI generation and validation overhead** — milliseconds per CI run and its share of the CI bill, because p.9 asks for *a number rather than a hand-wave*. A section that reports only the total fails all three | SUB:AI Cost Analysis | p.9, p.8 | PF-371 |
| PF-797 | ☐ Dev spend — dev-portal storage and egress at demo volume | Sized, not guessed: delivery-log rows produced per drill run × bytes per row × drill runs over the week, plus portal egress at the expected demo volume. p.9 notes the logs *"grow with every drill run"*, so the number is a function of drill frequency and the ticket states which frequency it used. Feeds PF-801's retention arithmetic — the two must use the same bytes-per-row figure | SUB:AI Cost Analysis | p.9 | PF-794 |
| PF-798 | ☐ Production projections table — state whether each figure is reproduced or derived | p.9 supplies a four-tier table (100 / 1k / 10k / 100k users; API calls/day, webhook deliveries/day, agent LLM calls/day, est. cost/month). The deliverable reproduces the tier structure **and** labels every cell `[PRD]` or `[derived]`. Every `[derived]` cell shows its arithmetic from PF-799/PF-800's assumptions. Where our derivation disagrees with p.9's figure, the disagreement is shown side by side and explained — never silently overwritten. A table copied wholesale carries no assumptions and cannot be defended in the interview; a table that quietly contradicts the PRD's own numbers reads as an error rather than a finding | SUB:AI Cost Analysis | p.9 | PF-794 |
| PF-799 | ☐ Assumption — webhook fanout ratio, stated explicitly | One ratio: webhook deliveries triggered per write operation, backed by the average number of subscriptions per event type at each tier (p.9 asks for exactly that decomposition and says *"State this explicitly"*). The projections table's deliveries/day column equals that ratio × writes/day and the arithmetic is reproducible by hand from the stated numbers. Reconciles with L25 PF-753's fanout answer — if the two disagree at Final, the Pre-Search is the earlier document and this one moves | SUB:AI Cost Analysis | p.9 | PF-798, PF-753 |
| PF-800 | ☐ Assumption — agent active rate, with its sensitivity | Two numbers: fraction of users using agent features on a given day, and average agent turns per active user. The agent-LLM-calls/day column equals users × active rate × turns per user and the arithmetic checks against PF-798's table. p.9–p.10 states the projection *"bends on this assumption, not on platform traffic"* — so the section also states what the monthly cost does at 2× the assumed rate. An assumption whose sensitivity is unstated is a number, not an assumption | SUB:AI Cost Analysis | p.10, p.9 | PF-798 |
| PF-801 | ☐ Assumption — storage retention, **both** windows, each with why it is set there | p.10 demands delivery-log rows × retention days × bytes per row, *plus* audit-log rows, and *"State both retention windows and explain why each is set there."* So: two windows as day counts, two bytes-per-row figures (bytes-per-row shared with PF-797), two monthly storage numbers, and a reason per window that is a constraint rather than a preference — replay usefulness and DLQ tail for deliveries, incident forensics and the agent-went-through-the-front-door proof for audit. Identical windows are allowed; an unexplained window is not | SUB:AI Cost Analysis | p.10 | PF-797, PF-798 |
| PF-802 | ☐ Close the baseline handoff — L01 captures it, L26 consumes it | L01 PF-020 writes P95 latency, bundle size and per-route query counts to `docs/baseline-part1.json`; this lane's comparator reads it. Closes when the file's schema is documented in one place both sides cite, and the comparator **fails loudly** on a missing, empty, or schema-mismatched baseline rather than passing vacuously. L01's audit notes flagged this exact handoff as a possible gap between lanes — a comparator that green-lights an absent denominator is what that gap looks like in production | MVP-9 | p.2, p.6 | PF-020 |
| PF-803 | ☐ Comparator computes all three metrics as explicit deltas | For each of P95 latency, bundle size, and per-route query counts the comparator emits current value, baseline value, and percentage delta. Query counts are reported **per route**, not aggregated — p.2's wording is *"per-route query counts"*, and an aggregate hides a single route that tripled. Output is a committed artifact a grader can read, not console text | MVP-9 | p.2, p.6 | PF-802 |
| PF-804 | ☐ CI job fails the PR above +10% on any of the three metrics | Proven by seeding a deliberate ~11% regression in each metric in turn and showing the job fails three separate times, each with a message naming the metric, the affected route where applicable, and both numbers. p.18's Pre-Search question asks whether enforcement is manual, a baseline comparison, or a failing perf job — this ticket is the answer being *a failing perf job*, and a job that has never been seen to fail is not evidence of one | MVP-9 | p.2, p.6, p.18 | PF-803 |
| PF-805 | ☐ Record MVP item 9 evidence — both halves | The gate item is two claims. First: the existing Playwright regression suite passes **on main**, recorded with the run date and link (run via `/e2e-test-runner`, never `pnpm test:e2e` directly). Second: the three deltas from PF-803, each at or under +10%. Both pasted into `SUBMISSION-PLUGFORGE.md` under the MVP row. A green suite with no delta numbers satisfies half a gate item | MVP-9 | p.2, p.6 | PF-019, PF-804 |
| PF-806 | ☐ Demo video — the five-line story, then the dev-portal replay | Runtime between 3:00 and 5:00. The five-line story (p.6) runs live in order in a fresh terminal: `pnpm install @ship/sdk` → `ship login` → `ship docs create` → `ship webhooks tail` → a `document.created` delivery arrives with its signature verified. Then the video switches to the dev portal and replays one delivery, per p.12. Ticket carries a shot list mapping all six beats to timestamps, so "the demo shows it" is checkable rather than asserted | SUB:Demo Video | p.12, p.6 | — |
| PF-807 | ☐ Per-Epic Write-up — all four headings, every epic | `docs/per-epic-writeup.md` has one entry per epic, each with **before → fix → after → proof** as four non-empty headings in that order. An entry whose `proof` is a description rather than an artifact fails the check. p.13 names the shape; a write-up that narrates the work without proving it is the common failure and the reason `proof` is a separate heading rather than a closing sentence | SUB:Per-Epic Write-up | p.13 | PF-781 |
| PF-808 | ☐ Epic 6 proof — the TTFE drill passing **in CI** | The Epic 6 entry links a specific CI run in which `pnpm drill ttfe` passed, and quotes that run's elapsed time against the < 60 s target. p.13 says *"proof is the TTFE drill passing in CI"* — a local run, a screenshot of a terminal, or a green badge with no run ID does not satisfy the word *CI*. The stage timings from the drill's own instrumentation appear alongside the total | SUB:Per-Epic Write-up | p.13, p.8, p.6 | PF-807 |
| PF-809 | ☐ Epic 7 proof — the agent's audit-log rows showing OAuth app authentication | The Epic 7 entry embeds real rows from a flag-on run — timestamp, the agent app's `client_id`, route, scope, status — **and** the query that produced them, so a grader can re-run it against the deployed instance. p.13 is specific that the proof is the rows. A row set whose `client_id` is null or is the primary account disproves the claim rather than proving it | SUB:Per-Epic Write-up | p.13 | PF-807 |
| PF-810 | ☐ Three Discoveries — capture as they happen, select at the end | A dated running log, one entry per discovery written the day it happened, each stating what was expected, what was actually found, and the commit or artifact that proves it. At Final exactly three are promoted to `docs/three-discoveries.md`. p.13 names strong candidates (Device Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC + timestamp anti-replay, async-iterator pagination as a DX pattern) — a promoted entry that restates a candidate without our own specific finding and its evidence fails. Discoveries reconstructed on Sunday from memory are indistinguishable from the PRD's list, which is why the log is the ticket and the selection is the footnote | SUB:Three Discoveries | p.13 | — |
| PF-811 | ☐ Social post tagging @GauntletAI with the required screenshot | Post tags @GauntletAI and its screenshot is the `ship webhooks tail` terminal showing a verified signed event arriving in real time — p.13 specifies that terminal, so a portal screenshot, a code screenshot, or a staged mock does not satisfy the row. Post URL recorded in `SUBMISSION-PLUGFORGE.md` and resolving publicly | SUB:Social Post | p.13, p.6 | PF-781 |
| PF-812 | ☐ Pre-Search Document — submission-readiness check only | L25 authors it; this ticket reads p.13's row literally and confirms both halves from a **clean clone**: all three phases present with written answers and no placeholder text, and the saved AI conversation attached as a reference artifact at a path that resolves. Ticket does not review the answers — L25 PF-772/PF-776 own completeness. It fails only on the two conditions p.13 names | SUB:Pre-Search Document | p.13 | PF-771, PF-776 |
| PF-813 | ☐ OpenAPI Spec — the submission artifact, both copies, validated | L13 generates; this ticket ships the row. Confirms from outside the repo and outside localhost: the live `/api/v1/openapi.json` on the deployed instance returns 200 without credentials, `docs/openapi.json` exists in the repo and is byte-identical to the served document, and the served bytes validate against the OpenAPI 3.1 schema. Both URLs recorded in `SUBMISSION-PLUGFORGE.md`. p.13 requires the live URL *and* the static copy — shipping one is half the row | SUB:OpenAPI Spec | p.13 | PF-368, PF-369, PF-372, PF-629 |
| PF-814 | ☐ Deployed Application — README credentials and a reachability check from outside | L21 deploys; this ticket verifies the row as a grader experiences it. From a machine with no project state: the public URL loads, the dev portal is reachable, the OpenAPI spec resolves, and the README section carries the grader `client_id`, its read-only scopes, and the one-command CLI setup — run verbatim from the README and observed to work. p.13 requires *"credentials in the README"* and *"Dev portal reachable; OpenAPI spec resolvable"*; a credential that only works from the author's shell is not a credential in the README | SUB:Deployed Application | p.13, p.18 | PF-628, PF-630, PF-631 |
| PF-815 | ☐ Final assembly — ten rows Ready, deadline resolved, submitted | `SUBMISSION-PLUGFORGE.md` shows all ten Submission Requirements rows Ready with a resolving path or URL each; PF-782's confirmed deadline is recorded and the submission happens before it; a clean clone plus the recorded URLs reproduces every deliverable with no reference to the author's working tree. Last check before submitting: **no merged-branch pruning has occurred** — `repo-cleanup`, `git branch -d`, and auto-delete-head-branch each destroy graded evidence that the remote cannot return once both sides are gone | — | p.12, p.13 | PF-781, PF-783, PF-784, PF-785, PF-793, PF-794, PF-805, PF-806, PF-807, PF-810, PF-811, PF-812, PF-813, PF-814 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L26-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed. Most of this
lane's fitness tests are completeness checks over an artifact rather than a test run — stated as
such in the PR body rather than dressed up as a green suite. S4 is the exception: it ships a real
CI job and its fitness test is that job failing on a seeded regression.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L26-repo-and-pr-discipline` | PF-781–785 | Submission index exists; the GitHub Repository row is verifiably satisfied (public, branches preserved, PR bodies compliant) | Index has ten rows matching the PRD table; `git ls-remote` returns a branch per declared slice; zero non-compliant merged PRs; slice↔PR mapping bijective |
| S2 | `pf/L26-architecture-doc` | PF-786–793 | Architecture Document row complete — nine sections verified against the p.12 contract and reconciled against the code | Nine-heading check passes; nine per-section rows each cite a line; G1–G4 each closed in one recorded direction; as-built value table has zero unresolved divergences |
| S3 | `pf/L26-cost-analysis` | PF-794–801 | AI Cost Analysis row complete — tracked dev spend, projections table, and all three named assumptions | Every dev-cost bullet carries a number; every projection cell labeled `[PRD]` or `[derived]` with arithmetic; fanout ratio, agent active rate, and both retention windows each state a number and its reason |
| S4 | `pf/L26-regression-budget` | PF-802–805 | MVP gate item 9 — regression suite green and P95, bundle size, per-route query counts within +10% of the Part 1 baseline | Comparator fails on an absent baseline; seeded ~11% regressions fail the CI job three separate ways with named metrics |
| S5 | `pf/L26-demo-and-writeups` | PF-806–811 | Demo Video, Per-Epic Write-up, Three Discoveries, Social Post | Video 3:00–5:00 with six timestamped beats; every epic entry has four non-empty headings; Epic 6 links a CI run ID and Epic 7 embeds rows plus the query; exactly three discoveries, each with its own evidence; post URL resolves and tags @GauntletAI |
| S6 | `pf/L26-final-assembly` | PF-812–815 | The three rows other lanes produce are submission-ready, and the submission goes out | Clean-clone reproduction of every deliverable; live spec 200s uncredentialed and matches `docs/openapi.json`; README one-command setup run verbatim; ten Ready rows before the confirmed deadline |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots in this lane, stated so you
can confirm or refute rather than rediscover.

**Which page the Submission Requirements table is on.** Both p.12 and p.13, and the split is not
cosmetic. p.12 carries the heading, `Deadline: Sunday 11:59 PM CT`, and the GitHub Repository and
Demo Video rows. p.13 carries the other eight. The Required Documentation nine-section table is
also p.12 — its heading's last line (*"Architecture Document (1–2 pages) committed at
docs/architecture.md"*) is the final line of p.11. So a ticket about branch discipline cites
p.12, a ticket about the cost analysis cites p.13, and both are right. Do not normalize them.

**Submission Requirements coverage: 10 of 10 rows.** GitHub Repository → PF-783–785 · Demo Video
→ PF-806 · Pre-Search → PF-812 · Architecture Document → PF-786–793 · OpenAPI Spec → PF-813 ·
AI Cost Analysis → PF-794–801 · Per-Epic Write-up → PF-807–809 · Three Discoveries → PF-810 ·
Deployed Application → PF-814 · Social Post → PF-811. If you find a row that isn't reachable
from a ticket, PF-781's ten-row index is where it should have been caught.

**No `CTR:` entries in this lane, deliberately.** Everything L26 owns is either a Submission
Requirements row or MVP gate item 9. If you think a Core Technical Requirement (p.2–p.5) landed
here uncited, name it — but check first that it isn't L13's, L20's, or L21's.

**The +10% handoff was a real gap and PF-802 is the whole reason this slice exists.** L01's audit
notes say: *"The +10% regression budget (p.6) is captured here but enforced in L26. Confirm the
handoff is real and not a gap between lanes."* It was a gap: PF-020 writes `docs/baseline-part1.json`
and, before this lane, nothing read it. The failure mode to check for is not a missing job — it
is a job that runs, finds no baseline, and reports success. PF-802's criterion is specifically
that it fails loudly instead.

**Reproduce-or-derive on the projections table is a judgment call I made and you should re-test.**
p.9 hands over a complete four-tier table. Two readings: the deliverable is that table copied
with our assumptions attached, or the deliverable is our own table derived from our own
assumptions. PF-798 does both — reproduce the structure, label every cell, show the arithmetic
for the derived ones, and surface disagreements side by side rather than overwriting. My reason:
p.13's row demands *"explicit assumptions"*, and assumptions that don't generate the numbers
aren't load-bearing; but silently contradicting the PRD's own figures reads as an arithmetic
error, not a finding. If you think one reading clearly wins, say which — this is the single
softest call in the lane.

**Overlap with L25 on the cost assumptions, and the tie-break.** Fanout ratio, agent active rate
and retention windows are Pre-Search answers (L25 PF-753, PF-754) *and* cost-analysis inputs
(PF-799, PF-800, PF-801). L25's own scope note sets the rule: the Pre-Search is the earlier
document and L26 moves if they disagree. PF-799 states that explicitly; PF-800 and PF-801 should
inherit it. Bytes-per-row is shared between PF-797 and PF-801 and must be one number, not two.

**PF-793 and L25 PF-773 run in opposite directions, on purpose.** PF-773 aligns the Pre-Search to
`docs/architecture.md`. PF-793 aligns `docs/architecture.md` to the shipped code. Run PF-793
first if you can — otherwise PF-773 can align the Pre-Search to a doc that is about to move.
That sequencing is not encoded in the Deps column because L25 lands earlier in the week; flag it
if you think it should be.

**G3 belongs to L21, not here.** PF-790 verifies PF-622's landing. If you find PF-790 re-writing
the Deployment Topology paragraph rather than checking it, that is scope creep and should be cut.

**Two tickets I could not make fully mechanical.** PF-782 (the deadline) closes on a human answer
from a grader — there is no check that resolves a document contradicting itself, and asserting PM
because it appears in the Submission Requirements section would be exactly the assumption the
ticket exists to prevent. PF-806 (the demo video) can be checked for runtime and beat coverage
but not for whether the five-line story actually *worked* on camera; that depends on L19 and L20
having landed, and it is the ticket most likely to be discovered broken on Sunday.

**Things this lane deliberately does not claim.** MVP-10 (deployed + public spec URL +
pre-registered grader app) is L21's — PF-814 checks the same surfaces from the grader's side and
advances `SUB:Deployed Application` rather than double-claiming the gate item. Likewise PF-813
advances `SUB:OpenAPI Spec` and leaves MVP-7 to L13. If the audit wants gate items claimed by
every lane that touches them, that is a spine-level decision, not a lane-level one.

**Deps reference only lanes whose files exist** (L01, L03, L07, L08, L13, L14, L21, L25). Real
dependencies on L12 (audit rows for PF-809), L19/L20 (the drill and CLI behind PF-806 and
PF-808), L22 (portal replay in PF-806), and L23 (the rewire behind PF-788, PF-795 and PF-809)
are stated in prose here and must be added to the Deps column once those lane files land.

Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
