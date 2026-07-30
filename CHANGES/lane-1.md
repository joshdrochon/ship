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
