# ---------------------------------------------------------------------------
# PF-633 / PF-635 — the IAM least-privilege drill (PRD p.5).
#
# p.5: "Start with an AdministratorAccess task role", lock it down to the
# minimum, verify the service still works, verify an action outside the policy
# is DENIED, and submit the before/after policy with rationale per permission.
#
# THE DRILL RUNS THROUGH TERRAFORM, NOT THE CONSOLE. That is the whole reason
# this file exists rather than the work being two `aws iam` commands: p.5 asks
# for a before/after *policy*, and a console click leaves no artifact anyone can
# diff. The "before" state is a committed diff attaching AdministratorAccess;
# the "after" state is the commit that removes it. `git log -p` on this file IS
# the deliverable.
#
# WHICH ROLE. `aws_iam_role.eb_instance` -- the role the APPLICATION assumes,
# reached through `aws_iam_instance_profile.eb`. In ECS's vocabulary that is the
# *task role*, which is the one p.2 names. It is the right target because it is
# the credential that runs in production and that anything compromising the
# application would inherit. The operator identity (`ship-terraform`, an IAM
# user with AdministratorAccess and no MFA) is deliberately NOT the subject of
# this drill -- it is a human's laptop deploy credential and Terraform genuinely
# needs admin to create IAM roles, VPCs and RDS clusters. Different threat
# models; see docs/infra/aws-account.md §2.
#
# See docs/infra/iam-least-privilege.md for the before/after policies, the
# per-permission rationale table, and the recorded AccessDenied transcript.
# ---------------------------------------------------------------------------

variable "eb_instance_role_overprivileged" {
  description = <<-EOT
    PF-633's "before" state. When true, AdministratorAccess is attached to the
    EB instance role.

    This exists as a flag rather than as a line someone comments in and out so
    that the over-privileged state is (a) reachable by a one-word change when
    the drill needs re-running for a demo, and (b) IMPOSSIBLE TO LEAVE ON BY
    ACCIDENT without it showing up in a plan as a named variable rather than as
    a quietly re-added policy attachment.

    MUST be false in any state that outlives the drill. The whole point of p.5's
    exercise is that the end state is least privilege, so a `true` here at
    submission time would invert the deliverable.
  EOT
  type        = bool
  default     = false
}

resource "aws_iam_role_policy_attachment" "eb_instance_admin_before" {
  count      = var.eb_instance_role_overprivileged ? 1 : 0
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# ---------------------------------------------------------------------------
# The verification channel for PF-636 and PF-637.
#
# PF-637 requires a transcript taken FROM THE EB INSTANCE using the instance
# profile credentials only. The instances sit in private subnets with no public
# IP and no SSH key, which is correct for the architecture and leaves exactly one
# way in: SSM Session Manager / RunCommand.
#
# This is a real permission grant and it is called out as one rather than
# slipped in. Three things make it defensible as part of a least-privilege
# posture rather than a hole in it:
#
#   1. It REPLACES a worse alternative. The other way to get a shell on that
#      instance is a bastion host or opening SSH -- inbound network access to a
#      private subnet, versus an outbound-only agent with per-action IAM and a
#      full CloudTrail record of every command.
#   2. It grants no application-relevant data access. AmazonSSMManagedInstanceCore
#      covers ssmmessages/ec2messages channel setup, UpdateInstanceInformation,
#      and document reads. It does NOT include `ssm:GetParameter` on arbitrary
#      paths, so the path-scoped Parameter Store boundary this drill exists to
#      prove is untouched -- which is what keeps PF-637's denial test honest
#      rather than an artifact of the tooling used to run it.
#   3. Without it there is no way to demonstrate the denial at all, and p.5 asks
#      for exactly that demonstration.
# ---------------------------------------------------------------------------
resource "aws_iam_role_policy_attachment" "eb_instance_ssm_managed" {
  role       = aws_iam_role.eb_instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
