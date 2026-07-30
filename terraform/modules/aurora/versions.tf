# Provider requirements for this module.
#
# Added by lane 8. Brief p.11 requires provider versions pinned "in all
# modules"; audit finding W8-4 measured that all six modules here declared no
# required_providers at all, which is why the six stray .terraform.lock.hcl
# files in these directories record aws 6.28.0 -- a major the consuming roots'
# constraint forbids -- with no `constraints` line to check it against.
#
# Pinned exactly, matching every root: aws 5.100.0 (the newest 5.x, and what
# environments/prod's committed lock already selects) and random 3.7.2 (also
# from that lock). An exact pin in an internal module is right here because
# these modules are consumed only by the roots in this repository. A module
# published for outside consumers should declare a permissive range and let the
# root do the pinning -- an exact pin would make it unusable alongside any other
# provider version.
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.7.2"
    }
  }
}
