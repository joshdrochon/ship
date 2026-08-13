# Exercise 5 — answer key

**Do not read this until you have answered Exercise 5 cold and written your answer down.**

**Mutation class:** an unrelated no-op dressed up to look risky.
**Source of the mutation:** an `Owner` tag added to two resources, a wording fix on one
SSM parameter description, the `Resource` list reordered inside
`aws_iam_role_policy.eb_bedrock_access`, and the `aws_wafv2_regex_pattern_set.static_files`
block deleted from `terraform/waf.tf`.

**Verdict: nothing in this plan breaks anything.** Getting there requires checking, not
assuming — and the checks are the exercise.

---

## Changed resources — the complete list

Five resources. **Zero replacements. One destroy. Four in-place updates.**

| # | Address | Action | What actually changed | Runtime impact |
|---|---|---|---|---|
| 1 | `aws_elastic_beanstalk_environment.api` | `~` in-place | `tags` — one key added | None |
| 2 | `aws_iam_role_policy.eb_bedrock_access` | `~` in-place | `Resource` array reordered, same three ARNs | None |
| 3 | `aws_security_group.aurora` | `~` in-place | `tags` — one key added | None |
| 4 | `aws_ssm_parameter.cors_origin` | `~` in-place | `description` only | None |
| 5 | `aws_wafv2_regex_pattern_set.static_files[0]` | `-` destroy | resource removed from config | None |

Summary line check: `0 to add, 4 to change, 1 to destroy.` One `-` block and four `~`
blocks. `to add` is zero, so **there are no replacements in this plan** — that check
alone rules out every data-loss and hostname-change scenario in the crib.

---

## Why each one is harmless — with the check that proves it

### 1. `aws_elastic_beanstalk_environment.api` — the biggest piece of bait in the set

Seeing the EB environment in a diff should make you look hard, because an environment
replacement changes the CNAME and kills every published grader link. Check three things:

- The comment line reads **`will be updated in-place`**, not `must be replaced`.
- The symbol is `~`, not `-/+`.
- `cname` is printed **without a symbol** — it is an unchanged attribute, still
  `ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com`.

And critically: `# (24 unchanged blocks hidden)` means **no `setting` block changed**.
Not `Subnets`, not `IamInstanceProfile`, not `SecurityGroups`, not
`solution_stack_name`. A tag-only update calls the tagging API; it does not roll the
ASG, does not redeploy, does not restart anything.

### 2. `aws_iam_role_policy.eb_bedrock_access` — a policy diff that grants nothing

An IAM policy showing `-` and `+` lines is exactly the shape of Exercise 1's outage. It
is not the same thing here. Read the entries, not the symbols:

```
          - "arn:aws:bedrock:*::foundation-model/anthropic.*",
            "arn:aws:bedrock:*:379484935796:inference-profile/anthropic.*",
            "arn:aws:bedrock:*:379484935796:inference-profile/global.anthropic.*",
          + "arn:aws:bedrock:*::foundation-model/anthropic.*",
```

The same string is removed from position 0 and added at position 3. Three ARNs before,
the same three after. `Action`, `Effect`, `Version` are all in the hidden-unchanged
count. IAM does not care about array order, so the effective permission set is
identical, and the update is a single `PutRolePolicy` call that replaces the document
atomically — there is no window in which the role has fewer permissions.

The diff exists only because Terraform compares the JSON structurally and a list is
ordered. Cosmetic.

### 3. `aws_security_group.aurora` — a tag, not a rule

The Aurora security group is the database's only firewall, so it deserves a look. What
changed is `tags`. What did **not** change:
`aws_security_group_rule.aurora_ingress_from_eb` does not appear in this plan at all, so
the single 5432 ingress from the EB instance security group is intact, and no egress
rule was added (the Aurora SG deliberately has none).

### 4. `aws_ssm_parameter.cors_origin` — the description, not the value

`CORS_ORIGIN` is a security-relevant value: change it and the API starts accepting
cross-origin requests from somewhere new. But the only attribute carrying a `~` is
`description`. `value` sits inside `# (10 unchanged attributes hidden)`.

Note the asymmetry that makes this worth drilling: if the *value* had changed, the plan
would show `~ value = (sensitive value)` and tell you nothing about the new content
(primer A4). Here you can be confident precisely because the line is absent. Absence of
a `value` diff is stronger evidence than the presence of one.

### 5. `aws_wafv2_regex_pattern_set.static_files[0]` — the decoy

A WAF resource being destroyed is the scariest single line in the file. It is also the
one with genuinely zero blast radius, and the reason is checkable in two ways:

- `grep -rn "static_files" terraform/` returns exactly one hit: the resource's own declaration in `waf.tf`. Nothing references its ARN.
- `waf.tf` says why. The rule that was going to use it — "Rule 0: AWS Anti-DDoS Rule Set" — is commented out, because the provider does not fully support the `managed_rule_group_configs` block it needs. The pattern set was created for a rule that was never enabled.

So: no rule references it, the web ACL is untouched, and no WAF protection changes.
Rate limiting (300 per 5 minutes), IP reputation, the common rule set, known-bad-inputs,
SQLi and bot control all continue exactly as before.

**Now the part that stops this exercise from teaching the wrong lesson.** The correct
method is to grep for references, not to conclude "WAF deletions are fine." Change one
character in the address and the answer inverts:

- `- aws_wafv2_ip_set.bad_ips[0]` **is** referenced — by the `BadIPs` rule inside `aws_wafv2_web_acl.cloudfront[0]`, via `ip_set_reference_statement.arn`. Destroying it would force the web ACL to change and would fail on the dependency.
- `- aws_wafv2_web_acl.cloudfront[0]` is referenced by the CloudFront distribution's `web_acl_id`. Destroying it strips every protection from the public site, and the delete itself would fail with `WAFAssociatedItemException` while the association stands.

Same shape of diff, three very different answers. The shape is not the answer; the
reference graph is.

---

## The one-line answer

> Five resources, no replacements, nothing breaks. The EB environment and the Aurora
> security group are tag-only. The Bedrock policy is a list reorder granting exactly the
> same three ARNs. The `CORS_ORIGIN` change is the description, not the value. The
> destroyed WAF regex pattern set is referenced by nothing — the anti-DDoS rule that
> would have used it is commented out in `waf.tf`.

---

## Scoring

Two ways to fail this one, and they are opposite errors:

- **False alarm.** Calling any of these dangerous — "the EB environment is changing, the CNAME is at risk", "the WAF is being torn down", "an IAM policy is losing a permission" — is a miss. Record it.
- **Under-reading.** Answering "it's all cosmetic" without naming all five resources is also a miss. The exercise asks for the complete list, and a plan you waved through without enumerating is a plan you did not read.
