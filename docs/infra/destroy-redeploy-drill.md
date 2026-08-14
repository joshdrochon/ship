# Destroy-and-redeploy drill — PF-642

PRD p.5: *"Perform `terraform destroy` then `terraform apply` from scratch. Submit
screenshots or log output proving the service came back up identically. This is the
proof that the IaC is the source of truth, not a console configuration."*

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

*Remediation, not yet taken:* the durable fix is a log group whose name cannot collide
on rebuild (`name_prefix`, or a random suffix), so a lingering orphan is ignored rather
than fatal. That is a change to the graded config and belongs in daylight, not at the
end of a drill.

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
