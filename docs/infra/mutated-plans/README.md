# Mutated-plan exercise set (PF-644)

Five `terraform plan` excerpts, each with one deliberate mutation applied to the real
applied config at `terraform/*.tf`. Each has a sealed answer key naming every changed
resource and its blast radius.

The point is not to learn these five plans. The point is to build the reflex that reads
*any* modified plan correctly, unaided, under time pressure — the auto-fail defense
condition behind this lane.

---

## Stop — read this before opening anything

**Do not read the `-ANSWER.md` files first.** They are the assessment, not the study
material. Reading an answer before attempting its exercise destroys that exercise
permanently; there is no way to un-see it, and you will not get an honest measurement
of whether you can do this cold. If you want to study, read
[`../plan-reading.md`](../plan-reading.md) — that is what the primer is for.

The exercise files are `exercise-N.txt`. The answer keys are `exercise-N-ANSWER.md`.

---

## The set

| Exercise | Mutation class | Shape |
|---|---|---|
| 1 | A deleted attribute | Two in-place updates, one of which is a delayed outage |
| 2 | A changed availability zone | Five replacements cascading from one AZ |
| 3 | A provider version bump | `No changes.` — and that is the trap |
| 4 | A replace-forcing change on the Aurora cluster | The plan you must never approve |
| 5 | An unrelated no-op dressed up to look risky | Four cosmetic updates and one harmless destroy |

They are deliberately not ordered by difficulty. Exercises 3 and 5 are the ones people
get wrong, in opposite directions: 3 looks safe and is not, 5 looks dangerous and is
not. If you only ever drill 1, 2 and 4 you will train yourself to shout "replacement!"
and nothing else.

---

## How to run a session

Per exercise, cold:

1. **Start a timer. Target: 5 minutes per exercise.** That is roughly the length of a defense answer, and pressure is the variable being trained.
2. **No AI assistance. No editor search across the repo. No opening `terraform/*.tf`.** You may re-read `plan-reading.md` *before* the session starts, never during it. Anything you have to look up mid-answer is a thing you do not know yet.
3. Read `exercise-N.txt` and write your answer down — on paper or in a scratch file, but **written**, before you open anything else. An answer you only thought is an answer you can revise after the fact without noticing.

   Your answer must contain:
   - Every changed resource, by full Terraform address (including the `[0]` index where there is one).
   - The action for each: `+`, `-`, `~`, `-/+`.
   - Which changes are **replacements**, and what forced each one.
   - The blast radius of each — and specifically **when** it bites: now, on the next instance boot, or on the next deploy.
   - Whether the plan is safe to apply, and why.
4. Stop the timer.
5. **Now** open `exercise-N-ANSWER.md` and score yourself.
6. Log the run in [`../plan-reading-rehearsal.md`](../plan-reading-rehearsal.md) — including the misses. A wrong answer that goes unrecorded is worse than no rehearsal at all.

Run all five in one sitting. That is one session.

## Scoring — what counts as a miss

Each answer key ends with a scoring note. In general:

- A **missed resource change** — any resource in the plan that your answer does not name.
- A **missed replacement** — any `-/+` you called `~`, or any resource you did not identify as being replaced.
- A **false alarm** — calling something dangerous that is not. Exercise 5 exists to catch this, and it counts as a miss exactly like the others. In a live defense, over-calling risk costs you as much credibility as under-calling it.
- A **wrong blast radius** — naming the right resource with the wrong consequence. Saying "the NAT gateway is replaced so the egress IP changes" in Exercise 2 is a miss even though the resource name is right.

PF-645 closes on **two consecutive sessions with zero missed resource changes and zero
missed replacements**. One clean run is a coin flip.

---

## Honesty notes about these files

- The exercises are **hand-authored derivatives**, not literal captures. They were built from the real applied config (`terraform/*.tf`), the real plan artifact (`docs/terraform-plan-aws-20260812.txt`), the live `terraform state list`, and read-only AWS describe calls. Resource addresses, attribute names, resolved values (`skip_final_snapshot = true`, `Environment = dev`, `/ship/dev/*` parameter paths), the live CNAME `ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com`, the live egress IP `35.153.128.210`, the live distribution `E3VSP84GNHG3D` and the real WAF regex string are all taken from the real thing.
- AWS-assigned identifiers that were not read from the live account — subnet IDs, security group IDs, ENI IDs, KMS key IDs, WAF UUIDs, RDS resource IDs — are plausible placeholders. They are formatted correctly and used consistently within and across exercises, but they are not this account's actual IDs. Nothing in any answer depends on them.
- The mutations were never applied. No `terraform apply` produced these files, and none of them was ever run against the account.
- Exercise 4's plan describes an operation that would destroy the production database. It exists to be recognized and refused. Do not use it as a template for anything.
