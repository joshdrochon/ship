# Branch and Sync

Start work on a fresh branch cut from a verified-current `main`, and land it on **both**
remotes so neither is stale. This repo pushes to two independent forges and is graded on
one of them, so "it's pushed" is not a claim that can be made about a single remote.

## Trigger

- User types `/ship-branch-and-sync`
- User says "pull from a fresh main", "branch off main", "as always" about starting work
- User says "make sure GitHub and GitLab are in sync", "is main caught up on both"
- Before starting any new unit of work, since the branch must be cut before the first edit

## The three remotes

| Remote | URL | What it is |
|---|---|---|
| `origin` | `labs.gauntletai.com/joshrochon/ship` | **GitLab. This is what gets graded.** |
| `github` | `github.com/joshdrochon/ship` | Drives the Render deploy and GitHub Actions CI |
| `upstream` | `labs.gauntletai.com/byronmackay/ship` | The assignment's source fork. Read-only; never push here |

`origin` being GitLab rather than GitHub is the reversal that catches people. When in doubt
about which one matters, it is `origin`.

## Starting work

```bash
git fetch github
git fetch origin
git switch -c <type>/<slug> origin/main
```

Fetch each remote in its **own** command. `git fetch github main origin main` does not fetch
two remotes — git reads everything after the first remote as a refspec and fails with
`fatal: couldn't find remote ref origin`. It looks like a network error and is not one.

Branch names follow the repo's convention: `feat/`, `fix/`, `docs/`, `ci/`, `chore/`.

## Verifying main is actually current

The two `main` branches will almost always have **different tip SHAs** and that is normal —
a GitHub "Merge pull request #N" commit and a GitLab "Merge branch ... into 'main'" commit
are different objects wrapping the same result.

Compare trees, not commits:

```bash
git rev-parse github/main^{tree} origin/main^{tree}   # two identical lines = same content
```

Then confirm nothing is stranded:

```bash
git rev-list --count origin/main..github/main   # commits only GitHub has
git rev-list --count github/main..origin/main   # commits only GitLab has
```

Nonzero counts with identical trees means merge commits only — fine. Nonzero counts with
**different** trees means real work is missing from one side; find it before branching:

```bash
git log --oneline origin/main..github/main
```

## Landing the work

**Never push to `main` directly.** The commit history is graded, and a direct push to a
protected branch also breaks the MR/PR trail that shows review happened.

1. Push the branch to both remotes:
   ```bash
   git push -u origin HEAD
   git push github HEAD
   ```
2. Open an MR on GitLab and a PR on GitHub for the same branch.
3. Merge both. GitLab may return **405** if `only_allow_merge_if_pipeline_succeeds` is set —
   set `merge_when_pipeline_succeeds=true` rather than forcing it.
4. Re-run the tree comparison above. That, not the merge notification, is the proof.

## Commit rules that bite here

- **Never `git commit --no-verify`.** The pre-commit hooks run `comply opensource`; skipping
  them is a compliance failure, not a shortcut. See `/ship-security-compliance`.
- **`Closes:` trailers must be one contiguous block.** A blank line before `Co-Authored-By`
  splits the trailer paragraph, git parses only the last one, and every `Closes:` above it is
  silently inert. Fourteen commits' worth of ticket closures were lost to exactly this, and
  the tracker read ~10 points low for days. Verify with:
  ```bash
  node scripts/linear-import.mjs --verify
  ```
- Never commit anything under `.claude/prd/` — it is gitignored and is not ours to publish.
- Never write a credential value into a tracked file.

## Common failure, and what it actually was

`git checkout -q <branch> && git pull ... || git reset -q --hard origin/<branch>`

The `checkout` fails when the branch is already checked out in another worktree. The `||`
then fires against **whatever branch is currently checked out**, hard-resetting live work.
Recovery is `git reset --hard origin/<current-branch>` if the branch was pushed; if it was
not, the commits are only in the reflog.

Do not chain a destructive fallback to a checkout. Check the worktree list first:

```bash
git worktree list
```

## Related

- `/ship-worktree-preflight` — session-start checks when working in a worktree
- `/ship-security-compliance` — the pre-commit hooks and why `--no-verify` is banned
- `/ship-deploy` — promotion after the merge lands
