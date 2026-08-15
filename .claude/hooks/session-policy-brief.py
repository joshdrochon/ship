#!/usr/bin/env python3
"""SessionStart hook — put POLICIES.md in front of the model, deterministically.

WHY THIS EXISTS

The graded process rules were already written down (CONTRIBUTING.md for branching,
docs/measurement-rules.md for measurement, TICKETS-PLUGFORGE.md for the board). Being
written down did not make them followed: 61 of the 137 first-parent commits on
pf/integration during PlugForge were authored directly on the integration branch, in
violation of a rule that had been in CONTRIBUTING.md the whole time.

A rule that lives only in a file nobody is required to open is a rule enforced by memory,
and memory is what fails at hour three of a session. So there are two mechanisms and they
do different jobs:

  * scripts/check-branch-policy.sh (pre-commit) BLOCKS the violation.
  * this hook makes the rule PRESENT before the violation is drafted.

The block alone would be enough for correctness and infuriating in practice — you find out
you were on the wrong branch after writing the commit message. The brief alone would be
advisory. Together the rule is both known and enforced.

Output contract: SessionStart hooks return JSON on stdout; `additionalContext` is injected
into the model's context. Keep it SHORT. This is a pointer to POLICIES.md, not a copy of
it — a brief long enough to be ignored is the failure mode being avoided.
"""
import json
import os
import subprocess
import sys

REPO = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def current_branch() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=REPO, capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        # A hook that crashes the session start is worse than one that says nothing.
        return ""


def main() -> int:
    policies = os.path.join(REPO, "POLICIES.md")
    if not os.path.exists(policies):
        # Nothing to point at. Stay silent rather than nagging about a missing file.
        return 0

    branch = current_branch()
    lines = [
        "PROCESS POLICIES ARE IN EFFECT — full text at POLICIES.md (read it before "
        "committing, branching, closing a ticket, or citing the PRD).",
        "",
        "The four that get broken most:",
        "1. BRANCHING — author on a slice branch `pf/LNN-<slug>` cut from `pf/integration`. "
        "Never commit directly to `pf/integration` or `main`; never delete or force-push a "
        "`pf/*` branch. Graded: PRD p.12 'per-slice branches preserved'.",
        "2. NEVER `git commit --no-verify`. The pre-commit hooks are the compliance gate.",
        "3. PRD CITATIONS — verify with `grep -l \"<phrase>\" .claude/prd/page-*.txt`. Never "
        "take a page number from `full.txt`; it reflows. Read the DETAIL page (p.9/p.11/p.12), "
        "not p.13's summary row.",
        "4. AFTER CHANGING ANY DOC, run the api suite — fifteen test files assert on "
        "`docs/architecture.md` prose.",
        "",
        "PF-645 (plan-reading rehearsal) is the user's alone. PRD p.5 makes AI assistance on "
        "it an auto-fail. Do not run it, fill in its log, or suggest plausible numbers.",
    ]

    if branch in ("main", "master", "pf/integration"):
        lines += [
            "",
            f"NOTE: HEAD is currently `{branch}`, which is an integration branch. Cut a slice "
            "branch before authoring anything — `scripts/check-branch-policy.sh` will block "
            "the commit otherwise.",
        ]

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": "\n".join(lines),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
