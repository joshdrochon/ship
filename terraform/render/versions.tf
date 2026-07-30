terraform {
  # Same lower bound the rest of the repo declares. `.terraform-version` asks
  # for 1.6.0; the binary in use here is 1.15.8.
  required_version = ">= 1.6.0"

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
