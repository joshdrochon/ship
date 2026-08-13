# Plan-reading rehearsal log (PF-645)

> ## ⚠ THIS LOG IS EMPTY. PF-645 IS NOT SATISFIED.
>
> **No rehearsal has been performed.** The tables below are an unfilled template.
> There are zero recorded sessions, zero recorded times, and zero recorded misses.
>
> **This log can only be filled in by the human operator.** PF-645 requires each
> exercise to be answered **cold, unaided, against a timer, with no AI assistance and
> no editor search**. An AI agent cannot perform that rehearsal and cannot attest to
> it on someone's behalf — the thing being measured is a person's unaided recall, and
> a generated entry would measure nothing while making the artifact look complete.
> That is a worse outcome than an empty log.
>
> The scaffolding — the primer (`plan-reading.md`), the five exercises and their sealed
> answer keys (`mutated-plans/`), and this template — was prepared by an agent under
> PF-643 and PF-644. Everything below the line is yours to fill in.
>
> **Ticket closes when:** two *consecutive* sessions show zero missed resource changes
> and zero missed replacements across all five exercises. One clean run is a coin flip.

---

## Rules for a valid session

A session is all five exercises, run in one sitting, in one order.

| Rule | Why |
|---|---|
| No AI assistance of any kind | The defense is unaided |
| No editor search, no grep, no opening `terraform/*.tf` | The crib has to be in your head, not on disk |
| `plan-reading.md` may be re-read **before** the session, never during | Study and measurement are different activities |
| Timer per exercise, target 5 minutes | Pressure is part of what is being trained |
| Answer written down **before** opening the answer key | An unwritten answer can be revised after the fact without you noticing |
| Every miss recorded, including the embarrassing ones | An unrecorded wrong answer is worse than no rehearsal |

**What counts as a miss:** a resource change you did not name; a replacement you called
an in-place update; a false alarm (calling something dangerous that is not — Exercise 5);
a right resource with the wrong blast radius or the wrong timing.

A run is **clean** only if it has zero missed resource changes and zero missed
replacements. Blast-radius and timing errors are recorded in the misses column and
should be counted against a clean claim — note them explicitly if you count a run clean
in spite of one.

---

## Session log

Add one row per exercise. Copy the block for each new session.

### Session 1 — date: `<not run>`

| Exercise | Date | Time taken | Misses (resource changes / replacements / false alarms / blast radius) | Clean? |
|---|---|---|---|---|
| 1 — deleted attribute | | | | |
| 2 — changed AZ | | | | |
| 3 — provider bump | | | | |
| 4 — Aurora replacement | | | | |
| 5 — no-op dressed as risky | | | | |

**Session verdict:** `<not run>` — clean / not clean
**Notes:**

---

### Session 2 — date: `<not run>`

| Exercise | Date | Time taken | Misses (resource changes / replacements / false alarms / blast radius) | Clean? |
|---|---|---|---|---|
| 1 — deleted attribute | | | | |
| 2 — changed AZ | | | | |
| 3 — provider bump | | | | |
| 4 — Aurora replacement | | | | |
| 5 — no-op dressed as risky | | | | |

**Session verdict:** `<not run>` — clean / not clean
**Notes:**

---

### Session 3 — date: `<not run>`

| Exercise | Date | Time taken | Misses (resource changes / replacements / false alarms / blast radius) | Clean? |
|---|---|---|---|---|
| 1 — deleted attribute | | | | |
| 2 — changed AZ | | | | |
| 3 — provider bump | | | | |
| 4 — Aurora replacement | | | | |
| 5 — no-op dressed as risky | | | | |

**Session verdict:** `<not run>` — clean / not clean
**Notes:**

---

## Closure record

| Field | Value |
|---|---|
| First clean session | `<none>` |
| Second consecutive clean session | `<none>` |
| PF-645 status | **OPEN — no rehearsal performed** |
| Attested by | `<unsigned>` |

Fill this table in only when two *consecutive* sessions above are marked clean. If a
session between two clean ones was not clean, the count restarts — that is what
"consecutive" means, and it is the entire reason the ticket asks for two.
