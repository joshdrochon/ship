#!/usr/bin/env python3
"""PostToolUse hook on Write|Edit — re-assert the FleetGraph Engineering Requirements.

Week 5 has five non-optional Engineering Requirements (brief p.4, reproduced verbatim in
docs/fleetgraph/engineering-requirements.md). They are graded alongside agent functionality.
The failure this guards against is finishing a change and reporting it done without checking
it — most often requirement 1 (no regression test for a defined agent behaviour) or
requirement 4 (an outbound call shipped with no timeout).

Replaces implementation-rules-check.py in settings.json rather than editing it. That hook
encodes Week 4's 11 Implementation Rules, which governed an audit-and-improve brief built
around before/after measurement — not what this week grades. It stays on disk, unmodified,
as the record of a finished submission.

Python, not bash: `jq` is not installed on this machine. The Week 4 hook was first written
around jq and exited 0 with no output on every invocation — a hook that silently does
nothing is worse than no hook, which is why this one is Python too.

Fires only for source files. Markdown does not need the reminder.

Always exits 0. This informs; it never blocks.
"""
import json
import os
import sys

SOURCE_SUFFIXES = (
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.sql', '.sh', '.py', '.tf', '.yml', '.yaml',
)

REQUIREMENTS = """\
1. Regression test for every agent behaviour defined in the use cases.
   CI failure must roll the deployment back automatically — a failing build
   never stays deployed. Trigger and procedure documented in FLEETGRAPH.md.
2. E2E for both modes, both running in CI: (a) an event enters Ship and the
   agent surfaces it inside the latency window, (b) a user invokes the agent
   from context-aware chat and gets a grounded response.
3. Stable fakes for every external service in tests — Ship API and LLM alike.
   "Real Ship data" governs the running agent, never the test suite.
4. Explicit timeout + retry with exponential backoff on EVERY outbound call.
   Degrade gracefully; never crash, hang, or loop. Reuse
   api/src/services/circuitBreaker.ts — do not write a second one.
5. CHANGES.md updated: what was built, how to run and test it locally, how to
   roll it back. Written for the next engineer, not for graders."""

STANDING = """\
- Never `git commit --no-verify`; never push straight to main.
- `pnpm test` truncates the dev database (api/test/setup.ts:14) — reseed first.
- Never run `pnpm test:e2e` directly; use /e2e-test-runner.
- The E2E database resets per spec FILE, not per test."""


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
    if not (path.endswith(SOURCE_SUFFIXES) or base == 'Dockerfile'):
        return 0

    # Week 4's audit instruments are not FleetGraph work.
    if '/docs/audit/' in path:
        return 0

    project = os.environ.get('CLAUDE_PROJECT_DIR', '')
    rel = os.path.join('docs', 'fleetgraph', 'engineering-requirements.md')
    if os.path.isfile(os.path.join(project, rel)):
        note = f'Full verbatim text: {rel}'
    else:
        note = (f'WARNING: {rel} is MISSING. Restore it before continuing — it is the '
                'committed record of the requirements.')

    context = (
        f'Source file changed: {path}\n\n'
        'FleetGraph Engineering Requirements (Week 5 brief, p.4) apply. They are graded '
        'alongside agent functionality and are not optional. Do not report this change as '
        'done until each is satisfied, or explicitly noted as not applicable:\n\n'
        f'{REQUIREMENTS}\n\n'
        f'Standing project rules, unchanged:\n{STANDING}\n\n'
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
