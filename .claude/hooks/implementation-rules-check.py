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
Contract integrity
 1. Public/internal split is a ONE-WAY DOOR. No /api/v1/ import from api/src/routes/
    or internal middleware. Lint rule ships before there is anything to lint. (p.11)
 2. Generate the OpenAPI spec from Zod adjacent to the handler — never hand-write it. (p.11)
 3. Every /api/v1 route: OpenAPI entry + declared scope + ApiError shape on failures
    + cursor pagination if it is a list endpoint. Fitness-tested. (p.5)
 4. integrations/ imports ONLY @ship/sdk, never api/src/. (p.11)

Test discipline
 5. No setTimeout waits in webhook/retry tests — deterministic clock injection. (p.11)
 6. Negative cases mandatory: wrong code_verifier -> invalid_grant; tampered body
    fails verify; expired timestamp fails. (p.5)
 7. TTFE drill runs in CI from Day 5. Target flake rate over 20 runs: 0%. (p.8, p.11)

Budgets — numbers, not aspirations
 8. Regression vs Part 1 baseline <= +10% on P95, bundle size, query counts. (p.2, p.6)
 9. SDK < 250 KB min+gzip · webhook delivery P95 < 2s · PKCE round-trip P95 < 3s
    · TTFE drill < 60s in CI. (p.6, p.8)
10. The platform does ZERO AI work. One LLM call per agent turn, user-initiated only.
    Wanting platform-layer AI features is scope creep. (p.11)

Secrets and evidence
11. Secrets hashed at rest, shown EXACTLY ONCE (client_secret, webhook signing secret).
    Not recoverable — capture at creation or the flow is dead. (p.2)
12. Per-slice branches preserved under pf/LNN-<slug>; PR names the acceptance criterion
    and confirms the fitness test passed. Never prune before Final. (p.12)"""


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
        'Implementation Rules (Week 6 PlugForge PRD) apply. Do not report this change as done '
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
