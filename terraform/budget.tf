# ---------------------------------------------------------------------------
# PF-619 — Cost guardrail.
#
# This is a TRIPWIRE ON THE ARCHITECTURE AS DESIGNED, not a licence to shrink
# it. D6 considered the cheaper shape — `db.t4g.micro` in public subnets, no NAT
# gateway — and rejected it on the merits: it saves roughly $20 and costs the
# blast-radius answer, which is an auto-fail topic at the Architecture Defense.
# Architecture is not chosen to dodge $20.
#
# So if this budget breaches, the response is to INVESTIGATE what is running
# that should not be — a throwaway destroy-redeploy environment left up
# (PF-640/PF-642), a second NAT gateway, an Aurora instance that never scaled
# back down — and never to downgrade Aurora or drop the NAT gateway.
#
# The two standing meters, for whoever reads an alert:
#   NAT gateway  ~$0.045/hr  (~$32/mo) + $0.045/GB processed
#   Aurora Sv2   ~$0.12/ACU-hr, floor 0.5 ACU (~$43/mo at floor, 24/7)
# Those two are most of the bill and both are deliberate.
#
# Codified here rather than clicked in the console so it appears in `terraform
# plan` like everything else — an alarm that exists only in the console is an
# alarm the next operator cannot see in the config.
# ---------------------------------------------------------------------------

variable "budget_monthly_limit_usd" {
  description = <<-EOT
    Monthly USD ceiling for the AWS Budget tripwire (PF-619).

    D6 priced this week's graded infrastructure at roughly $15-25 against
    existing credits. A calendar-month budget spanning a one-week project needs
    headroom above the week's spend without being so loose it never fires: the
    two standing meters (NAT gateway + Aurora Serverless v2 at its 0.5 ACU
    floor) run about $75/mo if left up for a full month, so a ceiling below that
    would alert on nothing but the passage of time.

    50 USD is the chosen number: comfortably above the ~$15-25 the graded week
    should cost, and low enough that a forgotten second environment — which
    roughly doubles the NAT + Aurora meter — trips it inside a couple of days.
  EOT
  type        = number
  default     = 50
}

variable "budget_notification_email" {
  description = "Real address that receives the 50/80/100% budget notifications (PF-619)."
  type        = string
  default     = "joshdrochon@gmail.com"
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project_name}-monthly-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # 50% — informational. Expected to fire during a normal graded week; it is the
  # signal that the meters are running at all, which is how you notice an
  # environment nobody destroyed.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  # 80% — investigate now. At this point something is running that the graded
  # architecture does not account for.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  # 100% — breach.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  # FORECASTED at 100% is the one that arrives while there is still time to act.
  # The three ACTUAL thresholds above all tell you about money already spent.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_notification_email]
  }
}

output "budget_name" {
  description = "Name of the AWS Budget acting as the cost tripwire (PF-619)."
  value       = aws_budgets_budget.monthly.name
}

output "budget_monthly_limit_usd" {
  description = "Monthly USD ceiling the budget alerts against (PF-619)."
  value       = var.budget_monthly_limit_usd
}
