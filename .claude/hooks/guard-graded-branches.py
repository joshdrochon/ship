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
    # PF-641 — retargeted from Render to the applied AWS blast radius.
    #
    # These strings used to describe Render reassigning a service slug. That is
    # no longer what is at risk (D6), and a guard whose stated reason is wrong
    # is a guard people talk themselves past. The two AWS consequences, both
    # verified against the applied config:
    #
    #   Aurora  — database.tf:43 sets `skip_final_snapshot = var.environment != "prod"`.
    #             `var.environment` defaults to "dev" and there is no committed
    #             terraform.tfvars, so it is TRUE: destroying takes the cluster
    #             with NO final snapshot. database.tf:45 sets
    #             `backup_retention_period = 1` on the same non-prod branch, and
    #             `delete_automated_backups` is unset, which the provider defaults
    #             to true. So the automated backups go with the cluster. This is
    #             unrecoverable data loss, not a restore-from-backup inconvenience.
    #
    #   CNAME   — every published grader link points at the environment CNAME.
    #             `cname_prefix` is NOT set in elastic-beanstalk.tf, so the name is
    #             AWS-generated and cannot even be pinned on recreate. Evidence it
    #             has already bitten once: .claude/CLAUDE.md still documents
    #             `eba-xsaqsg9h` while the live environment answers on
    #             `eba-nvpntpge`.
    (r"\bterraform\s+destroy\b",
     "terraform destroy",
     "Destroying the graded environment deletes the Aurora cluster with NO final "
     "snapshot (skip_final_snapshot is true whenever environment != 'prod', and it "
     "is 'dev') and releases the EB environment CNAME that every published grader "
     "link points at -- cname_prefix is unset, so the replacement name is "
     "AWS-generated and unpinnable. The destroy-redeploy drill must run against a "
     "throwaway environment with its own state key and project_name prefix (PRD "
     "p.5, p.2; L21 PF-640). Confirm which environment you are pointed at first."),
    # A regex on `terraform destroy` alone is trivially bypassed by the wrapper
    # script that calls it.
    # Match the script being INVOKED, not the string appearing anywhere in the
    # command. The bare substring blocked three things it should not have:
    # PF-642's mandated `.destroy-redeploy/` run directory — the drill's own
    # evidence, so the guard blocked the artifact it exists to protect — a
    # `grep` for this pattern while reading this file, and the edit that fixes
    # it. An invocation has a path-ish prefix or a command boundary in front of
    # it; a directory path does not.
    (r"(?:^|[\s;&|(])(?:\./|bash\s+|sh\s+)?(?:scripts/)?destroy-redeploy\.sh\b",
     "destroy-redeploy wrapper",
     "scripts/destroy-redeploy.sh runs `terraform destroy` internally. NOTE: that "
     "script is Render-specific end to end (it lifts prevent_destroy off "
     "render_postgres and checks a GHCR image tag) and does NOT drive the AWS "
     "root -- running it is not the AWS drill. The AWS drill is PF-642, run by "
     "hand against the PF-640 throwaway environment. Blocked either way (PRD p.5, "
     "p.2)."),
    (r"\bterraform\s+workspace\s+(?:select|new)\s+(?:default|prod|production)\b",
     "terraform workspace select prod",
     "Switching to the live workspace ahead of a destructive command. The graded "
     "environment carries the Aurora cluster and the CNAME every published link "
     "resolves through (PRD p.5, p.2). Confirm intent."),
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
