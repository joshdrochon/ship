# ShipShape Audit Report

Repository: `US-Department-of-the-Treasury/ship` @ `076a183`
Brief: GFA Week 4 — ShipShape (13 pp., sha256 `d385bcc4…`)
Machine for all measurements: Apple M1 Max · 64 GB · macOS 14.6.1 · Node v26.5.0 ·
PostgreSQL 16 (Docker) · pnpm 10.27.0

Per p.2, each category records (1) how it was measured, (2) concrete baseline numbers,
(3) the specific weaknesses found, and (4) severity. Per p.3, nothing is fixed here —
diagnosis only.

Findings carry `F#` identifiers from the register in
[`orientation-notes.md`](./orientation-notes.md).

p.10 asks this report to include *"methodology, tools used, and raw data."* Methodology is in
each category's **How it was measured** section; tools are the single-command scripts in
[`scripts/`](./scripts/); raw tool output is in [`raw/`](./raw/), indexed by category with a
note on what could not be captured and why.

## Status

| Cat | Name | Baseline | Canonical measurement |
|---|---|---|---|
| 1 | Type Safety | **complete** | `scripts/count-type-violations.py` |
| 2 | Bundle Size | **complete** | `scripts/measure-bundle.py` |
| 3 | API Response Time | **complete** | `scripts/bench-api.sh` |
| 4 | Database Query Efficiency | **complete** | `scripts/measure-queries.mjs` |
| 5 | Test Coverage and Quality | **complete** | `scripts/measure-tests.py` |
| 6 | Runtime Error and Edge Case Handling | **complete** | `scripts/measure-runtime-errors.mjs` |
| 7 | Accessibility Compliance | **complete** | `scripts/measure-a11y.py` |
| 8 | Terraform Plan Review | **complete** | `scripts/measure-terraform.py` |

Every completed category has a single-command measurement script, so Phase 2's before/after
runs under identical conditions as Implementation Rule 1 requires (p.9). Numbers quoted in
prose that a script later contradicted have been superseded and the discrepancy recorded.

---

## Measurement prerequisite — seed volume

Category 3 (p.4) requires *"500+ documents, 100+ issues, 20+ users, 10+ sprints"* before
benchmarking, and permits *"pnpm db:seed or write your own seed script."*

`pnpm db:seed` alone falls short on two axes. Measured directly against the database:

| | after `pnpm db:seed` | required | after augmentation |
|---|---|---|---|
| documents | 257 | 500+ | **600** |
| issues | 104 | 100+ | **170** |
| users | 11 | 20+ | **25** |
| sprints | 35 | 10+ | 35 |

A second problem the counts hide: the stock seed leaves `issue`, `sprint`, `project` and
`person` bodies at the 51-byte empty-paragraph default. Only the weekly document types get
real prose. Benchmarking against 51-byte rows would measure an unrealistically cheap
workload.

`docs/audit/scripts/augment-seed.mjs` tops both up without modifying `api/src/db/seed.ts`.
It generates TipTap bodies with headings, prose, lists and code blocks, populates
type-appropriate `properties`, and creates `document_associations` rows so the batch loader
(F15) is actually exercised. Augmented rows are tagged
`properties->>'_audit_fixture' = 'true'` and deleted before re-insert, so the script is
idempotent — a second run returns identical counts.

Resulting body sizes:

```
issue          170 docs   avg 2,247 B
weekly_plan     85 docs   avg 2,972 B
weekly_retro    63 docs   avg 3,007 B
project         59 docs   avg 3,999 B
program         55 docs   avg 4,574 B
wiki            54 docs   avg 4,766 B
standup         53 docs   avg 4,336 B
sprint          35 docs   avg    51 B   <- untouched, stock seed
person          11 docs   avg    51 B   <- untouched, stock seed
```

Reproduce with `node docs/audit/scripts/augment-seed.mjs`.

---

## Category 2 — Bundle Size

### How it was measured

```bash
docs/audit/scripts/measure-bundle.py                     # canonical: build + measure
docs/audit/scripts/measure-bundle.py --no-build --json   # re-measure existing dist
npx vite-bundle-visualizer -o /tmp/bundle-treemap.html   # treemap (p.3)
```

> **Two figures corrected after scripting the measurement.** The first pass used
> `du -sh web/dist`, which reports **disk allocation** — 301 small files each rounded up to a
> block — and gave 4.5 MB. Actual content is **3,431,964 B**. The first pass also gzipped at
> the shell default (level 6) rather than maximum, overstating the compressed total by
> ~8 kB. The script is now canonical; these numbers supersede the earlier ones.

Byte attribution comes from the visualizer's embedded `nodeParts`/`nodeMetas` data
aggregated by npm package. `source-map-explorer` was tried first and rejected — it errored
with *"source map refers to generated column Infinity"* against Vite 7's output.

One caveat on the attribution figures: rollup reports `renderedLength`, which is
post-tree-shaking but **pre-minification**. Those numbers are valid for proportions between
packages, not as shipped byte counts. Shipped sizes come from the build output and `gzip`.

Dependency usage was cross-referenced by grepping all 44 declared `dependencies` against
`web/src`, `index.html`, and the vite/tailwind/postcss configs, then confirming presence or
absence in the built bundle.

### Baseline

| Metric | Value |
|---|---|
| Total production bundle size | **3,431,964 B** (3.43 MB) across 301 files |
| — JavaScript | 2,250,445 B raw across 261 files |
| — CSS | 66,512 B, 1 file |
| — PNG assets | 1,065,895 B across 31 files |
| — **JS + CSS gzipped** | **697,270 B** (gzip -9) |
| Largest chunk | `index-C2vAyoQ1.js` — 2,073,698 B raw / **585,796 B gzip** (92.1% of all JS) |
| Number of chunks | 261 JS files; 1 dominant, 13 route-tab splits, ~246 icon stubs |
| Top 3 largest dependencies | `emoji-picker-react` 8.5% · `highlight.js` 8.1% · `yjs` 5.7% |
| Unused dependencies identified | 1 — `@tanstack/query-sync-storage-persister` |

Composition of the main chunk:

```
web/src (app code)      28.2%      1,352,745 B
emoji-picker-react       8.5%        409,191 B
highlight.js             8.1%        387,008 B
yjs                      5.7%        271,286 B
prosemirror-view         5.0%        242,005 B
@tiptap/core             3.9%        185,562 B
react-dom                2.8%        134,906 B
prosemirror-model        2.6%        124,149 B
@uswds/uswds             2.4%        114,331 B
lib0                     2.3%        109,087 B
```

`index-C2vAyoQ1.js` alone is **92% of all shipped JavaScript**. The next largest chunk is
`ProgramWeeksTab` at 16.76 kB.

### Weaknesses

**W2-1 · No chunking strategy at all.** `web/vite.config.ts` contains no `manualChunks`, no
`rollupOptions`, and no `chunkSizeWarningLimit`. Vite's own build output flags it:
*"Some chunks are larger than 500 kB after minification."* The 13 dynamic imports that do
exist (`web/src/lib/document-tabs.tsx`) split document **tabs**, not routes — so every
route pays for every other route's code. **Severity: high.** This is the single lever that
reaches p.4's alternative target of *"code splitting that reduces initial page load bundle
by 20%."*

**W2-2 · `emoji-picker-react` is eagerly loaded — 409,191 B, 8.5%.** Imported statically in
one file. Most sessions never open an emoji picker. A `React.lazy` boundary removes it from
the initial payload outright. **Severity: high** — largest single-dependency win, and no
functionality is lost, which matters because p.4 says *"Removing functionality to shrink the
bundle does not count."*

**W2-3 · The full `highlight.js` common language set is registered — 387,008 B, 8.1%.**
`web/src/components/Editor.tsx:46` calls `createLowlight(common)`, which pulls ~35 language
grammars plus `lowlight`'s own 94,131 B. Registering only the languages the product
actually renders keeps syntax highlighting intact at a fraction of the cost.
**Severity: high.**

**W2-4 · One unused dependency, but it is worth zero bundle bytes.**
`@tanstack/query-sync-storage-persister` appears in `web/package.json:25` and nowhere else —
not in `web/src`, not in any config, and confirmed absent from the built output. The app
hand-rolls its own persister in `web/src/lib/queryClient.ts` on `idb-keyval`, importing only
the `Persister` *type* from `@tanstack/react-query-persist-client`. Removing it cleans up
install and `pnpm audit` surface but does not move the bundle.
**Severity: low.** Recorded because p.4 asks for it, not because it helps the target.

**W2-5 · 1,065,895 B of PNG — 31% of `dist/` — is never counted as "bundle."** 31 files.
Outside the JS budget but inside what a browser fetches. **Severity: low** — p.3 scopes this
category to *"the size of the production frontend bundle,"* so these assets sit outside the
improvement target and are not on the critical path. Recorded because a 4.5 MB `dist/` where a
quarter is unoptimised imagery is a real user-facing cost even when it is out of scope here.

### What this means for the improvement target

p.4 sets the bar at *"15% reduction in total production bundle size, or implement code
splitting that reduces initial page load bundle by 20%."*

W2-2 and W2-3 together are ~16.6% of the main chunk before any route splitting, so the
15% path is reachable without touching architecture. W2-1 is the larger and more defensible
win but carries more regression risk against the 869-test E2E suite.

Correction worth recording: `@tanstack/react-query-devtools` is imported unconditionally at
`web/src/main.tsx:6` and rendered at `:265`, which looks like dev tooling shipping to
production. It is not a real finding — the package ships a production no-op and tree-shakes
to **57 bytes** in the built output. Verified against the bundle rather than assumed.

---

## Category 1 — Type Safety

### How it was measured

`docs/audit/scripts/count-type-violations.py` — line-hit counts across `api/src`, `web/src`
and `shared/src`, all `.ts` and `.tsx`.

```bash
docs/audit/scripts/count-type-violations.py             # totals by package
docs/audit/scripts/count-type-violations.py --by-file   # ranked per file
```

Counting rules, stated because they change the number:

- **Lines, not occurrences.** A line with two casts counts once.
- **Buckets are mutually exclusive.** `as any` counts under `any`, not under `as` —
  counting it in both inflates the total.
- **`as const` is excluded.** It is a widening guard, not a type-safety escape.
- **Block comments, `//` lines, and `import`/`export` aliases are skipped**, so
  `import * as Y from 'yjs'` and prose containing "any" do not register.

> **Re-baselined.** The orientation notes recorded 858 (F5) but never recorded the command
> that produced it, so it could not be reproduced — which would have broken Implementation
> Rule 1's requirement that before/after run "under identical conditions" (p.9). The counter
> above is now the canonical command. `any` (258 vs 260) and `!` (321 vs 322) reproduce the
> earlier figures closely; `as` does not (429 vs 275), because the earlier pattern appears to
> have matched a narrower set. **This report's numbers supersede F5.**

Strict-mode settings were read from all four `tsconfig.json` files. Implicit-`any` coverage
was established by running `pnpm type-check`.

### Baseline

| Metric | Your Baseline |
|---|---|
| Total `any` types | **258** |
| Total type assertions (`as`) | **429** |
| Total non-null assertions (`!`) | **321** |
| Total `@ts-ignore` / `@ts-expect-error` | **1** |
| Strict mode enabled? | **Yes** — but unevenly (see W1-4) |
| Strict mode error count (if disabled) | n/a — strict is on |
| Top 5 violation-dense files | see below |

**Total: 1,009 violations across 144 files.**

| Package | `any` | `as` | `!` | `@ts` | Total | Files |
|---|---:|---:|---:|---:|---:|---:|
| `api/src` | 232 | 143 | 288 | 0 | **663** | 52 |
| `web/src` | 26 | 286 | 33 | 1 | **346** | 92 |
| `shared/src` | 0 | 0 | 0 | 0 | **0** | 0 |

Production vs test: **803 in 123 production files**, 206 in 21 test files.

`shared/` is clean at zero — the one package whose whole job is types has no escapes in it.

**Implicit `any` and untyped parameters: structurally zero.** The category overview (p.3)
names "untyped function parameters, and implicit `any` from missing return types" as part of
what is measured. Neither is grep-detectable, so it was established by compilation instead:
`strict: true` is set in all four tsconfigs and `noImplicitAny` is not overridden anywhere,
and `pnpm type-check` exits 0 with **0 errors**. Under `noImplicitAny`, an untyped parameter
is a compile error — so the codebase cannot contain any. This bucket is genuinely empty
rather than unmeasured.

### Top 5 violation-dense files

The brief asks for the most violation-*dense* files, which is a per-line measure, not a raw
count — so both readings are given. Files under 200 LOC are excluded from density (a 20-line
file with 3 casts scores 15/100 and means nothing).

**By density, production code only** — the ranking that should drive Phase 2:

| File | Violations | LOC | per 100 | Composition |
|---|---:|---:|---:|---|
| `web/src/components/document-tabs/ProjectDetailsTab.tsx` | 19 | 247 | **7.7** | 19 `as` |
| `api/src/utils/yjsConverter.ts` | 16 | 245 | **6.5** | 14 `any`, 2 `as` |
| `web/src/pages/UnifiedDocumentPage.tsx` | 32 | 532 | **6.0** | 31 `as`, 1 `!` |
| `web/src/components/UnifiedEditor.tsx` | 26 | 498 | **5.2** | 26 `as` |
| `api/src/utils/extractHypothesis.ts` | 12 | 306 | **3.9** | 4 `as`, 8 `!` |

**By absolute count** (all files, including tests):

| File | Violations | LOC | per 100 |
|---|---:|---:|---:|
| `api/src/routes/weeks.ts` | 83 | 3156 | 2.6 |
| `api/src/routes/projects.ts` | 49 | 1735 | 2.8 |
| `api/src/routes/issues.ts` | 44 | 1642 | 2.7 |
| `api/src/__tests__/transformIssueLinks.test.ts` | 37 | 560 | 6.6 |
| `api/src/services/accountability.test.ts` | 34 | 366 | 9.3 |

### Why these are problematic

The 1,009 figure is misleading if read as 1,009 independent mistakes. Three root causes
account for the overwhelming majority, and each is a single design decision expressed
hundreds of times.

**W1-1 · One optional type declaration produces 236 non-null assertions.**
`api/src/middleware/auth.ts:9-15` augments the global Express `Request` with every auth field
optional:

```ts
interface Request {
  sessionId?: string;
  userId?: string;
  workspaceId?: string;
  ...
}
```

Every authenticated route therefore has to write `req.workspaceId!`. Measured: **236 of
api's 290 non-null-assertion lines (81%)** are exactly `req.workspaceId!` or `req.userId!`.
`weeks.ts` alone has 48.

This is the worst kind of violation because it is load-bearing. `authMiddleware` guarantees
those fields are set, but the type does not express that, so the assertion is the only thing
bridging the gap — and it is unchecked. Any route that is mounted *without* the middleware
compiles identically and fails at runtime. F16 confirms 31 of 170 routes lack inline
`authMiddleware`; the type system cannot tell you whether that is safe.
**Severity: high.**

*Projected* impact of an `AuthenticatedRequest` interface with required fields, measured by
simulating the edit against the counter rather than estimated: **231 lines drop to zero
violations, 22.9% of the total.** Not 236 — five lines carry a second violation that
survives, because line-hit counting only stops counting a line when its last violation goes:

```
issues.ts:923   await logDocumentChange(id!, change.field, ..., req.userId!);
weeks.ts:1256   broadcastToUser(req.userId!, 'accountability:updated', ...);
```

So this change alone lands **21 violations short of the 25% target** (252). It is the single
largest lever available, but it does not clear the bar by itself. This is a projection, not a
result — Phase 2 owes the actual before/after per Implementation Rule 1 (p.9).

**W1-2 · JSONB `properties` is untyped at the boundary, so every read is a cast.**
`web/src` has 286 `as` assertions against only 26 `any`. They cluster in the document pages:

```ts
const impact = (projectUpdates.impact ?? previousDocument.impact) as number | null;
const belongsTo = (document as { belongs_to?: Array<{id: string; type: string}> }).belongs_to;
document_type: document.document_type as UnifiedDocument['document_type'],
```

The unified document model stores per-type fields in a JSONB `properties` column, and the
shared response type models it as an untyped bag. So every type-specific field read requires
the developer to re-assert a shape the API already knows. The casts are not lies — they are
the developer restating information the type system was never told.

This is where F8 bites: `shared/types/auth.ts` is two comment lines, and login shapes are
duplicated rather than shared. The `shared/` package has zero violations because it is barely
used for this. **Severity: high** — it is the largest single bucket and it is concentrated in
four files, which makes it tractable.

**W1-3 · Yjs conversion has no typed model.** `api/src/utils/yjsConverter.ts` carries 14
`any` in 245 lines — the densest `any` concentration in production code:

```ts
function extractTextWithMarks(element: Y.XmlElement, inheritedMarks: any[] = []): any[]
export function yjsToJson(fragment: Y.XmlFragment): any
```

This converts CRDT state into TipTap document JSON — the format every document in the system
is stored in. It is the least-typed code in the repo and it sits directly on the persistence
path for all user content. A malformed conversion writes malformed JSON to `content` with no
compile-time or runtime guard. TipTap publishes node type definitions; nothing here uses
them. **Severity: high** — low violation count, high blast radius.

**W1-4 · The frontend runs under weaker guarantees than the backend, silently.**
`web/tsconfig.json` has no `extends`. It redeclares compiler options from scratch and drops
three the root config sets: `noUncheckedIndexedAccess`, `noImplicitReturns`, and
`noFallthroughCasesInSwitch` (F4). `api/` and `shared/` inherit correctly.

Nothing warns about this. It is invisible unless you diff the four tsconfigs, and it means
`web/`'s clean type-check result is a weaker claim than `api/`'s. **Severity: medium** —
turning the flags on will surface new errors, so it is a cost to pay rather than a free win,
but the asymmetry should be a deliberate choice rather than an accident of copy-paste.

**W1-5 · `api/`'s 232 `any` are mostly one library decision.** The codebase uses raw `pg`
with no ORM, and `pg` returns `QueryResult<any>`. That is a deliberate, documented choice
(boring technology), not carelessness — but it means every query result enters the
application untyped and the `any` propagates until something casts it.
**Severity: medium.** A generic `query<T>()` wrapper types the boundary once instead of 232
times, without adopting an ORM.

### What this means for the improvement target

p.3 sets the bar at *"Eliminate 25% of type safety violations"* — **253 of 1,009** — with the
explicit constraint that *"Replacing `any` with `unknown` without proper type narrowing is not
an improvement"* and that all tests must still pass.

W1-1 is the largest single lever at a measured **231 violations (22.9%)**, and it is the
cleanest kind of fix: it replaces assertions with a type that states what the middleware
already guarantees — exactly the "meaningful types that reflect the actual data" the target
demands. But it does **not** clear the bar alone; it lands 21 short.

Closing that gap needs a second change. W1-2's three dense web files hold **76** `as`
assertions between them — `UnifiedDocumentPage.tsx` 31, `UnifiedEditor.tsx` 26,
`ProjectDetailsTab.tsx` 19 — so typing the `properties` boundary is the obvious candidate.
The same caveat applies: 76 is the count of matching lines, not a guaranteed reduction, since
a line only stops counting when its last violation goes.

Both are structural changes rather than several hundred scattered edits, which matters for
keeping the 869-test E2E suite honest under Implementation Rule 2 (p.9).

Everything in this subsection is projection. Phase 2 owes real before/after numbers from
`docs/audit/scripts/count-type-violations.py`, run identically before and after.

---

## Category 5 — Test Coverage and Quality

### How it was measured

Every inherited figure was re-derived rather than carried forward. All four held.

```bash
pnpm test                                   # api — 451 in 13.27s
pnpm --filter @ship/web test --run          # web — 151, 13 failing
PLAYWRIGHT_WORKERS=4 pnpm test:e2e          # E2E — 3 runs, see Baseline
pnpm --filter @ship/api  test:coverage --run
pnpm --filter @ship/web  exec vitest run --coverage \
     --coverage.reportOnFailure --coverage.reporter=text
```

Two things had to be fixed before coverage could be measured at all, both sanctioned by p.6's
*"If code coverage tooling is not configured, configure it and report line/branch coverage per
package"*:

1. **`@vitest/coverage-v8` was never installed.** `api/package.json:16` declares a
   `test:coverage` script and `api/vitest.config.ts:12` declares a v8 provider, but the
   package is absent — so `pnpm test:coverage` has always failed with `MISSING DEPENDENCY`.
   `web/` had no coverage config at all.
2. **Version drift.** Installing `@vitest/coverage-v8` by default resolves 4.1.10 against
   vitest 4.0.17, which throws
   `SyntaxError: 'vitest/node' does not provide an export named 'BaseCoverageProvider'`.
   The provider must track the vitest minor.

Web coverage additionally needs `--coverage.reportOnFailure`; vitest defaults it to `false`,
so with 13 failing tests the table is silently omitted.

E2E worker count was forced to 4 — the config's `os.freemem()` heuristic clamps to 1 worker on
macOS (F24), which removes the contention flake measurement depends on.

### Baseline

| Metric | Your Baseline |
|---|---|
| Total tests | **1,471** — 869 E2E · 451 api · 151 web |
| Pass / Fail / Flaky | E2E **864/0/5 · 865/0/4 · 862/0/7** · api **451/0/0** · web **138/13/0** |
| Suite runtime | E2E **9.6m · 10.0m · 9.8m** (4 workers) · api **13.27s** · web **1.77s** |
| Critical flows with zero coverage | **None** — all four have E2E tests (see mapping) |
| Code coverage % | **web 27.63% / api 40.34%** statements |

Coverage detail:

| Package | Stmts | Branch | Funcs | Lines |
|---|---:|---:|---:|---:|
| `api` | 40.34 | 33.44 | 40.90 | 40.52 |
| `web` | 27.63 | 19.38 | 25.60 | 28.53 |

api by directory:

```
src/openapi          100.00 / 100.00      src/utils          71.31 / 64.64
src/middleware        77.06 /  72.00      src/db             57.89 / 50.00
src/routes            36.93 /  32.56      src/services       20.36 / 16.33
src/collaboration      8.53 /   2.42   <- least-tested code in the repo
```

Critical-flow mapping (p.6 names document CRUD, real-time sync, auth, sprint management):

| Flow | E2E tests | Specs |
|---|---:|---|
| Auth / access | **160** | session-timeout 58 · workspaces 21 · private-documents 20 · security 18 · authorization 17 · … |
| Sprint / week mgmt | **102** | program-mode-week-ux 66 · weekly-accountability 19 · project-weeks 5 · … |
| Real-time sync | **55** | mentions 15 · data-integrity 11 · race-conditions 9 · inline-comments 9 · … |
| Document CRUD | **42** | toc 9 · backlinks 8 · docs-mode 7 · autosave-race-conditions 7 · … |

Remaining 514 tests span 44 unmapped specs (bulk-selection 85, accessibility-remediation 57,
features-real 24, drag-handle 19, …).

**What is *not* covered.** p.5's bullet asks to catalog covered flows *and which are not*, so
the inverse was derived too. Every one of the 37 declared routes has either a matching spec or
an in-test reference, so there is no wholly untested route. Checking feature areas against test
*content* rather than filenames — filenames mislead, `Login` is covered by `auth.spec.ts` —
four have **zero mentions anywhere in the 71 spec files**:

| Area | E2E references |
|---|---:|
| API tokens (`api/src/routes/api-tokens.ts`) | **0** |
| Claude / AI endpoints (`api/src/routes/claude.ts`) | **0** |
| Dashboard route (`/dashboard`) | **0** |
| Org chart (`OrgChartPage`) | **0** |

Thinly covered, single-digit references: person editor (1), setup wizard (1), public feedback
(5), iterations (5), associations (7).

API tokens is the notable one — it mints long-lived credentials and F16 records
`isApiToken` as an auth path, so an authentication surface has no end-to-end test at all.

### Weaknesses

**W5-1 · The most dangerous subsystem is the least tested.** `src/collaboration` sits at
**8.53% statements and 2.42% branches** — the lowest in the repo by a wide margin, against
`src/openapi` at 100% and `src/middleware` at 77%.

That directory holds the module-level `Map`s and the debounced Yjs persistence path behind
F31, the multi-process data-loss defect. 2.42% branch coverage means essentially none of the
error, disconnect, or eviction branches are exercised. The 55 E2E tests tagged real-time sync
run against a single API instance, so they cannot observe the failure at all — the split-brain
case only appears with two processes, which no test creates. **Severity: high.** The gap is
not "some untested code"; it is the absence of any test that could catch the worst bug found
in this audit.

**W5-2 · 13 web tests fail on clean `main`, and the documented command hides it.**
`pnpm test` is `pnpm --filter @ship/api test` (F18) — api only. The 151 web tests never run
under the documented workflow, so the 13 failures (F19) are invisible to anyone following the
README. Re-confirmed this pass: 3 failed files, 13 failed tests, 138 passed.
**Severity: high** — a suite that is red by default trains people to ignore red.

**W5-3 · Coverage tooling was declared but never worked.** A `test:coverage` script and a v8
provider config existed with no provider installed. Nobody had run it. Combined with W5-2,
`api`'s real 40.34% and `web`'s 27.63% were unknown numbers before this audit.
**Severity: medium.**

**W5-4 · `src/services` at 20.36% / 16.33% branch.** Business logic — accountability,
allocation, dashboard, weekly plans — with roughly four in five branches unexercised.
Individual files bottom out at 0% (`allocation.ts`, `...acceptance.ts`), 1.98%
(`dashboard.ts`), 4.8% (`weekly-plans.ts`). **Severity: medium.**

**W5-5 · The brief's premise about suite size is stale.** p.5 states *"Ship has 73+ Playwright
E2E tests."* Measured: **869 across 71 spec files** — 12× the stated figure. Not a defect in
the codebase, but it changes the shape of this category: the problem is not sparse E2E
coverage, it is unit coverage and a specific structural blind spot (W5-1).
**Severity: informational** — no defect in the codebase, but it invalidates the assumption the
category was written around, so it is recorded rather than ranked against the others.

**W5-6 · Flake is low but real: 0.61%.** 16 flaky occurrences across 2,607 executions, 12
distinct tests. Three recur:

| Test | Runs flaky |
|---|---|
| `my-week-stale-data.spec.ts:63` — retro edits visible after navigating back | **3 / 3** |
| `my-week-stale-data.spec.ts:28` — plan edits visible after navigating back | 2 / 3 |
| `status-overview-heatmap.spec.ts:69` — split cells for plan/retro status | 2 / 3 |

The two `my-week-stale-data` cases assert the same behaviour — whether a view refetches or
serves stale cache — so one root cause plausibly explains both. The other nine are
single-occurrence across unrelated features and read as ordinary 4-worker contention.
**Severity: low**, but these are the named candidates for the improvement target.

### What this means for the improvement target

p.6 offers *"Add meaningful tests for 3 previously untested critical paths, or fix 3 flaky
tests with documented root cause analysis"*, where meaningful means *"the test catches a real
regression, not just asserting that a page loads."*

Both routes are open, and they are not equal. The flaky route is cheaper — the three
recurring tests are identified and two likely share a cause. The untested-critical-path route
is worth more: `src/collaboration` at 2.42% branch coverage is where F31 lives, and a
regression test that spins two API instances against one document would be exactly what
Implementation Rule 3 (p.9) demands — *"Every bug or vulnerability found during the audit
must have a corresponding regression test that would have caught it."*

Note that Rule 3 makes this partly non-optional: F31 needs a regression test regardless of
which improvement route is chosen for scoring.

---

## Category 7 — Accessibility Compliance

### How it was measured

p.7 states the task plainly: *"Ship claims Section 508 compliance and WCAG 2.1 AA
conformance. Your job is to verify those claims."* Nothing in the repo's own
documentation was accepted as evidence, and neither was the existing E2E
accessibility suite. Both are re-derived below.

```bash
docs/audit/scripts/measure-a11y.py                    # canonical: axe + keyboard + Lighthouse
docs/audit/scripts/measure-a11y.py --no-lighthouse    # axe + keyboard only (~4 min)
docs/audit/scripts/measure-a11y.py --reuse            # re-aggregate an existing scan
docs/audit/scripts/measure-a11y.py --json             # machine-readable
```

The Python wrapper drives `docs/audit/scripts/a11y-scan.mjs`, which logs in with
Playwright, walks 17 URLs, and per page runs axe-core twice, captures landmark and
heading structure, and performs a Tab traversal. It then runs Lighthouse against
every one of those URLs at two form factors, replaying the captured session cookie.

**No dependency was added.** `@axe-core/playwright` 4.11.0 (axe-core 4.11.1) and
`@playwright/test` are already in the root `package.json`; Lighthouse 13.4.1 runs via
`npx` against the system Google Chrome and is deliberately *not* added to
`package.json`. `package.json` is unmodified by this category.

**Pages scanned** (17 URLs, 18 scans — `/docs` twice, once with the modal open):
login, docs home, my-week, dashboard, issues, projects, programs, team allocation,
team directory, team status, workspace settings, admin, and five document editors
(issue, project, sprint, weekly plan, wiki). Document IDs are discovered from
`/api/documents` at runtime rather than hard-coded, so the script survives a reseed.

Two axe passes per page:

| Pass | Rule set | Why |
|---|---|---|
| `axe_wcag_508` | `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `section508` | Exactly the conformance claim under test. Headline numbers come from here. |
| `axe_all_rules` | axe default | Adds axe's *best-practice* rules. Reported separately so best-practice findings are never counted as WCAG failures. |

#### Corrections and caveats, recorded because they change the numbers

> **Correction 1 — the first scan measured a modal, not the app.** Ship auto-opens
> `ActionItemsModal` on every authenticated page load when the signed-in user has a
> pending accountability item. It is a Radix dialog, so the rest of the app is marked
> `aria-hidden` while it is open and axe skips it. The first run therefore reported
> *4 focusable elements* on `/my-week` and **68 critical+serious nodes** overall. The
> driver now dismisses the dialog before scanning, and the real figure is **99**. The
> earlier 68 is superseded. The modal is now scanned once on its own instead.

> **Correction 2 — Lighthouse's default mobile viewport flatters the score.**
> Lighthouse defaults to 412×823 mobile emulation, where much of Ship's 4-panel layout
> does not render and dozens of audits return `notApplicable` (45 of them on
> `/settings` at mobile). Both form factors are now reported. Desktop (1350×940) matches the
> 1440×900 viewport axe ran at. Mobile and desktop differ on three pages.

> **Lighthouse under-reports on this app, and that is a finding in itself.** Lighthouse
> scored `/settings` **100** at both form factors. axe at the same viewport found **24
> critical `select-name` violations** on that page. The reason is timing: the member
> table is an async react-query fetch, and Lighthouse snapshots the DOM before it
> resolves, so `select-name` comes back `notApplicable`. Verified directly in the
> browser — `/settings` renders 25 `<select>` elements, 24 of them with no accessible
> name. Treat the per-page Lighthouse score as the weakest number in this category.

**Stability.** The axe + keyboard scan was run twice end to end. Both runs returned
identical figures — 99 nodes, 34 critical, 65 serious, 61 contrast, 269 unreachable,
1,990 expected-focusable — so the numbers below are not a single lucky sample.

Other caveats:

- Scans ran against the Vite **dev server**, which is what was running. Accessibility
  is DOM-derived so this is near-irrelevant, with one exception: the
  `ReactQueryDevtools` button is present in dev and appears in the tab order. It
  carries an `aria-label`, so it produces no violation, but it is one extra tab stop
  that will not exist in production.
- Data volume matters (see W7-6). Numbers are against the audit's seeded workspace:
  600 documents, 25 users.
- axe returned **38 colour-contrast nodes it could not resolve** (`incomplete`) across
  the 17 pages — typically text over gradients or images. Those are *not* counted as
  failures and are not counted as passes either. They need a human with an eyedropper.

#### What is genuinely NOT measured here

p.7 asks for five things. Two of them cannot be done by a script, and no result for
them is reported:

**Screen reader testing — not performed.** p.7 asks: *"Test with a screen reader
(VoiceOver, NVDA, or similar). Can you understand the page structure and interact with
all controls?"* That is a subjective judgement by a person operating assistive
technology. No automated proxy answers it. What the script *can* supply is structural
input to such a test — landmark counts, heading order, accessible-name coverage, live
regions — and those are reported below as structure, not as screen-reader results.
**A human must run VoiceOver or NVDA over at least the docs home, a document editor,
and workspace settings before the Section 508 claim can stand.**

**Keyboard navigation — measured in part only.** p.7 asks: *"Test full keyboard
navigation: can you reach every interactive element using only Tab, Enter, Escape, and
arrow keys?"* The traversal presses **Tab only**, and answers the *reach* half of that
question: it records what actually receives focus and diffs it against every element a
keyboard user should be able to reach (1,990 candidate elements across the 17 pages).
Traversals were sized per page (up to a 1,400-press cap) and **every page wrapped
back to its first stop rather than hitting the cap**, so no page's result is truncated.
Escape was tested against the auto-opening dialog. Not covered, and needing a human:

| Not covered | Why it needs a person |
|---|---|
| Enter / Space activation | Requires asserting the *right* thing happened per control |
| Arrow-key patterns (tree, tabs, menus) | Correct behaviour is component-specific |
| Focus visibility | A computed style can be present and still be invisible in practice |
| Focus order sensibility | Reachable ≠ in a logical order |
| Focus restoration after dialogs/navigation | Needs judgement about where focus *should* land |

### Baseline

| Metric | Your Baseline |
|---|---|
| Lighthouse accessibility score (per page) | **88–100** across 17 pages, desktop; median 96. Full table below. Lowest: `/admin` **88**. Caveat above: these scores are unreliable for this app. |
| Total Critical/Serious violations | **99 nodes / 23 rule-instances** across 18 page scans, from **7 distinct rules** (4 critical, 3 serious). Zero moderate, zero minor under the WCAG 2.1 AA + Section 508 tag set. |
| Keyboard navigation completeness | **Partial** — all four keys p.7 names now tested. Tab: 269 elements never focusable (all `li[role="treeitem"]`), zero positive `tabindex`, focus wraps on all 17 pages. Escape: closes the auto-dialog on all 15 pages it appears. Enter/Space: activate correctly, 6/6. **Arrow keys: focus never moves in any composite widget, 0/4.** |
| Color contrast failures | **61 nodes**, from **16 distinct foreground/background pairs**, worst **1.84:1** against the 4.5:1 AA threshold. Plus 38 nodes axe could not resolve. |
| Missing ARIA labels or roles | **7 distinct locations**, each with file:line below. These affect **25 interactive nodes** — location 1 alone is 24 `<select>` instances on one page, location 3 is 1 button — independently confirmed by accessibility-tree inspection, which found exactly those 25 nodes with an empty accessible name. |

#### Lighthouse accessibility score per page

| Page | Path | Desktop | Mobile | Failing audits (desktop) |
|---|---|---:|---:|---|
| login | `/login` | 98 | 98 | `landmark-one-main` |
| docs (home) | `/docs` | **91** | 91 | `aria-required-children`, `listitem` |
| my-week | `/my-week` | 96 | 96 | `color-contrast` |
| dashboard | `/dashboard` | 96 | 96 | `color-contrast` |
| issues list | `/issues` | 100 | 100 | — |
| projects list | `/projects` | 96 | 100 | `color-contrast` |
| programs list | `/programs` | 100 | 100 | — |
| team allocation | `/team/allocation` | 96 | 100 | `color-contrast` |
| team directory | `/team/directory` | 100 | 100 | — |
| team status | `/team/status` | 96 | 100 | `color-contrast` |
| workspace settings | `/settings` | 100 | 100 | — *(see caveat — axe finds 24 criticals here)* |
| admin | `/admin` | **88** | 88 | `button-name`, `color-contrast` |
| issue document | `/documents/{issue}` | 96 | 96 | `color-contrast` |
| project document | `/documents/{project}` | 100 | 100 | — |
| sprint document | `/documents/{sprint}` | **91** | 91 | `aria-required-children`, `listitem` |
| weekly plan document | `/documents/{weekly_plan}` | 96 | 96 | `color-contrast` |
| wiki document | `/documents/{wiki}` | **91** | 91 | `aria-required-children`, `listitem` |

#### axe-core violations by severity (WCAG 2.1 A/AA + Section 508 tag set)

| Impact | Rule-instances | Nodes |
|---|---:|---:|
| Critical | 11 | 34 |
| Serious | 12 | 65 |
| Moderate | 0 | 0 |
| Minor | 0 | 0 |
| **Critical + Serious** | **23** | **99** |

Seven distinct rules account for all of it:

| Impact | Rule | Nodes | Where |
|---|---|---:|---|
| serious | `color-contrast` | 61 | 9 pages |
| critical | `select-name` | 25 | workspace settings (24), sprint document (1) |
| critical | `aria-required-children` | 4 | docs home, sprint/wiki documents, modal scan |
| serious | `listitem` | 4 | same four |
| critical | `aria-allowed-attr` | 2 | issue + weekly-plan documents |
| critical | `aria-valid-attr-value` | 2 | project + sprint documents |
| critical | `button-name` | 1 | admin |

Running axe's **default** rule set instead adds 16 more nodes across 9
best-practice rules — `region` (5), `empty-table-header` (4),
`landmark-one-main`, `landmark-main-is-top-level`, `landmark-no-duplicate-main`,
`landmark-unique`, `label-title-only`, `page-has-heading-one`, `heading-order` (1
each). Total under the default rule set: **115 nodes / 16 rules**. These are *not*
WCAG 2.1 AA failures and are ranked lower accordingly.

#### Colour contrast failures against the 4.5:1 AA threshold

61 failing nodes reduce to 16 distinct colour pairs and two root causes:

| Foreground | Background | Ratio | Needs | Nodes | Cause |
|---|---|---:|---|---:|---|
| `#005ea2` | `#0a1d2b` | **2.55:1** | 4.5:1 | 17 | accent token |
| `#3f3f3f` | `#0d0d0d` | **1.84:1** | 4.5:1 | 15 | `text-muted/…` opacity |
| `#4c4c4c` | `#0d0d0d` | **2.26:1** | 4.5:1 | 15 | `text-muted/…` opacity |
| `#005ea2` | `#0d0d0d` | **2.89:1** | 4.5:1 | 4 | accent token |
| `#8a8a8a` | `#262626` | **4.38:1** | 4.5:1 | 2 | muted on a raised surface |
| `#005ea2` | `#0c1114` / `#0c151c` / `#1a1a1a` | 2.58–2.82:1 | 4.5:1 | 3 | accent token |
| `#585858`, `#4d4d4d`, `#404040` | `#0d0d0d`/`#101010` | 1.87–2.73:1 | 4.5:1 | 3 | `text-muted/…` opacity |
| `#8a8a8a` | `#333333` | **3.65:1** | 4.5:1 | 1 | muted on a raised surface |
| `#737373` | `#0d0d0d` | **4.09:1** | 4.5:1 | 1 | un-migrated literal |

24 of the 61 are the `accent` token; 33 are opacity-modified `muted`; the remaining 4
are `muted` on a raised surface (3) and one un-migrated literal.

#### Enter, Space and arrow keys

`docs/audit/scripts/measure-keyboard.mjs`. Tab reachability and Escape are covered above;
these are the remaining keys named in p.7's bullet.

**Arrow keys — focus does not move in any composite widget. 0 of 4.**

| Page | Widget role | Member role | Focus moved after ↓ ↑ → ← |
|---|---|---|---|
| `/docs` | `tree` | `treeitem` | **no** |
| `/docs` | `tablist` | `tab` | **no** |
| `/issues` | `tablist` | `tab` | **no** |
| `/issues` | `grid` | `gridcell` | **no** |

Each widget was tested by focusing a member element, pressing all four arrow keys, and
comparing `document.activeElement` before and after. It never changed.

**Enter and Space — both activate correctly, 6 of 6.** Tested on `/docs`, `/issues` and
`/my-week`: tab to the first button, press the key, confirm the URL or DOM changed.

**Focus visibility — 80 elements sampled, 0 without an indicator.** For each of the first 40
visible focusable elements on `/docs` and `/issues`, computed style was captured unfocused
and focused and compared across `outline-style`, `outline-width`, `box-shadow`,
`background-color` and `border-color`. Every element changed on focus. This does not retract
W7-7 — the repo's own focus test is still tautological and cannot fail — but the practical
gap is smaller than the 22 unreplaced `focus:outline-none` occurrences suggest.

#### Screen reader — accessibility tree inspection

`docs/audit/scripts/measure-a11y-tree.mjs`, via Playwright's `ariaSnapshot()`. **This is not
a screen reader.** It dumps the accessibility tree a screen reader *consumes* — the role and
accessible name of every exposed node — which answers p.7's two questions objectively:
*"can you understand the page structure"* and *"can you interact with all controls."* What it
cannot establish is whether the resulting speech is comprehensible in practice. That
limitation is why the measure bullet is still marked incomplete.

> **Corrected — the `/login` row previously reported `/docs` under the wrong name.** The
> script authenticated before walking its page list, and `PublicRoute` redirects a logged-in
> visitor from `/login` to `/docs` (`web/src/main.tsx:104`). The walk therefore measured
> `/docs` twice and filed one copy as `/login`, which is why the two rows were identical —
> 158 nodes, 2 headings, both landmarks. The real login page has **4 interactive nodes, 1
> heading and neither landmark**. The script now captures `/login` before authenticating and
> throws if it is redirected. The remaining six rows re-measured **identical** on a cleaned
> database, so the error was confined to this one row.

| Page | Interactive nodes | **Unnamed** | Headings | `main` | `navigation` |
|---|---:|---:|---:|---|---|
| `/login` | **4** | 0 | **1** | **no** | **no** |
| `/docs` | 158 | 0 | 2 | yes | yes |
| `/my-week` | 21 | 0 | 6 | yes | yes |
| `/issues` | 405 | 0 | **2** | yes | yes |
| `/settings` | 117 | **24** | **1** | yes | yes |
| `/admin` | 9 | **1** | 1 | yes | yes |
| `/team/directory` | 19 | 0 | 2 | yes | yes |

**Can you interact with all controls? No — 25 controls have no accessible name.**

- **`/settings`: 24 `combobox` nodes with an empty name.** This is the same defect axe reports
  as `select-name`, reached by a completely independent method, which raises confidence that
  it is real rather than a scanner artifact. A screen reader announces each as an unnamed pop
  up button, so a user cannot tell *which member's role* a given dropdown controls. These are
  the controls that grant workspace admin (W7-4).
- **`/admin`: 1 unnamed `button`**, matching axe's `button-name` failure.
- Every other page measured: **zero** unnamed interactive nodes.

**Can you understand the page structure? Partly.** Landmarks are in good shape *once you are
signed in* — all six authenticated pages expose both `main` and `navigation`, so landmark
navigation works there. **`/login` exposes neither**, which is the correction above and which
matches what axe independently reported for that page (`landmark-one-main`, location 7 below).
The first page every user meets is the one page with no landmark structure at all. Heading
structure is the weak half:

- **`/issues` exposes 2,257 accessibility nodes behind 2 headings.**
- **`/settings` has 1 heading** ("Settings") for 295 nodes and 117 interactive controls.

Heading navigation is the primary way screen reader users skip through a page. At that
density it does not function — a user must traverse linearly through hundreds of nodes
because there are no waypoints. That is a structural finding the Lighthouse scores do not
capture: `/issues` scores **100**.

#### Screen reader — simulated announcements

`docs/audit/scripts/measure-virtual-screenreader.mjs`, driving
`@guidepup/virtual-screen-reader` over the running application in Chromium.

```bash
node docs/audit/scripts/measure-virtual-screenreader.mjs --out docs/audit/raw/cat7-virtual-sr.json
```

**This is a screen reader simulator, not VoiceOver, and is not reported as VoiceOver.** Its
own documentation is explicit that it *"should not replace but augment your screen reader
testing, there is no substitute for testing with real screen readers and with real users."*
What it adds over the tree inspection above is the thing p.7 actually asks about: not the
roles and names a screen reader *consumes*, but the **phrases it would speak**, computed per
W3C ACCNAME / WAI-ARIA / HTML-AAM against the real rendered DOM.

Attempting the real thing failed and the evidence is recorded in
`docs/audit/voiceover-protocol.md`: VoiceOver starts and stops under program control and
AppleScript reaches it (`version` returns `10`), but every content object in its scripting
dictionary returns `-1728` — `content of last phrase`, `vo cursor`, `properties`. Reading
VoiceOver's caption panel through the accessibility API fails too; the VoiceOver process
exposes 0 windows and 0 UI elements to System Events. macOS 14.6.1 (23G93).

| Page | Controls announced | Bare role | **Indistinguishable** | Groups |
|---|---:|---:|---:|---:|
| `/login` | 3 | 0 | 0 | 0 |
| `/docs` | 263 | 0 | **138** | 15 |
| document editor | 58 | 0 | **14** | 3 |
| `/issues` | 472 | 0 | **136** | 34 |
| `/settings` | 118 | 0 | **100** | 5 |
| **Total** | **914** | **0** | **388 (42%)** | **57** |

**Every control announces something — 0 of 914 are bare role.** The defect is not silence, it
is that **388 of 914 controls (42%) are announced identically to another control on the same
page.** A user hears a phrase that does not tell them which control they are on.

The worst groups:

```
/docs      52x  "button, Delete document"
/docs      52x  "button, Add sub-document"
/settings  25x  "option, Admin, admin, not selected, position 1, set size 2"
/settings  24x  "combobox, member, has popup listbox, not expanded"
editor     10x  "button, Document actions, has popup menu"
```

**This sharpens W7-4 rather than repeating it.** The tree inspection and axe both found the
24 `/settings` comboboxes have an *empty accessible name*. The simulated announcement shows
what that means in the ear: the control falls back to announcing its **current value**, so all
24 say `combobox, member` — the same three words, whichever person's permissions they control.
Three independent methods now agree, and this is the one that establishes the consequence.

`/docs` is worse and was not previously identified. **52 buttons announce as
`button, Delete document`** with nothing naming the document. A screen reader user cannot tell
which document a delete button destroys without leaving the control and reconstructing
position from surrounding context.

**Can you interact with all controls? No.** Reachable, yes; distinguishable, no — for 42% of
them. **Can you understand the page structure?** The landmark and heading findings above stand
unchanged. What remains open is whether the resulting speech is comprehensible in practice,
which no simulator settles — see the manual protocol.

#### Missing ARIA labels or roles — locations

**7 distinct locations, 25 affected nodes.** The two counts differ because location 1 repeats
24 times on a single page. Locations are the unit of *fix*; nodes are the unit of *impact*.


| # | Location | Rule | Impact |
|---|---|---|---|
| 1 | `web/src/pages/WorkspaceSettings.tsx:324` — member role `<select>`, no label, `aria-label` or wrapping `<label>`. 24 instances on one page. | `select-name` | Critical |
| 2 | `web/src/components/sidebars/WeekSidebar.tsx:172` — sprint status `<select>`; its visible "Status" text is a sibling `PropertyRow` label, not programmatically associated. | `select-name` | Critical |
| 3 | `web/src/pages/AdminDashboard.tsx:121` — icon-only back button, no `aria-label`, no text. | `button-name` | Critical |
| 4 | `web/src/pages/App.tsx:637` and `:670` — `<ul role="tree">` whose 11th `<li>` (the "N more…" link, `:651-659`) and empty-state `<li>` (`:649`) carry no `role="treeitem"`. | `aria-required-children` + `listitem` | Critical + Serious |
| 5 | `web/src/components/ui/TabBar.tsx:25` — every tab sets `aria-controls={`tabpanel-${tab.id}`}`, but `role="tabpanel"` appears **0 times** in `web/src` and no element declares a matching `id`. Every tab points at nothing. | `aria-valid-attr-value` | Critical |
| 6 | `.tiptap-wrapper > div` in the editor — `aria-expanded` on a `div` with no role. Emitted by `tippy.js` 6.3.7 (TipTap's suggestion popper), not by app code. | `aria-allowed-attr` | Critical |
| 7 | `web/src/pages/Login.tsx` — no `<main>` landmark and no skip link. `/admin` also has no skip link. | `landmark-one-main` | Best-practice (Low) |

#### Keyboard reachability — Tab traversal

| Page | Expected focusable | Reached | Never focused | Wrapped |
|---|---:|---:|---:|---|
| login | 4 | 4 | 0 | yes |
| docs home | 200 | 200 | 62 | yes |
| my-week | 21 | 21 | 0 | yes |
| dashboard | 14 | 14 | 0 | yes |
| issues list | 368 | 538 | 0 | yes |
| projects list | 259 | 259 | 59 | yes |
| programs list | 126 | 181 | 0 | yes |
| team allocation | 49 | 64 | 0 | yes |
| team directory | 19 | 19 | 0 | yes |
| team status | 144 | 144 | 0 | yes |
| workspace settings | 66 | 66 | 0 | yes |
| admin | 9 | 9 | 0 | yes |
| issue document | 196 | 367 | 0 | yes |
| project document | 220 | 216 | 63 | yes |
| sprint document | 45 | 46 | 10 | yes |
| weekly plan document | 204 | 201 | 63 | yes |
| wiki document | 46 | 47 | 12 | yes |

This table measures *reachability by Tab*. The other three keys p.7 names are measured
separately below, so the `Partial` rating covers all four.

Reading this table honestly:

- **269 elements were never focused, and every single one is an `li[role="treeitem"]`.**
  Nothing else on any page is unreachable. Their *nested* links and buttons are all
  reachable, so no document or control is stranded — see W7-3 for what this actually
  means.
- Counts where `reached` exceeds `expected` are hover-revealed action buttons that
  become visible when focused. That is correct behaviour, not an error.
- **Zero positive `tabindex`** anywhere. Nothing hijacks the tab order.
- The auto-opening dialog **does** trap focus correctly (3 stops, wraps) and **does**
  close on Escape — verified on all 15 pages where it appeared.
- The good news is real: `lang="en"` on all 17 pages, a `<main>` landmark and a `<nav>`
  on all 16 authenticated pages, a skip link on 15 of them, an `<h1>` on 16 of 17, and
  `<main id="main-content" role="main" tabIndex={-1}>` at `web/src/pages/App.tsx:541`.
  The bones are there.

### Weaknesses

**W7-1 · The `accent` colour token fails AA everywhere it is used as text —
24 nodes, 80 uses in source.** `web/tailwind.config.js:13` sets
`accent: '#005ea2'` (the USWDS logo blue, designed for white backgrounds) against
`background: '#0d0d0d'`. Measured ratios: **2.55–2.89:1** where 4.5:1 is required.
`text-accent` appears **80 times** in `web/src`. It is used for the active nav item,
selected-tab text, week labels, estimate badges and inline links — that is, the
highest-signal text on the page is the least readable.

The comment heading that same colour block (`web/tailwind.config.js:8`) states the
opposite: *"All colors meet WCAG 2.1 AA contrast requirements (4.5:1 minimum)."* That
is wrong for `accent` on a dark surface.
**Severity: Serious** (axe) / **high** — the single largest violation cluster, it is a
one-token fix, and the code asserting it is fine is what stopped anyone from checking.

**W7-2 · Tailwind opacity modifiers silently undo the contrast fix — 33 nodes.**
`muted` was deliberately corrected once; the comment at `web/tailwind.config.js:11`
records it: `"Changed from #737373 (4.09:1) to #8a8a8a (5.1:1 contrast)"`. That fix
holds for `text-muted`. It does **not** survive `text-muted/50`, which composites to
`#4c4c4c` at **2.26:1**, or the `/30` and `/60` variants at **1.84–2.73:1**. There are
**22 opacity-modified text-colour utilities** in `web/src` (`text-muted/50` ×12,
`/60` ×4, `text-accent/80` ×4, `/30` ×1, `text-foreground/80` ×1).

Two smaller variants of the same blind spot: `#8a8a8a` on the `border` surface
`#262626` measures **4.38:1** — the token was validated against `background` only, not
against raised surfaces — and one un-migrated `#737373` literal at **4.09:1** survives
on the weekly plan page, the exact value the comment says was replaced.
**Severity: Serious** (axe) / **high**. Nothing in the toolchain checks a composited
colour, so this will regress again the moment someone types `/50`.

**W7-3 · The document tree announces itself as a tree and implements none of the
tree pattern — 269 treeitems, 0 focusable.** `web/src/pages/App.tsx:637`, `:670`,
`:1241` and `web/src/components/ContextTreeNav.tsx:108` declare `role="tree"`;
`role="treeitem"` appears 18 times in source, and **269 rendered treeitem instances
across the scanned pages never received focus** — they are the entirety of the
"never focused" column above. None is focusable: no `tabIndex` at `App.tsx:820`, no
roving tabindex, and no
`onKeyDown` handler anywhere in the tree. Focus lands on descendant `<a>` and
`<button>` elements instead.

The practical effect is a mismatch, not a lockout. Sighted keyboard users reach every
document, because the links inside the treeitems are ordinary links. But a screen
reader user is told "tree, 62 items", tries the arrow keys the tree role promises, and
nothing happens. axe catches the containers (`aria-required-children`, critical) but
cannot see the missing interaction model at all.

Related, same components: both trees carry `aria-live="polite"` on the entire `<ul>`
(`App.tsx:637`, `:670`), so every re-render of the sidebar is announced.
**Now measured directly, not inferred.** `measure-keyboard.mjs` focused a member of each
composite widget and pressed all four arrow keys: `document.activeElement` never changed, on
**0 of 4** widgets — the `tree` and `tablist` on `/docs`, the `tablist` on `/issues`, and the
`grid` on `/issues`. So the missing roving focus is not confined to the tree; every composite
role in the app declares ARIA semantics it does not implement.

**Severity: Critical** (axe, for the container rule) / **high overall** — this is the
single largest gap between what the app claims to AT and what it does, and it is
precisely the gap the un-run screen-reader test would have caught.

**W7-4 · 24 unlabeled role selectors sit on the page that changes permissions.**
`web/src/pages/WorkspaceSettings.tsx:324` renders one `<select>` per workspace member
with no accessible name — verified live: 25 selects, 24 unnamed. A screen reader
announces "Admin, combo box" 24 times with nothing distinguishing whose role is whose.
The control changes admin/member privileges.

The same defect at `web/src/components/sidebars/WeekSidebar.tsx:172` affects sprint
status. Its visible "Status" text lives in a sibling `PropertyRow` and is never
associated, which is the general shape of the bug: the design system draws labels
without connecting them.
**Severity: Critical** (axe) / **high** — highest-consequence control in the app, and
`aria-label={member.name}` is a one-line fix.

**W7-5 · Every tab in the app points `aria-controls` at an element that does not
exist.** `web/src/components/ui/TabBar.tsx:25` sets
`aria-controls={`tabpanel-${tab.id}`}`, but `role="tabpanel"` occurs **0 times** in
`web/src` and no element anywhere declares an `id` of the form `tabpanel-*`. axe flags
only the selected tab per page (2 nodes total) because the rule checks the active
reference, but the defect is in every tab the component renders. Screen reader users
get a tablist whose tabs control nothing, and no way to move from a tab to its content.
The component also has no arrow-key handling, which the tabs pattern expects.
**Severity: Critical** (axe) / **medium** — low node count, systemic cause, and the
content is still reachable by Tab.

**W7-6 · The 11 passing accessibility E2E tests pass because of test data volume,
not because the app conforms.** `e2e/accessibility.spec.ts` runs axe on four pages
(login, app shell, `/docs`, `/programs`), filters to `critical`/`serious`, and asserts
zero. Re-run during this audit: **11 passed in 33.4s.** The same `/docs` page in the
audit's seeded workspace has 2 critical+serious violations.

The reason is exact and checkable. The offending markup is the "N more…" `<li>` at
`web/src/pages/App.tsx:651-659`, rendered only when `workspaceHiddenCount > 0` — and
`SIDEBAR_ITEM_LIMIT = 10` at `App.tsx:604`. axe's own selector confirms it:
`ul[aria-label="Workspace documents"] > li:nth-child(11)`. The suite runs against
`e2e/fixtures/isolated-env.ts`, which creates a workspace with far fewer than 11
root documents, so the element never renders and the assertion never has anything to
catch. The suite is not wrong; it is under-powered, and the same threshold effect will
hide any future violation that only appears at realistic scale.

Coverage is also thin: 4 of 17 pages. `/settings`, which holds 24 of the 34 critical
nodes found, is not scanned by any test.
**Severity: high** — a green suite that certifies a claim it cannot test is worse than
no suite, because it stops anyone from looking.

**W7-7 · The test named "focus is visible on all interactive elements" cannot fail.**
`e2e/accessibility.spec.ts:175` checks exactly one element — `#email` on the login
page — and its condition is:

```js
styles.outlineStyle !== 'none' ||
styles.boxShadow !== 'none' ||
styles.borderColor !== styles.getPropertyValue('--border')
```

Ship defines no `--border` CSS custom property (`web/src/index.css` declares one custom
property, `--mx-auto-offset`; the palette lives in `web/tailwind.config.js`, which emits
literal colours). Verified in the browser: `getPropertyValue('--border')` returns `""`
and `borderColor` returns `rgb(229, 231, 235)`, so the third clause is **always true**.
The test passes regardless of whether any focus indicator exists.

That matters because focus indicators are genuinely at risk here: **22 of the 86
`focus:outline-none` occurrences in `web/src` have no `focus:ring`, `focus-visible:`,
`focus:border` or `focus:shadow` replacement within ±250 characters** — including
`ConfirmDialog.tsx:35`, `CommandPalette.tsx:258`, `SessionTimeoutModal.tsx:134`, four
sites in `ProjectCombobox.tsx` and four in `ProgramCombobox.tsx`. That heuristic is a
proximity match, not proof, and WCAG 2.4.7 is one of the two criteria a human still has
to confirm. But the one test that claims to cover it is inert.
The neighbouring test `"can navigate main app with keyboard"` (`:148`) presses Tab twice
and asserts the URL did not change; it makes no claim about reachability either.
**Severity: high** — two of the three keyboard/focus tests assert nothing.

**W7-8 · Eight pages share the page title "Ship | Ship".** Measured across the 17
pages: `/my-week`, `/dashboard`, `/projects` and all five document editors return
`document.title === "Ship | Ship"`; `/login` and `/admin` return the untouched default
`"Ship - Project Management & Documentation"`. Only **7 of 17** pages have a title that
identifies them. No automated rule catches this — axe's `document-title` only checks
that a title exists and is non-empty — but WCAG 2.4.2 Page Titled is **Level A**, and
titles are how screen reader users and tab-switchers tell pages apart. Every document
editor being called "Ship | Ship" is the worst case, since that is where a user has
many similar pages open.
**Severity: medium** — Level A, invisible to tooling, cheap to fix.

**W7-9 · Structural best-practice failures: two `<main>` landmarks, a missing `h1`,
and no landmark on login.** From the default rule set: `/settings` renders **two**
`<main>` landmarks (`landmark-no-duplicate-main`, `landmark-unique`,
`landmark-main-is-top-level`); the project document page has **no `<h1>`**
(`page-has-heading-one`, and it is the only page of the 17 without one); `region` flags
5 nodes of content outside any landmark; `login` has no `<main>` and no skip link, and
`/admin` has no skip link. `empty-table-header` fires 4 times.
**Severity: Moderate** (axe best-practice) / **low-to-medium** — none of these are
WCAG 2.1 AA failures, which is why they are ranked below W7-1…W7-5, but duplicate
`main` landmarks and a missing `h1` degrade exactly the "understand the page structure"
property p.7 asks about, and they are trivial to fix.

**W7-10 · The published compliance claim is stronger than the evidence.**
`README.md:263` states *"Ship is Section 508 compliant and meets WCAG 2.1 AA
standards"* with badges at `README.md:16-17`, and bullets *"All color contrasts meet
4.5:1 minimum"* and *"Visible focus indicators"*. `docs/application-architecture.md:562`
asserts *"Section 508 strict compliance"* for government deployment.

Measured: 61 contrast nodes below 4.5:1 with a worst case of 1.84:1, 34 critical
nodes, and 22 focus-outline removals with no replacement. The architecture doc also
attributes the guarantee to shadcn/ui and Radix primitives providing *"Proper ARIA
attributes"* — Radix does hold up where it is used (the dialog traps focus and closes
on Escape, as measured), but the violations are concentrated in hand-rolled markup that
never went through those primitives: raw `<select>`, hand-built trees, a hand-built
`TabBar`.
**Severity: high (non-technical)** — for a Treasury deployment, an overstated Section
508 claim is a procurement and legal exposure, not just a bug. Recorded separately from
the technical findings because the fix is partly editorial: either the claim comes down
or the violations go.

**W7-12 · 42% of controls are announced identically to another control on the same page.**
Measured by simulated screen-reader announcement over the real DOM: **388 of 914 controls**
across five pages, in **57 groups**. None is silent — 0 of 914 announce a bare role — so this
is invisible to a scanner checking for missing accessible names, and axe reports nothing for
the worst instance.

```
/docs      52x  "button, Delete document"        <- destructive, no document named
/docs      52x  "button, Add sub-document"
/settings  24x  "combobox, member, has popup listbox, not expanded"
```

`/docs` is the serious one and is not covered by any existing finding. Fifty-two delete
buttons announce the same three words. The document each one destroys is never spoken, so a
screen reader user has no way to confirm the target of an irreversible action from the control
itself.

`/settings` is the same defect as W7-4 seen from the other end: the accessible name is empty,
so the control announces its *value* instead, and every member with the same role produces an
identical phrase.

Fixing this is the same edit as W7-4 — an `aria-label` carrying the row's subject — so the two
should be fixed together, but they are separate findings because a scanner catches one and
cannot catch the other.

**Severity: high.** Measured behaviour, not a heuristic, and it defeats safe operation of a
destructive control.

**W7-11 · Heading structure does not support screen reader navigation.** `/issues` exposes
**2,257 accessibility nodes behind 2 headings**; `/settings` has **1 heading for 117
interactive controls**. Headings are how screen reader users skip through a page — the rotor
lists them and jumps between them. At this density there is nothing to jump to, so navigation
degrades to linear traversal of hundreds of nodes.

This is invisible to the automated scores: `/issues` scores **100** in Lighthouse and has
**zero** unnamed controls. Both tools check that headings are correctly *formed*, not that
enough of them exist to be useful. **Severity: medium** — no violation is technically
occurring, but the page is impractical to navigate non-visually, which is the actual claim
Section 508 and WCAG 2.1 AA make.

### What this means for the improvement target

p.7 sets the bar at: *"Achieve a Lighthouse accessibility score improvement of 10+
points on the lowest-scoring page, or fix all Critical/Serious violations on the 3 most
important pages. Provide before/after Lighthouse reports or axe scan output as
evidence."*

**The two routes are not equally honest, and the first one is a trap.**

The lowest-scoring page is `/admin` at **88**. Its two failing audits are one unlabeled
icon button (`AdminDashboard.tsx:121`) and one `text-accent` link. Adding an
`aria-label` and changing one colour scores **100** — a 12-point gain that clears the
target from a single afternoon's work on a super-admin-only page almost no user sees.
It satisfies the letter of the target and improves accessibility for approximately
nobody. Recorded because it is the cheapest path, and someone should decide
deliberately whether to take it rather than discover it by accident.

**The second route is the one worth taking.** "The 3 most important pages" should be
`/settings`, `/docs`, and a document editor — which between them hold 24 of the 34
critical nodes, the tree-role defect, and the editor's `aria-allowed-attr` failure.
Fixing all Critical/Serious violations there means: 24 `aria-label`s on
`WorkspaceSettings.tsx:324`, `role="treeitem"` on two `<li>`s in `App.tsx`, and the
`accent` token. Three changes, two of them one-liners.

Note that this route also exposes the Lighthouse problem: `/settings` already scores
100, so **no Lighthouse before/after can show the 24-violation fix**. Evidence for that
page has to be axe scan output, which the target explicitly permits
(*"or axe scan output as evidence"*). `docs/audit/scripts/measure-a11y.py` run
identically before and after is the intended artifact, per Implementation Rule 1's
requirement that measurements run *"under identical conditions"* (p.8).

Two things Phase 2 owes beyond the scored target:

1. **W7-6 makes any before/after suspect until the fixture is fixed.** A regression test
   added to `e2e/accessibility.spec.ts` against `isolated-env` will pass on a workspace
   with 10 documents whether or not the bug is fixed. Implementation Rule 3 requires
   *"a corresponding regression test that would have caught it"* (p.8); for the tree
   violation that means the fixture must create more than `SIDEBAR_ITEM_LIMIT` root
   documents, or the test is theatre.
2. **The screen reader pass and the focus-visibility pass still have to happen.** Both
   are named in p.7 and neither is scriptable. W7-3 (tree role without tree behaviour)
   and W7-7 (22 unreplaced `focus:outline-none`) are the two findings a human session
   would most likely expand, and both sit outside what any axe or Lighthouse number in
   this report can settle.

---

## Category 8 — Terraform Plan Review

### How it was measured

Terraform was not installed on this machine. `brew install terraform` **fails** —
HashiCorp's BUSL relicence removed it from homebrew-core, and the name now resolves to
unrelated formulae (`terraform-ls`, `terraformer`, …). Installed from the vendor tap
instead:

```bash
brew install hashicorp/tap/terraform      # Terraform v1.15.8, darwin_arm64
```

This is genuine HashiCorp Terraform, not OpenTofu. The repo's `.terraform-version` asks
for `1.6.0` and every root declares `required_version = ">= 1.6.0"`, so 1.15.8 satisfies
the constraint — but it is not the version the repo pins, which matters for W8-4.

```bash
docs/audit/scripts/measure-terraform.py            # canonical baseline
docs/audit/scripts/measure-terraform.py --json     # machine-readable
```

**Everything was run against a scratch copy of `terraform/`, never the repo.** `terraform
init` writes a `.terraform.lock.hcl` into whatever root it runs in, and the *absence* of
lock files in four of the five roots is one of the findings — initialising in place would
have destroyed the evidence. The tree was copied to a scratch directory first so relative
`source = "../../modules/..."` paths still resolve:

```bash
cp -R terraform "$SCRATCH/tfcopy/"
cd "$SCRATCH/tfcopy/terraform" && terraform init -backend=false
```

#### `terraform plan` against AWS could not be run. Here is exactly why.

p.7 states *"No AWS account or cloud credentials are required."* That is true of the local
provider exercise. It is **not** true of this repo's Terraform, which is 100% AWS. There
are no credentials on this machine: no `AWS_*` environment variables, no `~/.aws`
directory (`ls: /Users/joanmiguel/.aws: No such file or directory`), and no `aws` CLI
binary (`command not found: aws`).

Three attempts, in escalating order:

**1. `terraform init` (as the README instructs).** Blocked before any provider work — the
S3 backend has no bucket name committed, by deliberate design:

```
Initializing the backend...
bucket
  The name of the S3 bucket
  Enter a value:
Error: Error asking for input to configure backend "s3": bucket: EOF
```

The bucket name lives in SSM and the README says to fetch it with
`aws ssm get-parameter --name /ship/terraform-state-bucket`. That needs the `aws` CLI and
credentials — neither exists here.

**2. `terraform init -backend=false`.** Succeeds. Downloads providers, resolves modules,
and enables `terraform validate`. It does not enable `plan`, because plan requires state.

**3. Backend neutralised in the scratch copy only** (a `zz_override.tf` declaring
`backend "local" {}`, written into the *copy*, never the repo) so that `plan` could get
past state loading and reach the provider. It reaches provider authentication and stops:

```
Error: No valid credential sources found

  with provider["registry.terraform.io/hashicorp/aws"],
  on versions.tf line 24, in provider "aws":
  24: provider "aws" {

Error: failed to refresh cached credentials, no EC2 IMDS role found,
operation error ec2imds: GetMetadata, exceeded maximum number of attempts, 3,
request send failed, Get
"http://169.254.169.254/latest/meta-data/iam/security-credentials/": dial tcp
169.254.169.254:80: connect: host is down
```

**No AWS plan output appears in this document.** None was obtainable, and none is
invented. Even with credentials the plan would be meaningless here: the real state lives
in a remote S3 bucket, so a plan against an empty local state would report "create
everything" rather than the real diff.

**What replaces it**, and it is labelled as such wherever it appears:

| Instead of | Used | Gives |
|---|---|---|
| `terraform plan` | `terraform validate` (all 5 roots) | config correctness + provider warnings |
| `terraform providers` | same, backend overridden in the copy | resolved provider dependency tree |
| plan resource list | `terraform graph` + static parse | exact managed-resource inventory per root |
| plan change verbs | AWS provider ForceNew semantics read from the resource definitions | blast-radius classification |

`terraform graph` is a real Terraform command reading the real configuration, so the
inventory below is Terraform's own view, not a grep. It reports the resources a plan
*would* address; it cannot report which are already created or drifted.

**Cross-check.** The Python parser and `terraform graph` were run independently and agree
exactly: root 74, bootstrap 5, `environments/prod` 66, `environments/dev` 52,
`environments/shadow` 52. Both numbers are reported because shell counting has produced
wrong figures twice on this project — a first pass here also failed
(`paste -sd+ | bc` returned empty for every directory), which is why the canonical script
is Python.

The drift demonstration is real, ran end-to-end, and needed no cloud account. It lives in
a scratch directory, not the repo.

### Baseline

Every figure below was re-derived this pass. **F25's inventory is confirmed on five points
and corrected on two** — see the corrections after the table.

| Metric | Value |
|---|---|
| `.tf` files under `terraform/` | **42** |
| `resource` blocks (all dirs) | **145** |
| `data` blocks / `module` calls | 14 / 16 |
| Terraform roots | **5** (root, bootstrap, dev, shadow, prod) |
| Reusable modules | **6** |
| Providers required | **2** — `hashicorp/aws`, `hashicorp/random` |
| Provider constraints declared | **9** |
| — exactly pinned | **0** |
| — range-constrained | **9** (`~> 5.0`, `~> 3.6`) |
| `required_version` | `>= 1.6.0` (all 5 roots) |
| `.terraform.lock.hcl` on disk | **7** |
| Roots *without* a lock file | **4 of 5** |
| State locking configured | **none** — no `dynamodb_table`, no `use_lockfile` |
| Saved plan files committed to git | **1** (`terraform/environments/shadow/tfplan`) |

**Managed resources per root** (`terraform graph`, confirmed by the script):

| Root | Static `resource` blocks | Managed resources | Composition | Lock file |
|---|---:|---:|---|---|
| `terraform/` (legacy flat) | 74 | **74** | direct, no modules | **NO** |
| `bootstrap/` | 5 | **5** | direct | **NO** |
| `environments/dev` | 0 | **52** | 5 modules, shared VPC via SSM | **NO** |
| `environments/shadow` | 0 | **52** | 5 modules, shared VPC via SSM | **NO** |
| `environments/prod` | 0 | **66** | 6 modules, own VPC | yes |

**Modules:** `cloudfront-s3` 20 · `vpc` 14 · `ssm` 12 · `elastic-beanstalk` 10 ·
`aurora` 6 · `security-groups` 4 = 66.

Static block counts understate instances: `modules/vpc` uses `count = var.az_count` on
subnets and route-table associations, so 14 blocks become ~18 instances at `az_count = 2`.

**Lock file contents** — the reason this matters is in W8-4:

| Location | aws | random | declares `required_providers`? |
|---|---|---|---|
| `environments/prod` | **5.100.0** | 3.7.2 | yes (`~> 5.0`, `~> 3.6`) |
| `modules/aurora` | **6.28.0** | 3.7.2 | **no** |
| `modules/cloudfront-s3` | **6.28.0** | — | **no** |
| `modules/elastic-beanstalk` | **6.28.0** | — | **no** |
| `modules/security-groups` | **6.28.0** | — | **no** |
| `modules/ssm` | **6.28.0** | 3.7.2 | **no** |
| `modules/vpc` | **6.28.0** | — | **no** |

All 7 are git-tracked even though `terraform/.gitignore` lists `.terraform.lock.hcl` —
they predate the ignore rule, so any *new* lock file will be silently ignored.

**Corrections to F25** (superseded, with reasons):

| F25 claim | Measured | Why it changed |
|---|---|---|
| "Single provider: `hashicorp/aws`" | **Two** — `aws` *and* `hashicorp/random ~> 3.6` | `random` is declared in all four non-bootstrap roots and produces 2 real resources (`random_password.db_password`, `random_password.session_secret`). Missing it understates the secret-generation blast radius. |
| "`environments/dev` and `environments/shadow` have none" | True but incomplete — **4 of 5 roots** have none | The legacy root `terraform/` and `bootstrap/` also lack lock files. The root is the one the deploy script actually applies (W8-2), so this is the more serious half of the gap. |

Confirmed unchanged: 42 `.tf` files · root ~74 resources (exactly 74) · bootstrap ~5
(exactly 5) · envs compose 5–6 modules · `~> 5.0` constrained not pinned ·
`required_version = ">= 1.6.0"` · EB `MinSize=1`, `MaxSize=4`, `LoadBalanced`, no
stickiness.

**`terraform validate` — all 5 roots pass.** One warning, identical in dev/shadow/prod
(it comes from the shared module) and present again in the root's own copy:

```
Warning: Invalid Attribute Combination
  with module.cloudfront_s3.aws_s3_bucket_lifecycle_configuration.uploads,
  on ../../modules/cloudfront-s3/main.tf line 440
No attribute specified when one (and only one) of
[rule[0].filter, rule[0].prefix] is required
This will be an error in a future version of the provider
```

`terraform providers`, root:

```
Providers required by configuration:
.
├── provider[registry.terraform.io/hashicorp/aws] ~> 5.0
└── provider[registry.terraform.io/hashicorp/random] ~> 3.6
```

### Annotated plan

p.8 asks for *"Annotated terraform plan output explaining every resource and its blast
radius"* and, per bullet 2, *"for every resource it will create, modify, or destroy, write
one sentence explaining what it is and whether the change is safe."*

**This is a static annotation, not plan output.** No plan was obtainable (see above).
Change verbs below are derived from the AWS provider's ForceNew semantics read against
each resource definition — they say what *would* happen if that attribute changed, not
what a live plan reports today. A real plan requires state and credentials and remains
owed.

Annotated at the root `terraform/` (74 resources) because that is what
`scripts/deploy-infrastructure.sh` actually applies:

```bash
cd "$SCRIPT_DIR/../terraform"
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

#### Networking — 12 resources

| Resource | n | What it is | Change verb | Safe? |
|---|---:|---|---|---|
| `aws_vpc.main` | 1 | 10.0.0.0/16 network | `cidr_block` is **ForceNew** | **Risky** — replacing the VPC cascades to every resource in it |
| `aws_subnet.public` / `.private` | 2 (`count=az_count`) | 2 public + 2 private subnets across AZs | `cidr_block`, `availability_zone` **ForceNew** | **Risky** — subnet replacement detaches EB instances and the Aurora subnet group |
| `aws_internet_gateway.main` | 1 | Public egress | in-place (tags) | Safe |
| `aws_nat_gateway.main` | 1 | Private egress for EB Docker pulls | **ForceNew** on subnet/EIP | Moderate — ~2 min outage on outbound pulls |
| `aws_eip.nat` | 1 | Static IP for the NAT | **ForceNew** | Moderate — the public IP changes; breaks any downstream allowlist |
| `aws_route_table` / `_association` | 4 | Public + private routing | in-place | Safe |
| `aws_flow_log` + `aws_cloudwatch_log_group` | 2 | VPC flow logging | in-place (`retention_in_days`) | Safe |

#### Database — 5 resources, the highest-consequence group

| Resource | What it is | Change verb | Safe? |
|---|---|---|---|
| `aws_rds_cluster.aurora` | Aurora Serverless v2 PostgreSQL, the entire application datastore | `cluster_identifier`, `database_name`, `master_username` are all **ForceNew** | **Highest risk in the repo.** Replacement destroys the production database. `deletion_protection` is not set anywhere. |
| `aws_rds_cluster_instance.aurora` | The single writer instance | `identifier` **ForceNew** | **Risky** — one instance, no reader, so replacement is a full outage |
| `aws_rds_cluster_parameter_group.aurora` | pg16 tuning (`statement_timeout`, `max_connections`, …) | `name` **ForceNew**; attaching a new group needs a **cluster reboot** | Moderate — reboot is a short outage |
| `aws_db_subnet_group.aurora` | Which subnets Aurora sits in | `name` **ForceNew**, and it is referenced by the cluster | **Risky** — cascades into cluster replacement |
| `random_password.db_password` | Generates the master password | Regenerates only if `keepers` change or the resource leaves state | Moderate — regeneration rewrites `master_password` in place, then SSM; instances holding the old password fail until they re-read |

`skip_final_snapshot = var.environment != "prod"`, so a destroy in dev/shadow takes **no
final snapshot at all**. `lifecycle { ignore_changes = [final_snapshot_identifier] }`
correctly neutralises the `timestamp()` call that would otherwise produce a perpetual diff.

#### Compute — 11 resources

| Resource | What it is | Change verb | Safe? |
|---|---|---|---|
| `aws_elastic_beanstalk_environment.api` | The running API environment, `ship-api-prod` | `name` and `solution_stack_name` are **ForceNew** | **Risky** — the stack is hardcoded to `64bit Amazon Linux 2023 v4.9.0 running Docker`; when AWS retires that platform the value becomes invalid and apply fails |
| `aws_elastic_beanstalk_environment` `setting{}` changes | ~30 config settings | in-place, via `RollingWithAdditionalBatch`, `BatchSize=1`, `Timeout=600` | Safe — this is genuinely zero-downtime and correctly configured |
| `aws_elastic_beanstalk_application.api` | Container for app versions | `name` **ForceNew** | Moderate — replacement drops application versions |
| `aws_iam_role` ×4, `aws_iam_role_policy` ×5, `aws_iam_role_policy_attachment` ×5, `aws_iam_instance_profile` ×1 | EB instance + service roles and their policies | `name` **ForceNew**; policy bodies in-place | Mostly safe; an instance-profile replacement forces an EB instance refresh |

`lifecycle { ignore_changes = [version_label] }` is correct and necessary — the deploy
script writes `version_label` on every deploy, so Terraform must not fight it. It does mean
Terraform and the deploy script co-own this resource, which is a standing drift source.

#### Frontend and edge — 20 resources

| Resource | What it is | Change verb | Safe? |
|---|---|---|---|
| `aws_cloudfront_distribution.main` | The CDN in front of the SPA and API | Nearly all attributes in-place, but each deploy takes ~10–15 min to propagate | Safe but slow; a bad change is slow to roll back |
| `aws_s3_bucket` ×2 | SPA assets + user uploads | `bucket` (name) **ForceNew** | **Risky** — bucket replacement means data loss; no `force_destroy`, so a non-empty bucket fails the destroy instead, which is the safer failure |
| `aws_s3_bucket_policy`, `_public_access_block` ×2, `_versioning` ×2, `_server_side_encryption_configuration` ×2, `_cors_configuration`, `_lifecycle_configuration` | Bucket hardening | in-place | Safe — but the lifecycle rule carries the `validate` warning above |
| `aws_acm_certificate.app` + `_validation` | TLS cert | `domain_name` **ForceNew**; validation waits on DNS | Moderate — replacement stalls apply until DNS validates |
| `aws_route53_record` ×2 | Apex + validation records | in-place (upsert) | Safe |
| `aws_cloudfront_function`, `_cache_policy`, `_origin_request_policy`, `_origin_access_control`, `_realtime_log_config` + `aws_kinesis_stream` | SPA routing, caching, real-time logs | in-place | Safe |

#### Security and config — 26 resources

| Resource | n | What it is | Change verb | Safe? |
|---|---:|---|---|---|
| `aws_security_group` | 3 | ALB, EB instances, Aurora | `name` **ForceNew**; rules in-place | Moderate — SG replacement briefly detaches from the ENI |
| `aws_security_group_rule` | 1 | Discrete rule | in-place | Safe |
| `aws_wafv2_web_acl` / `_ip_set` / `_regex_pattern_set` | 3 | Edge WAF | in-place | Safe |
| `aws_ssm_parameter` | 9 | `DATABASE_URL`, `DB_PASSWORD`, `SESSION_SECRET` (SecureString) + 6 plain | in-place | **Moderate** — `SESSION_SECRET` rotation invalidates every live session at once |
| `random_password.session_secret` | 1 | Generates that secret | Regenerates if it leaves state | Moderate, same reason |

#### Blast radius if `terraform apply` ran right now

Bullet 3 asks for the **worst case**. Derived from resource definitions and provider
behaviour, not from a plan — with no state on this machine I cannot know which resources
are currently in sync.

| Class | Resources | Consequence |
|---|---|---|
| **Safe no-ops** (steady state) | ~55 of 74 | Tag-only and in-place-attribute resources: route tables, WAF, bucket sub-configs, IAM policy bodies, CloudFront policies, flow logs |
| **Modified in place** | ~12 | EB `setting{}` blocks (rolling, zero-downtime), SSM values, security-group rules, CloudFront distribution config (slow propagation) |
| **Recreated → downtime** | ~7 | `aws_rds_cluster` + `aws_rds_cluster_instance` + `aws_db_subnet_group` + `aws_rds_cluster_parameter_group`, `aws_elastic_beanstalk_environment`, `aws_s3_bucket` ×2 |

The single worst realistic case is **not** a config edit. It is applying
`environments/prod/` against infrastructure the legacy root created, because the two
define production differently (W8-2):

- Every resource is renamed (`ship-aurora` → `ship-prod-aurora`, `ship-eb-instance-role` →
  `ship-prod-eb-instance-role`). Name is ForceNew on Aurora, the subnet group, the
  parameter group, IAM roles and buckets — so **the entire stack including the database is
  destroyed and recreated**, with `skip_final_snapshot` deciding whether a backup survives.
- The EB *environment* name is the one thing that does **not** change: root hardcodes
  `${var.project_name}-api-prod` and the module computes `ship-api-${environment}` =
  `ship-api-prod`. Same physical name, two state files. AWS rejects duplicate EB
  environment names, so whichever applies second errors out mid-apply — after the
  destructive database changes have already begun.
- `engine_version` differs: root `database.tf:38` says **16.8**, `modules/aurora/main.tf:65`
  says **16.4**. Applying the module against a 16.8 cluster requests a downgrade, which RDS
  refuses.

### Drift detection

p.8 bullet 2: *"using the local provider, write a Terraform config that manages a local
file resource. Manually edit the file outside of Terraform to simulate a drift condition.
Re-run terraform plan and capture the diff showing what Terraform detects has changed."*

Run for real with `hashicorp/local`, no cloud account. Kept **outside the repo**
(`$SCRATCH/tf-drift-demo`) so it cannot be mistaken for the Phase 2 deliverable. One
resource, matching this bullet — p.8's "at least two local resources" belongs to the
improvement target and was deliberately not built.

```hcl
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    local = {
      source  = "hashicorp/local"
      version = "2.5.2"   # exactly pinned
    }
  }
}

resource "local_file" "app_config" {
  filename        = "${path.module}/out/app.config.json"
  file_permission = "0644"
  content         = jsonencode({
    service = "shipshape-api"
    port    = 3000
    logging = { level = "info" }
  })
}
```

```
$ terraform init && terraform apply -auto-approve
local_file.app_config: Creation complete after 0s [id=eb3015e649cb282495322d6606aec709f4c1d5ff]
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

**BEFORE — plan with no drift:**

```
local_file.app_config: Refreshing state... [id=eb3015e649cb282495322d6606aec709f4c1d5ff]

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

**Manual change made outside Terraform** — `port` 3000→8080, log level `info`→`debug`:

```bash
echo '{"logging":{"level":"debug"},"port":8080,"service":"shipshape-api"}' > out/app.config.json
```

**AFTER — `terraform plan` detects it:**

```
Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # local_file.app_config will be created
  + resource "local_file" "app_config" {
      + content              = jsonencode(
            {
              + logging = {
                  + level = "info"
                }
              + port    = 3000
              + service = "shipshape-api"
            }
        )
      + content_base64sha256 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha256       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0644"
      + filename             = "./out/app.config.json"
      + id                   = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.
```

Drift is detected, and applying restores the declared content. Note the verb: **`create`,
not `update`**. The `local` provider's read stores a content hash; when the hash no longer
matches it clears the resource ID, so Terraform concludes the object is gone rather than
changed. `plan -refresh-only` attributes it explicitly:

```
Note: Objects have changed outside of Terraform

Terraform detected the following changes made outside of Terraform since the
last "terraform apply" which may have affected this plan:

  # local_file.app_config has been deleted
  - resource "local_file" "app_config" {
      - content              = jsonencode(
            {
              - logging = {
                  - level = "info"
                }
              - port    = 3000
              - service = "shipshape-api"
            }
        ) -> null
      - content_md5          = "09b6f1d7dbbd5dcfeee1fab32f58adab" -> null
      - content_sha256       = "7e939a28cd93d438317cbf01f109dfc50614e34cd77b42fb110656edbdebfc05" -> null
      - filename             = "./out/app.config.json" -> null
      - id                   = "eb3015e649cb282495322d6606aec709f4c1d5ff" -> null
    }
```

Two further scenarios were run to establish the limits of this detection:

| Scenario | Result |
|---|---|
| File **deleted** outside Terraform | Detected — `Plan: 1 to add, 0 to change, 0 to destroy` |
| **Permissions** changed, content untouched (`chmod 0666`) | **Not detected** — `No changes`, and `apply` leaves the file world-writable |

The permission case was verified rather than assumed, because it is a claim about provider
behaviour: a fresh create from an absent file does honour `file_permission = "0644"`
(`-rw-r--r--`); after `chmod 0666`, `plan` reports `No changes`, `apply` does not repair
the mode (`-rw-rw-rw-` persists), and a follow-up content edit is still detected — so the
blind spot is specific to file mode, not a broken demo. This matters for the p.8 target,
which proposes managing **environment files** with this provider: `local_file` will not
notice or repair a permissions change on a file holding secrets.

### Weaknesses

**W8-1 · A committed plan file leaks the AWS account ID, a named IAM principal, and live
network IDs.** `terraform/environments/shadow/tfplan` is git-tracked — a 28,542-byte zip
containing a `tfstate` snapshot with fully resolved data-source values. Extracted and
inspected (values redacted here):

```
aws_caller_identity.current  -> arn:aws:iam::############:user/shawn.jones
                                account_id ############, user_id AIDAWX#GPYT#NMB#PXKZ#
aws_ssm_parameter.vpc_id     -> vpc-#f#c###c######f##
aws_ssm_parameter.private_subnet_ids -> subnet-#dacbc#b#fa#c####,subnet-###f##bcafa####df
aws_ssm_parameter.public_subnet_ids  -> subnet-#f######f##f#e#d#,subnet-#####a###d#e#d#d#
aws_ssm_parameter.vpc_cidr   -> ##.#.#.#/##
```

This directly defeats a control the repo states in `versions.tf`:
*"Backend bucket name is not committed to git (compliance requirement)"* — the bucket name
was withheld precisely to keep the account ID out of the repository, and the plan file put
it back. The named IAM user is a real person's identity in a Treasury-deployed system.

Root cause is one missing glob: `.gitignore:72-73` ignores `terraform/*.tfplan` and
`terraform/tfplan`, neither of which matches `terraform/environments/shadow/tfplan`. The
README's own Quick Start tells operators to run `terraform plan -out=tfplan` from inside
`terraform/environments/<env>/`, so the documented workflow produces a file the ignore
rules do not cover.

Cluster passwords are **not** exposed — the state serial is 0 with only data sources
recorded, so `random_password` values were still `(known after apply)`. Checked rather than
assumed. **Severity: high.** Not because of what leaked, but because it is credential-
adjacent disclosure in a compliance-scoped repo, it is already in git history, and the
fix for the file does not remove it from history.

**W8-2 · Two Terraform roots both define production, and the one the deploy script uses is
the less maintained of the two.** `terraform/*.tf` (74 resources) and
`terraform/environments/prod/` (66 resources) are parallel definitions with separate state
keys (`ship/terraform.tfstate` vs `ship/prod/terraform.tfstate`).

`terraform/README.md` documents this — it labels the root *"legacy flat structure,
prod-only"* and says *"New environments should use the environments/ directories."* So the
duplication is deliberate and known, and is not reported as an oversight. What is **not**
acknowledged anywhere:

- `scripts/deploy-infrastructure.sh:24-50` runs `cd ../terraform` — it applies the
  **legacy root**, not `environments/prod/`. `scripts/deploy-frontend.sh:31` does the same
  for `ENV=prod`. The structure the README calls legacy is the structure production
  actually runs on, and it is the one with no lock file.
- The two have **diverged**, not merely duplicated. Root `database.tf:38` sets
  `engine_version = "16.8"`; `modules/aurora/main.tf:65` sets `"16.4"`. The root's Aurora
  parameter group is also missing five hardening parameters the module has
  (`max_connections`, `statement_timeout`, `idle_in_transaction_session_timeout`,
  `log_connections`, `log_disconnections`) — the DDoS-protection settings exist only in the
  path production does not use.
- The EB environment name collides exactly (`ship-api-prod` from both), so the two roots
  claim the same physical AWS resource from different state files.

**Severity: high.** This is the blast-radius finding above, and the divergence means the
"recommended" path is untested against production reality.

**W8-3 · No state locking on any backend.** All four S3 backends declare `key`, `region`
and `encrypt`, and none declares `dynamodb_table` or `use_lockfile`. `bootstrap/main.tf`
creates the state bucket with versioning, encryption and a public-access block but no lock
table — locking was never set up. Two concurrent `terraform apply` runs can interleave
writes and corrupt state. Bucket versioning makes recovery *possible*, not automatic.
**Severity: high** — for infrastructure whose worst case is destroying the production
database, and where a deploy script makes running apply easy.

**W8-4 · Four of five roots have no lock file, `.gitignore` prevents new ones, and the six
that exist record an incompatible provider major.** Measured:

- Roots without `.terraform.lock.hcl`: `terraform/` (the one production uses),
  `bootstrap/`, `environments/dev`, `environments/shadow`. Only `environments/prod` has one.
- `terraform/.gitignore` lists `.terraform.lock.hcl`. The 7 existing files are tracked only
  because they predate the rule; any new one is ignored by default — so the gap is
  self-perpetuating.
- The six module lock files record **aws 6.28.0**, a major version the roots' `~> 5.0`
  constraint forbids. They have no `constraints` line at all, because the modules declare no
  `required_providers` — they are stray artifacts of someone running `terraform init` inside
  a module directory, which is not how modules are consumed. They lock nothing and describe
  a provider that cannot be used.
- All 9 declared constraints are ranges; **0 are pinned**.

Demonstrated live, not projected: initialising `environments/prod` (has a lock) resolved
`random 3.7.2`, while `environments/dev` and `environments/shadow` (no lock) resolved
`random 3.9.0` — from identical configuration, in the same session, minutes apart. That is
the reproducibility failure happening in practice.
**Severity: medium-high.** Nothing is broken today; the risk is that a future `init` picks
up a new AWS 5.x minor and changes plan output under an operator who is mid-incident.
p.8's target — *"Both configs must have pinned provider versions"* — targets exactly this.

**W8-5 · The load balancer has no session stickiness while the app keeps collaboration
state in process memory.** `MinSize=1`, `MaxSize=4`, `EnvironmentType=LoadBalanced`,
`LoadBalancerType=application`, with a CPU trigger that scales out at 70%. Grepping the
whole tree for `stickiness` / `StickinessEnabled` returns **nothing**, so the ALB default
(disabled) applies.

The API terminates Yjs WebSocket collaboration and holds document state in module-level
`Map`s (F31; `src/collaboration` sits at 8.53% statement / 2.42% branch coverage per
Category 5). With stickiness off and `MaxSize=4`, the autoscaling policy is the trigger for
the split-brain condition: two clients on the same document routed to different instances
get divergent state, and the debounced persistence path writes whichever loses. The
infrastructure does not cause F31, but it converts it from a latent multi-process bug into
something a traffic spike sets off. **Severity: high** — this is the infra half of the
worst application defect in the audit, and `MaxSize=4` means it is one busy afternoon away.

**W8-6 · Nothing protects the database from deletion.** `deletion_protection` is not set on
`aws_rds_cluster` in either the root or the module. `prevent_destroy` appears exactly once
in 42 files — on the bootstrap state bucket, not on any data resource. And
`skip_final_snapshot = var.environment != "prod"` means a destroy in dev or shadow takes no
final snapshot at all. **Severity: medium** — prod does snapshot, and destroying prod takes
a deliberate act, but the guardrail that makes that act safe is absent everywhere.

**W8-7 · Hardcoded platform and engine versions are standing drift and failure sources.**
`solution_stack_name = "64bit Amazon Linux 2023 v4.9.0 running Docker"` is pinned in both
EB definitions. AWS retires solution stacks on a schedule; when this one goes, apply fails
with an invalid-stack error at the worst possible time. `engine_version` is likewise
hardcoded (16.8 / 16.4) with no `ignore_changes`, so any AWS-side minor auto-upgrade shows
up as a permanent diff proposing a downgrade. **Severity: medium.**

**W8-8 · A `validate` warning that becomes an error on the next provider major.** The
`aws_s3_bucket_lifecycle_configuration.uploads` rule specifies neither `filter` nor
`prefix`. The provider says *"This will be an error in a future version of the provider."*
Combined with W8-4 — no pinning, and module locks already pointing at aws 6.x — an
unlucky `init` upgrade turns a warning into a hard apply failure. Present in both the root
copy and the shared module, so it affects all environments. **Severity: low-medium** — a
two-line fix, but it is the concrete cost of the unpinned constraint.

**W8-9 · Aurora runs a single instance with no reader.** `aws_rds_cluster_instance.aurora`
is one `db.serverless` instance, `identifier` hardcoded to `...-aurora-instance-1`, with no
`count` and no second instance anywhere. Serverless v2 scales capacity vertically but a
single instance is still a single failure domain; there is no reader to promote, so
instance replacement or AZ loss is a full outage. **Severity: medium.**

**W8-10 · The brief's premise for this category does not match the repo.** p.7 states
*"Deployment is done via Render, which has an official first-party Terraform provider. No
AWS account or cloud credentials are required"* and instructs *"Navigate to terraform/ and
run terraform init followed by terraform plan."* The repo contains no Render provider and
no local provider — it is 100% AWS across all 42 files, behind a remote S3 backend whose
bucket name is deliberately withheld from git. Following p.7 literally cannot produce plan
output on a machine without AWS credentials. **Severity: informational** — no defect in the
codebase, recorded because it is why the primary deliverable is a static annotation rather
than plan output, and because it changes what Phase 2 has to build. Same category as W5-5.

### What this means for the improvement target

p.8 sets the bar at:

> *"Write a new Terraform config that uses the local provider to manage at least two local
> resources (e.g. configuration files, environment files). Then write a second config using
> the Render provider that declares a Render web service and deploys your improved
> ShipShape fork. Both configs must have pinned provider versions. Run terraform plan on
> each and confirm the output matches intent. The Render deployment replaces any manual
> deploy steps — your fork should be deployable from a clean machine using only terraform
> apply."*

Quoted for reference only. **Both configs are Phase 2 work and were deliberately not
written**, per p.3: *"You do not fix anything during the audit."*

Three things this audit establishes that shape that work:

**The target is additive, not a refactor.** It asks for two *new* configs. None of W8-1
through W8-9 is on the critical path to passing — the existing AWS Terraform can be left
untouched and the target still met. That is worth stating plainly, because the highest-
severity findings here (W8-1, W8-2, W8-3, W8-5) would otherwise look like prerequisites.
They are not; they are the reason the *existing* infrastructure is risky.

**"Pinned provider versions" is the one place the target and the findings meet.** W8-4
measured 9 declared constraints, 0 pinned. The drift-demo config above already uses
`version = "2.5.2"` — an exact pin, not `~> 2.5` — so the pattern the target wants is
demonstrated. Applying it to the Render config is mechanical; applying it to the AWS roots
is not, because pinning `~> 5.0` down to `5.100.0` should be done together with generating
the four missing lock files and removing the `.gitignore` rule that suppresses them, and
that is a change to live infrastructure config.

**"Deployable from a clean machine using only `terraform apply`" is a real gap, and this
audit measured its size.** Today a clean machine cannot even run `terraform init` — it
needs AWS credentials, the `aws` CLI, and an SSM lookup to discover the backend bucket, as
the three failed attempts above document. A Render config with a pinned provider and an API
key in an environment variable does clear that bar. If Phase 2 does that, note that it does
**not** retire W8-1 through W8-9 — the AWS stack described here is what production runs on
until something decommissions it.

One caveat on W8-10 for whoever picks this up: p.7 assumes a Render deployment that does
not exist in this repo. Phase 2 will be creating that deployment, not migrating to it, and
the ShipShape architecture measured elsewhere in this audit — Aurora PostgreSQL, WebSocket
collaboration with in-process state (W8-5, F31) — does not port to a single Render web
service without deciding what happens to the database and to Yjs state. That is a design
decision, not a Terraform one.

---

*Measurement script: `docs/audit/scripts/measure-terraform.py`. Terraform v1.15.8 from
`hashicorp/tap`. Drift demo run in a scratch directory outside the repo; no repo Terraform
was modified, no `terraform apply` was run against AWS, and nothing was committed.*

---

## Category 6 — Runtime Error and Edge Case Handling

### How it was measured

Two harnesses, both driving the running app (web :5173, api :3000) in a real browser.

`docs/audit/scripts/measure-runtime-errors.mjs` covers five of p.6's six bullets — console
monitoring, network failure, malformed input, 3G throttling and the server log — plus a static
sweep for error boundaries.

```bash
node docs/audit/scripts/measure-runtime-errors.mjs --out /tmp/cat6-raw.json
```

`docs/audit/scripts/measure-concurrent-edit.mjs` covers the sixth: *"Test concurrent edge
cases: two users editing the same document field simultaneously."* It needs two genuinely
different sessions, which the first harness has no way to produce, so it is a separate script.

```bash
node docs/audit/scripts/measure-concurrent-edit.mjs --out /tmp/cat6-concurrent.json
```

> **Corrected mid-measurement, recorded because it changed the headline number by 11x.**
> The first revision attached a fresh console listener per route, so each of the 11 routes
> registered another listener and every message was recorded once per listener. That reported
> **505** console entries. With a single listener the real figure is **45**. The script now
> attaches exactly once and tags entries by live URL; the comment in `attachConsole` records
> why.

Two selector corrections were also needed before the input and offline bullets could run at
all. `/docs` exposes only a sidebar search box; the editor lives at `/documents/{id}`, reached
via a `/docs/{id}` redirect, with the title as `textarea[placeholder="Untitled"]`. And an
action-items modal auto-opens and intercepts pointer events, so every interaction must clear
it first — see W6-6.

### Baseline

| Metric | Your Baseline |
|---|---|
| Console errors during normal usage | **0** across all 11 routes |
| Unhandled promise rejections (server) | **19** stack frames at `processTicksAndRejections`; 15 from one recurring cause |
| Network disconnect recovery | **Partial** — data survives, UI does not recover |
| Missing error boundaries | **6 top-level routes** (see W6-1) |
| Silent failures identified | **5** (W6-2, W6-3, W6-5, W6-9, W6-10) |
| Concurrent edit — same field, two users | **Title: data loss in 13 of 13 runs. Body: converges when the socket holds, loses everything when it does not — 7 of 12 runs.** |

All 45 client-side console entries came from the edge-case tests. Navigating the app normally
produced **zero**:

```
login 0 · my-week 0 · dashboard 0 · docs 0 · issues 0 · projects 0
programs 0 · weeks 0 · team 0 · settings 0 · admin 0
```

Server log, distinct causes:

```
15x  Plan analysis error: CredentialsProviderError: Could not load credentials
 4x  Update document error: invalid byte sequence for encoding "UTF8": 0x00
 1x  ForbiddenError: invalid csrf token
19x  at process.processTicksAndRejections   (async frames under the above)
```

Malformed input against the document title:

| Payload | Sent | Accepted | Persisted | Script executed |
|---|---:|---:|---:|---|
| empty | 0 | 0 | **26** | no |
| 100k chars | 100,000 | 100,000 | **100,000** | no |
| unicode / control chars | 31 | 31 | 31 | no |
| `<img src=x onerror=…>` | 38 | 38 | 38 | **no** |
| `<script>…</script>` | 33 | 33 | 33 | **no** |
| `'; DROP TABLE documents; --` | 27 | 27 | 27 | **no** |
| template-injection | 50 | 50 | 50 | **no** |

3G throttle (Chrome "Slow 3G": 400 ms latency, 400 kbps):

| Route | DOM ready | Settled | Loading state shown |
|---|---:|---:|---|
| `/my-week` | 13,242 ms | 15,105 ms | **no** |
| `/docs` | 13,220 ms | 15,139 ms | **no** |
| `/issues` | 13,267 ms | 15,191 ms | **no** |

### Weaknesses

**W6-9 · Two users editing the same title: one edit is silently destroyed, every time.**
Ship stores a document's two editable fields two different ways. The body is TipTap bound to
a Yjs CRDT over the collaboration WebSocket. The title is plain React state saved by a
debounced PATCH — `web/src/components/Editor.tsx:187`:

```ts
const [title, setTitle] = useState(initialTitle === 'Untitled' ? '' : initialTitle);
```

Nothing reconciles two concurrent writers of that field. The last debounced PATCH to land
overwrites the whole column.

Measured across **13 runs** in which the pre-test reset verifiably held:

| | Result |
|---|---:|
| Runs where exactly one user's edit was destroyed | **13 of 13** |
| Runs where both users' text survived | **0 of 13** |
| Runs showing any conflict, merge or overwrite warning | **0 of 13** |

Which user loses is not deterministic — user A lost in 9 runs, user B in 4, on identical
inputs. Both clients then converge on the winner's value, so the loser watches their own
typing disappear from their own screen with no explanation.

Reproduction: open the same document as two users, type into the title in both, wait five
seconds. The body, by contrast, behaves correctly — the CRDT interleaves both streams and
every character survives, which is what makes the title's behaviour a defect rather than a
design limit. The mechanism for doing this right is already in the codebase; the title field
simply does not use it.

**Severity: critical.** Silent, unrecoverable, user-facing data loss on the most visible field
of a document, in an application whose stated purpose is real-time collaboration.

**W6-10 · Collaboration stops working after the first session and the UI still reports
"Saved".** Repeating the same two-client test against the same running API degrades:

| Session since API start | Sockets opened / closed (user A) | Body edits reaching the server |
|---|---|---|
| 1st | 7 / 6 — one held open | **A +8, B +8, clients converged** |
| 2nd | 14 / 14 — none held | **A +0, B +0, clients diverged** |
| 3rd | 18 / 18 — none held | **A +0, B +0, clients diverged** |

The collaboration WebSocket reconnect-loops and never holds. Meanwhile the editor keeps
accepting keystrokes, each client accumulates its own divergent copy, no peer receives
anything, nothing is persisted — and the status indicator reads **"Saved"** the entire time.

Three controls establish this is process-level state, not the document or the database:
a brand-new document fails the same way on the second session; the failure follows the API
process rather than the document; and restarting the API makes the *same document that just
failed twice* work immediately (`raw/cat6-concurrent-raw.json`, run `after-restart`).

This is the same module-level-`Map` state described in the architecture section, observed
failing. It also compounds W6-5: that finding recorded the UI failing to recover after a
*deliberate* disconnect, where data at least survived. Here the disconnect is spontaneous and
the data does not survive.

**Severity: critical.** In deployment this is worse than measured — the audit's scaling
finding notes the collaboration state cannot be shared across processes, so a second instance
cannot repair a session the first one has lost.

**W6-1 · Six top-level routes have no error boundary.** The only boundaries are
`web/src/pages/App.tsx:541`, wrapping `<Outlet />`, and `web/src/components/Editor.tsx:980`.
`App` renders under the `/` route, so everything routed outside it is unprotected:

```
/feedback/:programId     PublicFeedbackPage   — public, unauthenticated
/setup                   SetupPage
/login                   LoginPage
/invite/:token           InviteAcceptPage
/admin                   AdminPage
/admin/workspaces/:id    AdminWorkspacePage
```

A render error on any of these unmounts to a blank white page with no recovery path. The
public feedback route and the login page are the worst of them — both are reachable by people
who cannot be told to "try refreshing." **Severity: high.**

**W6-2 · Clearing the document title silently reverts it.** Emptying the field is accepted by
the UI (`accepted=0`), but after a reload the old title is back (`persisted=26`). No error, no
toast, no indication the edit was rejected. The user watches their change disappear.
**Severity: high** — this is a real user-facing data-loss-shaped scenario, which is exactly
what p.7's improvement target asks for: *"At least one must involve a real user-facing data
loss or confusion scenario (not just a missing loading spinner)."*

**W6-3 · A 100,000-character title is accepted and persisted.** No length cap client-side or
server-side. The title renders in the sidebar, breadcrumbs, and document header, so a single
paste degrades every view that lists it. **Severity: medium.**

**W6-4 · Malformed input reaches Postgres unfiltered and returns 500.** Four occurrences of
`invalid byte sequence for encoding "UTF8": 0x00` in the server log, surfacing to the client as
**two `500 PATCH /api/documents/{id}`**. A null byte in user input is a client error and should
be a 400 with a useful message; instead the driver error propagates and the request fails
opaquely. **Severity: medium.** The same input path is the one every document edit uses.

**Not a finding, and worth stating plainly:** none of the injection payloads executed.
`<script>`, `onerror=`, template-injection and SQL-shaped input were all stored and rendered
inertly, and `window.__XSS__` was never set. Parameterised `pg` queries and React's default
escaping are doing their job.

**W6-5 · Reconnect leaves the UI in a stale error state.** Measured: typing while offline
works, the UI *does* signal the disconnection, and the edit **survives** reconnect — Yjs and
the IndexedDB cache do their job. But `ui_recovered_after_reconnect` came back **false**: the
offline indicator was still visible after the network returned and the data had flushed. The
user is told they are disconnected while they are connected. 18 collaboration WebSocket
reconnect failures were logged during the cycle. **Severity: medium** — data is safe, trust in
the UI is not. This is what puts the deliverable row at **Partial** rather than Pass.

**W6-6 · An action-items modal auto-opens and traps interaction.** It appears without user
action and intercepts pointer events — every scripted interaction had to press Escape up to
three times before the page became usable, and the accessibility audit independently found the
same modal applying `aria-hidden` to the app behind it (W7-3 territory). **Severity: medium.**

**W6-7 · Zero loading state under 3G.** All three measured routes take **13.2 s to DOM-ready
and ~15.1 s to settle** on Slow 3G, and none showed a spinner, skeleton or progress indicator
at any point. p.6 asks specifically for *"every missing loading state"* — the app shows chrome
and empty panels for thirteen seconds and gives the user no signal that anything is happening.
**Severity: medium.**

**W6-8 · 15 unhandled AWS credential rejections in local dev.** `Plan analysis error:
CredentialsProviderError: Could not load credentials from any providers` fires repeatedly
during normal use. A feature reaches for AWS credentials that do not exist locally and the
rejection is logged rather than handled. Harmless locally, but it is the same
AWS-coupling-in-the-boot-path problem that blocks the Render deployment.
**Severity: low.**

### What this means for the improvement target

p.7 sets the bar at *"Fix 3 error handling gaps. At least one must involve a real user-facing
data loss or confusion scenario (not just a missing loading spinner). Each fix requires
reproduction steps, before/after behavior, and a screenshot or recording."*

**W6-9 is now the strongest candidate** for the "real data loss" requirement, and it displaces
W6-2. Both are data loss; W6-9 is worse on every axis that matters. It destroys text the user
typed rather than reverting to a previous value, it happened in 13 of 13 runs, it gives no
warning, and it strikes the feature the product is built around. Reproduction is two browsers
and five seconds, and before/after is directly measurable by re-running
`measure-concurrent-edit.mjs` — the fix should take the title's `both_survived` count from
0 of 13 to 13 of 13.

W6-1 and W6-5 remain the natural companions — one prevents a white screen on the login and
public feedback routes, the other stops the UI lying about connection state after recovery.
W6-10 is the more serious defect of the two collaboration findings but is also the larger
change; it is called out here so the choice to defer it is deliberate rather than accidental.

W6-7 is deliberately *not* proposed as one of the three: p.7 explicitly excludes
*"just a missing loading spinner."*

---

## Category 4 — Database Query Efficiency

### How it was measured

`docs/audit/scripts/measure-queries.mjs` drives the five flows p.5 names, delimiting each
with a marker query (`SELECT 'FLOWMARK:<label>'`) so the PostgreSQL log attributes queries to
the right flow.

```bash
docker exec ship-postgres-1 psql -U ship -d ship_dev \
  -c "ALTER SYSTEM SET log_statement='all'" \
  -c "ALTER SYSTEM SET log_min_duration_statement=0" -c "SELECT pg_reload_conf()"

node docs/audit/scripts/measure-queries.mjs --out /tmp/cat4-raw.json
```

> **Two counting errors found and corrected before any number below was reported.**
> Both are commented in the script so they cannot recur.
>
> 1. **PostgreSQL logs to stderr**, so `docker logs` emits it on stderr. `execFileSync`
>    returns stdout only, which yielded an empty string and made every flow report
>    **0 queries**. Fixed by merging both streams.
> 2. **The extended query protocol logs `parse`, `bind` and `execute`** for one logical
>    statement. Counting all three inflated every flow ~3x — `view_a_document` read 450
>    instead of 200. The parser now counts executions only.

> **Third counting error, found by challenging the number rather than the method.** The
> reported figure for `view_a_document` was **200**. Cross-checking it against HTTP requests
> showed only **7** requests for that page — 200 queries could not follow from 7 requests at
> ~7 queries each. Cause: `docker logs` returns the entire history, so `FLOWMARK` markers from
> *earlier runs of this script* were still present, and the parser appended to the same array
> each time instead of resetting. Every flow was inflated by exactly the number of times the
> script had been run — 4×. The parser now resets on each marker. **Corrected figures below
> supersede the originals.**

**Known limitation, stated rather than papered over:** PostgreSQL logs multi-line SQL across
multiple lines and the parser captures only the first. Query *counts* and *durations* are
exact; the recorded SQL text for multi-line statements is truncated to its first line. The
`EXPLAIN ANALYZE` below was therefore run against the full statements taken from source, not
from the log.

### Baseline

| User Flow | Total Queries | Slowest Query (ms) | N+1 Detected? |
|---|---:|---:|---|
| Load main page (`/my-week`) | **32** | 3.791 | **Yes** |
| View a document (`/documents/:id`) | **48** | 0.652 | **Yes** |
| List issues (`/issues`) | **23** | 0.364 | **Yes** |
| Load sprint board (`/weeks`) | **14** | 0.820 | **Yes** |
| Search content | **16** | 0.313 | **Yes** |

Total query time per flow is small — 1.5 ms to 8.8 ms — so nothing here is slow *yet*. The
problem is count, not latency.

### Weaknesses

**W4-1 · Session revalidation is roughly half of every flow's query budget.** Each
authenticated API request re-runs the same four-query preamble: fetch session, **write**
`last_activity`, fetch user, fetch workspace membership.

Measured on `view_a_document` — **48 queries for 7 HTTP requests**:

```
13x  UPDATE sessions SET last_activity = $1 WHERE id = $2      <- a WRITE per request
10x  SELECT s.id, s.user_id, s.workspace_id, s.expires_at ...
 4x  SELECT w.id, w.name, wm.role ...
 4x  SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2
 3x  SELECT user_id, workspace_id, last_activity, created_at
 2x  SELECT id, email, name, is_super_admin FROM users WHERE id = $1
---
36 of 48 queries (75%) are authentication overhead.
Every repeated statement is a session, user or membership lookup; the 12
single-occurrence queries are the actual document data.
```

The `UPDATE` is the expensive part conceptually — it turns every read request into a write,
which takes a row lock, generates WAL, and blocks the session row for concurrent requests
from the same user. The 15-minute idle timeout it supports does not need per-request
granularity.

**Severity: high.** This is also the clearest route to p.5's target of *"20% reduction in
total query count on at least one user flow"* — writing `last_activity` at most once every
N seconds instead of every request removes 13 of 48 queries on document view, **27%**, from
one change.

**W4-2 · The purpose-built partial composite index is not being chosen.**
`idx_documents_active` exists precisely for the app's dominant access shape:

```sql
CREATE INDEX idx_documents_active ON documents(workspace_id, document_type)
  WHERE archived_at IS NULL AND deleted_at IS NULL;
```

But `EXPLAIN (ANALYZE, BUFFERS)` on that exact shape shows the planner reaching for the
single-column index instead and filtering the rest in the heap:

```
Limit  (cost=99.66..99.79 rows=50) (actual time=0.242..0.249 rows=50)
  ->  Sort  Sort Key: updated_at DESC   Sort Method: top-N heapsort  Memory: 136kB
        ->  Bitmap Heap Scan on documents  (actual time=0.018..0.124 rows=170)
              Recheck Cond: (document_type = 'issue'::document_type)
              Filter: ((archived_at IS NULL) AND (deleted_at IS NULL)
                       AND (workspace_id = '…'::uuid))
              Heap Blocks: exact=48
```

`workspace_id` and both NULL predicates are applied as a **Filter**, not an index condition.
`pg_stat_user_indexes` confirms the preference in production traffic:

```
idx_documents_document_type   7,285 scans
idx_documents_workspace_id    2,898 scans
idx_documents_active            415 scans   <- the composite, largely unused
```

At 600 documents this costs nothing — 0.25 ms, 52 shared buffer hits. The finding is that the
index the team built for this query is not the one the query uses, and nobody would notice
until the table is large enough for the difference to matter.
**Severity: medium**, and it is the honest correction to F14's "indexing is thorough" — the
indexes exist; one of the important ones is not earning its keep.

**W4-3 · `ORDER BY updated_at DESC` is unindexed, forcing a sort on every list view.**
The plan above shows `Sort Method: top-N heapsort  Memory: 136kB` for 170 rows. There is no
index on `updated_at`, so every list view sorts in memory. Adding `updated_at DESC` to the
composite would let the index satisfy the ordering directly. **Severity: medium** — currently
free, becomes the dominant cost as document count grows.

**W4-4 · Planning cost exceeds execution cost on the hottest query.** The session lookup runs
in **0.008 ms** but reports `Planning: Buffers: shared hit=122` and `Planning Time: 0.251 ms`
— planning is ~30x execution. It runs on every authenticated request. Prepared statements or
a session cache would remove it. **Severity: low** in absolute terms, but it multiplies by
W4-1's request volume.

**Not a finding — F15 confirmed.** No per-item query loop was observed in any list view. The
repeated shapes above are all per-*request* auth overhead, not per-*row* data fetching.
`getBelongsToAssociationsBatch` is doing its job. The "N+1 Detected? Yes" column above refers
to W4-1's per-request duplication, and that distinction matters: this is not the classic
list-view N+1 the category description anticipates.

### What this means for the improvement target

p.5 sets the bar at *"20% reduction in total query count on at least one user flow, or 50%
improvement on the slowest query,"* with before/after `EXPLAIN ANALYZE` required.

W4-1 clears the first option on its own — 27% on `view_a_document` by throttling the
`last_activity` write. W4-2 and W4-3 together are the more interesting fix and are what the
before/after `EXPLAIN ANALYZE` requirement is really aimed at, since they change the plan
shape rather than the request count.

These are projections from the measured baseline, not results. Phase 2 owes real before/after
numbers from `docs/audit/scripts/measure-queries.mjs` run identically.

---

## Category 3 — API Response Time

### How it was measured

Endpoints were chosen by **tracing the frontend's actual network requests** across the common
flows, as p.4 requires, not by guessing. A headless browser walked `/my-week`, `/docs`,
`/issues`, `/weeks`, `/projects`, `/programs`, `/team` and a document view while recording every
`/api/` call:

```
9x GET /api/auth/me          8x GET /api/documents        2x GET /api/team/grid
2x GET /api/documents/:id/backlinks                       1x GET /api/projects
```

Benchmarking uses `docs/audit/scripts/bench-api.sh` (k6), against the augmented seed meeting
p.4's minimums — 600 documents, 170 issues, 25 users, 35 sprints.

```bash
docs/audit/scripts/bench-api.sh            # 10 / 25 / 50 VUs
docs/audit/scripts/bench-api.sh --quick    # 10 VUs only
```

> **Three harness defects were found and fixed before any number below was trusted.**
> All are commented in the script.
>
> 1. **`curl`'s cookie jar came back empty** for these session cookies, so k6 ran entirely
>    unauthenticated. Masked because **`/api/auth/me` returns 200 even when unauthenticated** —
>    it cannot be used to verify login. `/api/documents` can, and now is. Cookies are read
>    from `Set-Cookie` directly: `connect.sid` (CSRF) plus `session_id` (app session).
> 2. **The first runs reported ~380,000 requests at 0.4 ms with a 100% failure rate.** That was
>    not throughput — it was the API rate-limiting every request (below).
> 3. **An open-ended VU loop cannot be used against this API at all** (see W3-1). Load is now
>    generated at a *fixed arrival rate* below the limiter while concurrency varies.

### Baseline

Measured at a fixed 12 req/s, 20 s per run, **0% failures across all 15 runs**.

| Endpoint | P50 | P95 | P99 |
|---|---:|---:|---:|
| `GET /api/auth/me` | 12.68 ms | 23.09 ms | 29.0 ms |
| `GET /api/documents` | 26.51 ms | 36.1 ms | 39.77 ms |
| `GET /api/documents/:id/backlinks` | 11.86 ms | 22.09 ms | 28.08 ms |
| `GET /api/team/grid` | 13.12 ms | 19.75 ms | 24.8 ms |
| `GET /api/projects` | 15.1 ms | 24.24 ms | 27.41 ms |

Latency under concurrency — P50 / P95 in ms:

| Endpoint | 10 VUs | 25 VUs | 50 VUs |
|---|---|---|---|
| `auth/me` | 12.68 / 23.09 | 11.99 / 23.04 | 12.64 / 23.09 |
| `documents` | 26.51 / 36.1 | 26.61 / 37.45 | 26.09 / 36.37 |
| `documents/:id/backlinks` | 11.86 / 22.09 | 10.94 / 19.89 | 9.77 / 15.88 |
| `team/grid` | 13.12 / 19.75 | 12.21 / 16.5 | 13.38 / 24.72 |
| `projects` | 15.1 / 24.24 | 15.21 / 23.17 | 14.88 / 24.61 |

### Weaknesses

**W3-1 · The API cannot be load-tested as configured, and the production limit is very low.**
`api/src/app.ts:137` mounts a rate limiter on all of `/api/`:

```ts
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTestEnv ? 10000 : isDevEnv ? 1000 : 100,   // app.ts:81-83
});
```

**100 requests per minute per IP in production** — 1.67 req/s for an entire address. The
frontend makes 4–5 API calls per page view (measured in the trace above), so roughly **20–25
page views in a minute exhausts the budget for that IP**. Anyone behind shared egress — an
office, a VPN, a government network — shares one bucket. The failure mode is a JSON
`{"error":"Too many requests. Please slow down."}` with no client-side handling observed.

**Severity: high.** This is also why p.4's *"Test under concurrent load: 10, 25, and 50
simultaneous connections"* cannot be satisfied in the sense the brief intends: an open-ended
load generator produces 100% 429s within a second. Raising the limit to measure it would mean
changing the system under test, which p.3 forbids during the audit.

**W3-2 · `GET /api/documents` is the slowest endpoint and the most requested one.** 26.5 ms
P50 / 36.1 ms P95 — roughly **twice** every other endpoint measured, while also being the
highest-traffic call in the trace.

The cause is visible in Category 4's measurements rather than hypothesised: the list query
does a `Bitmap Heap Scan` with `workspace_id` and both soft-delete predicates applied as a
**Filter** rather than an index condition (W4-2), then a `top-N heapsort` for
`ORDER BY updated_at DESC` with no supporting index (W4-3). Add the ~4-query authentication
preamble every request pays (W4-1) and 26 ms is accounted for.
**Severity: medium** at current data volume — the plan degrades with row count, not with
concurrency.

**W3-3 · Throughput is capped so far below saturation that concurrency is not observable.**
P50 for `/api/documents` is 26.5 ms at 10 VUs, 26.6 at 25, and 26.1 at 50 — flat. Nothing
queues, because the limiter binds long before the process does. That is a reasonable
defensive posture, but it means **there is currently no measurement of where this API actually
breaks**, and no capacity number to plan against. **Severity: medium** — an unknown, not a
defect.

**W3-4 · `/api/auth/me` returns 200 when unauthenticated.** Found while debugging the harness:
the endpoint responds 200 with no valid session, where `/api/documents` correctly returns 401.
Any client using it as an auth check would believe it was logged in. **Severity: medium** —
it is not an auth bypass (protected endpoints still reject), but it is a misleading signal and
it silently broke this category's first benchmark run.

### What this means for the improvement target

p.5 sets the bar at *"20% reduction in P95 response time on at least 2 endpoints,"* with
before/after benchmarks *"run under identical conditions (same data volume, same concurrency,
same hardware)."*

`GET /api/documents` at 36.1 ms P95 is the obvious first target and the fixes are already
diagnosed in Category 4 — an index that supports the actual predicate and ordering. The second
endpoint is more likely to come from W4-1: every endpoint measured pays the same ~4-query
auth preamble, so throttling the per-request `sessions` write should move P95 on all five at
once.

`bench-api.sh` pins the conditions the target requires — fixed 12 req/s arrival rate, 20 s,
same seed volume — so the after-measurement is a re-run of one command.

---
