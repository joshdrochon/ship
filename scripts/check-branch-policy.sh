#!/usr/bin/env bash
#
# Branch policy gate. POLICIES.md §1, CONTRIBUTING.md "Branching and PR discipline".
#
# PRD p.12 grades on "per-slice branches preserved". The existing guards
# (.husky/pre-push, .claude/hooks/guard-graded-branches.py) protect branches that
# ALREADY EXIST — they refuse deletion and force-push. Nothing enforced the rule
# that work is authored ON a slice branch in the first place, and 61 of the 137
# first-parent commits on pf/integration during PlugForge went in directly.
#
# This is that missing half. It blocks AUTHORING on an integration branch and
# allows MERGING into one, which is what the branch is for.
#
# Override for a genuine human decision:  ALLOW_GRADED_BRANCH_OPS=1 git commit ...
set -uo pipefail

PROTECTED_RE='^(main|master|pf/integration)$'
SLICE_RE='^pf/L[0-9]{2}-[a-z0-9][a-z0-9-]*$'

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0

# Detached HEAD (rebase, bisect, cherry-pick in progress) — not our business.
[ "$branch" = "HEAD" ] && exit 0

if [ "${ALLOW_GRADED_BRANCH_OPS:-}" = "1" ]; then
  echo "check-branch-policy: override set — skipping ($branch)" >&2
  exit 0
fi

# A merge into an integration branch is the intended way work lands there.
# MERGE_HEAD exists only while a merge commit is being created.
git_dir=$(git rev-parse --git-dir 2>/dev/null || echo .git)
if [ -f "$git_dir/MERGE_HEAD" ]; then
  exit 0
fi

if [[ "$branch" =~ $PROTECTED_RE ]]; then
  cat >&2 <<EOF

BLOCKED: refusing to author a commit on '$branch'.

PRD p.12, Submission Requirements: "per-slice branches preserved; each PR
description lists which acceptance criterion that slice advances". Work authored
directly on an integration branch has no slice branch and no PR, so there is
nothing for a grader to follow.

Move the work to a slice branch — it is not lost, and nothing needs rewriting:

    git checkout -b pf/LNN-<slug>          # your staged changes come with you
    git commit ...

Naming is 'pf/LNN-<slug>', lane number then a short slug: pf/L22-portal-replay.
One branch per SLICE — a group of tickets in one lane that lands one working
increment — not per ticket and not per lane.

Merging INTO $branch is allowed and is not affected by this check.

See POLICIES.md section 1. Genuinely intentional, and a human decision?
    ALLOW_GRADED_BRANCH_OPS=1 git commit ...

EOF
  exit 1
fi

# Non-blocking: a pf/* branch that is not named like a slice still works, but the
# lane prefix is what makes 26 parallel lanes collision-proof, so say something.
if [[ "$branch" == pf/* ]] && ! [[ "$branch" =~ $SLICE_RE ]]; then
  echo "check-branch-policy: WARNING — '$branch' is not 'pf/LNN-<slug>' (POLICIES.md 1)" >&2
fi

exit 0
