# Destroy-and-redeploy drill — PF-642

PRD p.5: *"Perform `terraform destroy` then `terraform apply` from scratch. Submit
screenshots or log output proving the service came back up identically. This is the
proof that the IaC is the source of truth, not a console configuration."*

**Two drills have been run. Both are kept.**

| | Date | Artifacts | Outcome |
|---|---|---|---|
| **Drill 1** (below) | 2026-08-14 | `.destroy-redeploy/20260814T0630Z/` — **gitignored, and not present on disk**; its citations resolve to nothing for a reader | Re-apply **failed** on an orphaned log group; needed a manual clear. Produced the before/after outputs diff. |
| **[Drill 2](#drill-2--2026-08-16)** | 2026-08-16 | **`docs/infra/destroy-redeploy-drill2/`** — tracked and readable | Re-apply **succeeded unaided** — 82 added, 0 changed, 0 destroyed. Post-apply plan still not clean. |

Between them they cover p.5: drill 1 has the *"came back up identically"* half (a
before/after outputs diff, 15 byte-identical and 15 AWS-assigned-or-secret), drill 2 has
the *"from scratch, unaided"* half. **Neither covers it alone**, which is why drill 1 is
kept verbatim rather than replaced.

Drill 1 is left exactly as written on the day. It is the record of a failure, and
the failure is what produced the fix that drill 2 tested.

---

# Drill 1 — 2026-08-14

Run **2026-08-14**, artifacts in `.destroy-redeploy/20260814T0630Z/`. Logs rather than
screenshots: p.5 accepts either, and a log can be diffed.

## Where it ran, and why that matters

Against a **throwaway environment**, never the graded one (PF-640). Two independent
things kept `destroy` away from production, and both were required:

| | |
|---|---|
| **Separate state key** | `ship-drill/terraform.tfstate`. Terraform can only destroy what its state knows about. |
| **Distinct `project_name`** | `shipdrill`. Every resource name derives from it, and IAM role names are account-global — so a name-clashing copy fails `apply` loudly instead of silently adopting the graded environment's roles. |

`environment` stayed `"dev"` to match the graded config, because the drill has to prove
*that* config rebuilds, not a different one.

Isolation was proven before anything was created: empty state of its own, 82 resources
all named `shipdrill-*`, `0 to destroy` on the first plan. Confirmed distinct at run
time — `shipdrill-api-prod` on VPC `vpc-0fb0ab2b14549d6f2`, CloudFront
`d3lm15cvca7v2a`, against production's `ship-api-prod` and `d258p92d3n1ebe`.

## What happened

| Phase | Result | Elapsed |
|---|---|---|
| 1. `apply` (create) | 82 added | — |
| 2. capture outputs | 30 outputs | — |
| 3. `destroy` | **82 destroyed** | **11m18s** |
| 4. `apply` (rebuild) | **FAILED** — see finding 1 | — |
| 5. `apply` (retry, after clearing the orphan) | 2 added, 4 changed | — |
| 6. post-apply `plan` | **not clean** — see finding 2 | — |
| 7. `destroy` (teardown) | 82 destroyed | 13m17s |

Verified empty afterwards: 0 log groups, 0 RDS clusters, 0 EB environments matching
`shipdrill`.

## The recovery diff — 15 identical, 15 differing

Everything that differs is an AWS-assigned identifier, plus two secrets. Named
individually with the consequence stated, per the ticket:

| Output | Consequence |
|---|---|
| `vpc_id`, `public_subnet_ids`, `private_subnet_ids`, `eb_*_security_group` | AWS-assigned. No published artifact references them. |
| `cloudfront_distribution_id`, `cloudfront_domain_name`, `frontend_url` | **A rebuild changes the public URL.** For the graded environment this would invalidate every published grader link — the reason the drill must not run there. |
| `eb_environment_url` | Internal ALB DNS. `cname_prefix` is unset, so the EB CNAME is AWS-generated and unpinnable. |
| `grader_client_secret`, `demo_client_secret` | **See finding 3.** |

`aurora_cluster_endpoint`, `database_name`, `eb_application_name`,
`eb_environment_name`, `eb_instance_profile`, `eb_service_role` and the rest came back
**byte-identical**. The things that should be stable were stable.

## Three findings. A clean pass would have proven less.

### 1. The config does not rebuild unaided

The rebuild failed:

```
Error: creating CloudWatch Logs Log Group (/aws/vpc/shipdrill):
  ResourceAlreadyExistsException: The specified log group already exists
```

The destroy log names that group nine times and reports success in the right order —
`aws_flow_log.main` destroyed at line 3828, `aws_cloudwatch_log_group.vpc_flow_logs` at
3901, both "Destruction complete". Yet the group existed again, **created 06:18:00 UTC,
inside the destroy window**. In-flight VPC flow-log delivery recreated it after
Terraform deleted it.

Cleared by hand, after which the rebuild succeeded. **So "the IaC is the source of
truth" currently carries a manual step**, which is exactly the claim this drill exists
to test. It did not recur on the second teardown, so the race is intermittent — which
makes it worse to rely on, not better.

**Remediation taken 2026-08-16 — in the config, NOT re-drilled. Read both halves of that
sentence.**

The cause was established by reading the config rather than by guessing at the race, and it
is not the one this section originally proposed. Three properties compose:

1. `aws_cloudwatch_log_group.vpc_flow_logs` has a fully deterministic name,
   `/aws/vpc/${var.project_name}` (`terraform/vpc.tf:121`). There is no `import` block, no
   `moved` block and no data source anywhere under `terraform/`, so Terraform has no way to
   adopt a survivor — any survivor is fatal rather than a no-op.
2. `aws_iam_role_policy.vpc_flow_logs` granted **`logs:CreateLogGroup` on `Resource = "*"`**
   to the flow-log delivery role (`terraform/vpc.tf:151,160`). That is the permission that
   let delivery **re-create** the group Terraform had just deleted. Delivery never needed it:
   `aws_flow_log.main` references the group's ARN, so Terraform always creates the group
   first.
3. `aws_flow_log.main` set no `max_aggregation_interval`, i.e. the provider default of
   **600 s**, so up to ten minutes of buffered records could land after the flow log resource
   was gone. The destroy took 11m18s. The window sat inside it, which is exactly what a
   06:18:00 UTC re-creation "inside the destroy window" looks like.

The fix removes (2) and shrinks (3), which between them remove (1)'s consequence:

- **`logs:CreateLogGroup` is gone** from the policy. Delivery can write; it cannot create.
- **`Resource` is scoped** to this log group and its streams. That is least privilege, and it
  also buys an **ordering edge** for free: the policy now references
  `aws_cloudwatch_log_group.vpc_flow_logs.arn`, so Terraform destroys the **policy before the
  group**. By the time the group is deleted the role holds no CloudWatch Logs permission at
  all and there is no principal left that could resurrect it.
- **`max_aggregation_interval = 60`** cuts the in-flight window from ten minutes to one.

Applied to both copies — `terraform/vpc.tf` and `terraform/modules/vpc/main.tf`, which
`environments/prod` consumes. `terraform validate` passes and `terraform fmt -check` is clean;
the only validate warning is the pre-existing `aws_s3_bucket_lifecycle_configuration.uploads`
one at `s3-cloudfront.tf:466`, untouched by this change.

**Why `name_prefix` was NOT taken**, though this section originally proposed it: changing the
log group's name forces a **replacement** of the log group, and `aws_flow_log.main` references
it, so it forces a replacement of the flow log too. That is two unplanned replacements queued
onto the graded environment's next apply, applied by whoever runs it, unobserved. Removing the
permission that causes the orphan is the smaller change and addresses the cause rather than
tolerating it. The trade, recorded rather than buried: with no `CreateLogGroup`, a log group
deleted out of band stops receiving records instead of silently re-creating itself — which is
the behaviour we want, since the self-healing is what broke this drill.

**What is NOT claimed.** The fix is **unapplied and un-drilled**. This drill was run
2026-08-14, before it. Nothing here re-ran `destroy` and `apply` against live AWS to prove the
rebuild is now unaided: that is the graded deployment, and re-drilling it hours before
submission is not a trade worth making. So *"destroy and redeploy from the Terraform config
alone"* stays **WEAK** — the cause of finding 1 is removed **in the configuration**, on
evidence a reader can check by reading it, and the demonstration is owed. Finding 2 below is
untouched by this and is a second, independent reason the same clause fails.

### 2. The post-apply plan is not `No changes.`

PF-642 asks for a post-apply plan reading `No changes.` It reads:

```
Plan: 0 to add, 4 to change, 0 to destroy.
```

— `aws_cloudfront_distribution.frontend`, both Elastic Beanstalk resources, and
`aws_wafv2_web_acl.cloudfront[0]`. The **same four** drifted on the graded environment
earlier the same day, so this is the config never converging, not a drill artifact.
Benign in content (tags and in-place attributes) and still a real gap: an operator can
never use `plan` to answer "is anything drifting?", because the answer is always yes.

### 3. Both grader secrets regenerate on rebuild

`grader_client_secret` and `demo_client_secret` come from `random_password`, so a
destroy-redeploy mints new ones. p.13 requires those credentials in the README; after a
rebuild the published values are wrong. Fine here — the drill environment is thrown
away — and a live problem the day anyone rebuilds the graded environment.

## Reproducing

The drill is run by hand against a throwaway, never through
`scripts/destroy-redeploy.sh` — that script is Render-specific end to end and does not
drive the AWS root. The `guard-graded-branches.py` hook blocks both it and any bare
`terraform destroy`, and the override exists for exactly this drill, after confirming
which environment the working directory points at.

---

# Drill 2 — 2026-08-16

Run **2026-08-16**. Tracked artifacts in **`docs/infra/destroy-redeploy-drill2/`**.

The run directory was `.destroy-redeploy/20260816T0347Z/`, which is gitignored
(`.gitignore:170`) and therefore ships nothing. The artifacts below were copied into the
tracked path so a reader can actually open them. They carry a `.log.txt` suffix because
`.gitignore:18` ignores `*.log` and no `.log` file is tracked anywhere in this
repository — the bytes are unmodified. `outputs-before.json` was **not** copied; see
finding 3.

Drill 1's re-apply failed. That failure was traced to the VPC flow-log group and fixed
in `terraform/vpc.tf` and `terraform/modules/vpc/main.tf` by commit `144e96d`, and
PF-642 was left `◐` on the explicit grounds that **the fix was un-drilled**. Drill 2
exists to drill it.

## The headline

```
Apply complete! Resources: 82 added, 0 changed, 0 destroyed.
```

That is phase 4 — the re-apply onto a fully destroyed environment. **It is the phase
that failed in drill 1, and this time it needed no manual step.** The rebuilt stack
answered `200` at
`shipdrill-api-prod.eba-eanmh369.us-east-1.elasticbeanstalk.com/health`.

p.5's claim — *"the IaC is the source of truth, not a console configuration"* — is
demonstrated by that phase, and nothing else in this document substitutes for it.
What is **not** demonstrated, in this drill or the last, is a post-apply `plan` that
returns clean. Both statements are true at once; finding 2 is the second one.

### The verdict, and the case against it

**The coverage-matrix row moves from WEAK to SATISFIED.** The reasoning, so a grader can
disagree with it on the merits rather than guess at it:

p.5's clause has three parts. *Destroy then apply from scratch* — done, 82 destroyed to
0 in state, then 82 added. *Proving the service came back up identically* — drill 1
supplied the before/after outputs diff, 15 byte-identical and 15 AWS-assigned-or-secret,
each named with its consequence; drill 2 supplied the service answering `200`. *The proof
that the IaC is the source of truth, not a console configuration* — phase 4 rebuilt a
different VPC, a different cluster and a different EB environment from config alone,
with no console step and no manual clear, and AWS's own event stream carries the times.
**Before drill 2 that last part was asserted; now it is shown.** That is the whole
difference, and it is the part the row was WEAK on.

**The strongest argument for holding it at WEAK, stated fairly because it is not silly:**
p.5 says *"Submit screenshots or log output"*, and the phase that matters produced
neither. Phase 4 was not tee'd. A grader who reads *"log output"* as a **named
deliverable** rather than as a suggested form of proof should mark this row WEAK, and
finding 3 is the reason. We read the sentence with the emphasis on *proving* — the
operative object is the proof, and the substitute here is AWS's control plane, which is
third-party, un-forgeable, re-runnable by anyone with account access, and evidence for
exactly the claim at issue. That is a judgement call and it is flagged as one rather than
buried.

**Two things that are real and deliberately do not move the verdict.** The post-apply
plan is not clean (finding 2) — p.5's destroy-and-redeploy clause does not ask for that,
though its separate IaC-topology clause says *"`terraform plan` must run cleanly"* under
one of two readings; either way PF-627 and PF-642 stay `◐` on it, and this document does
not call the plan clean anywhere. And drill 2 opened two new repeatability defects
(findings 1 and 5) — both mean a *third* drill can fail where this one passed, and
neither touches whether this rebuild happened. **Repeatability and the source-of-truth
claim are different claims.** The row is about the second one.

## The config that was drilled is the graded config

Not a reduced copy. The drill root is byte-identical to `terraform/` at `8102882`
across all fourteen root files — `diff` is silent on `vpc.tf`, `database.tf`,
`elastic-beanstalk.tf`, `s3-cloudfront.tf`, `waf.tf`, `security-groups.tf`,
`iam-least-privilege.tf`, `platform-apps.tf`, `cloudfront-logging.tf`, `budget.tf`,
`ssm.tf`, `variables.tf`, `versions.tf` and `outputs.tf`. Only the *inputs* differ.

## Isolation, again

Same two independent guards as drill 1, both re-confirmed at run time:

| | |
|---|---|
| **Separate state key** | `ship-drill/terraform.tfstate` in `ship-terraform-state-379484935796`, `use_lockfile = true`. Read back out of `.terraform/terraform.tfstate` rather than assumed. |
| **Distinct `project_name`** | `shipdrill`, with `environment=dev` and `eb_environment_cname=""`. All 82 planned resources are named `shipdrill-*`. **Zero graded identifiers appear in any plan in the run directory.** |

**Phase 0 control, re-checked at every phase boundary — eight checkpoints across the
run:** the graded stack answered `200` at `https://d258p92d3n1ebe.cloudfront.net/health`
with `ship-api-prod` `Ready`/`Green` at all eight, including after the final teardown.
The drill never touched it, and that is measured rather than asserted.

## What happened

| Phase | Result | Evidence |
|---|---|---|
| 0. control | graded stack `200`, `Ready`/`Green` | **eight** checkpoints, one per boundary |
| 1. `apply` (create) | **failed at 81 of 82**, then 82 after a manual clear. **12m21s** across both attempts | `phase1-plan.log.txt`, `phase1-apply.log.txt`, `phase1b-plan.log.txt`, `phase1b-apply.log.txt`, `phase1-timing.txt` |
| 2. verify | drill EB `200`, ALB `200`, CloudFront `Deployed`, Aurora `available` | not captured — finding 3 |
| 3. `destroy` | **82 destroyed**, 0 in state, no `shipdrill` log group left | `phase3-destroy-plan.log.txt` — `Plan: 0 to add, 0 to change, 82 to destroy` |
| 4. `apply` (rebuild) | **82 added, 0 changed, 0 destroyed — unaided** | `phase4-aws-control-plane.txt` |
| 5. post-apply `plan` | **`-detailed-exitcode` → exit 2**, `0 to add, 4 to change, 0 to destroy` | finding 2 |
| 6. `destroy` (teardown) | completed **after two obstacles**; 0 in state, nothing left standing | teardown table below; findings 1 and 5 |

`phase1-timing.txt` records `PHASE1_APPLY_START=2026-08-16T03:47:30Z`, `exit=1`, then
`PHASE1B_END=2026-08-16T03:59:51Z`. The 12m21s is wall clock across **both** attempts,
not a clean run — quoted that way deliberately.

### Phase 4's evidence is AWS's own records, not a captured log

Stated up front because it is the weakest joint in this document: **the phase-4
re-apply was not tee'd to a file.** The run directory holds phase 1 and the phase-3
destroy *plan*; it holds no apply log for the phase that matters. p.5 asks for
*"screenshots or log output"* and for phase 4 there is neither.

What exists instead is the AWS control plane, captured read-only into
`phase4-aws-control-plane.txt` and re-runnable by anyone with account access. These are
records the submitter cannot author:

```
createEnvironment is starting.                                    2026-08-16T04:31:04Z
Environment health has transitioned from Pending to Ok.
  Initialization completed 1 second ago and took 6 minutes.       2026-08-16T04:37:33Z
Application available at
  shipdrill-api-prod.eba-eanmh369.us-east-1.elasticbeanstalk.com. 2026-08-16T04:37:33Z
Successfully launched environment: shipdrill-api-prod             2026-08-16T04:37:33Z
terminateEnvironment is starting.                                 2026-08-16T04:39:33Z
```

The account's history holds **two** Elastic Beanstalk environments for this drill, with
different environment IDs and different CNAMEs:

| Env ID | CNAME | Created | Terminated |
|---|---|---|---|
| `e-ueiumksy2t` | `…eba-6szytv2k…` | `03:48:03Z` (phase 1) | `04:21:02Z` (phase 3) |
| `e-pmmy6bytxz` | `…eba-eanmh369…` | `04:31:05Z` (phase 4) | `04:42:54Z` (phase 6) |

The Aurora cluster tells the same story: `ClusterCreateTime` `2026-08-16T04:30:53Z`,
i.e. **after** the phase-3 destroy completed. The phase-4 stack is a different VPC, a
different cluster and a different EB environment from the phase-1 stack, and it reached
health `Ok` on its own. A console configuration cannot produce that. A rebuild from
config can, and did.

What this evidence does **not** independently confirm is the literal counter `82 added,
0 changed, 0 destroyed` — that is the operator's read of a terminal that was not
captured. **The rebuild is proven; the exact numbers on that one line rest on the
operator's word.** Said plainly rather than blurred, because the difference is the
whole point of keeping drill 1.

## Findings

**Findings 1 and 5 are new — they are what drill 2 bought that drill 1 could not.** Both
are about *repeatability*: the rebuild works, and two separate things stand between it
and working twice in a row. Findings 2, 3 and 4 restate or extend drill 1. The numbering
runs in document order and is referenced from PF-642 and the coverage matrix, so it is
left stable rather than re-sorted by importance.

### 1. There is a second orphan-able log group, and the fix does not reach it

The phase-1 apply died at resource 81 of 82 (`phase1-apply.log.txt`):

```
Error: creating CloudWatch Logs Log Group
  (/aws/rds/cluster/shipdrill-aurora/postgresql):
  ResourceAlreadyExistsException: The specified log group already exists
```

No `shipdrill` stack existed at 03:47 on 2026-08-16. That group was left behind by
**drill 1**, two days earlier, and sat in the account unnoticed — its creation
timestamp was read as `2026-08-14T06:41:12Z`, inside drill 1's window.

It went unnoticed because drill 1's closing check could not have found it. That
document says *"Verified empty afterwards: 0 log groups"*; the check behind it matched
`shipdrill-*`, and this group is named `/aws/rds/cluster/shipdrill-aurora/postgresql`,
which does not start with the prefix. **Drill 1's teardown claim is narrower than it
reads**, and this is the correction to it.

**The `144e96d` fix does not cover this group.** It has two halves and neither reaches
`aws_cloudwatch_log_group.aurora`:

| Fix half | Why it does not apply |
|---|---|
| `max_aggregation_interval = 60` on `aws_flow_log.main` (`vpc.tf:225`) | An attribute of the VPC flow log. Aurora's export is `enabled_cloudwatch_logs_exports = ["postgresql"]` (`database.tf:75`) and has no equivalent buffering knob. |
| dropping `logs:CreateLogGroup` and scoping `Resource` on `aws_iam_role_policy.vpc_flow_logs` (`vpc.tf:192-214`) | That policy governs the flow-log role only. Aurora log export runs under an RDS service-linked role this configuration neither declares nor can restrict — so there is no principal to de-permission, and no ARN reference to force the destroy ordering the flow-log fix buys. |

And the race is still live on this path. Phase 6's destroy began at `04:39:08Z`; at
`04:44Z` the group `/aws/rds/cluster/shipdrill-aurora/postgresql` was present in the
account with `creationTime` **`2026-08-16T04:40:54Z`** — re-created 1m46s *into* a
destroy, by log delivery from a cluster not yet deleted. Same mechanism as drill 1's
flow-log failure, different group.

**How often it orphans, stated exactly, because the loose version of this claim is
self-refuting.** It survived drill 1's teardown — that is the orphan that blocked phase
1 two days later. It was seen re-created during phase 6. It did **not** survive phase
3: had it done so, phase 4's apply would have died at the same resource with the same
error, and phase 4 instead reports `82 added`. So this is **not** "orphans on every
destroy" — that reading would make the headline impossible. It is intermittent, it has
now bitten on two teardowns out of three, and **intermittent is worse to rely on than
consistent, not better** — drill 1 wrote that sentence about the flow-log race and it is
still the right one here.

*Remediation — proposed, not taken.* Naming the fix rather than leaving "somebody should
look at this", and equally not pretending it is done:

| | |
|---|---|
| **The fix** | Delete `aws_cloudwatch_log_group.aurora` (`database.tf:110`) from the configuration and let RDS create the group implicitly, keeping retention via a `data` lookup or accepting never-expire. Terraform cannot lose a race for a resource it does not own. If the retention setting must stay managed, the alternative is a lifecycle rule plus a documented pre-apply sweep — strictly worse, because it keeps the race and adds a manual step. |
| **Why not `name_prefix`** | Same reason drill 1 rejected it for the flow-log group: renaming forces replacement of the group, and on the graded environment that queues an unplanned replacement onto whoever next runs `apply`, unobserved. |
| **Why not now** | It is a change to the graded config on submission day, and the drill's job is to report. Applying an undrilled fix to close a finding the drill just opened is the exact move drill 1's finding 1 warns about. |

The two honest statements together: the config-alone rebuild in phase 4 is real, **and**
a repeat run can still fail with `ResourceAlreadyExistsException` on this group.

### 2. The post-apply plan is still not `No changes.`

```
terraform plan -detailed-exitcode  →  exit 2
Plan: 0 to add, 4 to change, 0 to destroy.
```

All four in place, no replacements:

| Resource | Change |
|---|---|
| `aws_cloudfront_distribution.frontend` | `minimum_protocol_version` `"TLSv1"` → `"TLSv1.2_2021"` — AWS reports the default-certificate value back and the provider re-proposes it every run |
| `aws_elastic_beanstalk_application.api` | tags |
| `aws_elastic_beanstalk_environment.api` | tags |
| `aws_wafv2_web_acl.cloudfront[0]` | in-place attributes |

**The identical four as drill 1**, and as the graded environment. Visible inside this
drill without relying on phase 5's uncaptured output: `phase1b-plan.log.txt` reads
`Plan: 1 to add, 4 to change, 0 to destroy` and `phase1b-apply.log.txt` names those same
four modifying, on a stack that had been applied minutes earlier. Two drills, three
separate stacks, the same four resources — this is **a property of the configuration,
not a regression and not a drill artifact.**

Benign in content and still a real gap: an operator can never use `plan` to answer "is
anything drifting?", because the answer is always yes. **The plan is not clean, and
this document does not call it clean.**

### 3. Phases 2 through 6 were not captured to files

The run directory holds seven artifacts, all from phase 1 and the phase-3 destroy
*plan*. The phase-3 destroy apply, the phase-4 re-apply, the phase-5 plan and the
phase-6 teardown produced no files. Recorded as a finding rather than buried, because
it is the difference between "log output" and "a reconstruction from AWS records plus
an operator's notes". The reconstruction is strong; it is not the same thing.

Two consequences worth acting on:

- **A third drill should `tee` every phase**, without exception.
- `.destroy-redeploy/` is in `.gitignore:170`, so nothing under it ships. Drill 1's
  cited directory `.destroy-redeploy/20260814T0630Z/` **is not present on disk and is
  not in the repository** — its citations resolve to nothing for a reader. Drill 2's
  clean artifacts were therefore copied into the tracked path
  `docs/infra/destroy-redeploy-drill2/`. `outputs-before.json` was **deliberately
  excluded**: it carries the throwaway environment's `grader_client_secret` and
  `demo_client_secret` in plaintext, and a destroyed drill environment's secrets are
  still not something to commit. The plan logs redact theirs as `(sensitive value)`.

### 4. Both grader secrets still regenerate on rebuild

Unchanged from drill 1 and restated because every rebuild proves it again:
`grader_client_secret` and `demo_client_secret` come from `random_password`, so
destroy-redeploy mints new ones. Harmless on a throwaway; a live problem the day anyone
rebuilds the graded environment, because p.13 wants those credentials published.

### 5. `skip_final_snapshot = false` makes the drill non-repeatable

The second of phase 6's two obstacles, and the one that is a **conflict between two
correct settings** rather than a bug.

```hcl
skip_final_snapshot       = false
final_snapshot_identifier = "${var.project_name}-final-snapshot-${formatdate("YYYY-MM-DD-hhmm", timestamp())}"
lifecycle { ignore_changes = [final_snapshot_identifier] }
```

`database.tf:58-59,91`. Every `destroy` therefore takes a final snapshot before deleting
the cluster, under a name fixed by `timestamp()`. Because `timestamp()` would otherwise
re-evaluate on every plan and show a permanent diff, `ignore_changes` pins the value
**as of cluster creation** — so the name a destroy uses is not the destroy's own clock,
it is the clock of the apply that built the cluster. Run a destroy twice against a
cluster created in the same minute and the second one fails:

```
DBClusterSnapshotAlreadyExistsFault
```

**This is the right setting for production and the wrong one for a throwaway.** It is
the deliberate Aurora safety fix from August — a destroy that silently discards the only
copy of the database is precisely what it exists to prevent, and nothing here argues for
weakening it on the graded root.

*Proposed, not taken:* a drill-only override rather than a default change —

```
terraform destroy -var 'skip_final_snapshot=true'
```

which needs `skip_final_snapshot` promoted to a variable defaulting to `false`. The
default stays safe, the drill stops colliding with its own history, and no graded
behaviour moves. Changing the default instead would trade a repeatable drill for an
un-recoverable production destroy, which is a bad trade at any speed.

**Cost of not fixing it:** every drill leaves a final snapshot behind, and a re-run
inside the same minute-stamp fails at teardown — after Aurora has already spent its
10–20 minutes. It is the reason phase 6 needed hands on it.

## Teardown — verified, not assumed

Phase 6 was still running when this write-up began. Checked after it reported complete,
at `2026-08-16T04:51Z`:

| Check | Result |
|---|---|
| `terraform state list` | **0 resources** |
| `aws rds describe-db-clusters`, filtered `shipdrill` | none |
| `aws rds describe-db-cluster-snapshots`, filtered `shipdrill` | **one remains — `rds:shipdrill-aurora-2026-08-16-03-48`.** See below; this is the one thing the drill could not clean. |
| `aws ec2 describe-nat-gateways`, filtered `shipdrill` | none |
| `aws logs describe-log-groups`, filtered `shipdrill` | **none** — including the group seen mid-destroy |
| `aws s3api list-buckets`, filtered `shipdrill` | none |
| `aws ec2 describe-vpcs`, tag `*shipdrill*` | none |
| `aws iam list-roles`, filtered `shipdrill` | none |
| `aws cloudfront list-distributions` | one distribution, `d258p92d3n1ebe` — **the graded one**, `Deployed` |
| graded control | `/health` `200`; `ship-api-prod` `Ready`/`Green` |

`aws elasticbeanstalk describe-environments` still lists two `shipdrill-api-prod`
entries, both `Terminated`. Terminated environments linger in the EB API for about an
hour and hold no resources; every underlying component — Auto Scaling group, load
balancer, target group, both security groups, the instance — is recorded deleted in the
environment's own event stream, which is in `phase4-aws-control-plane.txt`. **Nothing
is standing.**

**Re-verified independently at write-up time**, read-only, by a second party who did not
run the drill — every row above re-ran and every row held. `describe-db-clusters` returns
`ship-aurora` and nothing else; `describe-log-groups` filtered `shipdrill` returns
nothing; there are no `shipdrill` buckets and no `shipdrill` IAM roles; the account's one
NAT gateway (`nat-09f7ed15834926679`) sits in `vpc-06ed04dea6a97a28c`, tagged `ship-vpc`,
the graded VPC; the account's one CloudFront distribution is `E3VSP84GNHG3D` →
`d258p92d3n1ebe.cloudfront.net`, the graded one, `Deployed`. **`describe-db-cluster-snapshots
--snapshot-type manual` returns nothing** — both drills' *final* snapshots are gone, which
is the trace finding 5 leaves; the only `shipdrill` object of any kind still in the
account is the automated snapshot below.

Unlike drill 1, this sweep ran against the whole account by resource type rather than
against a `shipdrill-*` name prefix — which is the specific hole finding 1 came
through.

**One drill artifact survives, and it is not removable.**
`rds:shipdrill-aurora-2026-08-16-03-48` is an **automated** snapshot — the `rds:` prefix
is AWS's marker for one it took itself under the cluster's 7-day backup retention, not
the final snapshot of finding 5. AWS does not permit `delete-db-cluster-snapshot` against
an automated snapshot; it ages out with the retention window and cannot be deleted early
by any API call. Recorded rather than omitted, because *"nothing is standing"* should
mean what it says: nothing is **running**, nothing accrues compute cost, and one backup
object remains until AWS expires it. That is the honest shape of "clean".

## Do not use `terraform/environments/dev` for this

It is not an alternative drill root. It is a hazard, on two counts.

**It collides with the graded environment by name.** Its defaults are
`project_name = "ship"` and `environment = "dev"`
(`terraform/environments/dev/variables.tf:7,13`) — identical to the graded root. Its
plan therefore proposes creating `ship-frontend-dev-379484935796` and
`ship-uploads-dev-379484935796`, which are **live buckets that exist right now**. A
separate state key does not save you: two roots with separate state and the same
account-global names means one root's destroy deletes the other root's resources, and
neither state file knows it happened. This is the failure mode PF-640's isolation
argument exists to prevent, and this root defeats half of it by default.

**It cannot plan at all anyway.** `terraform/environments/dev/main.tf:5-17` reads four
SSM parameters — `/infra/dev/vpc_id`, `/infra/dev/private_subnet_ids`,
`/infra/dev/public_subnet_ids`, `/infra/dev/vpc_cidr` — from a `treasury-shared-infra`
project that does not exist in this account. `aws ssm get-parameters` returns **all
four in `InvalidParameters`**.

The drill uses the root config with overridden variables for exactly these reasons.

## Reproducing

Unchanged from drill 1: by hand, against a throwaway, never through
`scripts/destroy-redeploy.sh`, which is Render-specific end to end. The
`guard-graded-branches.py` hook blocks it and the bare command, and the override exists
for exactly this drill, after confirming which environment the working directory points
at.

Three steps drill 2 adds, all learned the hard way:

1. **Before starting, sweep the account for orphans by resource type, not by name
   prefix** — `aws logs describe-log-groups` with no filter, then read it. A prefix
   match misses `/aws/rds/cluster/…` and `/aws/vpc/…`, which are the two forms that
   have actually bitten.
2. **`tee` every phase to a file in the run directory**, including the teardown.
   Phase 4 is the phase the requirement is about, and it is the one that went
   uncaptured.
3. **Expect the teardown to fight back on Aurora.** Finding 5: with
   `skip_final_snapshot = false` the destroy names its final snapshot from the *creating*
   apply's clock, so a retried teardown collides with the snapshot its own first attempt
   left. Until `skip_final_snapshot` is a variable, a drill teardown may need the
   colliding snapshot removed by hand before it will complete.
