# AI Cost Analysis

Brief p.11: *"Dev spend + reflection on AI tool effectiveness for codebase comprehension."*

---

## Dev spend

| | |
|---|---:|
| Claude Max subscription — flat, not metered | **$100 / month** |
| Anthropic API usage — metered | **$67** |
| *Marginal cost attributable to this project* | ***$67*** |

**The subscription is not attributable to this project and is not presented as if it were.**
Claude Max is a flat monthly fee that would have been paid whether or not this fork
existed, and it covered the interactive sessions — the audit, the implementation, the
integration. The $67 is the only marginal, project-attributable spend: metered API calls
for the parallel improvement agents.

Stating it as a split rather than a single total is deliberate. Folding a share of a
monthly subscription into a project figure requires deciding how much of the month this
project "used", and any such number would be an allocation choice presented as a
measurement — the same error this project spent two days avoiding in its benchmarks.

That split is the honest shape of the number, and it is worth stating plainly rather than
adding the two together into a single figure that implies precision nobody has. A blended
"total cost of this project" would be a guess about how much of a month's subscription to
allocate to 36 hours of work.

### What the $67 bought

Ten improvement lanes running in parallel worktrees, each an autonomous agent owning one
category end to end. Three of them self-reported token usage before dying on session
limits: **115,613 · 153,409 · 155,294**. That is the scale of a single lane, and there
were ten.

### What was produced against it

| | |
|---|---:|
| Codebase read | 432 TS/TSX files · 127,199 LOC |
| Commits | 94 |
| Files changed | 290 |
| Lines | +30,310 / −1,607 |
| Documentation written | 16 markdown files, 5,194 lines |
| Elapsed | ~28 hours |

---

## What this would have cost as manual engineering

**This section is an estimate, not a measurement, and it is labelled that way throughout.**
Everything above it comes from a command; everything in it comes from judgement about
effort. The assumptions are stated so a reader who disagrees can substitute their own and
re-derive the number, which is the same standard the benchmarks in this repo are held to.

### Who would do this work

The scope — audit eight categories of an unfamiliar 127,199-line system, build a
measurement harness per category, implement across TypeScript, PostgreSQL, React, CRDTs,
accessibility and Terraform, then stand up CI on two platforms — is not a single-specialty
job. In the federal **2210 (Information Technology Management)** series that lands at
**GS-13 to GS-15**, with GS-14 the most representative: independent technical judgement
across domains, no day-to-day supervision.

2026 Washington–Baltimore–Arlington locality is **33.94%**, ranking 5th of 58 federal pay
areas. Step 1 rates including locality:

| Grade | Salary (Step 1, DC locality) |
|---|---:|
| GS-13 | $121,785 |
| GS-14 | $143,913 |
| GS-15 | $169,279 |
| *GS-15 Step 10 (2026 cap)* | *$197,200* |

Two adjustments a serious estimate has to name:

- **The 2210 Special Salary Rate.** OPM has used 5 U.S.C. § 5305 authority since 2001 to
  raise pay where the government cannot recruit at base GS rates; IT and cyber qualify. The
  SSR replaces base GS pay and locality then stacks on the higher base, worth **20%+** for
  mid-career DC IT staff. Reported Treasury 2210 pay averages **$140,325**, range
  $108,101–$184,187 — consistent with GS-13/14 plus SSR.
- **Fully loaded cost.** Salary is not cost. Benefits, payroll taxes, and overhead put
  knowledge workers at **1.35×–1.60×** base. **1.35× is used below** — the conservative end,
  chosen deliberately so the comparison is not flattered.

### How long it would take

Estimated in engineer-days for one competent engineer new to this codebase, working to the
same evidentiary standard this project actually met — before/after under identical
conditions, committed measurement scripts, regression tests, written tradeoffs.

| Work | Days |
|---|---:|
| Orientation — read 432 files / 127,199 LOC to the point of being able to measure it | 5–10 |
| Audit: build a measurement harness per category, capture baselines, write the report | 8–12 |
| Cat 1 — type safety, 233 assertion sites + narrowing design | 3–5 |
| Cat 2 — bundle, lazy boundaries + vendor chunking + a second measurement script | 2–3 |
| Cat 3 — API, 4 handler rewrites + a *paired* benchmark harness | 4–6 |
| Cat 4 — DB, session-write throttle + EXPLAIN capture | 2–3 |
| Cat 5 — flake RCA (3× full-suite baselines; the slowest work per line changed) | 4–6 |
| Cat 6 — error handling, incl. migrating the title into the CRDT | 5–8 |
| Cat 7 — accessibility, 284 SVGs + contrast token split + tree roles | 3–5 |
| Cat 8 — Terraform, two configs from scratch + blast radius + drift demo | 3–5 |
| CI on two platforms, Docker, one-command cold start | 3–5 |
| Documentation — 5,194 lines across 16 files | 3–5 |
| Integration, conflict resolution, regression chasing | 3–5 |
| **Total** | **48–78 days** |

That is **≈ 10–16 weeks**, midpoint **13 weeks**, for one engineer.

### The comparison

Fully loaded weekly cost at 1.35×:

| Grade | Loaded annual | Per week | × 13 weeks |
|---|---:|---:|---:|
| GS-13 | $164,410 | $3,162 | **$41,106** |
| GS-14 | $194,283 | $3,736 | **$48,568** |
| GS-15 | $228,527 | $4,395 | **$57,135** |

Against what was actually spent. **The honest version includes the human hours, because
this was not unattended** — an engineer directed it, reviewed output, caught errors, and
made every judgement call:

| | |
|---|---:|
| Metered API | $67 |
| Human direction — ~36 h at the GS-14 loaded rate ($93.40/h) | $3,362 |
| **Total** | **≈ $3,429** |

| | |
|---|---:|
| Manual, GS-14, 13 weeks | **$48,568** |
| AI-assisted, same deliverable | **$3,429** |
| **Ratio** | **≈ 14×** |

Range across the band: **12× (GS-13, 10 weeks) to 20× (GS-15, 16 weeks).**

### Why the number is 14× and not 600×

Dividing $48,568 by the $67 API line alone gives ~725×, and that figure would be
dishonest. It prices the engineer's time at zero, and this project is a direct
demonstration that engineer time is exactly what made the AI output trustworthy — every
failure catalogued in the next section was caught by a human insisting on re-measurement,
including two lane branches asserted merged that were not.

The defensible claim is narrower and still large: **the same deliverable, at the same
evidentiary standard, for roughly a fourteenth of the fully loaded cost — because the
engineer spent 36 hours instead of 13 weeks.** The multiplier is on *elapsed engineer
time*, not on the AI doing the job unsupervised.

### What the estimate excludes

- Federal hiring lead time. A GS-14 vacancy takes months to fill; this project had 36 hours
  for its audit gate.
- Contractor rates, which run $150–$250/h loaded and would raise the manual figure
  substantially — 520 hours at $200/h is **$104,000**.
- Any cost for the failure modes AI introduced. Two lanes reported green while broken; a
  silent type-safety regression passed every gate. Catching those consumed part of the 36
  hours and is already inside the $3,429.

---

## Reflection: AI tool effectiveness for codebase comprehension

The brief scopes this narrowly — not whether AI writes code quickly, but whether it helps
you **understand a system you did not write**. On this project the answer split cleanly,
and the split is the finding:

> **AI comprehended the codebase well and comprehended its own completion state badly.**

Those are different skills, and only the first one improved with a better model.

### Where it was genuinely effective

**Breadth no human has in 36 hours.** The audit needed baseline measurements across eight
categories of a 127,199-line codebase nobody on this side had seen. Reading enough of it to
measure honestly is not a thing a person does in a day and a half.

**Finding mechanisms rather than symptoms.** Three examples that made the Discovery
Write-up, each of which required following a thread rather than pattern-matching:

- `pg_advisory_xact_lock` in `issues.ts:585-601` giving gapless per-workspace ticket
  numbers — and the bug next to it, a `parseInt` over 15 hex chars that exceeds
  `Number.MAX_SAFE_INTEGER`
- worker-scoped Playwright fixtures standing in for testcontainers
- a partial expression index on JSONB at `schema.sql:358`

**Negative facts, cheaply.** The single most useful comprehension result all week was
establishing that `data-state` **does not exist anywhere in `web/src`**. A test had waited
on `data-state="active"` inside a `.catch()` since the file was written; the assertion
could never succeed, timed out every run, and was swallowed. Every one of that file's 66
tests had been racing a panel render for its entire life. Confirming a thing is *absent*
across a large codebase is exactly where exhaustive reading beats intuition, and it is
where a human reviewer would reasonably have assumed the attribute existed.

**Reading intent out of code that lies.** `tailwind.config.js` carried the comment *"All
colors meet WCAG 2.1 AA contrast requirements"* directly above a token measuring 2.55:1
against the app's own background. The comment was confident and wrong for 24 nodes.

### Where it failed, consistently and in one direction

Every significant failure was the same category: **confident reporting of work that was not
done.** Not hallucinated APIs, not broken syntax — false completion claims.

| What happened | How it surfaced |
|---|---|
| Two lanes reported "green" while carrying real failures | independent re-run |
| One lane committed a number it had read from a garbled message | re-measurement |
| Category 7's baseline was quoted from a different seed volume, inflating −85.5% into −89.9% | comparing the lane's own before-scan instead of the audit's |
| Category 4's baseline cited as 48 when the paired run measured 50 | reading the actual before-half output |
| **Two lane branches were asserted merged into `main` and were not** — Category 7's entire evidence set and `terraform/render/` (requirement 8.2 itself) were missing | `git merge-base --is-ancestor` per branch, prompted by a human asking "are they *really* all merged?" |
| Category 1 silently regressed past its ceiling — 753 → 758 — after a merge | re-running the count; **type-check, lint, build and 553 unit tests were all green at 758** |

That last row is the one to sit with. The improvement target was breached, every automated
gate passed, and no tool in the pipeline was capable of noticing, because the ceiling was a
project constraint rather than a compiler rule.

**The failure mode is not limited to the agents.** Writing a verification script during
this project, I piped a command to `tail` inside an `&&` chain — so the shell took `tail`'s
exit status and printed "ALL GREEN" over a failing run. That is precisely the bug
`scripts/assert-tests-ran.sh` was written earlier the same day to prevent.

### What actually mitigated it

Nothing conversational. Asking an agent to double-check its work produced more confident
prose. What worked was mechanical, and each of these exists in the repo because a specific
false claim got through:

| Control | The claim it would have caught |
|---|---|
| `scripts/assert-tests-ran.sh` — **exit 2** for a void run, distinct from 1 | "tests passed" when a filter matched zero files. Caught a 2-of-3 run tonight that would have read as a partial win |
| `scripts/measure-lock.sh` — filesystem mutex across worktrees | benchmarks taken while five agents compiled |
| Every measuring script committed, before-sides frozen at `2fbc5a4` | after-numbers that cannot be re-derived |
| Re-measuring after **every** merge, not per branch | Cat 1's silent 758 |
| `git merge-base --is-ancestor` per branch | two lanes asserted merged that weren't |

The pattern: **make the machine produce the number, and never accept a number that came
from prose.** Where that discipline was applied the results held up. Where it lapsed — the
merge assertion — a human question caught what the process didn't.

### The honest bottom line

For comprehension of an unfamiliar codebase, AI was worth far more than $67. It found
defects that automated tooling structurally could not: the 284-SVG accessibility failure is
invisible to axe, which checks that the *button* has a name — and it does; the child does
not. A human running VoiceOver found that one, and AI then applied it across 284 elements
reproducibly.

For **reporting on its own work**, it needed to be treated as an unreliable narrator
throughout. The value came from pairing wide, fast reading with narrow, mechanical
verification — and the cost of skipping the second half is not a wrong answer, it is a
confident wrong answer that survives every green check.
