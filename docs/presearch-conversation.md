# Pre-Search — AI research conversation (reference artifact)

**Required by** PRD p.13: *"Pre-Search Document: All three phases completed with written
answers; **saved AI conversation attached as a reference artifact**."*

**Attached to** [`PRESEARCH-PLUGFORGE.md`](../PRESEARCH-PLUGFORGE.md) at the repository root.

| | |
|---|---|
| **Date** | 2026-08-12 |
| **Model** | Claude Opus 5 (`claude-opus-5`), via Claude Code |
| **Repository state** | `pf/integration` @ `cd12779` — ten lanes merged, 246 tickets marked done |
| **Branches produced** | `pf/L25-scaffold` → `pf/L25-phase1-constraints` → `pf/L25-phase2-architecture` → `pf/L25-phase3-refinement` → `pf/L25-defense-and-transcript` → `pf/L25-assembly` |
| **Redactions** | None were required. No secret, token or credential value appears in this file or in the session it records. Where a credential *name* appears (`AGENT_CLIENT_SECRET`, `GRADER_CLIENT_SECRET`, `DEMO_CLIENT_SECRET`) it is the environment-variable identifier, never a value |

---

## What this artifact is, stated precisely

**This is a record of the research session that produced `PRESEARCH-PLUGFORGE.md`: the sources
opened, the questions asked of the codebase, the measurements taken, and the conclusions each
one forced.** It is written from the session itself, not reconstructed afterwards from the
finished document.

**What it is not, and this matters for how a reader should weight it.** It is not a transcript
of a human-and-assistant dialogue in which architecture was decided. That conversation is not
this one and it did not happen here — **most of the decisions this Pre-Search records were
argued during the build**, by the lane authors, and they are preserved with their reasoning in
`tickets/plugforge/lane-99-unassigned.md` (fourteen decisions D1–D14) and in the audit notes of
the twenty-six lane files. This session's job was to **find those arguments, verify them against
the tree, and record them** — plus to answer the bullets nobody had reached.

Presenting a reconstructed dialogue as a saved conversation would be a fabricated artifact, and
p.13 asks for a reference document, not a performance. What follows is the real thing.

---

## 1 · Establishing the denominator: how many bullets is this?

**Question asked:** the lane brief and the ticket file both say 58. Is that right?

**Method.** Read `.claude/prd/page-15.txt` through `page-18.txt` directly and counted bullets
per subsection, rather than trusting either the brief or a total.

**Result — 58, confirmed, and the arithmetic is worth keeping because two traps live in it:**

```
Phase 1: 1.1(4) + 1.2(4) + 1.3(3) + 1.4(4) + 1.5(3) = 18
Phase 2: 2.1(4) + 2.2(4) + 2.3(4) + 2.4(4) + 2.5(4) + 2.6(4) = 24
Phase 3: 3.1(4) + 3.2(3) + 3.3(3) + 3.4(3) + 3.5(3) = 16
                                                    ---
                                                     58
```

**Trap 1 — section headings do not sit on the same page as their bullets.** `2.4 — SDK Design`
has two bullets on p.16 and two on p.17. `3.3 — Tooling & CI` is the **last line of p.17** while
all three of its bullets are on **p.18**. A count that follows headings gets a different answer
from a count that follows bullets.

**Trap 2 — compound bullets.** 2.6's scopes bullet is *"Which scopes does the agent request, and
what is your defense for each?"* — one bullet that expands to one answer per scope. It is counted
as one and answered as five (three granted, plus an explicit not-granted line for the writes).

---

## 2 · Locating the sources

**Finding:** `.claude/prd/` is **gitignored** and therefore absent from the worktree; it lives
only in the main checkout. Recorded because a future reader following this document from a clean
clone will not find the PRD where the citations point.

**Citation discipline adopted:** every PRD page reference in the Pre-Search was resolved by
`grep -l "<phrase>" .claude/prd/page-*.txt`, never from memory. `full.txt` reflows and its line
positions do **not** map to pages. Confirmed page assignments this way include:

| Phrase | Page |
|---|---|
| `"Pre-Search Document"` | p.13 |
| `"never recoverable"` | p.2 |
| `"IAM task role"` | p.2 |
| `"reuse invalidates"` | p.3 **and** p.15 |
| `"4xx"` | p.4 **and** p.16 |
| `250` (the SDK budget) | p.9 |

The `4xx` result is the one that mattered: **two pages, and they disagree** — p.4 says "4xx
permanent" flat while p.16 names 429 as transient. That is C-level contradiction material, not a
citation detail (see §5).

---

## 3 · Reading the decision record before writing anything

**The instruction that shaped the whole session:** for Phase 2 and Phase 3, most questions were
already decided and defended during the build. The job is to **record the decision and its
reasoning**, not to invent one — and where a question is genuinely open, to say so plainly and
give the range.

**Sources read in full:**

| Source | What it carried |
|---|---|
| `tickets/plugforge/lane-25-presearch.md` | the 26-ticket work order, and an audit note splitting the 58 bullets into ~22 already-answered and ~28 open |
| `tickets/plugforge/lane-99-unassigned.md` | **the primary source.** D1–D14, ~45 verified defects (F1–F45), three PRD contradictions (C1–C3), fourteen cross-lane disputes (B1–B14), six unticketable requirements (U1–U6) |
| `docs/architecture.md` | 449 lines, the graded architecture deliverable, already carrying full defenses for the consent screen, scope upgrades, token lifecycle, `ITokenStore`, secret storage and rotation |

**Consequence for the document's shape.** Roughly two-thirds of the Phase 2 and Phase 3 answers
are transcriptions of arguments made elsewhere, with a pointer to where they were made. The
Pre-Search is not the place those arguments live; it is the index to them. Restating a decision
as if it were open — or asserting one the record never made — were the two failure modes to
avoid, and the audit note in the lane file names both.

---

## 4 · Verification pass: which claims survive contact with the tree?

Two parallel research agents were dispatched to measure rather than assume. **Seven inherited
claims did not survive**, and each one changed an answer:

| Claim (as inherited) | What measurement showed | Where it changed the answer |
|---|---|---|
| SDK footprint **117.5 KB gzipped** | **Correct** — 120,305 B in `sdk/size-report.json`. But it is **gzip of *unminified* files**, an upper bound on min+gzip, and `size:check` runs in `.github/workflows/ci.yml` and **not** in `.gitlab-ci.yml` | Q7 states both caveats |
| Terraform apply **9m19s + 5m00s**, Aurora **8m23s** | Present in `docs/infra/apply-timing.md` — and that document **labels the figure "Unverified… not observed by me"** | Q53 quotes it as unverified. Quoting it as measured would contradict the artifact carrying it |
| NAT gateway **~$1/day** | **No such string exists** anywhere in the repo. The nearest datum is `$33` monthly in `INFRASTRUCTURE_SUMMARY.md:205` (≈ $1.10/day) | Q53 cites the monthly figure and derives the daily one |
| **1568** api tests passing | **Unverifiable.** `grep -rn "1568"` returns only coincidental UID substrings. Static count of `it(`/`test(` call sites under `api/src`: **1415** across 98 files; runtime would be higher via `it.each` | Not used as a claim anywhere in the Pre-Search |
| SDK error union has six `kind` members | **Five** — `'auth' \| 'rate_limit' \| 'not_found' \| 'validation' \| 'server'` (`sdk/src/errors.ts:45`). The 6→5 collapse is deliberate and documented | Q32 states five and explains the collapse |
| DLQ + circuit breaker enforce the cost ceiling | The retry ladder and `MAX_ATTEMPTS` are shipped constants. **`RetryScheduler` is a TODO, `HttpDeliverer` is a TODO, there is no delivery-log or DLQ table, and no webhook circuit breaker exists.** L16 is 0/34 | Q8 and Q44 state the mechanism as designed-not-built |
| Eleven lanes merged, 247 tickets | Measured **ten** lanes carrying `☑` rows, **246** tickets. L21 produced real artifacts (`docs/infra/*`) with **zero** ticked boxes | Reported as a discrepancy rather than repeated |

**One live contradiction found that no lane had recorded:** `api/src/db/platformApps.ts:93`
seeds the agent app with `['documents:read', 'issues:read', 'issues:write', 'sprints:read']` —
**four scopes including a write** — under a comment reading "Least privilege, not `*`". **D5b
decided read-only, exactly three.** The seed predates the decision and contradicts it; L23
PF-690's assertion would fail today. Carried into Q41, the D-6 defense block, and Open Items.

---

## 5 · The three PRD self-contradictions, and how each was resolved

Not resolved *by this session* — resolved during the build, and verified here. Recorded because
p.13 puts several of them in interview prep.

**C1 — Final Submission deadline.** 11:59 **AM** (p.1) vs 11:59 **PM** (p.12). Unresolved; the
board flags it. The safe reading is the earlier one.

**C2 — deployment target.** p.10's Technical Stack **permits Render by name**; p.2's MVP gate and
p.5's Terraform table demand IAM task/execution roles, VPC/subnets and security groups. Resolved
as **D6 → AWS**, on the principle that **a gate outranks a suggestion**: p.10 says *"Use whatever
stack helps you ship"* (a suggestion table) while p.2 is a hard gate, and Render's config carries
zero IAM, VPC or SG resources — it cannot satisfy the gate at all.

**C3 — webhook signing secret at rest.** p.3 says the secret is **hashed**; p.12 presumes the
server **re-signs each attempt with the subscription's current secret**. HMAC-SHA256 is
symmetric, so **a one-way hash cannot key it** — the two requirements are mutually impossible,
not a wording quibble. Resolved as **AES-256-GCM encrypted at rest**. The tempting non-answer —
store `sha256(secret)` and sign with *that* — satisfies the word and is theater: **whatever the
server signs with *is* the key**, so a database compromise forges signatures either way, and it
silently breaks the `verifyWebhook(headers, rawBody, secret)` signature printed on p.7. Note the
deliberate asymmetry with `client_secret`, which correctly stays **hashed**: a client secret is
*presented back to us* and verified by comparison; a signing secret is *used by us* to produce a
MAC and is never presented.

**C-adjacent — the 4xx question (D9).** p.4 says "4xx permanent" flat; p.16 asks the question and
names 429 as transient. L16 took the page that thought about it: **408, 425, 429 transient;
other 4xx permanent.** Dead-lettering a subscriber for rate-limiting *us* is the one failure a
sender cannot have.

---

## 6 · The questions this session had to answer rather than record

Roughly a third of the bullets had no recorded decision. These were reasoned from measurements
in the tree, and each carries its assumption in the answer:

| Q | Question | Basis for the answer |
|---|---|---|
| Q1–Q4 | scale, fanout, device concurrency, log growth | `docs/baseline-part1.json` (worst route p95 **6.93 ms**, flagship list **3.63 ms**), PRD p.9's volume tiers (5,000/day at 100 users), the shipped retry ladder |
| Q2 | the deliverer's 2 s breakpoint | Two breakpoints, not one: **N ≈ 40** against the delivery target at an *assumed* 50 ms/POST, and **N = 1** against the +10% API budget if `publish()` is awaited on the request path — because 3.63 ms → 3.99 ms is a budget one 50 ms outbound call overruns 12× |
| Q6 | daily CI-minute ceiling | Measured `e2e` runs of **78.9 / 81.7 / 79.7 min** in `.gitlab-ci.yml:387`, of which `file-attachments.spec.ts` is **39.7 min of pure timeout** |
| Q10 | hours per day | Refused to invent a figure. Reported the measured proxy — **81 commits on 12 Aug**, Week 5's ~28 h elapsed — and answered in coordination hours, which is what the execution model actually consumes |
| Q16–Q18 | team skill inventory | The only subsection not derivable from a file. Grounded in repository evidence (no authorization server existed in Part 1/2; 130 `registerPath()` calls establish Zod fluency; F14/F19–F23 are five consumer-found SDK defects) and flagged as author-attested |
| Q4, Q8 | delivery-log retention, breaker thresholds | **Left open** with a stated lean. D10 decided the *audit* log; no lane decided the delivery log, and L16 chose no breaker values |

**On Q10 specifically.** The PRD asks for hours and says "be honest." The honest answer is that
the units are wrong for this build: 81 commits in one day is not a typing rate, and the hours go
into closing decisions, resolving integration conflicts and refusing bad answers. Substituting a
plausible-sounding "6 hours a day of coding" would have been the fabrication the question is
explicitly guarding against.

---

## 7 · What is still open, and why that is the finding

Six items are recorded as **open with a stated range and lean**, not closed:

| | Open item |
|---|---|
| **D7** | webhook payload contents — ids / ids+title / full object. F10's hard delete makes a universal ids-only rule *impossible*, which is why it cannot be settled by picking the safest end |
| **D12** | the grader's app is read-only by requirement, so `ship docs create` — the headline of p.6's five-line story, the demo video and the Social Post — **fails for anyone following the README** |
| **D13** | three of five detectors read tables with no public route and no registered scope |
| **D14** | single-flight refresh is process-local; two terminals sharing one credential file revoke the family. **L06 reversed the coordinator's lean with a better argument** and that reversal is preserved rather than smoothed over |
| **U6** | **nothing gives an externally-hosted webhook listener a public URL** — and `ship webhooks tail` is the Social Post screenshot |
| **Agent scope seed** | ships `issues:write` against D5b's three read scopes |

**An honest open-items list is stronger evidence of a real Pre-Search than 58 confident
answers.** That is the lane file's own framing (PF-775) and this session took it literally: every
answer resting on an unverified assumption is marked **Designed / Verified / Unproven** in the
Pre-Search's Open Items table, with what would close it.

---

## 8 · Method notes for a reader reproducing this

- **Every number in the Pre-Search carries its denominator.** "117.5 KB" is meaningless without
  "against a 250 KB budget"; "6.93 ms" is meaningless without "60 samples, nearest-rank,
  in-process supertest, no TCP".
- **Where a measurement was inherited rather than taken, it says so.** The Terraform timings are
  the worked example: the artifact carrying them labels them unverified, and repeating them as
  measured would have been a citation that contradicted its own source.
- **Where nothing was measured, the answer states the assumption rather than a number dressed as
  a measurement.** The 50 ms per-delivery latency behind Q2's breakpoint is the clearest case and
  it is called out in the answer and in Open Items.
- **Week 5's `PRESEARCH.md` was not touched.** It is graded evidence for a different week.
