# Lane 2 — Bundle Size

Category 2, brief p.3–4. Written for the next engineer who inherits this, per
Implementation Rule 8; reasoning and tradeoffs per Rule 9.

## Target and result

> 15% reduction in total production bundle size, **or** implement code splitting that
> reduces initial page load bundle by 20%. Provide before/after bundle analysis output.
> Removing functionality to shrink the bundle does not count. — p.4

Target B, met with room to spare.

| | Before | After | Change |
|---|---:|---:|---:|
| **Initial load (Target B)** | **2,144,744 B** | **385,118 B** | **−82.0%** |
| Initial load, gzipped | 599,789 B | 114,910 B | −80.8% |
| Entry chunk | 2,073,684 B | 65,893 B | −96.8% |
| Largest chunk | 2,073,684 B | 620,148 B | −70.1% |
| JS files in initial load | 1 | 4 | +3 |
| Total dist (Target A) | 3,431,950 B | 3,459,825 B | +0.8% |

Target B required ≤ 1,715,795 B. The result is 385,118 B — **77.6% below the
threshold.**

Nothing was removed. Every feature that worked before works after; the browser
verification below exercises each one.

## Reproducing the numbers

Both scripts, both sides, same commands, run back to back under
`scripts/measure-lock.sh` so no other lane's build was competing:

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

### Two measurement notes

- The frozen baseline records 3,431,964 B; the rebuild measured 3,431,950 B, a
  14 B difference. `web/` is byte-identical to the freeze commit `24bf639`
  (`git diff 24bf639..HEAD -- web/` was empty at that point). The delta is
  content-hash filename lengths inside `index.html`, not a code change.
- **Total dist went up 27,875 B (+0.8%), and that is expected.** Splitting one
  chunk into 300+ means per-chunk module wrappers, import statements and less
  cross-module minification. Target A and Target B pull in opposite directions
  and the brief asks for either; this lane chose B, see below.

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

*Effect:* initial load 2,144,744 → 362,169 B on its own.

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
  (362,169 → 385,118 B), from inter-chunk boilerplate and cross-module
  minification Rollup can no longer perform. Bought deliberately: 1.3% of the
  initial-load budget, still landing 77.6% under target, in exchange for cache
  granularity.
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

Reverting only `9a6996b` is safe and keeps most of the win (initial load returns
to 362,169 B). Reverting `56ed542` gives back the entire improvement — it is the
commit carrying the result.

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
