terraform {
  # Same lower bound the rest of the repo declares. `.terraform-version` asks
  # for 1.6.0; the binary in use here is 1.15.8.
  required_version = ">= 1.6.0"

  # ── Remote state ───────────────────────────────────────────────────────────
  #
  # State lives in GitLab, on the same instance and the same project this repo
  # is graded on. It was a local file until now, and that was the single reason
  # `.github/workflows/deploy.yml` refused to arm: a CI `terraform apply` would
  # have started with no knowledge of the running service and tried to create a
  # second one.
  #
  # Why GitLab rather than S3 or Terraform Cloud:
  #
  #   - S3 needs an AWS account reachable from this machine. There is no `aws`
  #     CLI, no `~/.aws`, and no `AWS_*` in the environment. It was the first
  #     choice and it does not exist here.
  #   - Terraform Cloud works, but adds a fifth external service and a fifth
  #     credential for one file.
  #   - GitLab already holds the repository, already has a token in use, and its
  #     state API is enabled on this instance — an unauthenticated request to
  #     `/terraform/state/*` answers 401 where a disabled feature answers 404,
  #     and the same request with the token reaches the handler.
  #
  # The brief says nothing about where state lives. It requires a `terraform/`
  # directory, an annotated plan, and a destroy-and-redeploy — all of which are
  # unaffected by this. The choice is ours, and this is the one with no new
  # account behind it.
  #
  # Deliberately partial. The address is here because it is not a secret and
  # belongs in review; the credentials are not, and come from the environment:
  #
  #   export TF_HTTP_USERNAME=<gitlab-username>
  #   export TF_HTTP_PASSWORD=<personal-access-token with api scope>
  #
  # `deploy.yml` sets both from repository secrets. Locally, `scripts/tf-env.sh`
  # sources them out of `.env`, which is gitignored.
  #
  # Project 1609 is `joshrochon/ship`. `retry_wait_min` is raised because the
  # instance is shared and a cold lock request can take a few seconds; the
  # default of 1 gives up early enough to fail a CI apply on a slow morning.
  backend "http" {
    address        = "https://labs.gauntletai.com/api/v4/projects/1609/terraform/state/fleetgraph"
    lock_address   = "https://labs.gauntletai.com/api/v4/projects/1609/terraform/state/fleetgraph/lock"
    unlock_address = "https://labs.gauntletai.com/api/v4/projects/1609/terraform/state/fleetgraph/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    retry_wait_min = 5
  }

  required_providers {
    # Exact `=` pin, not a range — the same rule applied to all five AWS roots
    # and the six modules in commit 36bdf1d. 1.9.1 is the newest published
    # version of render-oss/render at the time of writing (26 versions on the
    # registry, 1.9.1 latest). A `~> 1.9` here would let a future `init` pick a
    # provider minor that changes plan output against live infrastructure.
    render = {
      source  = "render-oss/render"
      version = "1.9.1"
    }
  }
}
