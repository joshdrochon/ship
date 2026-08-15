# POLICIES — graded process rules

These are the rules that a **grader** checks, or that exist because breaking one
previously cost us a review. They are not house style. Each rule names the artifact it
protects and the mechanism that enforces it.

If a rule here has no mechanism, that is a defect in the rule, not a licence to skip it.

**Detail lives elsewhere; this file is the index.** `CONTRIBUTING.md` carries the full
branching rationale, `docs/measurement-rules.md` the measurement rules, and
`TICKETS-PLUGFORGE.md` the board conventions.

---

## 1. Branching — PRD p.12

> *"Public; per-slice branches preserved; each PR description lists which acceptance
> criterion that slice advances and confirms the fitness test passed."*

| Rule | Mechanism |
|---|---|
| One branch per **slice**, named `pf/LNN-<slug>`, cut from `pf/integration` | `scripts/check-branch-policy.sh` via `.husky/pre-commit` |
| Never commit directly to `pf/integration` or `main` | same |
| Never delete a `pf/*` branch | `.husky/pre-push`, `.claude/hooks/guard-graded-branches.py` |
| Never force-push a `pf/*` branch | `.husky/pre-push` |
| Never run `repo-cleanup`, `git branch -d`, or any merged-branch pruning | `.claude/hooks/guard-graded-branches.py` |

Override for a genuine **human** decision is `ALLOW_GRADED_BRANCH_OPS=1`. It is not for an
agent working around a guard.

**Merges into `pf/integration` are allowed** — that is what the branch is for. The block is
on *authoring* work there.

### Retroactive branches are not evidence

Cutting a branch today at a commit that was authored days ago manufactures a paper trail
that never existed. Do not do it. If work landed directly on `pf/integration`, the honest
record is to say so. A branch cut within minutes of the commit, for work that has not yet
been pushed anywhere, is late — not fabricated — and is fine.

## 2. Commits

| Rule | Why |
|---|---|
| **Never `git commit --no-verify`** | The pre-commit hooks are the compliance gate |
| Commit messages name the tickets **and** a re-runnable artifact | A slice that says "verified" without a command or an exit code cannot be checked. `docs/pr-compliance-sweep.md` swept 66 slices; 9 failed on exactly this |
| `Closes:` trailers must be a contiguous block | A blank line before `Co-Authored-By` silently voids them |
| Stage by explicit path — never `git add .` / `-A` / `commit -a` | Multiple agents share this working tree |

## 3. The board

| Rule | Mechanism |
|---|---|
| Run `python3 scripts/check-plugforge-tickets.py` **before** committing a ticket edit | Manual — a red board has been pushed by running it after |
| Read every error line, not the tail | Manual |
| Escape a literal `\|` inside a table cell | The validator splits cells on unescaped pipes |
| Close a ticket only with a named artifact or command as proof | A false closure is worse than an open ticket |

## 4. PRD citations

Verify every page number before citing it:

```
grep -l "<distinctive phrase>" .claude/prd/page-*.txt
```

**Never derive a page number from `full.txt`** — it reflows, and every citation taken from
it has been wrong. **Read the detail page, not the summary row**: p.13 summarises each
deliverable in one line; p.9, p.11 and p.12 carry the actual required structure. The cost
analysis was written against p.13's one-liner and missed five of p.9's tracked items.

Enforced after the fact by `.claude/hooks/verify-prd-citations.py` (Stop hook).

## 5. Measurement — the rule that cost us an MVP review

The MVP failed review on the +10% regression budget because the evidence measured the wrong
thing three ways: the baseline was not Part 1, the harness timed its own server binds, and
the two trees ran under different rate-limit ceilings.

**Hold a control that cannot move.** `/health` runs no query. When it reports +108%, the
instrument is broken and you know it without knowing anything about the change.

Full set: `docs/measurement-rules.md`. Enforced by `scripts/perf-self-check.mjs` (A/A before
A/B) and by `compare-baseline`'s refusal when `method.transport` differs.

## 6. Tests

| Rule | Why |
|---|---|
| Never run `pnpm test:e2e` directly — use `scripts/e2e-run.sh` | 600+ tests streaming to stdout crashes an agent session |
| A test containing only TODO comments passes silently — use `test.fixme()` | `scripts/check-empty-tests.sh` at pre-commit |
| **After changing any doc, run the api suite** | Fifteen test files `readFileSync` `docs/architecture.md` and assert on its prose. A trim to that file once turned 62 tests red |
| `FAIL file [ file ]` in vitest is a collection error — the file never ran | Not a test failure |

## 7. Work that is the user's alone

**PF-645, the plan-reading rehearsal.** PRD p.5 makes AI assistance on it an auto-fail.
Do not run it, do not fill in `docs/infra/plan-reading-rehearsal.md`, and do not suggest
plausible numbers — that last one has been asked for and refused, and it stays refused.

The demo video and the social post are likewise the user's.
