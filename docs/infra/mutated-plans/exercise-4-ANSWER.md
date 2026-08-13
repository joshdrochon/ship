# Exercise 4 — answer key

**Do not read this until you have answered Exercise 4 cold and written your answer down.**

**Mutation class:** replace-forcing change on the Aurora cluster.
**Source of the mutation:** `terraform/database.tf` — `database_name = var.db_name`, and
`var.db_name` in `terraform/variables.tf` changed from `"ship_main"` to `"ship"`. A
one-word variable edit that looks like tidying up a name.

**This is the plan you must never approve.**

---

## Changed resources — the complete list

Five resources. **Two replacements, three in-place updates.**

| # | Address | Action | Trigger |
|---|---|---|---|
| 1 | `aws_rds_cluster.aurora` | `-/+` **replace** | `database_name` `"ship_main"` → `"ship"` — `# forces replacement` |
| 2 | `aws_rds_cluster_instance.aurora` | `-/+` **replace** | `cluster_identifier` → `(known after apply)` — `# forces replacement` |
| 3 | `aws_ssm_parameter.database_url` | `~` in-place | value rebuilt from the new endpoint, port and database name |
| 4 | `aws_ssm_parameter.db_host` | `~` in-place | new cluster endpoint |
| 5 | `aws_ssm_parameter.db_name` | `~` in-place | new database name |

Summary line check: `2 to add, 3 to change, 2 to destroy.` The two adds and two destroys
are the two replacements; the three changes are the three SSM parameters. Nothing was
added to or removed from the config.

Three outputs move: `aurora_cluster_endpoint`, `aurora_cluster_reader_endpoint`,
`database_name`.

---

## Blast radius

### 1. Total, unrecoverable data loss

`-/+` on `aws_rds_cluster.aurora` is **destroy first, then create**. Every document, every
issue, every user, every session row, every Yjs collaboration state blob in the
`documents` table is deleted before the new cluster exists.

Three lines in the plan tell you there is no way back, and you must be able to point at
all three:

```
        skip_final_snapshot                   = true
        delete_automated_backups              = true
        backup_retention_period               = 1
```

- **`skip_final_snapshot = true`** — the destroy takes no final snapshot. This is not a default someone forgot; it is `skip_final_snapshot = var.environment != "prod"` in `database.tf`, and `var.environment` is `"dev"` (no `terraform.tfvars` is committed — only `terraform.tfvars.example`). The applied plan artifact confirms the resolved value.
- **`delete_automated_backups = true`** — the automated backups are deleted with the cluster.
- **`backup_retention_period = 1`** — even if you raced to grab one, the point-in-time window is 24 hours.

There is nothing to restore from. Not a snapshot, not PITR, not a read replica —
`aws_rds_cluster_instance.aurora` is the cluster's only member and it is being destroyed
too.

### 2. Aurora replacement is slow in both directions

Roughly 10–20 minutes to destroy and 10–20 minutes to create, per PF-627's measurement.
The application is down for the whole window, and `MinSize = 1` means there is no
partially-working state — every request that touches the database fails.

### 3. The new database is empty and unmigrated

The new cluster comes up with a database called `ship` and no schema. Nothing in this
Terraform root runs migrations; `api/src/db/migrate.ts` runs on deploy. So even after
Aurora is healthy, the application cannot serve until a deploy is pushed to Elastic
Beanstalk to create the tables — and it will then serve an empty product.

### 4. The application will not notice the new endpoint on its own

The three SSM parameters update at apply time, but the running instance read them at
boot and holds them in process memory. It will keep dialing
`ship-aurora.cluster-cx8mqy4kzp1n...` — which by then is a dead endpoint — until it is
restarted or redeployed. Recovery therefore requires an EB deploy or instance
replacement on top of the Terraform apply.

### 5. `DB_USERNAME` and `DB_PASSWORD` deliberately do not change

`aws_ssm_parameter.db_username` reads `master_username`, a literal `"postgres"` that did
not change, so it does not appear in the plan. `random_password.db_password` is not
being replaced, so `DB_PASSWORD` and the cluster's `master_password` are unchanged —
the *credentials* survive; the *data* does not. Do not confuse the two.

---

## What is deliberately *not* in this plan — the traps

- **`aws_cloudwatch_log_group.aurora` is not replaced.** Its name interpolates `aws_rds_cluster.aurora.cluster_identifier`, which is the literal `"ship-aurora"` in config and did not change. Terraform can compute it without waiting for the new cluster. Claiming the log group is replaced is a miss.
- **`aws_db_subnet_group.aurora`, `aws_rds_cluster_parameter_group.aurora`, `aws_security_group.aurora` and `aws_security_group_rule.aurora_ingress_from_eb` are all untouched.** The cluster's references to them are unchanged.
- **The EB environment is untouched.** No CNAME change, no rolling deploy. The API stays up and returns 500s.
- **No `+/-`.** `create_before_destroy` is not set on `aws_rds_cluster`, so there is no window where both clusters exist. Ordering is destroy, then create.

---

## What the correct response is

Do not apply. Revert `var.db_name`. If the database genuinely must be renamed, that is a
data migration (dump, new cluster, restore, cut over), not a Terraform attribute edit —
and it happens against the PF-640 throwaway environment first.

If the goal was to *test* Aurora replacement, that is what PF-642's destroy-redeploy
drill is for, and PF-640 exists precisely so the drill cannot reach the graded
environment.

---

## Scoring

Full marks require **all five** resources named, both replacements identified, and the
words "no final snapshot" with `skip_final_snapshot = true` cited from the plan text.
Saying "the Aurora cluster is replaced, that's bad" without citing
`skip_final_snapshot = true` is a partial answer — in a defense, the follow-up question
is always "how do you know you can't restore it," and the answer is that line.

Claiming the CloudWatch log group is replaced, or that the EB environment changes,
counts as a miss.
