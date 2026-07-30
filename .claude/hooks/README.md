# Claude Code hooks

Wired by `../settings.json`, which is committed so these travel to git worktrees and to
the fork. Personal settings stay in the gitignored `settings.local.json`.

| Hook | Event | What it does | Blocks? |
|---|---|---|---|
| `implementation-rules-check.py` | `PostToolUse` on `Write`/`Edit` | On any **source** file change, re-states the 11 Implementation Rules (brief p.8–9) plus the repo's own traps. Skips markdown and `docs/audit/`. | Never |
| `verify-prd-citations.py` | `Stop` | Checks the last assistant message three ways: requirement claims cite a page, quoted text really appears on the page cited, and proposed work maps to a page or is declared self-directed. | Up to twice, then stands down |

## `verify-prd-citations.py` needs page text that is not committed

It reads `.claude/prd/page-N.txt`, extracted from the brief PDF. That directory is
**deliberately excluded** (see `.git/info/exclude`) because it is third-party assignment
text. Without it the hook **fails open** — it exits 0 and checks nothing.

To enable it in a fresh clone or worktree:

```bash
.claude/hooks/extract-prd.sh /path/to/brief.pdf "Week 4 — ShipShape"
```

That writes `page-N.txt`, `full.txt`, and a `source.json` manifest recording the PDF's
sha256. If the PDF later changes, the hook reports the staleness instead of silently
verifying against outdated text.

`implementation-rules-check.py` has no such dependency — it reads
`docs/audit/implementation-rules.md`, which is committed.

## Why these exist

Both guard the same failure: drifting away from the document being graded. One re-asserts
the rules at the moment code changes; the other refuses to let a requirement claim or a
proposed task go out without a page number behind it.

Neither is a substitute for reading the brief. They catch the case where you think you
already did.

## Turning one off

Delete its block from `../settings.json`. Both are informational or allow-with-feedback —
neither can hard-fail a tool call.
