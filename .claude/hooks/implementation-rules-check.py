#!/usr/bin/env python3
"""PostToolUse hook on Write|Edit — re-assert the Implementation Rules after a code change.

Week 6 PlugForge's rules live on PRD p.11 as eight Build Strategy priority rules plus
six Critical Guidance bullets, reproduced in docs/audit/implementation-rules.md. The
failure this guards against is finishing a code change and reporting it done without
checking it against them — most often A2 (a cross-import that should have been fenced),
A4 (a route added without regenerating the spec) and A8 (Epic 7 reported as proven when
no CI job runs the flag matrix).

The rule text below is DUPLICATED from that markdown file rather than read from it, so
the two drift. They did: this block once carried a flat 1-12 list that had silently
dropped five of p.11's eight priority rules. If you edit one, edit both, and keep the
8 + 6 shape so an omission is countable.

The previous docstring described Week 4 ShipShape's 11 measure-and-improve rules; those
are archived at docs/audit/archive/implementation-rules-week4-shipshape.md.

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

# Mirrors docs/audit/implementation-rules.md. PRD p.11 is 8 + 6 — eight Build
# Strategy priority rules, then six Critical Guidance bullets — and this block
# keeps that shape. The previous version flattened both into one 1-12 list, which
# dropped priority rules 1, 5, 6, 7 and 8 without leaving a countable hole; A8's
# feature-flag matrix, the one requirement with no CI evidence, was among them.
# Keep A1-A8 numbered A, keep B1-B6 numbered B, and keep C separate: a reader has
# to be able to count eight and six.
RULES = """\
A — Build Strategy, the eight priority rules (p.11). All eight.
 A1. OAuth foundation FIRST — Auth Code + PKCE end-to-end Day 1, negative tests
     (wrong verifier rejected) included. Device grant the same day.
 A2. Public/internal boundary Day 1 — /api/v1/ is a fresh router sharing NO
     middleware with the internal API. The lint rule ships before the first
     cross-import exists.
 A3. Error shape and ApiError class BEFORE any resource endpoint. The fitness
     test that enumerates routes and asserts the shape is the E2 TODO list.
 A4. OpenAPI generated from route metadata, never hand-written. One resource
     (documents) end-to-end before issues, sprints, me.
 A5. Webhooks end-to-end Day 4, seven slices: event registry -> event bus ->
     subscriptions -> signer -> queue deliverer -> delivery log -> replay. The
     signer has its own suite: positive, negative, replay, tamper.
 A6. SDK skeleton + one resource client + auth helpers next, with the CLI
     consuming it as it is built.
 A7. CLI reference integration is MUST-SHIP — ship login, ship docs create,
     ship webhooks tail. It is the proof the platform works.
 A8. Developer portal + agent rewire (Epic 7) behind a feature flag, so Part 2's
     tests pass with the flag ON or OFF.
     ^ Weakest evidence in the repo. SHIP_AGENT_VIA_SDK exists and
       docs/l23-flag-matrix.md inventories it, but NO CI job runs both states.
       Do not report Epic 7 as proven on this clause.

B — Critical Guidance, the six bullets (p.11). All six.
 B1. The public/internal split is a one-way door. The lint rule is not optional.
 B2. Generate the OpenAPI spec from Zod adjacent to the handler; hand-written
     specs lie within a week.
 B3. In-memory deliverer resolves synchronously; the queue-backed one is tested
     with deterministic clock injection. No setTimeout waits — timing-based
     webhook tests are flaky tests.
 B4. One LLM call per agent turn, period. The platform never invokes the LLM;
     wanting platform-layer AI features is scope creep.
 B5. integrations/ imports ONLY @ship/sdk, never api/src/. This is what makes
     "the agent is a platform citizen" true rather than aspirational.
 B6. TTFE drill in CI from Day 5 onward.

C — derived from other pages. NOT p.11 text.
 C1. Every /api/v1 route: OpenAPI entry + declared scope + ApiError shape on
     failure paths + cursor pagination if it is a list endpoint. (p.5)
 C2. Regression vs the Part 1 baseline <= +10% on P95, bundle size, per-route
     query counts. (p.2, p.6)
 C3. PKCE round-trip P95 < 3s · webhook delivery P95 < 2s first attempt · TTFE
     < 60s in CI, <= 30 min clean machine (p.6). SDK < 250 KB min+gzip and 0%
     drill flake over 20 CI runs (p.9 — NOT p.8). verifyWebhook < 1 ms (p.8).
 C4. Negative cases are mandatory, not optional: wrong code_verifier ->
     invalid_grant (p.5); tampered body fails, timestamp > 5 min fails (p.8).
 C5. Secrets shown EXACTLY ONCE and never recoverable (p.2). client_secret is
     hashed at rest; webhook signing secrets are ENCRYPTED, not hashed — a
     knowing departure from p.3, recorded as C3 in docs/architecture.md.
 C6. Expired tokens return 401 with a distinct error code (p.2 MVP gate item 3).
     Shipped as details.reason + a per-reason RFC 6750 challenge, not a distinct
     ApiErrorCode. The argument is in docs/architecture.md -> Failure Modes.
 C7. Per-slice branches preserved under pf/LNN-<slug>; the PR description names
     the acceptance criterion and confirms the fitness test passed (p.12).
     Never pruned before Final. See POLICIES.md §1 for what was NOT satisfied."""


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
