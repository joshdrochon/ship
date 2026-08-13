# Exercise 3 — answer key

**Do not read this until you have answered Exercise 3 cold and written your answer down.**

**Mutation class:** provider version bump.
**Source of the mutation:** `terraform/versions.tf` — `aws` moved from the exact pin
`"5.100.0"` to the range `"~> 6.0"`, and `random` from `"3.7.2"` to `"~> 3.7"`.

---

## Changed resources — the complete list

**Zero.** `No changes. Your infrastructure matches the configuration.`

If your answer was "no resources changed, this is safe" you got the first half right and
the second half wrong. That is the whole exercise.

---

## What actually changed

| Thing | Before | After | Where you can see it |
|---|---|---|---|
| `aws` provider version | 5.100.0 | 6.0.0 (a **major** version) | `terraform init` output, `.terraform.lock.hcl` |
| `aws` constraint | exact pin | `~> 6.0` — any 6.x | `versions.tf`, and `constraints =` in the lock file |
| `random` provider version | 3.7.2 | 3.7.2 (unchanged **today**) | lock file `version` line — same |
| `random` constraint | exact pin | `~> 3.7` — any 3.x ≥ 3.7 | lock file `constraints` line |

The `random` line is the quiet one. The resolved *version* did not move, so the lock
file diff looks almost empty. What moved is the **constraint**, and a constraint is a
statement about every future `init`, not about this one. The next person to run
`terraform init -upgrade` — or the next CI runner with a cold plugin cache and no lock
file — gets whatever 3.x is newest that day.

---

## Blast radius

### 1. The plan cannot tell you a provider bump is safe

`No changes.` under a new major provider means only: *the new provider's schema, applied
to this config, produces the same desired state that the old one recorded in state.* It
says nothing about apply-time behavior, new defaults on attributes the config does not
set, changed API call patterns, or removed arguments that this config does not currently
use but will after the next edit.

A major version bump is a semver promise of breaking changes. Getting a clean plan out of
one is expected, not reassuring.

### 2. The pin that was removed exists for a documented reason

`terraform/versions.tf` carries the rationale in a comment, from audit finding W8-4:
`~> 5.0` / `~> 3.6` previously let two roots resolve **different provider versions from
identical configuration in the same session** — dev and shadow picked random 3.9.0 while
prod picked 3.7.2. The exact pins were the fix. This diff reverts the fix and reopens
the failure it closed.

Concretely, with `~> 6.0`, an operator who runs `init` in the middle of an incident can
silently move to a different provider build than the one that produced the last known
good apply, and then cannot tell whether a new diff is drift or a provider change.

### 3. It fails the lane's own pin requirement

PF-622 requires every provider pinned, and the S2 slice's fitness test is CI failing on
an unpinned version. `~> 6.0` and `~> 3.7` are range constraints, not pins. This diff
should be caught by CI before a human ever reads the plan; if it reached a plan review,
the pin check is also broken.

### 4. What you would actually have to do before accepting this

- Read the provider's v6 upgrade guide against every resource type in this root — Aurora, Elastic Beanstalk, CloudFront, WAFv2, S3 (S3 in particular has moved sub-resource semantics repeatedly across major versions).
- Re-pin exactly: `version = "6.0.0"`, not `~> 6.0`.
- Commit the regenerated lock file in the same change.
- Run the bump against the **throwaway environment from PF-640**, never against the graded one, and confirm a clean `plan` there first.

---

## The one-line answer

> Nothing in the plan changed. The change is the provider pin — `aws` jumped a major
> version and both providers went from exact pins to ranges. A clean plan is not
> evidence the bump is safe, and the range constraints re-introduce the drift the exact
> pins were added to stop.

---

## Scoring

This is scored as a **miss** if you wrote "no changes, nothing to do." Naming the aws
5→6 major bump is the minimum pass. Full marks also name the `random` constraint
loosening despite the resolved version staying at 3.7.2 — that is the line most readers
skip because the version number on both sides is identical.
