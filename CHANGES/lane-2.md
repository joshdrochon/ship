# Lane 2 — Bundle Size

Category 2, brief p.3–4. Written for the next engineer who inherits this, per
Implementation Rule 8; reasoning and tradeoffs per Rule 9.

## Target and result

> 15% reduction in total production bundle size, **or** implement code splitting that
> reduces initial page load bundle by 20%. Provide before/after bundle analysis output.
> Removing functionality to shrink the bundle does not count. — p.4

Target B, met with room to spare.

After-numbers below are re-measured on the integrated tree at `c432768`, not carried over
from this lane's own branch. See "Two eras of after-number" for why they differ slightly.

| | Before | After | Change |
|---|---:|---:|---:|
| **Initial load (Target B)** | **2,144,744 B** | **386,072 B** | **−82.0%** |
| Initial load, gzipped | 599,789 B | 115,465 B | −80.7% |
| Entry chunk | 2,073,684 B | 67,814 B | −96.7% |
| Largest chunk | 2,073,684 B | 476,475 B | −77.0% |
| Deferred JS | 176,747 B | 1,982,209 B | +1,021% |
| JS files in initial load | 1 | 4 | +3 |
| Total dist (Target A) | 3,431,950 B | 3,480,150 B | +1.4% |

Target B required ≤ 1,715,795 B. The result is 386,072 B — **77.5% below the
threshold.**

Nothing was removed. Every feature that worked before works after; the browser
verification below exercises each one.

## Reproducing the numbers

Both scripts, both sides, same commands:

```bash
docs/audit/scripts/measure-bundle.py            # total dist size
docs/audit/scripts/measure-initial-load.py      # initial-load size (Target B)
```

Committed output:

| | Before | After |
|---|---|---|
| Total | `docs/audit/raw/cat2-before-bundle.txt` / `.json` | `docs/audit/raw/cat2-after-bundle.txt` / `.json` |
| Initial load | `docs/audit/raw/cat2-before-initial-load.txt` / `.json` | `docs/audit/raw/cat2-after-initial-load.txt` / `.json` |

The before-numbers were taken on the frozen baseline tree and committed in
`ecc2b15` *before* any source change, so the pair is reconstructible from git
history alone.

### Why a second measurement script

`measure-bundle.py` sums everything in `web/dist`. That number is the right one
for Target A and the wrong one for Target B: **code splitting does not delete
bytes, it moves them off the critical path.** A lazy chunk still ships to the
CDN; it just is not downloaded before first paint. Measuring Target B with a
total-size tool would report roughly 0% for a change that cuts first load by
five sixths.

`docs/audit/scripts/measure-initial-load.py` reads the initial-load set off the
built `dist/index.html` the way a browser resolves it — the entry module script,
every `<link rel="modulepreload">` (Vite emits one per statically imported chunk,
i.e. the transitive static closure of the entry), and every stylesheet. Chunks
reachable only through `import()` are absent from `index.html` by construction,
which is exactly the deferred set. No hand-maintained list to drift.

### Measurement lock

The before-numbers were taken holding `scripts/measure-lock.sh` (acquired in 0s,
machine quiet).

The after-numbers were not, and deliberately so. Six lanes share this machine;
at after-measurement time load average was 10–24 on 10 cores and `lane-3` held
the lock continuously for over an hour, re-acquiring it faster than a queued
waiter could take it. Two things follow:

1. **The lock serialises builds, and this measurement did not build.** `web/dist`
   was already the artifact of the committed tree — `git status` clean, dist
   newer than every file in `web/src`, `web/vite.config.ts` and
   `web/package.json`, and all 353 files sharing one mtime. Both scripts were run
   with `--no-build`, which only stats and gzips existing files. It consumed no
   build CPU and could not perturb another lane's in-flight benchmark.
2. **Bundle size is load-independent anyway.** The lock exists so that
   latency-style benchmarks are not measuring machine load. A byte count is
   deterministic: the same source produces the same bytes whether the machine is
   idle or at load 24. Rule 1's "identical conditions" is satisfied here by
   identical source, identical build command and identical measurement script,
   none of which the load average touches.

Rebuilding under the lock would have produced the same integers at the cost of
adding CPU pressure to a machine that was already corrupting other lanes'
results.

That last claim was then checked rather than asserted. The final `pnpm build`
gate rebuilt `web/` from scratch at load ~15 and emitted **the same content
hashes** — `vendor-react-DTmS2JJb`, `vendor-syntax-CJAzNMSb`,
`vendor-emoji-CKpDoWoY`, `vendor-editor-cnFZDnyj` — and re-measuring gave
`total 3465762 / initial 385118 / entry 65893`, identical to the digit *on this
lane's tree*. Two builds of the same source, wildly different machine load,
byte-identical output. That is the claim the paragraph supports, and it does not
extend to trees with different source in them — see below.

### Two eras of after-number

`385,118 / 65,893` are this lane's numbers, measured on the lane branch. The
integrated tree at `c432768` measures **`386,072 / 67,814`**, and the difference
is not measurement noise: other lanes landed after `9a6996b`, and
`git diff --stat 9a6996b..c432768 -- web/` is **96 files, +2,108 / −509**. Lane 1's
narrowing helper, lane 6's `useCollaborativeTitle` and `syncStatus`, and lane 7's
Tailwind token split all ship in the entry and route chunks.

The vendor chunk hashes are unchanged — `vendor-react-DTmS2JJb`,
`vendor-editor-cnFZDnyj`, `vendor-query-_oxqrmmt`, `vendor-router-Jb59XTrA` are
byte-for-byte what this lane produced — which is exactly what the grouping is
supposed to do: application churn does not invalidate library chunks. The entry
chunk is the one that moved, `index-B8T7TWoG` → `index-CU9fwwxk`, +1,921 B.

Where a number in this file describes an intermediate configuration measured on
the lane branch (`362,169 B`, the `+22,949 B` grouping cost), it is left at the
lane-branch value, because both halves of those comparisons were taken there.
Mixing an old before with a new after would not measure anything.

### Two measurement notes

- The frozen baseline records 3,431,964 B; the rebuild measured 3,431,950 B, a
  14 B difference. `web/` is byte-identical to the freeze commit `24bf639`
  (`git diff 24bf639..HEAD -- web/` was empty at that point). The delta is
  content-hash filename lengths inside `index.html`, not a code change.
- **Total dist went up 48,200 B (+1.4%) on the integrated tree, and that is
  expected.** Splitting one chunk into 300+ means per-chunk module wrappers,
  import statements and less cross-module minification. Vite also now emits a
  second, per-chunk stylesheet (`PropertyRow-*.css`, 1,410 B) alongside the main
  one. On the lane branch alone the rise was 33,812 B (+1.0%); the extra 14,388 B
  is the other lanes' source, not this change. Target A and Target B pull in
  opposite directions and the brief asks for either; this lane chose B, see below.
- The reported after-numbers come from a clean `pnpm build:web` on `c432768`,
  then both scripts with `--no-build`. This lane's own after-measurement was taken
  with `--no-build` against the `web/dist` that `9a6996b` produced; all 353 files
  in it shared a single mtime, so it was one clean build of the committed tree with
  no stale artifacts. See "Measurement lock" below for why that one was not rebuilt.

## Why Target B rather than Target A

Target A needs 514,781 B off a dist that is 2,250,431 B of JS and 1,065,895 B of
`.png`. Getting there means deleting roughly a quarter of all application
JavaScript. There is no way to do that without removing features, which p.4
rules out explicitly. The audit's suggestion that lazy-loading
`emoji-picker-react` (8.5%) and `highlight.js` (8.1%) "clears Target A on its own"
does not hold: making a module lazy changes which chunk holds it, not whether it
is built. Both are still in `dist` after this work — 270,700 B and 172,210 B
respectively — they are simply no longer downloaded on first paint.

Target B is also the honest description of the actual defect. The baseline
initial load was **one 2,073,684 B chunk**: 92.1% of all JS, and the build had
been printing `Some chunks are larger than 500 kB after minification` on every
run. A user opening `/login` downloaded TipTap, ProseMirror, Yjs, y-websocket,
emoji-picker-react and highlight.js in order to render an email field.

## What changed

Four commits, each independently revertible.

### 1. `ecc2b15` — measurement first

Added `measure-initial-load.py` and committed the before-numbers before touching
any source.

### 2. `56ed542` — route-level code splitting

`web/src/main.tsx`. All 23 page components were static imports, so Rollup had one
entry with no dynamic boundary above the page layer. Each is now
`React.lazy(() => import(...))` with one `React.Suspense` above the route tree.

*Why better:* route boundaries are where user intent is already expressed — they
navigated somewhere, so the fetch is paid for by a navigation they asked for. It
needs no manual chunk assignment and cannot drift: a new page added to `main.tsx`
is lazy by construction. The 13 lazy document-tab chunks in `lib/document-tabs.tsx`
show the pattern was already understood here, it had just never been applied at
the route layer.

*Tradeoffs:* one round trip per route on first visit, over an already-warm HTTP/2
connection, cached after. The Suspense fallback is the same centered "Loading..."
that `PublicRoute` and `ProtectedRoute` already render while auth resolves, so a
chunk fetch is visually indistinguishable from the auth check that follows it.
The boundary sits above the route tree rather than per-route, so a nested chunk
(`UnifiedDocumentPage` inside `AppLayout`) always has a parent to suspend against.

*Effect:* initial load 2,144,744 → 362,169 B on its own. This is the commit that
carries the result.

### 3. `b7cd517` — emoji-picker-react behind its open handler

`web/src/components/EmojiPicker.tsx` imported the library at module scope while
only rendering it behind `{isOpen && ...}`. The library moved to
`EmojiPickerPanel.tsx` reached via `React.lazy`; what remains in `EmojiPicker.tsx`
is an `import type`, erased at build time, so no runtime edge to the library
survives.

*Why better:* the dynamic boundary now sits exactly where the `isOpen` guard
already was. Extracting a module rather than casting types at the call site keeps
`Theme.DARK` a real enum reference — an `as` cast would have added a type-safety
violation to Lane 1's count for no benefit here.

*Tradeoffs:* first open shows a 300×350 "Loading emoji..." placeholder, sized to
the picker so the popover does not resize under the cursor. One extra file.

*Effect:* 270,700 B chunk, deferred. Its only caller is the project icon control,
which most sessions never touch.

### 4. `9a6996b` — vendor chunk grouping

`web/vite.config.ts` had no `build.rollupOptions` block at all. Added a
`manualChunks` function grouping seven library clusters: `vendor-syntax`
(highlight.js + lowlight), `vendor-emoji`, `vendor-editor` (@tiptap +
prosemirror), `vendor-collab` (yjs + y-\* + lib0), `vendor-react`, `vendor-router`,
`vendor-query`.

*Why better:* route splitting alone left every editor-bearing route sharing one
836,570 B chunk that Rollup had named after an arbitrary member module
("PropertyRow"). Editing one TipTap extension invalidated ProseMirror, Yjs and
highlight.js in every user's cache along with it. Grouping by library gives cache
lifetimes that match change rates. It also gives highlight.js the separate
boundary the audit asked for, and it silences the >500 kB warning legitimately
rather than by raising `chunkSizeWarningLimit`.

*Tradeoffs:*

- **+22,949 B raw / +9,944 B gzip on initial load** versus route splitting alone
  (362,169 → 385,118 B, both halves measured on the lane branch), from inter-chunk
  boilerplate and cross-module minification Rollup can no longer perform. Bought
  deliberately: 1.3% of the initial-load budget, still landing 77.5% under target
  on the integrated tree, in exchange for cache granularity.
- `vendor-react` / `vendor-router` / `vendor-query` look removable — they are in
  the initial load either way — but removing them is measurably wrong. React is
  imported by both the entry and by modules inside `vendor-editor`. Left unnamed,
  Rollup resolves that shared ownership by folding React *into* `vendor-editor`,
  which promotes `vendor-editor` to a static dependency of the entry and drags all
  of TipTap back into the initial load: **940,969 B, 2.4× worse.** Measured both
  ways; recorded in a config comment so it does not get "simplified" back.
- `react`/`react-dom`/`scheduler` are deliberately in one group. Splitting them
  apart is the usual source of `Cannot access X before initialization` from a
  cycle between emitted chunks.
- Grouping by path substring is string matching against `node_modules` paths. It
  degrades safely: an unmatched library falls through to Rollup's default chunking.

*Effect:* largest chunk 836,570 → 476,475 B (`vendor-editor`), 20.9% of all JS on
the lane branch and 20.7% on the integrated tree — where the old entry chunk was
92.1%. `vendor-editor` is byte-identical across both. The >500 kB build warning
is gone.

> Correction: the body of commit `9a6996b` says "largest chunk 836,570 B ->
> 620,148 B". 620,148 B was `vendor-editor` in the intermediate configuration
> that omitted the `vendor-react` group — the one measured and rejected two
> bullets up. In the configuration actually committed it is 476,475 B, as the
> same commit's `vendor-editor 476,475 B` line says. The committed number is
> right; the "largest chunk" line in that message is not.

## Verification: every lazy boundary actually loads

A chunk that never loads is a broken feature, not a saving. The production build
was served with `vite preview` against a real API and database and driven in a
real browser.

| Route / action | Chunks fetched | Result |
|---|---|---|
| `/login` | entry + `vendor-react` + `vendor-query` + `vendor-router` + `Login` | No editor, syntax or emoji chunk. Login succeeded. |
| Login → `/docs` | `+ App`, `+ Documents` | Document tree rendered. |
| Open a wiki document | `+ UnifiedDocumentPage`, `+ vendor-editor`, `+ vendor-collab`, `+ vendor-syntax` | Editor mounted; IndexedDB synced; WebSocket connected and synced. |
| Type a ```js code block | (already loaded) | 6 `hljs-` token spans rendered: `hljs-keyword => const`, `hljs-number => 42`, `hljs-title function_ => go`, `hljs-string => "hi"`. highlight.js works from the deferred chunk. |
| Project → Details tab | `vendor-emoji` still **not** fetched | Confirms it is genuinely deferred. |
| Click the project icon | `+ EmojiPickerPanel`, `+ vendor-emoji` | Picker mounted, 49 emoji rendered, "Search emoji..." placeholder present, fallback gone. |

Automated gates: `pnpm build`, `pnpm --filter @ship/web exec vitest run`
(152/152), `pnpm type-check`, `pnpm lint` (0 errors) — all pass.

## How to run, test, and roll back

```bash
# Build and measure
pnpm build:web
docs/audit/scripts/measure-initial-load.py --no-build
docs/audit/scripts/measure-bundle.py --no-build

# Test
pnpm --filter @ship/web exec vitest run
pnpm type-check && pnpm lint

# See the split in a real browser
pnpm build:web && pnpm --filter @ship/web exec vite preview --port 4173
# then watch the network panel while navigating
```

**Rollback.** Each commit is independent and reverts cleanly:

```bash
git revert 9a6996b   # vendor grouping only — back to one 836 kB shared chunk
git revert b7cd517   # emoji picker becomes eager again
git revert 56ed542   # all routes eager again; restores the single 2 MB chunk
```

Reverting only `9a6996b` is safe and keeps most of the win (initial load returned
to 362,169 B when measured on the lane branch; expect roughly 23 kB below the
current 386,072 B, not that exact figure). Reverting `56ed542` gives back the
entire improvement — it is the commit carrying the result.

**What to watch after deploy.** The failure mode of code splitting is a chunk
404 after a redeploy, when a client holding an old `index.html` requests a hashed
chunk that no longer exists. Keep at least one previous build's `assets/` in the
S3 bucket rather than syncing with `--delete`, or a user mid-session gets a blank
route. This is not new to this change — the 13 document-tab chunks already had
this property — but it now applies to every route.

## Findings that did not become changes

**`@tanstack/react-query-devtools` costs nothing in production.** The audit flags
it as sitting in production `dependencies`, which is true, and it is imported and
rendered unconditionally in `main.tsx`, which is also true. It still contributes
~0 bytes: the package's own entry is

```js
var ReactQueryDevtools2 = process.env.NODE_ENV !== "development"
  ? function () { return null; }
  : Devtools.ReactQueryDevtools;
```

Vite substitutes `process.env.NODE_ENV` with `"production"`, so Rollup shakes the
real panel out. Verified by building both ways: **3,459,812 B with the static
import vs 3,459,825 B with a dev-only dynamic import** — a 13 B difference, i.e.
hash noise. The dev-only version was written and then reverted, because
Implementation Rule 10 bars changes that do not move a measured number.

**`@tanstack/query-sync-storage-persister` is reported as an unused dependency**
by `measure-bundle.py` in both the before and after runs. It is referenced
indirectly through `@/lib/queryClient`, so the script's source-text scan misses
it. Not a real finding, and not touched — removing a dependency is out of scope
for this lane.

## Blocked / out of scope

**Setting a project emoji fails with HTTP 400, and it is a pre-existing API bug.**
Found while verifying the emoji picker. The picker itself works end to end — the
click handler fires and issues `PATCH /api/documents/:id` with the emoji, which is
the proof the lazy boundary is intact; a broken boundary would send no request at
all. The API rejects it: `updateDocumentSchema` in `api/src/routes/documents.ts`
accepts `color` but has no `emoji` field, so Zod rejects the body. `emoji` is only
handled by `api/src/routes/projects.ts`, which this call does not go through.

Untouched for two reasons: `api/` is outside this lane's boundary, and
`git diff 24bf639..HEAD -- api/` is empty, so it is not a regression from this
work. It wants a one-line schema addition from whoever owns the API.
