# Audit Checklist

Working checklist for the Phase 1 audit. Every item is derived verbatim from the brief —
`.claude/prd/page-N.txt` holds the extracted source if you want to check wording.

**Deliverable file:** [`audit-report.md`](./audit-report.md)
**Gate:** Tuesday 11:59 PM. p.12 — *"Incomplete audits are an automatic fail regardless of
implementation quality."*

## How to read this

Each category has three blocks of checkboxes, and **all three must be complete**:

- **Measure** — one box per "How to Measure" bullet (p.3–8). These are actions.
- **Report** — one box per row of that category's Audit Deliverable table. These are outputs.
- Per p.2, every category also needs methodology recorded, concrete numbers, specific
  weaknesses, and severity ranking.

The Measure bullets frequently ask for work the Deliverable table never collects — Category 1
wants you to *"explain why they are problematic"*, Category 4 wants `EXPLAIN ANALYZE` output.
Filling the table is not the same as finishing the category.

**Improvement Target** is quoted under each category for Phase 2. Do not act on it now —
p.3: *"You do not fix anything during the audit. Diagnosis comes before treatment."*

## Category count

The brief says "all 7 categories" on p.2 and p.12, then defines a **Category 8** on p.7–8 and
says *"Improve all 8 categories"* on p.9. p.11 lists Terraform Plan Review as its own
submission row. Treating it as 8 — reading "7" literally is a bet on which sentence is stale,
and the downside is an automatic fail.

---

## Progress

| Cat | Name | Measure | Report | Done |
|---|---|:---:|:---:|:---:|
| 1 | Type Safety | 5/5 | 7/7 | ☑ |
| 2 | Bundle Size | 5/5 | 5/5 | ☑ |
| 3 | API Response Time | 4/5 +1 partial | 5/5 | ⚠ |
| 4 | Database Query Efficiency | 6/6 | 5/5 | ☑ |
| 5 | Test Coverage and Quality | 5/5 | 5/5 | ☑ |
| 6 | Runtime Error and Edge Case Handling | 5/6 | 5/5 | ⚠ |
| 7 | Accessibility Compliance | 3/5 +1 partial | 5/5 | ⚠ |
| 8 | Terraform Plan Review | 3/4 +1 partial | 2/2 | ⚠ |

---

## Category 1 — Type Safety

> **What you are measuring:** The strength of TypeScript's type system as used in this
> codebase. This includes explicit `any` types, type assertions (`as`), non-null assertions
> (`!`), `@ts-ignore` and `@ts-expect-error` directives, untyped function parameters, and
> implicit `any` from missing return types. *(p.3)*

### Measure

- [x] Run grep or a static analysis tool to count all type safety violations across the codebase
- [x] Check the `tsconfig.json` for strict mode settings
- [x] *(conditional)* If strict mode is off, run `tsc --strict --noEmit` and count the errors — **n/a, strict is on**
- [x] Break down violations by package (`web/`, `api/`, `shared/`) and by violation type
- [x] Identify the 5 most violation-dense files **and explain why they are problematic**

> ✅ **Resolved.** The overview names untyped function parameters and implicit `any` from
> missing return types. Neither is grep-detectable, so it was settled by compilation:
> `strict: true` in all four tsconfigs, `noImplicitAny` never overridden, `pnpm type-check`
> exits 0 with 0 errors. Under `noImplicitAny` an untyped parameter is a compile error —
> the bucket is structurally zero, not unmeasured.

### Report

| Metric | Your Baseline | ✓ |
|---|---|:---:|
| Total `any` types | 258 | ☑ |
| Total type assertions (`as`) | 429 | ☑ |
| Total non-null assertions (`!`) | 321 | ☑ |
| Total `@ts-ignore` / `@ts-expect-error` | 1 | ☑ |
| Strict mode enabled? | Yes — unevenly, `web/tsconfig.json` has no `extends` (F4) | ☑ |
| Strict mode error count (if disabled) | n/a | ☑ |
| Top 5 violation-dense files | ProjectDetailsTab · yjsConverter · UnifiedDocumentPage · UnifiedEditor · extractHypothesis | ☑ |

Total: **1,009** — `api/src` 663 · `web/src` 346 · `shared/src` 0. Prod 803 / test 206.
Re-baselined; supersedes F5. Canonical command: `docs/audit/scripts/count-type-violations.py`.

> **Improvement Target (Phase 2):** Eliminate 25% of type safety violations. Every fix must
> preserve existing functionality (all tests still pass). Superficial fixes do not count.
> Replacing `any` with `unknown` without proper type narrowing is not an improvement. Each fix
> must include correct, meaningful types that reflect the actual data. *(p.3)*

---

## Category 2 — Bundle Size ☑

> **What you are measuring:** The size of the production frontend bundle. Large bundles slow
> down initial page load, hurt performance on slow networks, and waste bandwidth. You are
> looking for oversized dependencies, missing code splitting, unused imports, and
> opportunities to reduce what the browser has to download. *(p.3)*

### Measure

- [x] Build the production frontend and record the total output size
- [x] Use a bundle visualization tool (rollup-plugin-visualizer, vite-bundle-analyzer, or source-map-explorer) to generate a treemap of the bundle
- [x] Identify the largest chunks and the largest individual dependencies within them
- [x] Check for unused dependencies: cross-reference `package.json` dependencies against actual imports in the source code
- [x] Evaluate whether code splitting is in use and where lazy loading could reduce initial load

### Report

| Metric | Your Baseline | ✓ |
|---|---|:---:|
| Total production bundle size | **3,431,964 B** · 697,270 B gzip JS+CSS | ☑ |
| Largest chunk | `index-C2vAyoQ1.js` — 585,796 B gzip (92.1% of JS) | ☑ |
| Number of chunks | 261 JS files | ☑ |
| Top 3 largest dependencies | emoji-picker-react 8.5% · highlight.js 8.1% · yjs 5.7% | ☑ |
| Unused dependencies identified | `@tanstack/query-sync-storage-persister` (0 bundle bytes) | ☑ |

> **Improvement Target (Phase 2):** 15% reduction in total production bundle size, or
> implement code splitting that reduces initial page load bundle by 20%. Provide before/after
> bundle analysis output. Removing functionality to shrink the bundle does not count. *(p.4)*

---

## Category 3 — API Response Time

> **What you are measuring:** How fast the backend responds under realistic conditions. This
> is not about testing with an empty database. Seed the database with meaningful volume, then
> measure. *(p.4)*

### Measure

- [x] Seed the database with realistic data: 500+ documents, 100+ issues, 20+ users, 10+ sprints — **600 / 170 / 25 / 35**
- [x] Identify the 5 most important API endpoints by tracing the frontend's network requests — traced headless across 8 routes
- [x] Benchmark each endpoint with k6. Record P50, P95, P99 — 15 runs, 0% failures
- [~] Test under concurrent load: 10, 25, 50 — **all three run, but latency is flat.** The rate limiter (100/min prod, 1000/min dev) binds before concurrency does; true saturation needs raising it, which p.3 forbids (W3-1, W3-3)
- [x] Identify the slowest endpoints and hypothesize why — `/api/documents` 26.5ms P50, cause traced to W4-1/W4-2/W4-3

### Report

| Endpoint | P50 | P95 | P99 | ✓ |
|---|---|---|---|:---:|
| 1. `GET /api/documents` | 26.51 ms | 36.1 ms | 39.77 ms | ☑ |
| 2. `GET /api/projects` | 15.1 ms | 24.24 ms | 27.41 ms | ☑ |
| 3. `GET /api/team/grid` | 13.12 ms | 19.75 ms | 24.8 ms | ☑ |
| 4. `GET /api/auth/me` | 12.68 ms | 23.09 ms | 29.0 ms | ☑ |
| 5. `GET /api/documents/:id/backlinks` | 11.86 ms | 22.09 ms | 28.08 ms | ☑ |

> **Improvement Target (Phase 2):** 20% reduction in P95 response time on at least 2
> endpoints. You must provide before/after benchmarks run under identical conditions (same
> data volume, same concurrency, same hardware). Document the root cause of each
> bottleneck. *(p.5)*

---

## Category 4 — Database Query Efficiency

> **What you are measuring:** How efficiently the application queries the database. The
> unified document model (everything in one table) creates specific query patterns worth
> examining. You are looking for N+1 queries, missing indexes, full table scans, and
> unnecessary data fetching. *(p.5)*

### Measure

- [x] Enable PostgreSQL query logging — `log_statement='all'` + `log_min_duration_statement=0` via ALTER SYSTEM
- [x] Execute 5 common user flows — driven headless, marker-delimited per flow
- [x] Count total queries executed per flow — 128 / 200 / 92 / 56 / 64
- [x] Run `EXPLAIN ANALYZE` on the slowest queries — plans captured with BUFFERS
- [x] Check for missing indexes — 13 indexes present; `idx_documents_active` not chosen (W4-2); no `updated_at` index (W4-3)
- [x] Identify N+1 patterns — no per-row loop (F15 holds); per-request auth duplication instead (W4-1)

### Report

| User Flow | Total Queries | Slowest Query (ms) | N+1 Detected? | ✓ |
|---|---|---|---|:---:|
| Load main page | **128** | 0.674ms | Yes (per-request) | ☑ |
| View a document | **200** | 3.669ms | Yes (per-request) | ☑ |
| List issues | **92** | 1.408ms | Yes (per-request) | ☑ |
| Load sprint board | **56** | 0.741ms | Yes (per-request) | ☑ |
| Search content | **64** | 0.788ms | Yes (per-request) | ☑ |

> ⚠️ F14 and F15 already killed the two obvious angles here — indexing is thorough (13 indexes)
> and `getBelongsToAssociationsBatch` exists and is used. Any finding needs `EXPLAIN ANALYZE`
> behind it, not reasoning from the schema.

> **Improvement Target (Phase 2):** 20% reduction in total query count on at least one user
> flow, or 50% improvement on the slowest query. Provide before/after `EXPLAIN ANALYZE` output.
> Document what was inefficient and why your change fixes it. *(p.5)*

---

## Category 5 — Test Coverage and Quality

> **What you are measuring:** What the existing test suite covers, what it misses, and how
> reliable it is. Ship has 73+ Playwright E2E tests. Your job is to understand what they test,
> find the gaps, and assess test reliability. *(p.5)*

### Measure

- [x] Run the full test suite: `pnpm test`. Record pass/fail counts and total runtime
- [x] Read the test files. Catalog what user flows are covered and which are not
- [x] Identify flaky tests: run the suite 3 times and note any tests that pass sometimes and fail others
- [x] Map critical user flows (document CRUD, real-time sync, auth, sprint management) against existing test coverage
- [x] If code coverage tooling is not configured, configure it and report line/branch coverage per package

> ⚠️ `pnpm test` runs **api only** (F18) — 151 web tests never execute under the documented
> command, and 13 of them fail (F19). Coverage is half-wired: `api/vitest.config.ts:12`
> declares a v8 provider but `@vitest/coverage-v8` is not installed; `web/` has no coverage
> block. Configuring it is explicitly sanctioned by the bullet above.
> Running the api suite truncates the dev database (F22) — reseed after.

### Report

| Metric | Your Baseline | ✓ |
|---|---|:---:|
| Total tests | **1,471** — 869 E2E · 451 api · 151 web | ☑ |
| Pass / Fail / Flaky | 864/0/5 · 865/0/4 · 862/0/7 | ☑ |
| Suite runtime | 9.6m · 10.0m · 9.8m (E2E, 4 workers) | ☑ |
| Critical flows with zero coverage | **None** — auth 160 · sprint 102 · sync 55 · CRUD 42 | ☑ |
| Code coverage % | **web 27.63% / api 40.34%** stmts | ☑ |

> **Improvement Target (Phase 2):** Add meaningful tests for 3 previously untested critical
> paths, or fix 3 flaky tests with documented root cause analysis. "Meaningful" means the test
> catches a real regression, not just asserting that a page loads. Each test must include a
> comment explaining what risk it mitigates. *(p.6)*

---

## Category 6 — Runtime Error and Edge Case Handling

> **What you are measuring:** How the application behaves when things go wrong. This covers
> error boundaries, unhandled promise rejections, network failure recovery (especially during
> real-time collaboration), malformed input handling, and user-facing error states. *(p.6)*

### Measure

- [x] Open browser DevTools and monitor the console during normal usage. Count errors and warnings — **0** across 11 routes
- [x] Test network failure: disconnect while editing, then reconnect — data **survives**, UI does **not** recover (W6-5)
- [x] Test malformed input: empty, 100k chars, unicode/control, HTML/script/SQL/template injection — no XSS; 500 on null byte (W6-4)
- [ ] Test concurrent edge cases: two users editing the same document field simultaneously — **NOT DONE.** Needs two authenticated contexts driven simultaneously
- [x] Throttle to 3G — 13.2s DOM-ready, 15.1s settled, **zero loading state** on all 3 routes (W6-7)
- [x] Check server logs for unhandled errors — 19 async rejection frames; 15 AWS credential, 4 UTF8 0x00, 1 CSRF

### Report

| Metric | Your Baseline | ✓ |
|---|---|:---:|
| Console errors during normal usage | **0** across 11 routes | ☑ |
| Unhandled promise rejections (server) | **19** frames, 3 distinct causes | ☑ |
| Network disconnect recovery | **Partial** — data survives, UI does not recover | ☑ |
| Missing error boundaries | **6 top-level routes** incl. `/login`, `/admin`, `/feedback/:programId` | ☑ |
| Silent failures identified | **3** — title revert, 100k title, stale offline banner | ☑ |

> **Improvement Target (Phase 2):** Fix 3 error handling gaps. At least one must involve a
> real user-facing data loss or confusion scenario (not just a missing loading spinner). Each
> fix requires reproduction steps, before/after behavior, and a screenshot or recording. *(p.7)*

---

## Category 7 — Accessibility Compliance

> **What you are measuring:** Ship claims Section 508 compliance and WCAG 2.1 AA conformance.
> Your job is to verify those claims. This means automated accessibility scanning, keyboard
> navigation testing, screen reader testing, and color contrast verification across the
> application's major pages. *(p.7)*

### Measure

- [x] Run Lighthouse accessibility audits on **every major page**. Record the score for each — 17 pages, 88–100 desktop, median 96
- [x] Run an automated accessibility scanner (axe-core, pa11y, or the axe browser extension) and categorize violations by severity (Critical, Serious, Moderate, Minor) — 34 critical / 65 serious / 0 moderate / 0 minor
- [~] Test full keyboard navigation — **PARTIAL.** Tab reachability automated (1,990 candidates, zero positive tabindex, Escape verified). Enter/Space, arrow keys, focus visibility, focus order and restoration **still need a human**
- [ ] Test with a screen reader (VoiceOver, NVDA, or similar) — **NOT PERFORMED.** Structure reported from markup only, never presented as SR results. Requires a human
- [x] Check color contrast ratios on text, buttons, and interactive elements against the WCAG 2.1 AA 4.5:1 minimum — 61 failing nodes, worst 1.84:1

### Report

| Metric | Your Baseline | ✓ |
|---|---|:---:|
| Lighthouse accessibility score (per page) | 88–100 across 17 pages, median 96; lowest `/admin` 88 | ☑ |
| Total Critical/Serious violations | **99 nodes** / 23 rule-instances / 7 distinct rules | ☑ |
| Keyboard navigation completeness | **Partial** | ☑ |
| Color contrast failures | **61 nodes**, 16 colour pairs, worst 1.84:1 (+38 unresolvable) | ☑ |
| Missing ARIA labels or roles | **7 locations**, each with file:line | ☑ |

> **Improvement Target (Phase 2):** Achieve a Lighthouse accessibility score improvement of
> 10+ points on the lowest-scoring page, or fix all Critical/Serious violations on the 3 most
> important pages. Provide before/after Lighthouse reports or axe scan output as evidence. *(p.7)*

---

## Category 8 — Terraform Plan Review

> **What you are measuring:** Whether you can read and reason about infrastructure-as-code.
> This is not a writing exercise — the Terraform already exists in the repo. Your job is to
> understand it, run it locally using the Terraform local provider, and demonstrate you can
> identify what a plan will change and what the blast radius is. Deployment is done via
> Render, which has an official first-party Terraform provider. **No AWS account or cloud
> credentials are required.** *(p.7)*

### Measure

- [~] Install Terraform locally, run `terraform init` / `terraform plan`, save output — **PARTIAL.** Terraform v1.15.8 installed; init/validate/providers/graph real. **`terraform plan` against AWS not obtainable** — `No valid credential sources found`. No plan output fabricated
- [x] Annotate the plan — all 74 root resources annotated with safety assessment, **labelled static analysis** rather than plan output
- [x] Simulate drift — **done for real** with `hashicorp/local`, full before/after captured. Bonus: permission drift (`chmod 0666`) is NOT detected
- [x] Identify the blast radius — recreated / in-place / no-op split derived from provider ForceNew semantics

### Report

- [x] Annotated resource inventory explaining every resource and its blast radius (static, no live plan)
- [x] Drift detection demonstration: before-and-after plan output showing a manual change being detected

> ⚠️ The repo's Terraform is **AWS-only** — 42 `.tf` files, `hashicorp/aws ~> 5.0`, no other
> provider (F25). Week 4 replaces this with `hashicorp/local` for exercises and
> `render-oss/render` for deployment. Provider versions are constrained, not pinned, and
> `environments/dev` and `environments/shadow` have no lockfile.
> The **audit half** needs no Render API key — only the Phase 2 deployment does.

> **Improvement Target (Phase 2):** Write a new Terraform config that uses the local provider
> to manage at least two local resources. Then write a second config using the Render provider
> that declares a Render web service and deploys your improved ShipShape fork. Both configs
> must have pinned provider versions. Run `terraform plan` on each and confirm the output
> matches intent. The Render deployment replaces any manual deploy steps — your fork should be
> deployable from a clean machine using only `terraform apply`. *(p.8)*

---

## Cross-cutting requirements

Not category-specific, but graded. From p.2–3, every category in the report needs all four:

- [x] 1. How you measured it — tools, commands, methodology — verified present in all 8 categories
- [x] 2. Concrete baseline numbers — verified present in all 8 categories
- [x] 3. The specific weaknesses or opportunities found — verified present in all 8 categories
- [x] 4. Severity or impact ranking per finding — verified present in all 8 categories

Other Phase 1 deliverables:

- [x] Orientation notes — *"become part of your final submission"* (p.2). 8/8 checklist items
- [ ] Discovery write-up — 3 things learned, 4 elements each (p.10). Currently 3 of 4; missing *"How you would apply this knowledge in a future project"* on all three
