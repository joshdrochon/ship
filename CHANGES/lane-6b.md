# Lane 6b — Repair the backlinks / issue-estimates regression

Written for the next engineer (Rule 8): what changed, how to run it, how to test
it, how to roll it back — plus the reasoning and tradeoffs (Rule 9).

## Summary

Lane 6's W6-9 fix (document title moved from a debounced REST `PATCH` into the
Yjs CRDT) turned 10 E2E tests red and blocked the merge. **It was not a product
regression.** The title still persists correctly; ten tests were asserting on the
*transport* that used to carry it.

| | Before (merged, pre-fix) | After |
|---|---:|---:|
| `backlinks.spec.ts` + `issue-estimates.spec.ts` | **10 failed / 8 passed**, 15.5m | **18 passed / 0 failed**, 1.3m |
| W6-9 concurrent title edit, both users' text survives | 5 / 5 | **5 / 5** (unchanged) |
| `pnpm test` | 502 | 502 |
| `pnpm --filter @ship/web exec vitest run` | 192 | 192 |

The 14× runtime drop is the tell: the old failures were all `waitForResponse`
timeouts burning 5–60s each, not assertion failures.

## What the mechanism turned out to be

Not the backlink derivation. `Editor.tsx:742-783` syncs mentions to
`POST /api/documents/:id/links` off the TipTap `editor.on('update')` event, which
W6-9 never touched. `api/src/routes/backlinks.ts` was never modified either.

The failures were **all in test setup**. `backlinks.spec.ts` had a local
`setDocumentTitle` helper whose third line was:

```ts
await page.waitForResponse(
  resp => resp.url().includes('/api/documents/') && resp.request().method() === 'PATCH',
  { timeout: 5000 }
)
```

Every backlinks test called that helper before touching a mention, so all seven
died before a single line of backlink code ran. `issue-estimates.spec.ts` had the
same shape at :86/:100/:143 — which is exactly the Week Assignment Validation
block that failed. The one remaining failure
(`issue-estimates.spec.ts:53`, an estimate-field test with no title involvement)
was environmental: it timed out at 60s with no stack while the machine was down
to 0.9 GB free, and it passes in the green run with no change made to it.

### The PATCH did not simply disappear — it became a race

Worth recording, because it explains why this presented as "some tests fail":
`web/src/hooks/useCollaborativeTitle.ts:129-137` keeps a REST fallback that fires
1.5s after typing **if the collaboration socket has not synced yet**. So a
title-bearing PATCH fires:

- **zero times** when the socket syncs before the user types (the common case), or
- **once** when it does not.

Both were observed in the same test file. Waiting on that PATCH is therefore not
a broken signal so much as a *nondeterministic* one — the tests were latent flakes
that the W6-9 timing change pushed over the edge.

## Verified: persistence is not broken

This was the question that decided whether to fix forward or escalate.
`e2e/title-persistence.spec.ts` asserts, against the real stack, that a title
typed in the editor is served back by `GET /api/documents/:id` and survives a
full page reload. **Both assertions pass.** The title lands in the column via
`persistDocument` (`api/src/collaboration/index.ts:173-183`), which reads it out
of the CRDT and writes `title = COALESCE($5, title)` on the collaboration
server's 2s debounce.

No production code was changed in this lane.

## The finding worth keeping: tests coupled to transport

Eight spec files waited on `method() === 'PATCH'` as a proxy for "the data was
saved":

```
backlinks.spec.ts   documents.spec.ts    data-integrity.spec.ts   weeks.spec.ts
issue-estimates.spec.ts   autosave-race-conditions.spec.ts
drag-handle.spec.ts       program-mode-week-ux.spec.ts
```

A test that asserts on which HTTP verb carried a value breaks whenever the
transport changes, even when the user-visible behaviour is identical — and it
passes when the transport is right but the data never lands. Both failure modes
are backwards. The suite paid for this once here; the same coupling would break
again on any future move to batched writes, a service worker, or a different
socket. Assertions now target the outcome: the server serves the value back, the
element shows it, the document appears in the list.

Not every PATCH wait was wrong. Four sites legitimately still wait on REST,
because those fields never moved into the CRDT, and they were left alone:

| Site | Field | Why unchanged |
|---|---|---|
| `issue-estimates.spec.ts:47,63` | estimate | still a REST `PATCH /api/documents/:id` |
| `weeks.spec.ts:57` | estimate | same |
| `weeks.spec.ts:83` | week assignment | same |
| `program-mode-week-ux.spec.ts:767,877` | issue sprint move | `/api/issues/`, untouched by W6-9 |

## Files changed

| File | Change |
|---|---|
| `e2e/fixtures/test-helpers.ts` | new `documentIdFromUrl`, `expectDocumentTitleSaved`, `setDocumentTitle` — poll `GET /api/documents/:id` until the title lands |
| `e2e/title-persistence.spec.ts` | **new.** Transport-agnostic regression tests (Rule 3) |
| `e2e/backlinks.spec.ts` | local `setDocumentTitle` delegates to the shared helper; 2 further PATCH waits replaced (one now waits on the `/links` POST it actually depends on) |
| `e2e/issue-estimates.spec.ts` | 3 title waits → `expectDocumentTitleSaved` |
| `e2e/documents.spec.ts` | 2 title waits → outcome assertions; "can edit document title" now also reloads to prove persistence |
| `e2e/autosave-race-conditions.spec.ts` | throttle test rewritten — see tradeoff below |
| `e2e/data-integrity.spec.ts` | title wait (which swallowed its own timeout) → real assertion |
| `e2e/drag-handle.spec.ts` | title wait → outcome assertion |
| `e2e/weeks.spec.ts` | title wait → outcome assertion |

Production code: **none**.

## The one real semantic change: the throttle test

`autosave-race-conditions.spec.ts` had
`throttle: saves periodically during long typing session`, which counted
title-bearing PATCH bodies and required `>= 3`. That assertion cannot be
preserved honestly:

- there are no title PATCHes in the steady state, and
- `schedulePersist` (`api/src/collaboration/index.ts:189-197`) *resets* its 2s
  timer on every update, so during genuinely continuous typing there is
  legitimately no column write until the user pauses.

The old test's purpose was "work is being flushed while you type, not just once
at the very end." Rewritten as
`throttle: intermediate and final title edits are both persisted`: type a burst,
assert the server holds it, type a second burst, assert the server holds the
concatenation, then reload and assert the complete untruncated value. An
implementation that only saved at the very end still fails it.

**Tradeoff, stated plainly:** the new test tolerates a longer flush window (2s
debounce vs 500ms throttle), so it is weaker on latency. It is stronger on what
matters — it checks the value actually reached the database, which the PATCH
count never did. Durability during typing is now provided by the WebSocket
(every keystroke reaches the server's in-memory Y.Doc immediately), not by the
REST flush, so the risk window moved from "browser crash" to "server crash".

## How to run and test

```bash
# the exact reproduction command for this lane
PLAYWRIGHT_WORKERS=2 pnpm exec playwright test \
  e2e/backlinks.spec.ts e2e/issue-estimates.spec.ts --workers=2 --retries=0
# expect: 18 passed

# the regression tests specifically
PLAYWRIGHT_WORKERS=2 pnpm exec playwright test e2e/title-persistence.spec.ts --workers=2

# W6-9 must still hold — needs the app running (pnpm dev, note the ports)
BASE=http://localhost:<web> API=http://localhost:<api> DOC_ID=<wiki uuid> RUNS=5 \
  node docs/audit/scripts/measure-concurrent-edit-suite.mjs \
    --out docs/audit/raw/cat6-w6-9-after-lane6b.json --label after-lane-6b
# expect: title_both_survived 5, title_one_edit_destroyed 0

# unit suites. `pnpm test` TRUNCATES the dev database — reseed after.
pnpm test && pnpm db:seed          # 502
pnpm --filter @ship/web exec vitest run   # 192
pnpm type-check && pnpm lint && pnpm build
```

Raw evidence: `docs/audit/raw/cat6-w6-9-after-lane6b.json`.

## How to roll back

Every change is in E2E test files and one test-helper module; no production code
is involved, so rolling back cannot affect the running application — it only
restores the failing assertions.

```bash
git revert <this lane's commits>
# or, to drop just the helper additions:
git checkout <sha-before> -- e2e/fixtures/test-helpers.ts
```

If the W6-9 CRDT title is ever reverted, these tests keep passing: they assert
the title is saved, not how. That is the point.

## Rules checklist

| Rule | Status |
|---|---|
| 1 — before/after, identical conditions | Same command, same tree, same machine: 10 failed → 18 passed. W6-9 suite re-run, not extrapolated. |
| 2 — tests still pass | 502 api, 192 web, 18/18 target specs, full E2E diffed against `known-flakes.txt`. Changed tests justified above. |
| 3 — regression test | `e2e/title-persistence.spec.ts` asserts persistence independent of transport — the assertion the eight files should have had. |
| 4 — CI | Not in scope for this lane (lane-0 owns CI). |
| 5 — build/release/run | Unchanged. |
| 6 — one-command start | Unchanged. |
| 7 — retries/timeouts | Unchanged. Lane 6's heartbeat and breaker work is untouched. |
| 8 — dev docs | This file. |
| 9 — reasoning | Mechanism, the PATCH race, and the throttle tradeoff, above. |
| 10 — not cosmetic | Moves 10 failing tests to passing and cuts 14 min of timeout wall-clock. |
| 11 — commit discipline | Separate branch `lane-6b/backlinks-regression`. |
