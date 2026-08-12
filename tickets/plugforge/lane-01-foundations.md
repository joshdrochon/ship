# L01 · Foundations & Public/Internal Boundary

| | |
|---|---|
| **Agent** | `platform-foundations` |
| **Tier** | 0 — blocks all of tier 1 |
| **Block** | PF-001–030 (26 allocated, 4 reserved for audit) |
| **Blocks on** | — |
| **Unblocks** | L02, L03, L07 |
| **MVP gate** | Indirect — every gate item depends on this lane |

**Why this lane is tier 0.** PRD Build Strategy §2 (p.10): *"Add the lint rule that fails the
build on cross-imports before you have any cross-imports to lint. This decision is far cheaper
to enforce than to retrofit."* Critical Guidance (p.11) calls the public/internal split a
one-way door. Nothing else starts until the boundary is mechanical.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-001 | ☑ Create `api/src/platform/` module tree | Eight dirs exist (`apps`, `oauth`, `scopes`, `ratelimit`, `webhooks`, `api/v1`, `openapi`, `audit`), each with a stub `index.ts`; tree matches `docs/architecture.md` Module Layout exactly | — | p.12 | — |
| PF-002 | ☑ `platform/README.md` documents the boundary contract | One line per module; states the no-internal-import rule; reviewer can derive the lint rule from it | — | p.12 | PF-001 |
| PF-003 | ☑ Register `sdk/` as pnpm workspace package | `pnpm-workspace.yaml` includes `sdk`; `pnpm -F @ship/sdk build` resolves from repo root | — | p.2 | — |
| PF-004 | ☑ `@ship/sdk` package.json — name, exports, types, sideEffects | `exports` map ships ESM+CJS+types; `files` excludes tests; private until publish decision | — | p.10 | PF-003 |
| PF-005 | ☑ Register `integrations/*` as workspace packages | `pnpm-workspace.yaml` includes `integrations/*`; `integrations/cli` resolves `@ship/sdk` by workspace protocol | — | p.11 | PF-003 |
| PF-006 | ☑ `sdk/tsconfig.json` — strict mode, declaration output | `strict: true`, `declaration: true`, `noUncheckedIndexedAccess`; build emits `.d.ts` | — | p.10 | PF-004 |
| PF-007 | ☑ `integrations/cli/tsconfig.json` — strict, project reference to SDK | Compiles against SDK types via project reference, not a relative path | — | p.10 | PF-005 |
| PF-008 | ☑ TypeScript strict mode verified across all new packages | `pnpm type-check` covers `api`, `sdk`, `integrations/*`; zero errors; no `skipLibCheck` masking | — | p.10 | PF-006, PF-007 |
| PF-009 | ☑ ESLint rule: `platform/api/v1/**` may not import `api/src/routes/**` | `no-restricted-imports` with explicit patterns; violation fails `pnpm lint` with a message naming the boundary | — | p.3, p.18 | PF-001 |
| PF-010 | ☑ ESLint rule: `platform/**` may not import internal middleware | Blocks `api/src/middleware/**`; platform gets its own stack, shares none | — | p.3 | PF-009 |
| PF-011 | ☑ ESLint rule: `integrations/**` may import only `@ship/sdk` | Any `api/src/` or deep-relative import into the API fails the build | — | p.11, p.18 | PF-005 |
| PF-012 | ☑ Negative fixtures prove each boundary rule fires | Three fixture files under `eslint-fixtures/`, one per rule; a test asserts lint **fails** on each — a rule that never fires is untested | — | p.18 | PF-009, PF-010, PF-011 |
| PF-013 | ☑ CI runs boundary lint as a blocking job | Job fails the PR, not warn-only; runs before the test job so violations surface fast | — | p.18 | PF-012 |
| PF-014 | ☑ `createApp(deps)` accepts injected concretes | Signature `createApp(deps = productionDeps())`; existing zero-arg callers unchanged | — | p.12 | PF-001 |
| PF-015 | ☑ `productionDeps()` factory — bus, deliverer, limiter, clock, db | Single exported factory; the only place production concretes are chosen | — | p.12 | PF-014 |
| PF-016 | ☑ `testDeps()` factory — in-memory concretes, no network, no wall clock | Returns `InProcessEventBus`, `InMemoryDeliverer`, `InMemoryTokenBucket`, `FakeClock`, test pool | — | p.12 | PF-014 |
| PF-017 | ☑ `Clock` interface + `SystemClock` + `FakeClock` | `FakeClock.advance(ms)` drives all time-dependent code; no `setTimeout` in any test | — | p.11 | PF-016 |
| PF-018 | ☑ Internal `/api` middleware stack verified unchanged | Session + CSRF stack byte-for-byte identical; diff on `api/src/middleware/auth.ts` is empty | — | p.3 | PF-014 |
| PF-019 | ☑ Existing Playwright regression suite green after refactor | Full suite passes on the refactored `createApp`; run via `/e2e-test-runner`, not `pnpm test:e2e` | MVP-9 | p.2 | PF-018 |
| PF-020 | ☑ Capture Part 1 performance baseline | P95 latency, bundle size, per-route query counts recorded to `docs/baseline-part1.json` — the denominator for the +10% budget | MVP-9 | p.2, p.6 | PF-019 |
| PF-021 | ☑ Reserve migration numbers for platform tables | Next free `NNN_` confirmed against `schema_migrations`; block reserved so L02/L06/L15/L16 don't collide | — | — | — |
| PF-022 | ☑ `docs/architecture.md` Module Layout matches shipped tree | Fitness test walks `platform/` and asserts every documented module exists and no undocumented one does | — | p.12 | PF-001 |
| PF-023 | ☑ Branch naming convention `pf/LNN-<slug>` documented and adopted | Convention in `CONTRIBUTING.md`; lane prefix guarantees 26 parallel agents never collide on a branch name | — | p.12 | — |
| PF-024 | ☑ PR template requires acceptance criterion + fitness-test confirmation | `.github/pull_request_template.md` with two mandatory sections: "Advances acceptance criterion" (ticket IDs + criterion text) and "Fitness test" (name + pass confirmation) | — | p.12 | PF-023 |
| PF-025 | ☑ Branch-preservation guard | Repo setting: auto-delete-head-branch **off**; documented in `CONTRIBUTING.md` that merged branches are graded evidence and must never be pruned before Final | — | p.12 | PF-023 |
| PF-026 | ☑ CI check fails a PR whose body omits criterion or fitness-test confirmation | Job parses the PR body for both required sections; missing either fails the check — the PRD grades the description, so an unenforced template will drift | — | p.12 | PF-024 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L01-<slug>`; the PR body
names the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L01-workspace` | PF-001–008 | Module tree + workspace packages resolve under strict TS | `pnpm type-check` clean across api/sdk/integrations |
| S2 | `pf/L01-boundary-lint` | PF-009–013 | Public/internal boundary enforced mechanically (MVP dependency) | Negative fixtures fail lint; CI job blocking |
| S3 | `pf/L01-composition-root` | PF-014–018 | Single composition root; internal stack unchanged | Internal middleware diff empty |
| S4 | `pf/L01-baseline` | PF-019–022 | Part 1 baseline captured; module layout matches docs | Regression suite green; layout fitness test passes |
| S5 | `pf/L01-pr-discipline` | PF-023–026 | Per-slice branch + PR description discipline (PRD p.12) | CI rejects a PR body missing either required section |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots in this lane, stated so
you can confirm or refute rather than rediscover:

- **Pre-Search 3.3 (p.18)** asks *which* lint rules catch boundary violations — "both?" is the
  PRD's own open question. PF-009/010/011 answer "all three." Verify that's actually the full
  set implied by p.11's `integrations/` rule.
- No ticket here covers the **workspace dependency rule** as distinct from the lint rule
  (a `package.json` dependency allowlist vs. an import-path lint). PRD p.11 says "enforced by a
  workspace dependency rule" — if that's a separate mechanism, it's missing.
- The **+10% regression budget** (p.6) is captured here but enforced in L26. Confirm the
  handoff is real and not a gap between lanes.
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
