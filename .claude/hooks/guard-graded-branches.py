#!/usr/bin/env python3
"""PreToolUse/Bash guard for PlugForge (Week 6) graded artifacts.

The PRD (p.12) requires per-slice branches to be PRESERVED as submission
evidence. Branch deletion and history rewrites are one-way doors: once the
local ref and the remote ref are both gone, the evidence is unrecoverable.

Exit 2 blocks the tool call and feeds stderr back to the model.
Exit 0 allows.

Deliberate override (human, not agent):  ALLOW_GRADED_BRANCH_OPS=1
"""
import json
import os
import re
import sys

# (compiled pattern, short label, why it is blocked)
RULES = [
    (r"\bgit\s+branch\b[^|;&]*\s-(?:d|D)\b",
     "git branch -d/-D",
     "Deletes a local branch. Per-slice branches are graded evidence (PRD p.12)."),
    (r"\bgit\s+branch\b[^|;&]*--delete\b",
     "git branch --delete",
     "Deletes a local branch. Per-slice branches are graded evidence (PRD p.12)."),
    (r"\bgit\s+push\b[^|;&]*(?:--delete\b|\s-d\b)",
     "git push --delete",
     "Deletes a remote branch. Unrecoverable once the local ref is also gone."),
    (r"\bgit\s+push\b[^|;&]*\s:[\w./-]+",
     "git push colon-refspec",
     "`git push origin :branch` is a remote delete in disguise."),
    (r"\bgit\s+push\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b)",
     "git push --force",
     "Rewrites remote history. Per-slice commit history is what the PR descriptions cite."),
    (r"--no-verify\b|\bgit\s+commit\b[^|;&]*\s-n\b",
     "--no-verify",
     "Skips pre-commit hooks. Explicitly forbidden by .claude/CLAUDE.md (security compliance)."),
    (r"\bgit\s+reset\s+--hard\b",
     "git reset --hard",
     "Discards working-tree and index state with no reflog entry for uncommitted work."),
    (r"\bgit\s+filter-branch\b|\bgit\s+filter-repo\b",
     "history rewrite",
     "Rewrites history across the repo. Destroys per-slice branch provenance."),
    (r"\bterraform\s+destroy\b",
     "terraform destroy",
     "The destroy-redeploy drill must run against a throwaway workspace, never the "
     "grader-facing instance (PRD p.5). Confirm the workspace first."),
    # A regex on `terraform destroy` alone is trivially bypassed by the wrapper
    # script that calls it. Render reassigns a random slug on recreate, so
    # destroying the live service breaks every published grader link.
    (r"destroy-redeploy(?:\.sh)?\b",
     "destroy-redeploy wrapper",
     "scripts/destroy-redeploy.sh runs `terraform destroy` internally. Render "
     "reassigns the service slug on recreate, so this breaks every published "
     "grader URL. Run it against a throwaway workspace only (PRD p.5)."),
    (r"\bterraform\s+workspace\s+(?:select|new)\s+(?:default|prod|production)\b",
     "terraform workspace select prod",
     "Switching to the live workspace ahead of a destructive command. Confirm intent."),
]

COMPILED = [(re.compile(p), label, why) for p, label, why in RULES]


def main() -> int:
    if os.environ.get("ALLOW_GRADED_BRANCH_OPS") == "1":
        return 0

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0  # never block on a malformed payload

    command = (payload.get("tool_input") or {}).get("command") or ""
    if not command:
        return 0

    for pattern, label, why in COMPILED:
        if pattern.search(command):
            print(
                f"BLOCKED — {label}\n\n"
                f"{why}\n\n"
                f"Command: {command}\n\n"
                f"PlugForge branch policy: per-slice branches under pf/** are preserved "
                f"until Final Submission. See TICKETS-PLUGFORGE.md → "
                f"'Branching & PR Discipline'.\n"
                f"If this is genuinely intended, the user must run it themselves or set "
                f"ALLOW_GRADED_BRANCH_OPS=1 — do not work around this guard.",
                file=sys.stderr,
            )
            return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
