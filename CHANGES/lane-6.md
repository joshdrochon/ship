# Lane 6 — Runtime Error and Edge Case Handling

Category 6 of the ShipShape audit. Written for the next engineer: what changed,
how to run it, how to test it, how to roll it back (Rule 8), plus the reasoning
and tradeoffs behind each change (Rule 9).

Target, brief p.7:

> Fix 3 error handling gaps. At least one must involve a real user-facing data loss
> or confusion scenario (not just a missing loading spinner). Each fix requires
> reproduction steps, before/after behavior, and a screenshot or recording.

Plus Rule 7 (p.9), assessed across three surfaces.

## Summary

| | Gap | Severity | Measured before | Measured after | Commit |
|---|---|---|---|---|---|
| 1 | **W6-9** — a concurrent title edit destroys the other user's typing | critical, **data loss** | both edits survived **0 of 5** runs | **5 of 5** | `fe41fa1` |
| 2 | **W6-1** — six top-level routes have no error boundary | high | **6 of 6** routes blank, **0** recovery paths | **0** blank, **6** recovery paths | `6f45133` |
| 3 | **W6-5** — the sync badge misreports a dead collaboration socket | medium, **confusion** | badge says "Cached" while nothing saves | badge says "Offline" | `8e7af24` |
| — | Rule 7 — retries, timeouts, breakers on 3 surfaces | — | see below | see below | `6ee1638` |

Suites after all four commits: `pnpm test` **502 passed**, `pnpm --filter @ship/web
exec vitest run` **192 passed**, `pnpm type-check` / `pnpm lint` / `pnpm build`
all clean.

## How to run and test any of this

```bash
# app (finds free ports, writes .ports — do not use ./start.sh in a worktree,
# it pins 5173/3000 and will collide with another lane)
pnpm dev

# unit tests. `pnpm test` TRUNCATES the dev database (api/src/test/setup.ts:14),
# so reseed before taking any browser measurement
pnpm test && pnpm db:seed
pnpm --filter @ship/web exec vitest run

# just this lane's tests
pnpm --filter @ship/api  exec vitest run src/collaboration/documentTitle.test.ts \
                                          src/services/circuitBreaker.test.ts \
                                          src/db/client-resilience.test.ts
pnpm --filter @ship/web  exec vitest run src/hooks/useCollaborativeTitle.test.tsx \
                                          src/lib/syncStatus.test.ts \
                                          src/hooks/useRealtimeEvents.test.ts \
                                          src/main.test.tsx
```

All measurement scripts take `BASE`, `API` and `DOC_ID` from the environment. Get a
document id after seeding:

```sql
select id from documents where document_type = 'wiki' and title = 'Project Overview';
```

---

## Gap 1 — W6-9: a concurrent title edit destroys the other user's typing

**The mandatory data-loss gap.** Severity: critical. Silent, unrecoverable,
user-facing data loss on the most visible field of a document, in an application
whose stated purpose is real-time collaboration.

### Reproduction

1. `pnpm dev`, then open the same wiki document as two different users in two
   browser profiles — `dev@ship.local` and `alice.chen@ship.local`, password
   `admin123`. Two profiles, not two tabs: one session shares a Yjs client id and
   never exercises the merge path.
2. Press Escape to clear the action-items modal that auto-opens (W6-6).
3. Click into the large document title in both windows.
4. Type in both at the same time — user A types `AAAAAAAA`, user B types `BBBBBBBB`.
5. Wait five seconds for the debounced save.

Scripted, five runs, aggregated:

```bash
BASE=http://localhost:5174 API=http://localhost:3001 DOC_ID=<wiki uuid> RUNS=5 \
  node docs/audit/scripts/measure-concurrent-edit-suite.mjs \
    --out docs/audit/raw/cat6-w6-9-after.json --label after
```

Screenshots:

```bash
BASE=... API=... DOC_ID=... \
  node docs/audit/scripts/capture-w6-9.mjs --label after --outdir docs/audit/evidence/w6-9
```

### Before / after

| Metric (5 runs, same document, same seed) | Before | After |
|---|---:|---:|
| Runs where both users' characters survived | **0 / 5** | **5 / 5** |
| Runs where one user's edit was destroyed | **5 / 5** | **0 / 5** |
| Runs where both clients converged | 5 / 5 | 5 / 5 |
| Runs where the pre-existing title text was intact | 5 / 5 | 5 / 5 |
| Runs showing any conflict or overwrite warning | 0 / 5 | n/a — nothing to warn about |

Behaviour, in words:

- **Before** — the server ends up with `Concurrent EdiBBBBBBBBt Test`. User A's
  eight characters are gone. Both clients then converge on B's value, so A watches
  their own typing disappear from their own screen with no explanation, and the
  status indicator never says otherwise: in the screenshot it reads a blue
  **"Cached"**. `claimsWorkIsSafe` (`web/src/lib/syncStatus.ts:82-84`) classes
  "Cached" alongside "Saved" as a state that tells the user their work is safe, so
  either word is the same lie here. Nothing on screen marks the loss.
  `docs/audit/evidence/w6-9/w6-9-before-user-A.png`
- **After** — the server ends up with `Concurrent EdiABABABABABABABABt Test`. All
  eight of A's characters and all eight of B's are present, both clients and the
  server agree on the same string, and the pre-existing title text is untouched.
  The badge reads a green **"Saved"** and both users' avatars are in the header.
  `docs/audit/evidence/w6-9/w6-9-after-user-A.png`

Raw: `docs/audit/raw/cat6-w6-9-before.json`, `cat6-w6-9-after.json`.

### What changed, and why the original was suboptimal

Ship stored a document's two editable fields two different ways. The body was
TipTap bound to a Yjs CRDT over the collaboration WebSocket and merged two writers
correctly. The title was plain React state saved by a debounced
`PATCH /api/documents/:id` (`Editor.tsx:187`), and **nothing reconciled two
writers** — the last request to land overwrote the whole column. Which user lost
was not even deterministic. Fourteen concurrent title runs are on record — nine in
`docs/audit/raw/cat6-concurrent-raw.json`, five in `cat6-w6-9-before.json` — and
not one of them preserved both edits. Counting the `lost_edit_of` field across
them: A's characters were destroyed in 11 runs, B's in 6, with three runs
destroying part of each. Identical inputs, different victim.

The mechanism for doing this properly was already in the codebase. The title
simply did not use it.

| File | Change |
|---|---|
| `web/src/lib/yTextDiff.ts` | new. Diffs a controlled field's whole new value down to the single contiguous span that changed, and applies it as insert/delete on a `Y.Text`. |
| `web/src/hooks/useCollaborativeTitle.ts` | new. Backs the title with `ydoc.getText('title')`, mirrors it into React state, preserves the caret across remote edits, and keeps a REST fallback for when no collaboration session exists. |
| `web/src/components/Editor.tsx` | uses the hook instead of `useState` + `onTitleChange`. |
| `api/src/collaboration/documentTitle.ts` | new. Server half: seed the shared type from the column, reconcile on load, read it back for persistence, replace it for REST renames. Pure Y.Doc functions, no DB or socket. |
| `api/src/collaboration/index.ts` | `getOrCreateDoc` reconciles the title at room creation; `persistDocument` writes it with `title = COALESCE($5, title)`; new export `applyTitleToRoom`. |
| `api/src/routes/{documents,issues,projects,programs,weeks}.ts` | call `applyTitleToRoom` after a REST title change. |

**The diff matters.** A controlled `<textarea>` only ever hands you the whole new
string. Writing that whole string into the CRDT (delete-all + insert-all) makes
every keystroke a full overwrite, and two writers still cannot merge. Diffing to
the span that actually changed is what gives Yjs the per-character intent it needs.
A common-prefix/common-suffix diff is exact for this input, because a controlled
text field produces exactly one contiguous edit per change event.

**Seeding is server-side and happens once.** `reconcileTitleOnLoad` runs in
`getOrCreateDoc`, before any client has synced and before the doc's `update`
listener is attached — the server is the only writer at that instant. Two clients
seeding the same string concurrently would leave Yjs holding both copies
("TitleTitle").

**Two bugs found while building this, both now covered by tests:**

1. A REST rename made while nobody had the document open was silently reverted. The
   room reloaded its title from `yjs_state`, which was older than the column, and
   the next debounced persist wrote the stale value back. Fixed by
   `reconcileTitleOnLoad`: when the two disagree and the column holds a real title,
   **the column wins**, because REST is the only writer that touches the column
   without touching `yjs_state`. A column reading `Untitled` or empty never
   overrides a CRDT title, so a title typed in the editor cannot be blanked by a
   row that was never renamed.
2. A rename made while the document *was* open would have been undone the same way.
   Fixed by `applyTitleToRoom`, called from all five REST routes that write
   `documents.title` for a collaboratively edited type.

**The measurement harness was wrong too, and was corrected.** Its title verdict
asked whether the server string *contained* each user's typed run. That is the same
mistake the script's own body test already documents in a comment: a correct merge
**interleaves** two simultaneous streams, so the contiguous run is gone even though
every character survived — the fixed title reads `…EdiTTiittlleeFFrroommBAt Test`,
which fails a `contains` check while losing nothing. The verdict is now the body
test's criterion applied to the title (count each user's characters), the note is
recorded in `measure-concurrent-edit.mjs`, and **both** the before and after
figures above were produced with the corrected script.

### Why this approach over the alternatives

| Option | Verdict |
|---|---|
| **Merge the title as a CRDT** | **Chosen.** The only option where neither user loses text. Reuses the mechanism the body already has. |
| Make the title write win (`updated_at` precondition, or last-write-wins with a version check) | Rejected. Moves which edit is lost; one user still loses their typing. |
| Overwrite and show a conflict warning | Rejected. Better to read, but still destroys text. For a 100-character field, keeping every character wins. |
| Lock the title while another user is editing it | Rejected. Adds a lock-holder-vanishes failure mode to a field people edit for two seconds at a time. |

### Tradeoffs

- **The saved title is an interleaving of both writers** (`ABABABAB`), which reads
  oddly. It loses nothing, which is the point. Two people renaming the same
  document simultaneously is rare; silently destroying one of them was not
  acceptable at any frequency.
- **Caret handling on remote edits is approximate.** A remote insert shifts the
  caret by the length delta rather than mapping it through the CRDT position, so a
  remote edit landing at the same instant can move it by a character.
- **With no collaboration session the title persists only via the REST fallback**,
  and once a session has existed the title lives in the CRDT and IndexedDB until
  the socket returns. That is exactly the guarantee the body has always had, and
  the badge now tells the user (gap 3) instead of showing a state that claims the
  work is safe.
- **A typed title can duplicate in one narrow window**: type into the title in the
  few hundred milliseconds between mount and first sync, on a document whose server
  title differs from the one the page was rendered with. The value is replayed onto
  the synced base, so nothing is lost, but the two can concatenate.
- **W6-2 is unchanged and still broken.** Clearing the title still does not stick:
  `readTitleFromDoc` returns null for an empty title and `COALESCE` leaves the
  column alone. That was pre-existing behaviour, it is not one of this lane's three
  gaps, and making an empty title persist is a product decision (does the sidebar
  show a blank row?) rather than a bug fix.

### Regression tests (Rule 3)

- `web/src/hooks/useCollaborativeTitle.test.tsx` — 16 tests. The one that would
  have caught it: two hook instances against two Y.Docs wired together the way the
  collaboration server wires two browsers, both typing before either update lands,
  asserting no character is lost and all three views converge. Also covers
  different-position edits, remote renames, the `Untitled` placeholder, and both
  REST-fallback paths.
- `api/src/collaboration/documentTitle.test.ts` — 19 tests: seed/reconcile/read/
  replace, the two-writer merge as the server sees it, order independence, and the
  rename regression described above.

Both are pure Y.Doc operations — no network, no database, stable in CI.

### Rollback

Revert `fe41fa1`. Nothing to undo in the database: the title column is still the
source of truth for every read path, and `yjs_state` carrying an extra `title`
shared type is inert to code that does not look for it. Documents edited while the
fix was live keep whatever title the merge produced.

---

## Gap 2 — W6-1: six top-level routes have no error boundary

Severity: high. A render error on any of these unmounted the tree to a blank white
page with no recovery path. The public feedback route and the login page are the
worst of them — both are reachable by people who cannot be told to "try
refreshing".

### Reproduction

The app has nothing that throws on demand, so the reproduction injects a throw and
removes it again:

```bash
node docs/audit/scripts/inject-render-error.mjs --apply    # gates a throw on ?__boom
BASE=http://localhost:5174 node docs/audit/scripts/capture-w6-1.mjs \
  --label after --outdir docs/audit/evidence/w6-1
node docs/audit/scripts/inject-render-error.mjs --revert   # restores byte-for-byte
```

Manually: with the injection applied, visit `http://localhost:5174/login?__boom`.

The injector edits the six page files in place and keeps a `.w6-1-bak` beside each
one. `--revert` restores them exactly; `git status` must be clean for those files
afterwards. The injected state is never committed.

### Before / after

| Metric (6 routes, same injected throw) | Before | After |
|---|---:|---:|
| Routes where the throw actually rendered | 6 / 6 | 6 / 6 |
| Blank white pages | **6** | **0** |
| Routes offering a recovery path | **0** | **6** |

The six: `/feedback/:programId` (public, unauthenticated), `/login`, `/setup`,
`/invite/:token`, `/admin`, `/admin/workspaces/:id`.

- **Before** — `#root` contains zero characters of text. No message, no button, no
  link. `docs/audit/evidence/w6-1/w6-1-before-login.png`
- **After** — a centred `role="alert"` panel: "This page failed to load", an
  explanation that saved work is unaffected, and two actions — "Reload the page"
  and "Go to sign-in". `docs/audit/evidence/w6-1/w6-1-after-login.png`

Raw: `docs/audit/evidence/w6-1/w6-1-{before,after}.json`.

### What changed, and why the original was suboptimal

The app had two boundaries — `AppLayout` (`App.tsx:541`) and the document editor
(`Editor.tsx:980`) — and both sit under the `/` route. Everything routed outside it
was uncovered.

- `web/src/components/ui/RouteErrorBoundary.tsx` — new.
- `web/src/main.tsx` — wraps the two route *elements*, exports `App`, and only
  calls `createRoot` when `#root` exists.

The boundaries go on the route elements rather than on the six pages because that
also covers `WorkspaceProvider`, `AuthProvider` and `RealtimeEventsProvider`, which
wrap `AppRoutes`. A throw in `AuthProvider` white-screened the app just as
thoroughly as one in `LoginPage`, and a per-page boundary would sit below it.

Guarding `createRoot` is what lets the regression test mount the real route tree.
A test against a duplicated `<Routes>` would keep passing if someone removed the
boundaries from the app.

### Why not reuse the existing `ErrorBoundary`

Its fallback offers "Try Again", which re-renders the same broken subtree —
reasonable for an editor panel, useless for a route whose own render threw. It also
renders as a flex child expecting surrounding chrome. Both boundaries are kept: the
inner one still handles panel-level errors, this one is the backstop.

### Tradeoffs

- **One boundary per route element, not per page.** An error in any of the five
  routes under `/*` replaces that whole element. There is nothing else on screen to
  preserve at that point, and it buys coverage of the providers.
- **"Reload the page" is `window.location.reload`, and "Go to sign-in" is a plain
  `<a>`.** The router lives inside the subtree that just threw, so navigating
  within it can rethrow immediately.
- **No stack trace in the fallback.** `/feedback/:programId` is public, so the
  fallback is read by people outside the organisation. Detail goes to the console.

### Regression test (Rule 3)

`web/src/main.test.tsx` — 7 tests. Imports the real `App` from `main.tsx`, mocks
each of the six pages to throw, and asserts a `role="alert"` fallback with both
recovery affordances at each of the six paths. **Verified to fail on the pre-fix
`main.tsx`** (7 of 7) and pass after.

### Rollback

Revert `6f45133`. No data or schema involvement. Removing it restores the blank
page behaviour; nothing else depends on the boundary.

---

## Gap 3 — W6-5: the sync badge misreports a dead collaboration socket

Severity: medium, and squarely the "confusion" case p.7 asks for: the user is told
their work is saved while it is not being saved at all.

### The audit's version of W6-5 does not reproduce — recorded, not quietly dropped

W6-5 as written says the offline indicator was still visible after the network
returned (`ui_recovered_after_reconnect: false`). Re-measured, that specific claim
is an artefact of the harness. The audit's probe was a page-wide
`text=/offline|disconnected/i` locator, and the same harness typed the marker
`OFFLINE-EDIT-<ts>` into the document title — which renders in the `h1`, the
textarea and the sidebar tree. **The probe was matching the marker the harness
itself typed.**

`measure-reconnect-ui.mjs` runs the same offline/online cycle twice, once with the
audit's marker and once with a neutral one, and evaluates both probes:

| Probe | Audit marker (`OFFLINE-EDIT-…`) | Neutral marker (`EDIT-…`) |
|---|---|---|
| Page-wide `/offline\|disconnected/` | never clears | clears in 7 ms |
| Editor's own sync badge | clears in 512 ms | clears in 510 ms |

Re-running the audit's own harness reproduces `false` exactly, and
`docs/audit/raw/cat6-before-lane6.json` records it — the number in the audit report
is reproducible, its interpretation is not.

The same harness re-run after all four commits is `docs/audit/raw/cat6-after-lane6.json`.
`ui_recovered_after_reconnect` is still `false` there, for the reason above: it is the
probe that is wrong, not the app. What did move is the console sweep over the same 11
routes — **40 entries before, 4 after** — and the offline cycle's `console_delta`, 11 → 3.
The four that remain are the `/login` 401 and three entries produced by the deliberate
offline step, all of them the same failed backlinks fetch seen at three levels
(`requestfailed`, the browser's resource error, and `BacklinksPanel.tsx:41`'s own catch).

### The defect that is actually there

Leave the browser online and sever the collaboration socket — a server restart, a
deploy, an idle load-balancer timeout, or the reconnect loop the audit recorded as
W6-10 — and the badge reads **"Cached"**, in blue, while everything typed into the
document body fails to reach the server. Nothing tells the user.

`cached` was the *startup* state, meaning "showing content from the local cache
while the socket comes up". It was being reused for a socket that dropped **after**
a successful sync, which is a completely different situation: the first is harmless,
the second means the user's work is going nowhere. Same root as the audit's W6-10
observation that the indicator "reads Saved the entire time" through a reconnect
loop — the state was set once per event and never reconciled against whether the
socket was actually up.

### Reproduction

1. `pnpm dev`, open a wiki document, wait for the badge to read "Saved".
2. Sever the collaboration WebSocket while leaving the browser online. Restarting
   the API process does it; the script uses Playwright's `routeWebSocket` to close
   every `/collaboration/**` connection and keep them closed.
3. Type into the document body. Wait ten seconds.
4. Read the badge, and check `GET /api/documents/:id` for the text you typed.

```bash
BASE=http://localhost:5174 API=http://localhost:3001 DOC_ID=<wiki uuid> \
  node docs/audit/scripts/measure-reconnect-ui.mjs --label after \
    --outdir docs/audit/evidence/w6-5
```

### Before / after

Phase 2 — browser online, socket severed for 12 s:

| Metric | Before | After |
|---|---|---|
| Badge while severed | **"Cached"** (blue) | **"Offline"** (red) |
| Typed text reached the server | false | false |
| Badge claims saved while not saving | **true** | **false** |

Phase 1 — the audit's offline/online cycle:

| Metric | Before | After |
|---|---:|---:|
| Page-wide probe, audit marker | stale | stale (harness artefact, both sides) |
| Page-wide probe, neutral marker | 7 ms | 4 ms |
| Editor badge recovered | 512 ms | 3 ms |
| Offline edit survived | true | true |

Screenshot: `docs/audit/evidence/w6-5/w6-5-after-phase2-severed.png` — badge
"Offline", body text present on screen, server does not have it.
Raw: `docs/audit/evidence/w6-5/w6-5-{before,after}.json`.

### What changed

| File | Change |
|---|---|
| `web/src/lib/syncStatus.ts` | new. The indicator's decisions as pure functions. After the first successful connection a drop is reported as a disconnection, never as `cached`. Before it, `cached` is still used, where it is accurate. |
| `web/src/components/Editor.tsx` | uses those functions; tracks whether this document's socket has ever connected (`hasSyncedRef`, reset per document); forces one immediate reconnect when the browser reports `online`; adds a tooltip and a `data-sync-state` attribute. |

The forced reconnect is also a Rule 7 retry improvement: y-websocket retries on its
own exponential backoff (up to 2.5 s per attempt) and does not watch for the
browser coming back, so a blip could leave the document unsynced for seconds after
the network was fine. It respects `shouldConnect`, so a socket closed deliberately
(access revoked, document converted) is not reopened.

### Why not new wording

"Reconnecting" or "Not saving" would read better than "Offline" for a dead socket
on a live network. The accessibility suite and five E2E specs assert on
`/Saved|Cached|Saving|Offline/`, and a new word would fail them for no gain in
honesty: from the document's point of view it *is* offline. The nuance goes in the
tooltip, which now explains that changes are kept on this device.

### Tradeoffs

- **"Offline" now appears while the browser is online**, which reads oddly for a
  second. Being told you are disconnected when you are is better than being told
  your work is saved when it is not.
- **A socket that dies without a close frame is still reported as connected** until
  y-websocket's 30 s message timeout fires. That is y-websocket's detection window,
  not this indicator's; closing it would mean a client heartbeat of our own.
- **The forced reconnect can fire while y-websocket is mid-retry**, costing one
  redundant connection attempt.
- **W6-10 is not fixed.** The module-level `Map` state that makes collaboration
  degrade after the first session per API process is a larger change and was
  deliberately deferred by the audit. The badge now tells the truth while it
  happens, which is a mitigation, not a fix.

### Regression test (Rule 3)

`web/src/lib/syncStatus.test.ts` — 12 tests. The one that would have caught it:
after a synced socket drops, the resulting state must not be one that claims the
work is safe, **for either value of `hasCachedContent`**. The pre-fix logic
returned `cached` there whenever an IndexedDB cache existed, which is almost
always.

### Rollback

Revert `8e7af24`. Purely presentational plus one reconnect trigger; no data or
schema involvement.

---

## Rule 7 — retries, timeouts and circuit breakers

> Assess the existing codebase for missing retry logic, hardcoded timeouts, and
> missing circuit breaker patterns on outbound service calls (database, WebSocket,
> external APIs). Add or improve these where gaps are found. Document each change
> with the failure mode it protects against.

Commit `6ee1638`. Every row below names the failure mode it protects against.

### Surface 1 — database (`api/src/db/client.ts`)

Already present and adequate: `max` (20 prod / 10 dev), `idleTimeoutMillis` 30 s,
`connectionTimeoutMillis` 2 s, `maxUses` 7500, `statement_timeout` 30 s. Four gaps.

| Change | Failure mode it protects against |
|---|---|
| `pool.on('error')` handler | **The API process dying.** node-postgres emits `error` on the *pool* for errors on idle clients — a PostgreSQL restart, an RDS failover, an operator running `pg_terminate_backend`. An unhandled `error` event on an EventEmitter is rethrown as an uncaught exception, so any of those took the process down, even though the pool's own recovery (discard the client, open a fresh one) is exactly right. |
| `query_timeout: 30_000` | **A half-open TCP connection hanging an HTTP request forever.** `statement_timeout` is enforced by PostgreSQL and does nothing if the server never answers at all. `query_timeout` is client-side, and is what unblocks a request whose connection was dropped without a FIN by a NAT or load balancer. |
| `keepAlive` + 10 s initial delay | **An intermediary killing idle pooled connections.** RDS Proxy or a NAT table eviction closes an idle flow; without keepalives the kernel does not notice and the dead connection is handed to the next request. |
| Bounded retry on connection establishment, wrapping `pool.query` | **A PostgreSQL restart or brief connection-limit exhaustion becoming a burst of HTTP 500s** for requests that would have succeeded 200 ms later. 3 attempts, exponential backoff with jitter, ~700 ms worst case. |
| Circuit breaker | **Assessed, deliberately not added.** There is no degraded mode for this API without its own database, so a breaker converts "some requests fail" into "all requests fail" and adds a stuck-open breaker to debug. Failing fast is already covered by the 2 s connect timeout, `max` bounding the queue, and the capped retry. Reason recorded in the file so the absence is a decision. |

The retry is **deliberately narrow**. It fires only for errors where the statement
provably never reached the server: `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`,
`ETIMEDOUT`, `57P03` (cannot_connect_now), `53300` (too_many_connections),
`08001`/`08004`/`08006`, and pg-pool's "timeout exceeded when trying to connect".
`ECONNRESET` and `57014` are **not** retried: `pool.query` cannot tell "the write
never ran" from "the write committed and then the socket broke", so a blanket retry
would risk applying a document update twice. Statement-level retry belongs at the
call site, where idempotence is known.

It is applied by wrapping `pool.query` rather than by editing call sites, because
there are several hundred of them.

### Surface 2 — WebSocket

| Change | Failure mode it protects against |
|---|---|
| Server heartbeat on both WebSocket servers (`api/src/collaboration/index.ts`) | **Half-open sockets accumulating forever.** A laptop lid, dropped Wi-Fi or a NAT eviction leaves `readyState` OPEN with no `close` event, so the connection is never removed from `conns`, every document update is written into a socket nobody reads, and awareness cleanup — which only runs in the `close` handler — never happens. That is the ghost-cursor symptom users see. A client missing two 30 s pings is terminated, which fires `close` and runs the existing cleanup. |
| `/events` reconnect: capped exponential backoff with jitter, 1 s → 30 s, reset on a good connection (`web/src/hooks/useRealtimeEvents.tsx`) | **A client reconnect storm tripping the server's own limiter and delaying recovery.** The old delay was a flat 3000 ms forever with no jitter — 20 attempts a minute per tab against `MAX_CONNECTIONS_PER_IP = 30`. Two tabs rate-limited the user against their own workspace during an outage, the resulting 429s counted as further attempts, and an office behind one NAT address did it to everyone at once. |
| Collaboration socket client retry | Covered by the eager reconnect in gap 3: y-websocket has backoff but does not watch for the browser coming back online. |

Not changed, and why: the per-IP connection limit and per-connection message limit
already in `RATE_LIMIT` are the inbound-abuse controls and were adequate. The
collaboration server has no circuit breaker because it has no outbound dependency
other than PostgreSQL, which is covered above.

### Surface 3 — AWS Bedrock (`api/src/services/ai-analysis.ts`)

The only third-party call in the request path. It had **no timeout, no retry and no
breaker**; Lane 0 flagged it rather than touching it.

| Change | Failure mode it protects against |
|---|---|
| `connectionTimeout: 3_000` | **An endpoint that accepts a TCP connection and never completes the handshake**, holding an Express handler open until the client gives up — and holding whatever else that request has acquired. |
| `requestTimeout: 20_000` | **A model call that starts and stalls.** 2048 `max_tokens` on Opus finishes well inside 20 s; past that it is not coming. |
| `maxAttempts: 3` | **A single throttled (429) or 5xx response.** Bounded, because the caller is a UI poll — retrying forever turns one slow analysis into a queue of them. |
| Circuit breaker: 5 consecutive failures, 60 s cooldown, single-flight half-open probe (`api/src/services/circuitBreaker.ts`) | **A Bedrock outage, an expired role, or no AWS credentials at all.** W6-8 recorded 15 `CredentialsProviderError` rejections in one local session — one per weekly plan or retro page load, each paying full credential-chain resolution and logging an unhandled rejection. The breaker turns those into an immediate `ai_unavailable`, which the UI already knows how to render. |

The breaker is ~40 lines in-repo rather than a new dependency, because dependency
changes are out of scope for this lane. Handler options are passed as a plain
object rather than a `NodeHttpHandler` instance, so no `@smithy/*` import is added
— it is a transitive dependency here and must not become a direct one.

### Rule 7 tests (Rule 3 — stable fakes, no live external calls)

- `api/src/services/circuitBreaker.test.ts` — 10 tests with an injected clock, so
  nothing waits out a 60 s cooldown. Covers open/half-open/closed transitions, the
  single-flight probe, and re-opening for a full cooldown when the probe fails.
- `api/src/db/client-resilience.test.ts` — 22 tests pinning the retry predicate,
  including every code that must **not** be retried. This is the guard against
  someone widening it later and turning a safe retry into a double-write.
- `web/src/hooks/useRealtimeEvents.test.ts` — 5 tests, including cumulative
  reconnect attempts inside a 60 s window measured against the server's own 30/min
  limit.

### Side effect worth recording

Re-running the Category 6 harness over the edge-case suite after these changes:

| Metric | Before | After |
|---|---:|---:|
| Client console entries across the edge-case suite | **40** | **4** |
| Console delta during the offline/reconnect cycle | 11 | 3 |
| Console entries during normal navigation (11 routes) | 0 | 0 |

Most of that noise was collaboration reconnect failures. Raw:
`docs/audit/raw/cat6-{before,after}-lane6.json`.

### Rollback

Revert `6ee1638`. All four surfaces return to their previous behaviour. The
database changes are the ones to watch: reverting reintroduces the process-crash
path on idle-client errors, so prefer reverting the retry wrapper alone
(`pool.query = ...`) over the whole commit if something misbehaves.

---

## Measurement scripts added or changed

| Script | Purpose |
|---|---|
| `docs/audit/scripts/measure-concurrent-edit.mjs` | **changed** — title verdict corrected from a substring check to a character count, with the note recorded in the file. |
| `docs/audit/scripts/measure-concurrent-edit-suite.mjs` | **new** — runs the above N times in fresh browsers and aggregates the verdict fields. W6-9's headline is a ratio over runs, and each run needs fresh Yjs client ids. |
| `docs/audit/scripts/capture-w6-9.mjs` | **new** — two-user title edit, self-describing screenshots with the counts in the caption. |
| `docs/audit/scripts/measure-reconnect-ui.mjs` | **new** — W6-5, three phases: the audit's cycle with its own marker, the same with a neutral marker, and the severed-socket case. |
| `docs/audit/scripts/capture-w6-1.mjs` | **new** — visits the six unprotected routes with a render error injected, records blankness and recovery affordances. |
| `docs/audit/scripts/inject-render-error.mjs` | **new** — applies and reverts that injection. |

## Follow-up — type-safety cleanup of this lane's own new code

Commit `refactor(types): remove all 15 type-safety violations this lane
introduced`. Category 1's target is a 25% reduction in type-safety
violations (brief p.3), and p.11 scores TypeScript quality on new code. In a
three-lane merge rehearsal this lane's new code contributed **15 violations**,
which pushed the merged total two over Lane 1's ceiling. Cleaned up here rather
than absorbed by Lane 1: they are mine, and a circuit breaker written with `any`
loses the p.11 points regardless of anyone else's count.

Measured with the canonical script, same command both sides:

```bash
python3 docs/audit/scripts/count-type-violations.py            # totals
python3 docs/audit/scripts/count-type-violations.py --by-file  # per file
```

| | Before | After |
|---|---:|---:|
| Repository total | **1023** | **1008** |
| `any` | 261 | 258 |
| `as` | 436 | 429 |
| `!` | 325 | 320 |
| Files with any violation | 147 | 143 |

**−15, all of them this lane's.** Per file:

| File | This lane's violations before | After |
|---|---:|---:|
| `api/src/db/client.ts` | 6 | **0** |
| `api/src/collaboration/documentTitle.test.ts` | 4 | **0** |
| `web/src/hooks/useRealtimeEvents.test.ts` | 2 | **0** |
| `api/src/services/circuitBreaker.ts` | 1 | **0** |
| `api/src/routes/issues.ts` | 1 | **0** (file 45 → 44) |
| `api/src/routes/projects.ts` | 1 | **0** (file 50 → 49) |

Nothing outside those six files was touched.

### What changed, and why the original was worse

**`api/src/db/client.ts` — a typed database surface replaces an `as any` monkey
patch.** The Rule 7 connection retry had to reach every call site, and the first
version got there by reassigning `pool.query`. `Pool['query']` is eight overloads
deep, so the wrapper could only be attached through `as any` — four `any`s and two
invented shape assertions (`err as { code?: string }`) in the one module every
route imports, buying no safety at all.

Replaced with a declared `Database` interface covering the three methods this
codebase actually uses — `query` (1310 call sites), `connect` (14) and `end` —
implemented as ordinary typed code over a private `Pool`. Error inspection is a
real narrowing helper (`typeof err === 'object' && 'code' in err`, then a `typeof`
check on the value) instead of asserting a shape onto `unknown`.

This closed a genuine gap on the way: **the old patch wrapped `query` only, so the
14 `pool.connect()` transaction sites had no retry.** They do now.

**`api/src/services/circuitBreaker.ts` — `this.openedAt!` removed by making the
null check narrow.** `run()` read the `state` getter and then re-read `openedAt`,
which the compiler could not connect, hence the assertion. It is now one private
`evaluate()` returning a discriminated union, with `retryAfterMs` present only on
the `open` branch. That also fixes a latent bug the assertion was hiding: state and
remaining-cooldown were read in two separate calls, so the clock could tick between
them and the two could disagree.

**`api/src/routes/issues.ts`** — `applyTitleToRoom(id!, …)`: `id` is already
`string` from `String(req.params.id)` twenty lines up. The assertion was pure noise;
removed.

**`api/src/routes/projects.ts`** — `applyTitleToRoom(id as string, …)`: here
`req.params.id` really is `string | string[]`, so the assertion was hiding a case.
Replaced with `typeof id === 'string'`, which is both honest and correct — a
repeated parameter would previously have reached the room lookup as an array.

**`api/src/collaboration/documentTitle.test.ts`** — `(a as unknown as { clientID:
number })` was unnecessary: `Y.Doc.clientID` is a plain public field, so `a.clientID
= 1` compiles. `relayed[0]!` became a `for…of` over the array, which the preceding
length assertion makes meaningful. One more was a false positive — the counter's
`as` pattern matched the prose "left as REST set it" in a test name, reworded.

**`web/src/hooks/useRealtimeEvents.test.ts`** — `windows[i]!.min` became a running
minimum walked in the loop. Same assertion (each window's floor strictly above the
previous), no index access.

### One `any` deliberately kept, and why

`QueryRunner.query` declares `<R extends QueryResultRow = any>`, mirroring
`@types/pg`'s own default. It carries the file's single remaining
`no-explicit-any` **lint warning** at `client.ts:158`, left visible rather than
suppressed with a disable comment.

It is load-bearing. Tightening the default to `QueryResultRow` makes
`result.rows[0].column` a "possibly undefined" error at every untyped call site —
**728 errors, measured, across ~40 files this lane does not own**. The fix for that
is per-query row types, one call site at a time, behind the same generic parameter
this signature already exposes. That is Lane 1-scale work, not a cleanup pass.

Note that the counter does not score `= any` in a default type argument, so this
one does not appear in the 1008. Flagging it explicitly so the number is not read
as cleaner than it is.

### Tradeoffs

- **`pool` is now a plain object implementing `Database`, not a `Pool` instance.**
  Anything reaching for a `Pool` member outside `query`/`connect`/`end`
  (`totalCount`, the callback forms, a `QueryConfig` object) will fail to compile
  until it is added to the interface with a type. That is the intended pressure —
  it was verified that nothing does today — but it is a real constraint on future
  code, and the interface comment says so.
- **The retry now also covers `pool.connect()`.** Better coverage, but a
  transaction that fails to acquire a client now takes up to ~700 ms longer to
  report failure.

### Verification

`pnpm test` **502 passed**, `pnpm --filter @ship/web exec vitest run` **192
passed**, `pnpm type-check` **exit 0**, `pnpm lint` **0 errors** (264 warnings, one
of them the deliberate `any` above), `pnpm build` **exit 0**. Behaviour tests are
unchanged — the same 502 and 192 as before the cleanup, which is the point: this
was a typing change, not a behaviour change.

### Rollback

Revert the `refactor(types)` commit. It restores the `as any` patch and the six assertions; Rule 7
behaviour is unaffected either way, except that reverting also drops the retry from
the 14 `pool.connect()` sites again.

## Not done, and why

- **W6-10** (collaboration stops working after the first session per API process,
  while the UI still reports "Saved") — the more serious of the two collaboration
  findings, and out of scope for this lane by the audit's own deliberate deferral.
  It is module-level `Map` state that cannot be shared across processes, so the fix
  is architectural. Gap 3 makes it visible to the user instead of silent.
- **W6-2** (clearing the title silently reverts it) — displaced by W6-9 as the
  data-loss gap. Unchanged; see the tradeoffs under gap 1.
- **W6-3** (a 100,000-character title is accepted), **W6-4** (a null byte returns
  500), **W6-6** (the auto-opening modal traps interaction), **W6-7** (no loading
  state under 3G) — not among the three, and W6-7 is explicitly excluded by p.7.
- **E2E suite** — not run for this lane. The changed status labels are unchanged
  strings by design, and the specs asserting on them were read before the change,
  but the suite itself was not executed.
