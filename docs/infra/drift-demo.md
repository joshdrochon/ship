# Drift detection and reconciliation (PF-639)

**Lane:** L21 · **PRD:** p.5 — *"Drift detection & destroy-redeploy"*
**Date:** 2026-08-13 · **Root:** `terraform/` (the graded root)

The claim this lane makes is that the Terraform configuration is the source of truth. A
claim like that is only worth something if you can show the system *noticing* when
reality stops matching it. So: change one thing by hand, outside the config, and watch
`terraform plan` find it.

---

## 1. Choosing the drift target

The choice is the interesting part of this ticket, and getting it wrong turns a demo into
an outage.

The requirement is a **reconcile that happens in place**. A drifted attribute that forces
replacement on the wrong resource is not a demonstration — on `aws_rds_cluster.aurora` it
is total data loss, because `skip_final_snapshot` is `var.environment != "prod"` and
`var.environment` is `"dev"`.

| Candidate | Verdict |
|---|---|
| Aurora `backup_retention_period` | Workable (in-place), but every plan against it takes an RDS modify window, and a misfingered change on that resource is the one with unrecoverable consequences. Rejected on blast radius. |
| EB environment option setting | In-place, but it triggers an environment update, which contends with any deploy in flight. Rejected on interference. |
| **Security group ingress rule** | **Chosen.** `aws_security_group.alb` declares its rules as **inline `ingress` blocks**, so Terraform owns the whole rule set and an out-of-band addition shows up as a removal. Instant in both directions, zero downtime, and it is the exact example PRD p.5 names. |

One property of the choice is worth stating because it is what makes the demo honest:
inline `ingress` blocks mean Terraform manages the *complete* set. Had the config used
separate `aws_security_group_rule` resources — as `aurora_ingress_from_eb` in fact does —
a hand-added rule would be **invisible** to `plan`, because Terraform would only track the
rules it created and would not care about a stranger. Same service, same kind of change,
completely different detection story. That distinction is the real lesson here, and it is
a good defense answer.

## 2. The change, made outside Terraform

Made with the AWS CLI against the live account. Never through the configuration.

```bash
$ aws ec2 authorize-security-group-ingress \
    --group-id sg-05cfe8b63251ae8bf \
    --ip-permissions 'IpProtocol=tcp,FromPort=8080,ToPort=8080,IpRanges=[{CidrIp=10.0.0.0/16,Description="PF-639 planted drift - added by CLI, never by config"}]'
{
    "Return": true,
    "SecurityGroupRules": [
        {
            "SecurityGroupRuleId": "sgr-016ea93bdfcdf70f2",
            "GroupId": "sg-05cfe8b63251ae8bf",
            "IsEgress": false,
            "IpProtocol": "tcp",
            "FromPort": 8080,
            "ToPort": 8080,
            "CidrIpv4": "10.0.0.0/16",
            "Description": "PF-639 planted drift - added by CLI, never by config"
        }
    ]
}
```

`sg-05cfe8b63251ae8bf` is `ship-alb`, the internet-facing load balancer group. The rule
opens TCP 8080 to the VPC CIDR only, so the drift itself is not a live exposure — which is
deliberate. A demo should not require you to actually widen your attack surface to the
internet to prove a point.

## 3. Detection — `terraform plan`

```
  # aws_security_group.alb will be updated in-place
  ~ resource "aws_security_group" "alb" {
        id                     = "sg-05cfe8b63251ae8bf"
      ~ ingress                = [
          - {
              - cidr_blocks      = [
                  - "10.0.0.0/16",
                ]
              - description      = "PF-639 planted drift - added by CLI, never by config"
              - from_port        = 8080
              - ipv6_cidr_blocks = []
              - prefix_list_ids  = []
              - protocol         = "tcp"
              - security_groups  = []
              - self             = false
              - to_port          = 8080
            },
            # (2 unchanged elements hidden)
        ]
        name                   = "ship-alb"
        tags                   = {
            "Name" = "ship-alb"
        }
        # (8 unchanged attributes hidden)
    }
```

### Line by line

| Line | Reading |
|---|---|
| `# aws_security_group.alb will be updated in-place` | The comment header names the resource address and the action. **`in-place`, not `must be replaced`** — this is the safety property the target was chosen for. The security group keeps its id, so the ALB it is attached to is untouched. |
| `~ resource` | The `~` prefix on the resource block means *update*. `+` would be create, `-` destroy, `-/+` replace. |
| `id = "sg-05cfe8b63251ae8bf"` | No `~`, no `(known after apply)` — the id is unchanged, which is the second confirmation this is not a replacement. A replacement always shows the id going to `(known after apply)`. |
| `~ ingress = [` | The attribute that differs. `~` on a list means the list's contents change, not that it is being replaced wholesale. |
| `- { … }` | A **whole element removed** from the set. Terraform is not "deleting a rule I asked for" — it is removing the element that exists in AWS and has no counterpart in the configuration. |
| `- description = "PF-639 planted drift…"` | Our planted rule, identified by the description we set. This is the drift. |
| `# (2 unchanged elements hidden)` | The two legitimate rules — 80 and 443 from `0.0.0.0/0` — declared in `security-groups.tf` and matching reality, so they are not shown. |
| `# (8 unchanged attributes hidden)` | Everything else about the group agrees with the config. |

**The direction is the point.** Terraform reports the hand-made rule as something to
**remove**. It does not offer to adopt it, and it does not ask. The configuration is the
desired state and anything in the account that the configuration does not describe is, by
definition, a difference to be erased. That is what "the IaC is the source of truth"
actually means operationally — and it is also the reason a hand-fix during an incident is
a time bomb: the next `apply` silently undoes it.

### Honest note on the rest of the plan

The same plan run reports **five** resources changing, not one:

```
Plan: 0 to add, 5 to change, 0 to destroy.
```

Only `aws_security_group.alb` is the planted drift. The other four — the EB application,
the EB environment, the CloudFront distribution and the WAF web ACL — are a **pre-existing
perpetual diff** on a `Name` tag, documented in the PF-623 commit: the tag is applied and
present in AWS (`aws elasticbeanstalk list-tags-for-resource` confirms
`Name=ship-api-prod` on the live environment) but is not read back into state on refresh.
It is a provider round-trip artifact, not configuration drift, and it is not caused by
this exercise. It is called out here rather than cropped out of the screenshot, because a
plan with four unexplained lines in it is exactly the kind of noise that trains an
operator to stop reading plans.

## 4. Reconciliation

See §5 for the captured run. `terraform apply` removes the planted rule and the security
group returns to what `security-groups.tf` describes.

## 5. Verification log

The reconcile was deliberately deferred until the application deployment in flight at the
time (PF-628) had finished, so that a `terraform apply` could not contend with an Elastic
Beanstalk environment update and leave two unrelated operations tangled in one log.

### The reconcile

```console
$ terraform apply -auto-approve
aws_security_group.alb: Refreshing state... [id=sg-05cfe8b63251ae8bf]
  # aws_security_group.alb will be updated in-place
aws_security_group.alb: Modifying... [id=sg-05cfe8b63251ae8bf]
aws_security_group.alb: Modifications complete after 1s [id=sg-05cfe8b63251ae8bf]

Apply complete! Resources: 0 added, 5 changed, 0 destroyed.
```

**One second.** In-place, no replacement, no interruption to the ALB or anything behind it
— which is what choosing the target for in-place reconcilability bought.

### The rule is gone from AWS, not just from the plan

Confirmed against the account rather than inferred from Terraform's own output:

```console
$ aws ec2 describe-security-group-rules \
    --filters Name=group-id,Values=sg-05cfe8b63251ae8bf \
    --query 'SecurityGroupRules[?FromPort==`8080`]'
[]
```

### The follow-up plan

```console
$ terraform plan
  # aws_cloudfront_distribution.frontend will be updated in-place
  # aws_elastic_beanstalk_application.api will be updated in-place
  # aws_elastic_beanstalk_environment.api will be updated in-place
  # aws_wafv2_web_acl.cloudfront[0] will be updated in-place
Plan: 0 to add, 4 to change, 0 to destroy.
```

**`aws_security_group.alb` is gone from the plan.** The planted drift is detected,
reconciled and confirmed absent from both the account and the diff. That is the ticket.

### It does not say `No changes.`, and that is not this exercise failing

The four resources still listed are the **pre-existing perpetual `Name`-tag diff**
documented in the PF-623 commit. They were present before the drift was planted, they
were present in the detection plan in §3, and they are unchanged by the reconcile — the
count simply went from five back to the four it started at.

Measured, not assumed: the tag really is applied in AWS —

```console
$ aws elasticbeanstalk list-tags-for-resource --resource-arn <env-arn>
...  { "Key": "Name", "Value": "ship-api-prod" }, ...
```

— so this is the provider not reading those tags back into state on refresh, not
configuration drift. Terraform re-proposes a change that has already been made and that
succeeds every time it is applied.

**It still matters, and it is not being waved away.** PF-627 asks for a post-apply plan
reading `No changes.` as the proof that the configuration describes what exists, and this
configuration cannot currently produce that line. Until it can, "the plan is clean" has to
mean "exits 0 with these four known, explained lines" — which is a weaker statement, and
worse, it is the kind of standing noise that trains an operator to skim a plan instead of
reading it. That is precisely the habit PF-643's blast-radius work exists to prevent.
Worth fixing properly (an `ignore_changes` on those tags would silence it, but silencing a
diff you have not explained is how real drift gets hidden); not fixed here, and named as
outstanding rather than left for someone else to trip over.
