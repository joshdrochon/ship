# Exercise 2 — answer key

**Do not read this until you have answered Exercise 2 cold and written your answer down.**

**Mutation class:** changed availability zone.
**Source of the mutation:** `terraform/vpc.tf` — `aws_subnet.public` and `aws_subnet.private`
resolve their `availability_zone` from `data.aws_availability_zones.available.names[count.index]`.
Index 0 moved from `us-east-1a` to `us-east-1c`. In practice this happens one of two ways:
someone hardcoded the AZ list, or AWS returned the zone list in a different order — see the
primer, section A7. **The config file may be untouched and this plan can still appear.**

---

## Changed resources — the complete list

Eight resources. **Five replacements, three in-place updates.**

| # | Address | Action | Trigger |
|---|---|---|---|
| 1 | `aws_subnet.public[0]` | `-/+` **replace** | `availability_zone` `us-east-1a` → `us-east-1c` — `# forces replacement` |
| 2 | `aws_subnet.private[0]` | `-/+` **replace** | `availability_zone` `us-east-1a` → `us-east-1c` — `# forces replacement` |
| 3 | `aws_nat_gateway.main[0]` | `-/+` **replace** | `subnet_id` → `(known after apply)` — `# forces replacement` |
| 4 | `aws_route_table_association.public[0]` | `-/+` **replace** | `subnet_id` — `# forces replacement` |
| 5 | `aws_route_table_association.private[0]` | `-/+` **replace** | `subnet_id` — `# forces replacement` |
| 6 | `aws_route_table.private` | `~` in-place | its default route's `nat_gateway_id` moves to the new NAT |
| 7 | `aws_db_subnet_group.aurora` | `~` in-place | `subnet_ids` swaps one member |
| 8 | `aws_elastic_beanstalk_environment.api` | `~` in-place | the `Subnets` and `ELBSubnets` settings |

Summary line check: `5 to add, 3 to change, 5 to destroy.` Five `-/+` blocks account for
all five adds and all five destroys; the three `~` blocks are the three changes. Nothing
was added or removed from the config, so **add and destroy both non-zero means
replacements** — the alarm from primer section A3.

Five output values also move: `private_subnet_ids`, `public_subnet_ids`,
`eb_private_subnets`, `eb_public_subnets`, and two keys inside `eb_config_summary`.

---

## Blast radius

### The trap: the egress IP does **not** change

`aws_eip.nat[0]` does not appear anywhere in this plan. It is not replaced. The NAT
gateway is destroyed and recreated, and the recreated one reuses the same allocation
(`allocation_id` points at the surviving EIP), so **the public egress IP stays
`35.153.128.210`**.

The plan is misleading on exactly this point, and this is the line to catch:

```
      ~ public_ip = "35.153.128.210" -> (known after apply)
```

That is the NAT gateway's *attribute* being unknown at plan time, not a statement that
the address will be different. The address is pinned by the EIP that Terraform is not
touching. If you said "the egress IP changes and every partner allow-list breaks," that
is a **miss** — record it. The correct answer is: the IP survives; what you lose is
egress *availability* for the duration of the swap.

(The inverse case — replacing `aws_eip.nat[0]` — genuinely does change the IP, and
forces the NAT gateway to replace along with it. Know both.)

### The real damage, in order of severity

**1. `aws_subnet.private[0]` — the destroy will probably fail.**
Both the Aurora cluster and the EB instances live in the private subnets. The subnet
carries an RDS network interface and at least one EC2 instance ENI. AWS refuses to
delete a subnet with attached ENIs: `DependencyViolation: The subnet has dependencies
and cannot be deleted`. Terraform stops there, mid-apply, having already destroyed
whatever came earlier in its graph. You are left half-applied with no clean rollback.
**"This plan does not apply cleanly" is part of the correct answer.**

**2. Private-subnet egress outage.**
The NAT gateway is destroyed before the replacement is created (`-/+`, not `+/-` —
`create_before_destroy` is not set on it). Between those two moments the private route
table's default route points at a NAT that no longer exists. Every EB instance loses
outbound internet: no ECR image pulls, no SSM parameter reads, no Bedrock calls, no
Secrets Manager reads. Instances already serving traffic keep answering the ALB —
inbound is unaffected — but any deploy, scale-out, or instance replacement started in
that window fails.

**3. Aurora loses an AZ from its subnet group.**
`aws_db_subnet_group.aurora` is updated in place, which is the *good* outcome:
`db_subnet_group_name` is force-new on `aws_rds_cluster`, so if this had been a
replacement of the subnet group rather than an in-place update, the Aurora cluster
would have been replaced and **all data lost**. It is not. The cluster and the cluster
instance do not appear in this plan at all. Say that explicitly — knowing the
data-loss path exists and that this plan does not take it is the point of the exercise.

What does happen: the writer instance currently sits in one of these two AZs. Moving
the subnet group's membership underneath a running cluster is not a supported way to
relocate an instance, and the single cluster member (`MinSize`-equivalent: exactly one
`aws_rds_cluster_instance.aurora`) has nowhere to fail over to.

**4. EB environment update rolls the fleet.**
Changing the `Subnets` and `ELBSubnets` settings triggers an environment update. The
ASG is retargeted at the new private subnet and the ALB at the new public subnet, which
means instance replacement and ALB target re-registration. With `MinSize = 1` and
`DeploymentPolicy = RollingWithAdditionalBatch`, expect a health dip; combined with the
NAT outage in point 2, expect the replacement instance to fail its boot-time parameter
reads.

**5. The ALB loses AZ diversity briefly.**
`aws_subnet.public[1]` (`us-east-1b`) is untouched, so the load balancer keeps one
healthy AZ throughout. This is the one piece of good news in the plan.

---

## What is deliberately *not* in this plan

- `aws_eip.nat[0]` — not replaced, IP preserved.
- `aws_rds_cluster.aurora` and `aws_rds_cluster_instance.aurora` — not touched. No data loss.
- `aws_subnet.public[1]` / `aws_subnet.private[1]` — index 1 still resolves to `us-east-1b`.
- `aws_vpc.main`, the internet gateway, and all three security groups — untouched.

---

## Scoring

Full marks require: all five replacements named, all three in-place updates named, the
`DependencyViolation` on the private subnet, and **explicitly saying the egress IP is
preserved**. Claiming the IP changes is a miss even if every resource name is right.
