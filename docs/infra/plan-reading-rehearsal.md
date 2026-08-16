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

### Session 1 — date: `2026-08-15`

| Exercise | Date | Time taken | Misses (resource changes / replacements / false alarms / blast radius) | Clean? |
|---|---|---|---|---|
| 1 — deleted attribute | 2026-08-15 | not recorded | not recorded against the key | see note |
| 2 — changed AZ | | | | |
| 3 — provider bump | | | | |
| 4 — Aurora replacement | | | | |
| 5 — no-op dressed as risky | | | | |

**Session verdict:** partial — exercise 1 answered; 2–5 not recorded here.

**Notes:**

Exercise 1, answered unaided and recorded verbatim from the author's own write-up.
Both resources were identified, both classified as in-place updates, and both blast
radii stated:

1. **`aws_cloudwatch_log_group.aurora`** — in-place update (`~`), log retention dropping
   from 30 days to 0. Blast radius: observability and compliance only. Nothing goes
   down; the database keeps running and the app keeps serving. The cost is the loss of
   historical logs to troubleshoot with.

2. **`aws_iam_role_policy.eb_ssm_access`** — in-place update (`~`), removing `kms:Decrypt`
   from the Elastic Beanstalk instance role. Blast radius: a **delayed full outage that
   lands on the next instance boot**. Running instances are unaffected because they
   already pulled and decrypted their SSM parameters at boot; the failure arrives with
   the next autoscaling event, deploy, or instance recycle, when a new instance cannot
   decrypt `DATABASE_URL` and crashes on `AccessDenied`.

The delayed-failure reading in (2) is the point of the exercise, and it is the same
shape that bit this project for real: the IAM least-privilege drill (PF-635..638) found
that revoking a permission leaves a running instance healthy, which is why that drill's
verification forces a fresh boot rather than accepting a green smoke test.

**Why the miss counts are blank.** This log is filled in from the author's own record.
Time taken and the per-exercise comparison against the sealed answer keys were not
captured at the time, and they are not reconstructible after the fact — writing a number
here that nobody measured would make the log worse than leaving it honest. Exercises 2–5
of this session are likewise not recorded.

**No AI assistance was given on the reading itself.** PRD p.5 makes unaided plan-reading
an auto-fail condition, so the answers above were not checked, corrected, hinted at, or
graded by Claude — the request to do so was declined at the time. The transcription into
this file is clerical.

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
