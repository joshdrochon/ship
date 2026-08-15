# AWS account and Terraform operator identity

**Tickets:** PF-618 (operator identity), PF-619 (cost guardrail), PF-620 (state backend)
**Lane:** L21 · Terraform, IAM Least-Privilege & Drift
**Recorded:** 2026-08-12
**PRD:** p.5, p.2, p.9, p.13

Every claim below carries the command that proved it. Where a command's output is
quoted, it is quoted verbatim.

---

## 1. The account

D6 moved the graded deployment to AWS. The account is live and the graded root is
applied against it.

```
$ aws sts get-caller-identity
{
    "UserId": "AIDAVQWYQSZ2IDMGWZTXM",
    "Account": "<redacted — see note>",
    "Arn": "arn:aws:iam::<account>:user/ship-terraform"
}
```

**On the account id and git.** PF-618 asks for the account id to be handled "the way
this config already handles it — kept out of git, read from SSM." That is how the
*configuration* handles it and that property still holds: no `.tf` file in the graded
root hardcodes an account id, they all resolve it at plan time through
`data.aws_caller_identity.current.account_id`, and the state bucket name (which embeds
the account id) is read from the SSM parameter `/ship/terraform-state-bucket` rather
than committed.

It does **not** hold for captured evidence, and this is worth stating plainly rather
than pretending otherwise: `docs/terraform-plan-aws-20260812.txt` is a tracked file and
renders real ARNs, so the account id is already in git. Re-measured 2026-08-15:

```
$ git grep -o 379484935796 | wc -l     # 71 occurrences
$ git grep -l 379484935796 | wc -l     # across 17 tracked files
$ git grep -n 379484935796 -- 'terraform/*.tf' | wc -l   # 0 in the graded root
```

(This paragraph previously said "eight places". That was measured when only the
2026-08-12 plan transcript was tracked; the figure grew with every captured artifact
that followed — `docs/infra/plan-baseline-w6.txt` alone now carries 17 and
`docs/infra/topology.md` 12. The count moves, so it is given with the command that
reproduces it rather than as a number to be trusted. What has not moved is the third
line: zero in the configuration.)

Redacting captured `terraform plan` and `AccessDenied`
output would destroy the thing that makes it evidence. So the rule this lane actually
follows, and the one worth defending:

> **Configuration never hardcodes the account id. Captured artifacts are not redacted.**

An AWS account id is an identifier, not a credential — it is visible in every ARN a
third party ever receives from you, and AWS's own guidance treats it as non-secret. The
things that would be a real leak — the access key, the Aurora master password, the
session secret — are covered in §3 and none of them are in git.

```
# how to get the account id without reading it out of a document
$ aws sts get-caller-identity --query Account --output text
```

## 2. The operator identity

An IAM **user**, not an assumed role.

```
$ aws iam list-attached-user-policies --user-name ship-terraform
{
    "AttachedPolicies": [
        {
            "PolicyName": "AdministratorAccess",
            "PolicyArn": "arn:aws:iam::aws:policy/AdministratorAccess"
        }
    ]
}

$ aws iam list-user-policies --user-name ship-terraform
{ "PolicyNames": [] }
```

| Property | Value | Proved by |
|---|---|---|
| Type | IAM user `ship-terraform` | `aws sts get-caller-identity` |
| Policy | `AdministratorAccess` (AWS managed), attached; no inline policies | `aws iam list-attached-user-policies`, `list-user-policies` |
| MFA | **None.** `MFADevices: []` | `aws iam list-mfa-devices --user-name ship-terraform` |
| Credential | One active access key `AKIA…F756`, created 2026-08-12T18:15:19Z | `aws iam list-access-keys --user-name ship-terraform` |
| Key storage | `~/.aws/credentials` on the operator workstation. **Not in any tracked file** | `grep -rn 'AKIA' --exclude-dir=.git .` returns nothing outside this table's masked reference |
| Region | `us-east-1` | `terraform/variables.tf` → `var.aws_region` |

### The two weaknesses, named rather than glossed

These are real and they are not fixed by this ticket. Recording them is the point of
recording anything.

1. **No MFA on an `AdministratorAccess` identity.** A single long-lived access key with
   no second factor is the whole account. For a one-week graded project on a dedicated
   account with a $50 budget tripwire this is an accepted risk, not a good practice. The
   correct shape is an IAM Identity Center user assuming a role with a session duration,
   or at minimum a virtual MFA device with a `aws:MultiFactorAuthPresent` condition on
   the admin policy.
2. **Long-lived static key.** It does not expire and nothing rotates it. Mitigations
   actually in place: it is on one workstation, it is outside the repo, and the account
   contains nothing but this week's graded infrastructure.

**Note the asymmetry with the rest of this lane, because a grader will.** PF-633–638
take the *application's* role from `AdministratorAccess` down to least privilege and
prove a denial. That drill is about the **EB instance role** — the credential that runs
in production and is reachable by anything that compromises the application. The
operator identity above is a human's deploy credential on a laptop, and it stays admin
because Terraform genuinely does need to create IAM roles, VPCs and RDS clusters. Those
are different threat models and the lane does not claim the operator identity was
locked down.

## 3. What is secret, and where it lives

| Secret | Where it lives | In git? |
|---|---|---|
| Operator access key | `~/.aws/credentials` | No |
| Aurora master password | `random_password.db_password` → Terraform state (S3, encrypted) → SSM `SecureString` `/ship/dev/DB_PASSWORD` | No |
| Session secret | `random_password.session_secret` → SSM `SecureString` `/ship/dev/SESSION_SECRET` | No |
| `DATABASE_URL` (embeds the password) | SSM `SecureString` `/ship/dev/DATABASE_URL` | No |
| State bucket name | SSM `String` `/ship/terraform-state-bucket` | No |

**Terraform state contains every one of these in cleartext.** That is inherent to
Terraform, not a defect here, and it is why the state bucket is versioned, encrypted and
public-access-blocked (§4). Anyone with read access to `s3://<state-bucket>` has the
Aurora password.

## 4. State backend (PF-620)

See `terraform/README.md` for the chicken-and-egg write-up and the bootstrap's own state
location. Summary:

- Bucket: `ship-terraform-state-<account-id>` — versioned, encrypted, public access
  blocked, created by `terraform/bootstrap`.
- Pointer: SSM parameter `/ship/terraform-state-bucket`, so the bucket name is not
  committed.
- Key: `ship/terraform.tfstate`.
- **Locking: `use_lockfile = true`** — added by PF-621, proven in
  `docs/infra/state-lock-proof.txt`. Before that commit there was no locking of any kind
  (L99 finding F32).

```
$ terraform init -backend-config="bucket=$(aws ssm get-parameter \
    --name /ship/terraform-state-bucket --query Parameter.Value --output text)"
```

## 5. Cost guardrail (PF-619)

Codified as `aws_budgets_budget.monthly` in `terraform/budget.tf` so it appears in
`terraform plan` rather than existing only as a console click.

```
$ aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" \
    --query 'Budgets[].{Name:BudgetName,Limit:BudgetLimit,Type:BudgetType,Unit:TimeUnit}'
[
    {
        "Name": "ship-monthly-cost",
        "Limit": { "Amount": "50.0", "Unit": "USD" },
        "Type": "COST",
        "Unit": "MONTHLY"
    }
]
```

| Threshold | Type | Meaning |
|---|---|---|
| 50% | ACTUAL | Informational — the meters are running. |
| 80% | ACTUAL | Investigate now; something unaccounted-for is up. |
| 100% | ACTUAL | Breach. |
| 100% | FORECASTED | The only one that arrives while there is still time to act. |

Notifications go to `joshdrochon@gmail.com` (`var.budget_notification_email`).

**The ceiling is $50/month and the reasoning is in `terraform/budget.tf`**, not repeated
here. The one thing that must not be lost: **a breach is investigated, never answered by
downgrading Aurora or dropping the NAT gateway.** D6 rejected that downgrade on the
merits — it saves ~$20 and weakens the blast-radius answer, which is an auto-fail topic.
The most likely genuine cause of a breach is a throwaway destroy-redeploy environment
(PF-640) left standing; the fix is to destroy it, not to resize the graded one.

The AI Cost Analysis deliverable itself (p.9, p.13) belongs to L26. This section supplies
only the alarm and the number.
