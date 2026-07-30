terraform {
  # Exact pin, not a range. `.terraform-version` in this repo asks for 1.6.0 and
  # every existing root declares `>= 1.6.0`, which is what let a 1.15.8 binary
  # run against configuration written for 1.6. A lower bound is a compatibility
  # statement, not a reproducibility one.
  required_version = ">= 1.6.0"

  required_providers {
    # Every version here is an exact `=` constraint. Audit finding W8-4 measured
    # 9 provider constraints in this repo and 0 exactly pinned, and demonstrated
    # the consequence live: environments/dev and environments/shadow resolved
    # random 3.9.0 while environments/prod (which has a lock file) resolved
    # 3.7.2, from identical configuration, minutes apart in the same session.
    local = {
      source  = "hashicorp/local"
      version = "2.9.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.0"
    }
  }
}
