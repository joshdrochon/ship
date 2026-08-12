# L03 · Scope Registry & Authorization

| | |
|---|---|
| **Agent** | `scopes-authz` |
| **Tier** | 1 — blocks L04, L05 |
| **Block** | PF-061–085 (20 allocated, 5 reserved for audit) |
| **Blocks on** | L01 (PF-001 module tree, PF-008 strict TS, PF-009 boundary lint, PF-016 `testDeps()`) |
| **Unblocks** | L04 (authorize-time scope validation), L05 (device grant scope validation) |
| **MVP gate** | Item 6 (p.2) directly — *"ScopeRegistry has scopes-as-data; insufficient scope returns 403 with the missing scope named explicitly in the error body (no opaque 'forbidden')"*. Item 4 (p.2) jointly with L09 — *"Each route declares its required scope via a `require(scope)` middleware factory."* |

**Why this lane is tier 1 and why it is only tier 1.** Build Strategy priority 1 (p.11): *"Without
working tokens and scope checks, nothing else has a contract."* But scope checking is not an OAuth
endpoint — it is a registry plus two pure functions plus one middleware factory. This lane ships
those and nothing that needs a live `/oauth/authorize`. L04 and L05 *call* `validateRequestedScopes()`
and mount `requireScope()`; they are consumers, not co-authors. That is what keeps L03 off the
critical path of L02 and lets three tier-1 lanes run wide.

The lane's whole design pressure is one PRD sentence, p.3: *"New scopes register at module load,
never edit middleware."* Every ticket below is either that registration surface, the middleware that
reads it, or a test that fails when someone edits the middleware instead of the data.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-061 | ☐ `ScopeRegistry` data structure in `platform/scopes/registry.ts` | Registry is a `Map<string, ScopeDefinition>` behind `register` / `has` / `get` / `list`; the module imports nothing from `express` or `../api/v1/` — a unit test imports it in a bare Node context with no HTTP stack and calls all four methods | MVP-6 | p.3 | PF-001 |
| PF-062 | ☐ Seven canonical scopes registered at module load | `scopeRegistry.list()` returns exactly the seven names `documents:read`, `documents:write`, `issues:read`, `issues:write`, `sprints:read`, `sprints:write`, `webhooks:manage` — test compares against a literal array and fails on both a missing and an extra entry | MVP-6 | p.3 | PF-061 |
| PF-063 | ☐ `ScopeDefinition` carries `resource`, `action`, `description` | Every registration parses as `<resource>:<action>` and round-trips (`\`${d.resource}:${d.action}\` === d.scope`) for all seven; `description` is non-empty prose reusable verbatim on the consent screen (L04) and in the 403 body | MVP-6 | p.3 | PF-062 |
| PF-064 | ☐ `Scope` type derives from the registration data, not a hand-written union | `requireScope('documents:delete')` is a **compile** error; proved by a `@ts-expect-error` fixture that fails `pnpm type-check` if the error stops firing | MVP-6 | p.3 | PF-063, PF-008 |
| PF-065 | ☐ Duplicate registration fails at module load, never silently shadows | Registering an already-registered name throws naming the scope; a test asserts the throw and asserts registry size is unchanged — a shadowed scope would silently change a description the 403 reads | MVP-6 | p.3 | PF-061 |
| PF-066 | ☐ OCP proof: adding a scope touches only the registration file | Test registers `plugins:read` on a fresh `ScopeRegistry` instance and drives a `requireScope('plugins:read')`-guarded handler to 200/403 with **zero** edits to `require-scope.ts`; `git diff --stat` over `platform/scopes/require-scope.ts` for the commit is empty | MVP-6 | p.12 | PF-062, PF-067 |
| PF-067 | ☐ `requireScope(scope)` middleware factory | Factory returns per-route middleware; a request whose `PlatformAuthContext.scopes` contains the scope reaches the handler, one whose does not never does (handler spy uncalled) | MVP-4 | p.2 | PF-062 |
| PF-068 | ☐ `requireScope` throws at **wiring** time on an unregistered scope | `createApp()` fails to boot when a route declares an unregistered scope; test asserts the thrown message names the offending scope and the route path — an unregistered scope is a defect, not a runtime 403 | MVP-4 | p.3 | PF-067, PF-014 |
| PF-069 | ☐ 403 body names the missing scope in a machine-readable field | Response is `{code:'forbidden', message, details:{required_scope, granted_scopes}, request_id}`; test asserts `body.details.required_scope === 'documents:write'` — asserting on `message` text alone does not satisfy this ticket, because an SDK cannot switch on prose | MVP-6 | p.2, p.7 | PF-067 |
| PF-070 | ☐ The 403 handler **reads the registry** for the missing scope's description | Test mutates a registration's `description` on a test registry and asserts the new text appears in `details.scope_description`; no scope name or description string literal exists anywhere in `require-scope.ts` (grep assertion in the same test file) | MVP-6 | p.12 | PF-069, PF-063 |
| PF-071 | ☐ Absent auth context yields 401, never 403 | `requireScope` with no `res.locals.platformAuth` emits `code:'unauthorized'` / 401, not `forbidden` / 403 — the distinction is what tells an SDK to refresh a token vs. re-consent | MVP-3 | p.3 | PF-067 |
| PF-072 | ☐ Route-level scope metadata is introspectable without parsing source | Each v1 route registration exposes its required scope on a route-metadata record (`{method, path, scope}`) that L13's generator and PF-079's fitness test both read; test enumerates the metadata of a two-route fixture router and gets both entries | TS-4 | p.5 | PF-067 |
| PF-073 | ☐ `validateRequestedScopes(requested)` — pure function, registry-backed | Returns `{valid, unknown[]}`; an unknown name (`documents:delete`) lands in `unknown` so L04/L05 can return RFC 6749 `invalid_scope`; empty request returns empty-valid, not all-scopes. Pure — no Express, no DB, callable before L04 exists | — | p.3, p.10 | PF-062 |
| PF-074 | ☐ Granted scopes are intersected with the app's `requested_scopes` at issuance | `resolveGrantedScopes(appRequested, userConsented)` returns the intersection; a scope the app never registered can never appear on a token even if the consent payload asks for it. Test covers: app-subset, user-subset, disjoint → empty | — | p.2 | PF-073 |
| PF-075 | ☐ Token scopes re-validated against the registry at request time | A token carrying a scope no longer in the registry (deregistered between issuance and use) is treated as **not granted** — 403 naming it — and the mismatch is recorded for the audit trail's `scope used` field rather than silently dropped | — | p.3, p.4 | PF-069, PF-073 |
| PF-076 | ☐ Scope-upgrade policy: decide, implement, document | Default implemented here is **re-consent** — a token granted `documents:read` that requests `documents:write` gets a fresh consent, and the issued token carries the union of old and new grants. Test asserts both halves (consent screen shown; resulting token has both scopes). Policy paragraph lands in `docs/architecture.md`. ⚑ **Decision, not a given** — see audit notes | — | p.16 | PF-074 |
| PF-077 | ☐ `sprints` → internal `weeks` mapping lives in one module | `platform/scopes/resource-map.ts` maps public resource names to internal domain modules; `sprints → weeks`. Fitness test greps `api/src/platform/**` and asserts the literal `'weeks'` appears in **no file but this one**. Verified repo facts: internal path is `/api/weeks` (`api/src/app.ts:240`) while `document_type` is already `'sprint'` (`api/src/db/schema.sql:100`) — the split is route-path and vocabulary, not table | — | p.3 | PF-063 |
| PF-078 | ☐ Ownership: L03 owns the map, L10 consumes it | `resource-map.ts` header states the contract-name-vs-table-name rule and names L03 as owner; L10's `/api/v1/sprints` routes import the map instead of restating the mapping — test asserts the sprints route module contains no `weeks` literal and resolves its domain module through the map | — | p.3, p.4 | PF-077 |
| PF-079 | ☐ Fitness test: every `/api/v1` route declares a registered scope | Walks the mounted v1 router's metadata (PF-072) and fails on any route with no scope **or** a scope absent from the registry; test names the offending `METHOD /path`. A route added later without a scope fails CI — this is Testing Scenario 4(b) | MVP-4, TS-4 | p.5 | PF-072, PF-062 |
| PF-080 | ☐ Negative matrix: insufficient / unknown / not-granted / wrong-resource | Four cases, four assertions: (a) token with `documents:read` on a `documents:write` route → 403 with `required_scope: 'documents:write'`; (b) authorize with `documents:delete` → `invalid_scope` listing it; (c) token with no scopes → 403, not 500; (d) token with `issues:write` on a `documents:write` route → 403 naming `documents:write`, proving the check is not "has any scope" | MVP-6 | p.2, p.3 | PF-069, PF-073 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L03-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L03-registry` | PF-061–066 | Scopes-as-data with the OCP property the architecture doc claims (p.12) | PF-066 extension test: new scope reaches 200/403 with an empty diff on `require-scope.ts` |
| S2 | `pf/L03-require-scope` | PF-067–072 | MVP gate 6 — 403 names the missing scope; MVP gate 4 — the `require(scope)` factory exists | PF-069 asserts `details.required_scope`; PF-071 asserts 401≠403 |
| S3 | `pf/L03-grant-validation` | PF-073–076 | Scope validation at grant time; L04/L05 unblocked with pure functions | PF-080(b) `invalid_scope`; PF-074 intersection table test |
| S4 | `pf/L03-sprints-weeks-map` | PF-077–078 | Public contract name `sprints` never leaks the internal `weeks` vocabulary | PF-077 grep fitness test over `api/src/platform/**` |
| S5 | `pf/L03-scope-fitness` | PF-079–080 | Testing Scenario 4(b) (p.5) — every route declares a scope; negative matrix green | PF-079 route-enumeration fitness test |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots, stated so you confirm or
refute rather than rediscover:

- **The sprints↔weeks mapping is the weakest area in this lane, and I made a judgment call.**
  What the PRD actually says is thin: the scope names are `sprints:read`/`sprints:write` (p.3) and
  the SDK surface is `client.sprints` (p.4, p.7). It says nothing about Ship's internal vocabulary.
  What the repo says, verified: the internal route is `/api/weeks` (`api/src/app.ts:240`), the
  `document_type` enum value is already `'sprint'` (`api/src/db/schema.sql:100`), and
  `docs/architecture.md:12` puts the note under `scopes/`. So the translation is **narrower than it
  looks** — it is a route-path and vocabulary mapping, not a column mapping. I placed the map in
  `platform/scopes/resource-map.ts` (PF-077) because architecture.md put the note there, and gave
  L03 ownership with L10 consuming (PF-078). **Left open:** whether a resource map belongs in
  `scopes/` at all, versus `api/v1/`. The scope string is just an identifier; the resource routing
  is arguably L08/L10's problem, and if the audit agrees, PF-077/078 should move and this lane keeps
  only the scope-name half. Do not silently split it across both lanes — that is the failure mode.
- **PF-076 is a decision I made on the user's behalf and should be re-litigated.** p.16 asks it as
  an open question: *"does a user who originally granted `documents:read` need to re-consent to
  grant `documents:write`, or do you support incremental consent?"* I picked re-consent-with-union
  because it is the smaller build and matches what a hand-rolled RFC 6749 implementation does by
  default. Incremental consent is the better product answer and the more defensible one in the
  Architecture Defense. If the audit has budget, flag PF-076 `⚑` and escalate rather than
  rubber-stamping it.
- **`/api/v1/scopes` is not ticketed.** p.16 references it in passing — *"small static lists (like
  `/api/v1/scopes`)"* — as an example in a pagination question, not as a requirement. A discovery
  endpoint listing the registry would be a natural PF-081 append and would make PF-063's
  `description` field earn its keep twice. I left it out rather than invent a requirement from an
  example inside a question. Your call.
- **PF-069/070/071 have an undeclared dependency on L07's `ApiError`.** I left the Deps column
  L03-internal rather than name an L07 ticket ID I have not read — L07's file is not written yet, so
  any ID would be a guess. But the dependency is real and it is *within* tier 1, where L03 and L07
  run concurrently. If L07's `ApiError` constructor signature moves, these three break. There is a working sketch at `api/src/platform/api/v1/errors.ts` (untracked, not wired, no
  tests) that both lanes are implicitly coding against. Confirm that sketch is L07's actual target
  or this is a silent conflict.
- **A working sketch of this lane already exists** at `api/src/platform/scopes/registry.ts`
  (untracked, 90 lines, no tests). It mixes the registry data and the middleware in one file, which
  PF-061 and PF-070 both split apart, and its 403 does not carry `scope_description`. Treat it as a
  spike, not as PF-061–069 already done.
- **Audit-trail coupling (PF-075).** p.4 requires the audit row to record `scope used`, and p.18
  asks the same question about metrics. L12 owns the audit trail. PF-075 asserts the mismatch is
  *recorded*; it does not assert the column exists. If L12 does not ship a `scope` field, PF-075
  passes vacuously. Check it.
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
