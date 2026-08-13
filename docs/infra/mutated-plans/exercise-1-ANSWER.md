# Exercise 1 — answer key

**Do not read this until you have answered Exercise 1 cold and written your answer down.**

**Mutation class:** deleted attribute (two of them).
**Source of the mutation:** `terraform/ssm.tf` — the second statement of
`aws_iam_role_policy.eb_ssm_access` removed. `terraform/database.tf` —
`retention_in_days` removed from `aws_cloudwatch_log_group.aurora`.

---

## Changed resources — the complete list

Two, and only two. Both `~` in-place. Zero replacements.

| # | Address | Action | What changed |
|---|---|---|---|
| 1 | `aws_cloudwatch_log_group.aurora` | `~` update in-place | `retention_in_days` 30 → 0 |
| 2 | `aws_iam_role_policy.eb_ssm_access` | `~` update in-place | the `kms:Decrypt` statement deleted from the policy document |

Summary line check: `0 to add, 2 to change, 0 to destroy.` Two `~` blocks, two
changes, nothing added, nothing destroyed. Consistent. No `# forces replacement`
anywhere in the file, and no `must be replaced` comment line.

---

## Blast radius

### 1. `aws_iam_role_policy.eb_ssm_access` — this is the outage

Severity: **high, delayed.**

The deleted statement is the only grant of `kms:Decrypt` on the EB instance role.
Three parameters in `terraform/ssm.tf` are `SecureString` and therefore KMS-encrypted:

- `/ship/dev/DATABASE_URL`
- `/ship/dev/DB_PASSWORD`
- `/ship/dev/SESSION_SECRET`

Without `kms:Decrypt` under the `kms:ViaService = ssm.us-east-1.amazonaws.com`
condition, `ssm:GetParameter` with decryption on those three names returns
`AccessDeniedException`. The `String`-typed parameters (`DB_HOST`, `DB_NAME`,
`DB_USERNAME`, `CORS_ORIGIN`, `CDN_DOMAIN`, `APP_BASE_URL`) still resolve — so the
failure is partial, which makes it harder to diagnose, not easier.

**When it bites — this is the part you must say out loud.** Nothing breaks at apply
time. The running instance already read its parameters at boot and holds them in
process memory. The application keeps serving, `/health` stays green, and the plan
looks like it applied cleanly.

It breaks on the **next instance boot**: a scale-out event, a rolling deploy
(`DeploymentPolicy = RollingWithAdditionalBatch`, so every deploy launches a fresh
instance), an ASG health replacement, or a managed platform update. At that moment the
new instance cannot build its database connection string and cannot sign session
cookies. With `MinSize = 1`, a single instance replacement is a total outage.

This is the pattern the primer's section A6 names: `0 to add, 1 to change, 0 to
destroy` on a JSON policy document is the cheapest-looking, most expensive change
available in this config.

### 2. `aws_cloudwatch_log_group.aurora` — compliance and cost, not availability

Severity: **low, but not zero.**

`retention_in_days = 0` in the AWS provider means **never expire**, not "delete
immediately". Existing log events are not destroyed — the log group is updated in
place, not replaced, so nothing already captured is lost.

What it costs:
- Aurora `postgresql` logs (`enabled_cloudwatch_logs_exports = ["postgresql"]`, with `log_statement = ddl` and `log_min_duration_statement = 1000` from `aws_rds_cluster_parameter_group.aurora`) accumulate forever. Unbounded CloudWatch Logs storage spend.
- The 30-day retention was a stated compliance posture. Silently removing it is a control regression, and "logs are kept longer" is not automatically a defensible answer in a records-retention context.

Note what is **not** affected: the log group is not replaced, so the `-/+` data-loss
question does not arise here. If this had been a `-/+` on the log group, every retained
`postgresql` log event would have been deleted.

---

## What is deliberately *not* in this plan — check you did not claim any of these

- No Aurora change. `aws_rds_cluster.aurora` does not appear.
- No EB environment change. The IAM policy is attached to the role by reference; editing the policy document does not touch `aws_elastic_beanstalk_environment.api` and does not roll the ASG. Nothing in this plan restarts anything — which is exactly why the failure is deferred.
- No IAM role replacement. `aws_iam_role.eb_instance` is untouched; only the inline policy attached to it changed.
- No SSM parameter change. The parameters still exist and still hold the same values. What changed is who may decrypt them.

---

## Scoring

You get this exercise right only if you named **both** resources **and** said that the
`eb_ssm_access` change is inert until the next instance boot. Naming both resources but
calling the plan "safe, nothing is being replaced" is a **miss** — record it as one.
