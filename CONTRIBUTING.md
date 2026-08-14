# Contributing to Ship

Thank you for your interest in contributing to Ship! This document provides guidelines and instructions for contributing.

## Code of Conduct

We expect all contributors to be respectful and professional in their interactions. By participating in this project, you agree to maintain a welcoming and inclusive environment.

## How to Contribute

### Reporting Issues

If you find a bug or have a feature request:

1. Check existing issues to avoid duplicates
2. Create a new issue with a clear title and description
3. Include steps to reproduce bugs
4. Add relevant labels if available

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Write or update tests as needed
5. Ensure all tests pass (`pnpm test`)
6. Commit your changes with clear commit messages
7. Push to your fork
8. Submit a pull request

### Pull Request Guidelines

- Keep PRs focused on a single feature or fix
- Include a clear description of changes
- Reference any related issues
- Ensure CI checks pass
- Be responsive to feedback

## Branching and PR discipline — PlugForge (Week 6)

These four rules are **graded artifacts**, not house style. PRD p.12, Submission
Requirements: *"Public; per-slice branches preserved; each PR description lists which
acceptance criterion that slice advances and confirms the fitness test passed."*

### 1. Branch names are `pf/LNN-<slug>` — PF-023

```
pf/L01-workspace          pf/L03-scope-registry       pf/L15-hmac-signing
pf/L01-boundary-lint      pf/L08-cursor-pagination    pf/L19-cli-login
```

One branch per **slice**, not per ticket (650 PRs) and not per lane (too coarse to name
a single acceptance criterion). A slice is a group of tickets in one lane that lands one
working increment — the PRD uses the word this way in Build Strategy §5 (p.10), where it
calls "event registry → event bus → subscriptions → signer → deliverer → delivery log →
replay" *seven slices*. Each lane file declares its own slice boundaries in a `## Slices`
section; 3–6 slices per lane is the default.

The `LNN` prefix is not decoration. Twenty-six lanes are built in parallel, and several
lanes independently want a branch called `feat/pagination` or `fix/rate-limit`. The lane
number makes a collision impossible without any coordination between them.

### 2. Merged branches are never deleted — PF-025

Branch history is the submission evidence. A grader following the PR trail needs the
branch that PR was opened from to still exist.

- The GitHub repo setting **"Automatically delete head branches" is OFF**. Verified
  2026-08-12 (`gh api repos/<owner>/<repo> --jq .delete_branch_on_merge` → `false`) and
  re-checkable any time with `pnpm check:branch-preservation`.
- `.husky/pre-push` refuses to push a deletion of, or a non-fast-forward to, any
  `refs/heads/pf/*`. Override for a genuine human decision is
  `ALLOW_GRADED_BRANCH_OPS=1`.
- **Do not run the `repo-cleanup` skill, `git branch -d`, or any merged-branch pruning
  before Final Submission.** Cleanup tooling deletes merged branches by default, and
  once both the local and the remote ref are gone it is not recoverable.

### 3. Every PR description names its acceptance criterion — PF-024

`.github/pull_request_template.md` has two mandatory sections and they are not optional
prose:

- **Advances acceptance criterion** — the ticket IDs and the criterion text. Cite what
  the PRD grades (`MVP-N`, `TS-N`, `CTR:…`, `PERF:…`, `INT:…`, `SUB:…`; see
  `TICKETS-PLUGFORGE.md` → Conventions). A slice that advances nothing writes `—`, and
  that is a real signal: it is plumbing, and no PR should claim graded credit for it.
- **Fitness test** — the test's name and confirmation that it passed. "Tests pass" is
  not a fitness test; `pnpm lint:boundary — 4 fences verified` is.

PR bodies are assembled from ticket metadata, not composed from scratch. Every ticket
carries an acceptance criterion and a PRD page reference precisely so this is mechanical.

### 4. The template is enforced, not suggested — PF-026

An unenforced template drifts by the third PR, and the PRD grades the description. The
`pr-discipline` GitHub Actions workflow parses the PR body and fails the check if either
required section is missing or left empty. Check a body before opening the PR with:

```bash
pnpm check:pr-body path/to/body.md      # or: gh pr view N --json body -q .body > /tmp/b.md
```

## Development Setup

```bash
# Install dependencies
pnpm install

# Start development servers
pnpm dev

# Run tests
pnpm test

# Type check
pnpm type-check
```

## Questions?

If you have questions, feel free to open an issue for discussion.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
