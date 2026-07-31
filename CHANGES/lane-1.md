# Lane 1 — Type Safety

Developer documentation for Category 1 (Implementation Rule 8, p.9). Separate from
`CHANGES.md`, which other lanes are writing concurrently.

Branch: `lane-1/type-safety` · branch point `2fbc5a4`, which is `24bf639` plus the frozen
baseline doc.

## Result

Target from the brief (p.3): eliminate 25% of type safety violations — at most **756**.

```
docs/audit/scripts/count-type-violations.py
```

| | any | as | ! | @ts | Total |
|---|---:|---:|---:|---:|---:|
| **Before** api | 232 | 143 | 288 | 0 | 663 |
| **Before** web | 26 | 286 | 33 | 1 | 346 |
| **Before total** | 258 | 429 | 321 | 1 | **1009** |
| **After** api | 231 | 139 | 47 | 0 | 417 |
| **After** web | 26 | 267 | 33 | 1 | 327 |
| **After total** | 257 | 406 | 80 | 1 | **744** |

**265 eliminated · 26.3% · 12 under the 756 ceiling.**

Before-numbers are the frozen baseline in `docs/audit/raw/phase2-baseline.md`, not
re-derived. The after-number is the same script, same machine, run at the end of the lane.

Per work unit, each measured after its own commit:

| Unit | Scope | Before | After | Commit |
|---|---|---:|---:|---|
| 1.1 | `AuthenticatedRequest` across `api/src` | 1009 | 775 | `f3f8513` |
| 1.4 | `ProjectDetailsTab.tsx` | 775 | 756 | `68936b3` |
| 1.6 | `extractHypothesis.ts` | 756 | 744 | `e118d70` |

Unit 1.1 removed 234 (233 `!` plus one `any` in a test stub) against its estimate of 231.
Unit 1.7 (`routes/weeks.ts`, held in reserve) was not needed.

## Gate results

| Check | Command | Result |
|---|---|---|
| api unit tests | `pnpm test` | 461 / 461 (was 451; 10 regression tests added) |
| web unit tests | `pnpm --filter @ship/web exec vitest run` | 174 / 174 (was 152; 22 added) |
| type-check | `pnpm type-check` | exit 0 |
| lint | `pnpm lint` | exit 0 — 263 warnings, unchanged from baseline |
| build | `pnpm build` | exit 0 |

`pnpm test` truncates the dev database (`api/src/test/setup.ts:14`). `pnpm db:seed` was run
after every unit run.

---

## W1-4 — the errors `web/tsconfig.json` hides: 102 → 111

This lane did not touch `web/tsconfig.json`, and the headline number does not cover what that
file conceals. This section quantifies it, because W1-4 was recorded in the audit report as a
finding and then never given a number.

`web/tsconfig.json` has no `extends`. It redeclares its compiler options from scratch and so
misses three the root config sets: `noUncheckedIndexedAccess`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`. `api/` and `shared/` inherit them.

### Measurement

A temporary config **outside the repo tree** extends `web/tsconfig.json` and adds only those
three flags. `web/tsconfig.json` itself was not modified and nothing was left in the repo.

```jsonc
{
  "extends": "<tree>/web/tsconfig.json",
  "compilerOptions": {
    "typeRoots": ["<tree>/web/node_modules/@types", "<tree>/node_modules/@types"],
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

```bash
cd <tree>/web && node_modules/.bin/tsc -p <temp-config> --noEmit --pretty false
```

`typeRoots` has to be pinned. TypeScript resolves automatic `@types` inclusion from the
directory of the config being *run*, not the one being extended, so a config outside the repo
otherwise loses `@types/node` and `@types/react` and reports ~16 phantom TS2307/TS2304 errors.
That was the first result this measurement produced and it was wrong; pinning `typeRoots`
removes all of them. Both trees were then re-run from scratch.

The HEAD run was taken in a shared worktree carrying other agents' uncommitted `web/src` edits,
so `c432768` was also exported clean with `git archive` and both runs repeated against it. The
error set came back byte-identical — 111 is a property of the commit, not of the working tree.

Full method and raw `tsc` output: `docs/audit/raw/cat1-w1-4-web-strict-flags.txt`.

### Result

| | baseline `767aa2f` | HEAD `c432768` | delta |
|---|---:|---:|---:|
| Control — `web/tsconfig.json` exactly as shipped | 0 | 0 | 0 |
| With the three root flags applied | **102** | **111** | **+9** |
| Category 1 headline violation count | 1,009 | 741 | −268 |

Both error counts were verified two ways (`grep -c "error TS"` and an anchored
`^file(line,col): error TSnnnn` match) and agree. The control run at 0 proves all 111 are
attributable to the three flags and nothing else.

By flag, at HEAD:

| Flag | Errors | Codes |
|---|---:|---|
| `noUncheckedIndexedAccess` | 103 | TS2532 (42), TS18048 (34), TS2345 (13), TS2322 (13), TS18047 (1) |
| `noImplicitReturns` | 8 | TS7030 |
| `noFallthroughCasesInSwitch` | 0 | — |

### What it means

**The hidden count went up while the headline went down.** The lane eliminated 268 counted
violations and the number of errors `web/tsconfig.json` suppresses grew by 9 over the same
interval. Those are not contradictory results, they are two different surfaces: the counter is
a source-text grep for `any` / `as` / `!` / `@ts`, and these are compiler errors that no
committed config ever asks for. Neither one can see the other. The 26.3% reduction is real; it
simply does not reach here.

**Where the +9 came from.** All nine are in a single file that did not exist at baseline —
`web/src/styles/a11y-invariants.test.ts`, added by the accessibility lane (`63c031c`). A full
per-file diff of the two error sets produces exactly one line of difference: that file. No
pre-existing file gained or lost a hidden error during Phase 2.

**The part that matters more than the +9:**

| | baseline | HEAD |
|---|---:|---:|
| Hidden errors in production files | 95 | 95 |
| Hidden errors in test files | 7 | 16 |

The production figure did not move at all. Phase 2 removed 268 counted violations from this
codebase and zero of the 95 unchecked-index errors sitting in `web/`'s production code. Every
new `web/` file written during Phase 2 was also written under the weaker ruleset, which is how
the number grows without anyone doing anything wrong — the growth is a property of the missing
`extends`, not of the code being added.

Five files hold 61 of the 111: `CommandPalette.tsx` (13), `lib/cn.ts` (12), `useSelection.ts`
(12), `editor/CommentDisplay.tsx` (12), `editor/AIScoringDisplay.tsx` (12).

### Why `web/tsconfig.json` was not changed here

Three reasons, in order of weight.

1. **It is not this lane's file and the change is not free.** Adding `extends` turns a passing
   `pnpm type-check` into 111 errors. The lane's gate (`pnpm type-check` exit 0) would fail on
   the commit that makes the change and stay failing until all 111 are resolved — so it is not
   a config edit, it is a config edit plus 111 fixes, in files three other lanes were editing
   concurrently.
2. **Implementation Rule 1 requires before/after under identical conditions.** Changing the
   compiler settings mid-lane changes what "identical conditions" means for every other
   measurement taken against `web/`.
3. **Rule 10 rules out cosmetic edits.** Silencing 103 index errors with `!` or `?? ''` to make
   the flag pass would satisfy the compiler and remove exactly zero of the risk, while inflating
   the very `!` count Category 1 measures. Doing it properly means reading each site.

### Would it be safe and small to fix? Partly — and one third of it is free today

Not one change. Three, with very different costs.

| Flag | Errors | Assessment |
|---|---:|---|
| `noFallthroughCasesInSwitch` | 0 | **Free. Enable it now.** No errors in either tree. Pure future protection, zero cost, zero risk. |
| `noImplicitReturns` | 8 | **Half an hour for 5 of them, care needed on 3.** |
| `noUncheckedIndexedAccess` | 103 | **Real work — roughly 1–2 days.** This is the one with substance. |

The 8 TS7030 split two ways, and the split is the flag doing its job:

- **5 are `useEffect` callbacks** that return a cleanup on one branch and nothing on another
  (`ResizableImage.tsx:40`, `SessionTimeoutModal.tsx:33`, `InlineWeekSelector.tsx:43` and `:56`,
  `TeamMode.tsx:513`). One `return undefined;` each, behaviour-identical — React already treats
  both as no cleanup.
- **3 are not.** `AIScoringDisplay.tsx:78` and `:99` are ProseMirror `doc.descendants`
  callbacks, where the return value is control flow: `false` means "do not descend into this
  node's children", and both callbacks *do* return `false` on one path (`:85`, `:106`) while
  falling off the end on another. `EmojiExtension.ts:148` is an input-rule handler returning
  `null` on one path and nothing on another. Blanket-adding `return undefined` there would be a
  guess about intended traversal behaviour. These need reading.

The 103 index errors are likewise not uniform:

- **Provably safe, TypeScript just cannot narrow it.** All 12 in `lib/cn.ts` are this:
  `hex[0..2]` is guarded by `if (hex.length === 3)` and `match[1..3]` by `if (match)` on a regex
  with three capture groups. Neither can be undefined at runtime; the compiler cannot see it.
  Cheapest to clear (destructure, or one guard), and no behaviour changes.
  *(An earlier draft of this section called `cn.ts` a live bug. It is not — the length check is
  right there on line 18.)*
- **Genuinely unguarded.** `useSelection.ts:146`, `:150`, `:155` read `itemIds[0]` when the list
  may be empty and assign the result to a variable declared `string | null`. On an empty list —
  a filtered view with no matches — the focused id becomes `undefined` rather than `null`. Minor,
  but it is exactly the case the flag exists to surface, and it is invisible today.
- **Noise from a `Record` lookup.** `CommandPalette.tsx`'s 10 `groupedDocuments.<type>` errors
  are one populated-by-construction record; a single `?? []` clears two at a time.

Recommended sequencing, if someone picks this up: `noFallthroughCasesInSwitch` plus the 5
trivial `useEffect` returns in a first commit, which is genuinely small. The 3 control-flow
returns second, as a separate reviewed change. Then `noUncheckedIndexedAccess` as its own piece
of work, five files first for 61 of the 103. The end state is `web/tsconfig.json` extending the
root and carrying only the genuinely web-specific options (`jsx`, `lib`, `moduleResolution`,
`paths`), which is what stops the gap silently reopening.

**Not done in this lane.** Recorded, measured, and left to a deliberate decision rather than
made as a side effect of type-safety work.

### Note on 744 vs 741

This lane's own after-measurement was 744, taken at the end of the lane on its own branch. The
same counter at merged `main` (`c432768`) reports **741** — api 412, web 329. The 3-violation
difference is other lanes' work landing after this lane closed, not a re-measurement of it. The
lane's before/after pair above is the comparable one under Rule 1; 741 is the current state of
`main` and is the figure the W1-4 comparison above uses.

---

## Unit 1.1 — request identity: assertion to checked narrowing

**Files:** `api/src/middleware/auth.ts`, 21 route files under `api/src/routes/`, 4 test
files.

### What changed

Every authenticated handler reached for the caller's identity with a non-null assertion:

```ts
const userId = req.userId!;
const workspaceId = req.workspaceId!;
```

236 of them. `api/src/middleware/auth.ts` now exports:

| Export | Purpose |
|---|---|
| `AuthIdentity` | `Required<Pick<Express.Request, 'userId' \| 'workspaceId'>>` — derived from the Express augmentation so the two cannot drift |
| `AuthenticatedRequest<P, ResBody, ReqBody, ReqQuery>` | `Request & AuthIdentity`, generic over the Express request parameters |
| `isAuthenticated(req)` | type guard, `req is AuthenticatedRequest<...>` |
| `requireAuth(req)` | returns the request narrowed, or throws `MissingAuthContextError` |

Call sites became `const { userId, workspaceId } = requireAuth(req);`. The 40 inline uses
with no local binding read `requireAuth(req).userId`; the 6 with one already in scope use
the local.

### Why the original was suboptimal

The Express augmentation declares both fields optional, and that is correct — a request
that has not passed `authMiddleware` has neither. The assertion silenced that at every
call site without checking it. When the invariant is actually broken (a route mounted
without the middleware, the case the optionality exists to describe) the assertion
evaluates to `undefined`, and that `undefined` goes into a SQL parameter, where it reads
as "no rows" rather than as an error. A workspace-scoped query silently returning nothing
is the failure mode this hid.

### Why this approach is better

The identity is verified rather than asserted; the fields are genuinely `string`
afterwards; a wiring mistake fails loudly at the handler boundary. Both auth paths read
these from NOT NULL columns (`sessions.user_id` / `sessions.workspace_id`,
`api_tokens.user_id` / `api_tokens.workspace_id`), so the check never fires in normal
operation — it fires exactly when something is wrong.

### Tradeoffs

- Two `typeof` checks per handler. Immeasurable against the queries that follow.
- `requireAuth` throws rather than returning 401. The 401 is `authMiddleware`'s job;
  reaching `requireAuth` without an identity is a wiring bug, and a handler's catch block
  turning it into a 500 is the correct signal.
- Express's `RequestHandler` is contravariant in `req`, so a handler **cannot** simply be
  annotated `(req: AuthenticatedRequest, ...)` — TypeScript rejects it with TS2769. This
  was tested before committing to the design. Narrowing inside the handler is what
  actually typechecks.
- Four test files stubbed the whole auth module with `vi.mock(..., () => ({ authMiddleware }))`
  and so dropped `requireAuth`. They now use `importOriginal` and stub only
  `authMiddleware`, which means they exercise the real narrowing instead of a stub of it.

### Regression tests

`api/src/__tests__/auth.test.ts`, `describe('requireAuth / isAuthenticated')` — 4 cases.
The second fails against the pre-fix code, where the assertion produced `undefined`
instead of throwing.

---

## Unit 1.4 — ProjectDetailsTab: 19 assertions to runtime readers

**Files:** `web/src/lib/document-fields.ts` (new), `web/src/lib/document-fields.test.ts`
(new), `web/src/components/document-tabs/ProjectDetailsTab.tsx`.

### What changed

`DocumentResponse` extends `Record<string, unknown>`, so every field beyond
`id`/`title`/`document_type` arrives as `unknown`. The component bridged that with 19 `as`
assertions. `document-fields.ts` replaces them with checked readers: `readString`,
`readStringOrNull`, `readNumberOrNull`, `readBooleanOrNull`, `readStringArray`,
`readFields`, `readField`, `readPersonRef`, `readBelongsTo`, plus the `isFields` guard.

Field types were read off the actual response literal in
`api/src/routes/documents.ts:325-361` and the schema, not guessed:

| Field | API produces |
|---|---|
| `impact` / `confidence` / `ease` | `props.*` — number or absent |
| `owner` | `{id,name,email} \| null`, from a LEFT JOIN |
| `owner_id` | `props.owner_id` |
| `accountable_id` | `props.accountable_id \|\| null` |
| `consulted_ids` / `informed_ids` | `props.* \|\| []` |
| `has_design_review` | `props.has_design_review ?? null` |
| `design_review_notes` | `props.design_review_notes \|\| null` |
| `belongs_to` | present only for issue / wiki / sprint / project |
| `converted_from_id` | nullable `documents` column |

### Why the original was suboptimal

The `unknown` is honest — `GET /api/documents/:id` flattens a JSONB `properties` column
onto the row, so which fields exist depends on `document_type`. The assertions did not
resolve that uncertainty, they only stopped the compiler mentioning it.
`document.consulted_ids as string[]` yields a `string[]`-typed value whatever is actually
there; a number in that array reaches a React `key` prop with no complaint anywhere. Two
assertions were also wrong about their own field: `accountable_id as string | undefined`
and `created_by as string | undefined`, against an API that returns
`props.accountable_id || null` and a nullable column.

### Why this approach is better

A malformed field produces the documented fallback rather than a value the render tree was
told to trust. `readNumberOrNull` additionally rejects `NaN` and `Infinity`, which the old
cast fed straight into `computeICEScore`.

### Tradeoffs

- Per-field function calls inside a `useMemo` instead of free compile-time casts. Runs
  once per document change, not on any hot path.
- `readPersonRef` requires `id` but tolerates a null `name` and `email`. Requiring all
  three would drop an owner whose person document has no matching user row, and only
  `owner?.id` is read downstream (`ProjectSidebar.tsx:192`) — checked before choosing.
- `readBelongsTo` validates `type` against `BelongsToType` and drops unknown values. The
  API only writes the four known relationship types, so nothing is lost today, and an
  unrecognised one would previously have been silently mistyped.
- `null` vs `undefined` shifts for `has_design_review`, `design_review_notes` and
  `accountable_id`. Every consumer uses `|| false`, `|| ''` or `=== user.id`, so behaviour
  is identical. Checked, not assumed.
- The readers are deliberately generic. `ProgramOverviewTab` and `WeekOverviewTab` carry
  9 assertions each from the same root cause and can reuse them — **not done here**, out
  of scope for this unit.

### Regression tests

`web/src/lib/document-fields.test.ts` — 22 cases, each feeding a reader the wrong runtime
type and asserting the fallback. Against the old assertions every one would have passed
the wrong value through.

---

## Unit 1.6 — extractHypothesis: validate the stored TipTap JSON

**Files:** `api/src/utils/extractHypothesis.ts`,
`api/src/__tests__/extractHypothesis.test.ts`.

### What changed

4 `as TipTapDoc` assertions and 8 `nodes[i]!` non-null assertions.

- `TipTapNode` now declares only what the format guarantees, `type: string`. `text`,
  `attrs` and `content` are `unknown`, narrowed at the point of use by `isRecord`,
  `childNodes` and `attr`.
- `topLevelNodes(content)` replaces the four `as TipTapDoc` + `type !== 'doc'` pairs with
  one guard that also drops non-node entries.
- `extractSection(nodes, title)` replaces four hand-rolled index scans with
  `findIndex`/`slice` — no indices, so no non-null assertions.
- `extractSuccessCriteriaFromContent`, `extractVisionFromContent` and
  `extractGoalsFromContent` were byte-for-byte identical apart from the heading string.
  They now delegate to `extractNamedSection`. That de-duplication is what removes 6 of the
  8 `!`, so it is not cosmetic — it is the fix. 307 lines to 216.

### Why the original was suboptimal

`documents.content` holds whatever the editor last wrote: it can be null (Yjs-only
documents), a doc from an older schema, or a node type since removed. `content as TipTapDoc`
declared `content?: TipTapNode[]` and `text?: string` for arbitrary stored JSON, and
nothing checked either. A null entry in the top-level array threw
`TypeError: Cannot read properties of null (reading 'type')`. A text node whose `text` came
back as an object concatenated `[object Object]` into the extracted plan. Both are
reproduced by the new tests against the pre-fix file.

### Tradeoffs

- `extractText` walks `childNodes(node)`, filtering on each descent — one extra array pass
  per node level. Documents are a few dozen nodes, and the function already runs on every
  collaboration save.
- `attr(node, 'level') === 2` keeps the original strict comparison, so a heading whose
  level arrives as `"2"` is still not an H2. Behaviour preserved deliberately rather than
  quietly widened; a test pins it.
- Merging the three extractors means a future divergence between Vision and Goals needs
  the shared helper split again. Given they were identical, the duplication was the larger
  risk.
- Non-node entries are dropped rather than failing the whole document. That is a change:
  a doc with one bad node previously threw, now it returns what it can. Extraction feeds a
  denormalised properties field, so partial output beats a 500.

### Regression tests

`api/src/__tests__/extractHypothesis.test.ts`, new `describe('malformed stored content')`
— 6 cases. Two fail against the pre-fix file, verified by restoring it and re-running: one
throws `TypeError`, one asserts `'Ship [object Object]it'`. The other four pin behaviour
that is preserved.

---

## How to run, test and roll back

```bash
# measure
docs/audit/scripts/count-type-violations.py
docs/audit/scripts/count-type-violations.py --by-file -n 20

# test
pnpm test                                      # api, 461
pnpm db:seed                                   # pnpm test truncates the database
pnpm --filter @ship/web exec vitest run        # web, 174
pnpm type-check && pnpm lint && pnpm build
```

Rollback is per unit, since each is one commit:

```bash
git revert e118d70   # unit 1.6, extractHypothesis
git revert 68936b3   # unit 1.4, ProjectDetailsTab + document-fields
git revert f3f8513   # unit 1.1, requireAuth
```

Reverting 1.1 alone is safe: nothing outside `api/src/middleware/auth.ts` and the route
files depends on `requireAuth`. Reverting 1.4 alone removes `web/src/lib/document-fields.ts`,
which only `ProjectDetailsTab` imports.

## Boundaries observed

- `web/src/components/UnifiedEditor.tsx` (26 `as`) and `api/src/utils/yjsConverter.ts`
  (16) untouched — Lane 6 owns them. Types were *read* from `UnifiedEditor.tsx`; nothing
  was written to it.
- No dependency change. `package.json` and `pnpm-lock.yaml` untouched.
- `terraform/` untouched.
- `CHANGES.md` untouched; this file is the lane's entry.

## Defects found and not fixed

Recorded rather than fixed, since they fall outside this lane.

1. **`api/src/routes/documents.ts:158-159`, `:223-224`, `:375-376`** use
   `String(req.userId)` instead of an assertion or a check. When `userId` is absent this
   produces the literal string `"undefined"`, which is then compared against a UUID column
   — a silent no-match rather than an error. The counter does not flag these (no `!`, no
   `as`), so unit 1.1 left them untouched, but they are the same latent bug with a worse
   disguise.
2. **`api/src/routes/api-tokens.ts:80` and `:180`** pass `workspaceId: req.workspaceId`
   (still `string | undefined`) to `logAuditEvent` on the line above a now-checked
   `requireAuth(req).userId`. Not a violation by the counter, so changing it would be a
   cosmetic edit under Rule 10, but the inconsistency is worth a follow-up.
3. **`web/src/components/sidebars/PropertiesPanel.tsx:463`** re-derives
   `document as { accountable_id?: string | null }` — the same assertion pattern unit 1.4
   removed from `ProjectDetailsTab`. It is one of that file's 23 remaining `as`, and the
   readers in `document-fields.ts` would cover it.

## Highest-value remaining targets

For whoever picks up Category 1 next, from
`docs/audit/scripts/count-type-violations.py --by-file`:

| File | Total | Nature |
|---|---:|---|
| `api/src/__tests__/transformIssueLinks.test.ts` | 37 | `any` in test fixtures |
| `api/src/routes/weeks.ts` | 35 | 25 `as`, 10 `any` |
| `api/src/services/accountability.test.ts` | 34 | `any` in test fixtures |
| `web/src/pages/UnifiedDocumentPage.tsx` | 32 | 31 `as` — same `DocumentResponse` root cause as unit 1.4 |
| `api/src/db/seed.ts` | 31 | 31 `!` |
| `web/src/components/sidebars/PropertiesPanel.tsx` | 23 | 23 `as`, same root cause as unit 1.4 |

The three `DocumentResponse` consumers (`UnifiedDocumentPage`, `PropertiesPanel`, and the
`ProgramOverviewTab` / `WeekOverviewTab` pair) total 71 assertions and all reduce to the
readers already added in `web/src/lib/document-fields.ts`.
