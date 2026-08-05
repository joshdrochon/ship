#!/usr/bin/env python3
"""PostToolUse hook on Write|Edit — re-assert the Implementation Rules after a code change.

Phase 2 has 11 non-negotiable Implementation Rules (brief p.8-9, reproduced verbatim
in docs/audit/implementation-rules.md). The failure this guards against is finishing a
code change and reporting it done without checking it against them — most often rule 1
(no before/after measurement), rule 2 (tests not actually run), rule 3 (no regression
test) or rule 9 (no reasoning written down).

Python, not bash: `jq` is not installed on this machine. The first version of this hook
was written around jq and exited 0 with no output on every single invocation — a hook
that silently does nothing is worse than no hook, so it is worth stating why.

Fires only for source files. Editing markdown or the audit tooling is not an
"improvement" under rule 10 and does not need the reminder.

Always exits 0. This informs; it never blocks. Blocking every source edit would make
the repository unusable.
"""
import json
import os
import sys

SOURCE_SUFFIXES = (
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.sql', '.sh', '.py', '.tf', '.yml', '.yaml',
)

RULES = """\
 1. Before/after proof, same script, identical conditions
 2. Tests still pass — `pnpm test` is api-only; web/ has 267 tests, all passing
    (was 151/13-failing; Week 4 fixed those, and M8 added 26. Re-measure before
    citing this number again rather than inheriting it.)
 3. A regression test that would have caught the bug
 4. CI covers build, lint, type-check, test, coverage, pnpm audit, security scan, licence inventory
 5. Artifact built once, tagged with the commit SHA, promoted rather than rebuilt
 6. One command starts app + database from a clean checkout
 7. Retry / timeout / circuit breaker, with the failure mode named
 8. CHANGES.md updated: what, how to run, how to test, how to roll back
 9. Reasoning written: what changed, why the original was worse, tradeoffs
10. Not cosmetic — it must move a measured number
11. Separable in git history"""


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    tool_input = payload.get('tool_input') or {}
    tool_response = payload.get('tool_response') or {}
    path = tool_response.get('filePath') or tool_input.get('file_path') or ''
    if not path:
        return 0

    base = os.path.basename(path)
    is_source = path.endswith(SOURCE_SUFFIXES) or base == 'Dockerfile'
    if not is_source:
        return 0

    # The audit scripts are instruments, not improvements to the product.
    if '/docs/audit/' in path:
        return 0

    project = os.environ.get('CLAUDE_PROJECT_DIR', '')
    rules_path = os.path.join(project, 'docs', 'audit', 'implementation-rules.md')
    if os.path.isfile(rules_path):
        note = 'Full verbatim text: docs/audit/implementation-rules.md'
    else:
        note = ('WARNING: docs/audit/implementation-rules.md is MISSING. '
                'Restore it before continuing — it is the committed record of the rules.')

    context = (
        f'Source file changed: {path}\n\n'
        'Implementation Rules (brief p.8-9) apply. Do not report this change as done '
        'until each of these is satisfied, or explicitly noted as not applicable:\n\n'
        f'{RULES}\n\n'
        'Reminder: `pnpm test` truncates the dev database (api/test/setup.ts:14). '
        'Reseed before taking any measurement, or the next number is taken against '
        'an empty database.\n\n'
        f'{note}'
    )

    json.dump({
        'hookSpecificOutput': {
            'hookEventName': 'PostToolUse',
            'additionalContext': context,
        },
        'suppressOutput': True,
    }, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
