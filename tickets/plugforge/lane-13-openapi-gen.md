# L13 · OpenAPI 3.1 Generation & Parity

| | |
|---|---|
| **Agent** | `openapi-gen` |
| **Tier** | 4 — runs concurrently with L10, L14 |
| **Block** | PF-351–390 (28 allocated, 12 reserved for audit) |
| **Blocks on** | L09 (documents resource, PF-241–270 — not yet written); transitively L01, L03, L07, L08 |
| **Unblocks** | L17 (SDK core reads the spec), L18 (Scenario 5's SDK-side walk) |
| **MVP gate** | Item 7 (p.2) — *"OpenAPI 3.1 spec served at /api/v1/openapi.json, generated from route metadata (never hand-written), validating against the OpenAPI schema in a unit test"* |

**Why this lane is tier 4 and deliberately narrow.** Build Strategy §4 (p.11): *"Get the generator
working end-to-end with one resource (documents) before adding issues, sprints, and me. The fitness
test that asserts spec ↔ route parity is the single best defense against drift."* So this lane ships
the generator, the serving route, the schema-validation test and the parity harness against
**`documents` only**. L10's issues/sprints/me must land with zero generator edits — that is the
proof the mechanism is generic, and PF-363 asserts it.

**The internal API already has an OpenAPI setup and it must NOT be shared.** Verified in repo:
`api/src/openapi/registry.ts` builds one global `registry` with `OpenApiGeneratorV3`, emits
`openapi: '3.0.0'`, and is typed against `openapi3-ts/oas30`; `api/src/swagger.ts` serves it at
`/api/openapi.json` and writes static copies to `api/openapi.json` / `api/openapi.yaml`. Schemas
live in `api/src/openapi/schemas/*.ts` — 22 files, ~130 `registerPath()` calls, in a directory
**detached from every handler**, with zero tests binding a registration to a real route. That is
the hand-written-spec failure mode wearing a generator's clothes, and it is the exact thing p.11
forbids: *"Every public route's request/response schema lives in Zod adjacent to the handler."*
Reuse verdict: **reuse the library, duplicate nothing else.** Same `@asteasolutions/zod-to-openapi`
dependency, separate registry instance, separate generator (V31, not V3), separate route, separate
static output path, separate tests. Sharing the registry would put ~130 internal `/api` paths into
the public contract and violate the p.3 boundary.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-351 | ☐ `publicRegistry` is a distinct `OpenAPIRegistry`, never the internal one | `platform/openapi/registry.ts` constructs its own instance; a test asserts `generatePublicOpenAPIDocument().paths` and the internal `generateOpenAPIDocument().paths` share **zero** keys, and a grep assertion proves no file under `api/src/platform/openapi/` imports `api/src/openapi/`. The internal registry holds ~130 `registerPath` calls for `/api/*` — one shared instance publishes the entire internal surface as public contract | MVP-7 | p.2, p.3 | PF-001, PF-009 |
| PF-352 | ☐ `extendZodWithOpenApi(z)` called from exactly one module | Both `api/src/openapi/registry.ts` and the platform sketch currently call it on the same `zod` singleton. Either hoist to one shared module both import, or keep two calls **and** ship a test asserting double-extension is idempotent (`.openapi()` still present, no prototype clobber) after importing both registries in one process. Silent divergence here breaks generation only when both modules load — i.e. only in the real server, never in a focused unit test | — | — | PF-351 |
| PF-353 | ☐ Generator is `OpenApiGeneratorV31` and the document is typed, not `unknown` | `generatePublicOpenAPIDocument()` returns `OpenAPIObject` from `openapi3-ts/oas31` (the sketch returns `unknown`, which makes every downstream assertion untyped) and the emitted `openapi` field string-equals `'3.1.0'`. Guard rail: copying the internal module gives you `OpenApiGeneratorV3` + `oas30` + `'3.0.0'`, which fails MVP gate item 7 on the version alone | MVP-7 | p.2, p.3 | PF-351, PF-008 |
| PF-354 | ☐ `@asteasolutions/zod-to-openapi` pinned to an exact version | `api/package.json` currently declares `"7"` — any 7.x minor. Pin exactly, commit the lockfile, and ship a test asserting `OpenApiGeneratorV31` is exported by the installed build. A minor bump that changes 3.1 emission silently rewrites the published contract between two CI runs | — | p.10 | PF-353 |
| PF-355 | ☐ `info` + `servers` make the base URL derivable by an SDK | `servers[0].url` concatenated with any `paths` key resolves to a route that answers — asserted by a test that fetches `servers[0].url + '/documents'` against the booted app and gets a non-404. `info.version` comes from one exported constant, not a literal repeated in the generator and the package | MVP-7 | p.2, p.13 | PF-353 |
| PF-356 | ☐ Security scheme carries the scope list, read from `ScopeRegistry` | `components.securitySchemes` declares an OAuth2 scheme whose flow `scopes` object deep-equals `scopeRegistry.list()` (seven names, PF-062); adding a scope without regenerating fails the test. **Decision, not the PRD's:** the sketch registers `type: http, scheme: bearer`, which cannot express scopes at all — an http-bearer spec cannot tell a reader which scope a route needs, and p.3 makes scope-per-route the contract | MVP-7 | p.3, p.10 | PF-351, PF-062 |
| PF-357 | ☐ Generation happens once at boot and a generation failure refuses the boot | `createApp()` generates the document during assembly, not per request; a fixture registering an ungenerable schema makes `createApp()` **throw** with a message naming the offending method + path, and the entry point exits non-zero. Test asserts the throw and asserts no server socket was opened. **This is our decision — p.12 asks what happens, it does not say** (see audit notes) | — | p.12 | PF-353, PF-014 |
| PF-358 | ☐ `defineRoute()` — one call registers the Express handler **and** the spec entry | A single registration carries `{method, path, scope, request?, response, summary}` and produces both. Test: register a throwaway route on a fixture router and assert without any further edit that it appears in `enumerateV1Routes()` (PF-200) **and** in `generatePublicOpenAPIDocument().paths`. Two separate registration calls is the drift this lane exists to prevent — one call or the parity test is just measuring how disciplined we were | MVP-7 | p.2, p.11 | PF-351, PF-200, PF-072 |
| PF-359 | ☐ Zod schemas live adjacent to the handler — enforced, not asked for | Fitness test walks `platform/api/v1/**` and asserts every route module defines its request/response schemas in the same file or a sibling `*.schema.ts` in the same directory, and that **no** platform file imports `api/src/openapi/schemas/`. The internal API's 22-file detached `schemas/` tree is the counter-example this rule exists to keep out of the public layer | MVP-7 | p.11 | PF-358, PF-009 |
| PF-360 | ☐ The response schema is the object the handler actually returns | The declared response Zod is applied to the handler's payload before serialization; a test that adds an undeclared field to a handler's return value makes the request **fail**, not pass. **Decision: enforce in test + dev, log-only in production** — the +10% P95 budget (p.6) makes unconditional response parsing a real cost. Without this ticket a spec entry can exist and still lie, and PF-373 would still be green | MVP-7 | p.6, p.11 | PF-358 |
| PF-361 | ☐ One shared `ApiError` component, generated from L07's schema | `components.schemas.ApiError` is generated from `apiErrorBodySchema` (PF-199) — grep proves one definition of the shape in the repo, no restatement in the openapi module. Every operation in the generated spec declares at least `401` and `500` responses `$ref`-ing it; a test walks all operations and fails naming any that does not | MVP-7 | p.3, p.7 | PF-358, PF-199, PF-186 |
| PF-362 | ☐ List operations declare cursor params and the `{data, next_cursor}` envelope | Every operation flagged as a list endpoint declares `limit` and `cursor` query parameters and a response schema with exactly the `data` + `next_cursor` keys, generated from L08's shared pagination Zod rather than restated in the spec module. Test asserts the `documents` list operation carries both and that the cursor param is typed `string`, not `integer` — the cursors are opaque base64, not offsets | MVP-7 | p.3 | PF-358 |
| PF-363 | ☐ `documents` only — issues, sprints and `me` are provably absent | Generated `paths` for this lane's branch equals exactly the documents set (list, by-id, create); a test asserts `/issues`, `/sprints`, `/me` are **not** present. Paired proof for L10: when those resources land, the diff touches their route modules and the generated spec, and **zero lines** of `platform/openapi/`. Build Strategy §4 is explicit that one resource proves the generator first | MVP-7 | p.11 | PF-358 |
| PF-364 | ☐ Deterministic, unique `operationId` on every operation | Derived from method + path by one exported function; a test asserts (a) uniqueness across the whole spec, (b) byte-stability across two consecutive generations in one process and across a fresh import — a spec whose keys move between runs makes PF-369's diff check flap and gives L18 no stable handle to key SDK methods off | TS-5 | p.5 | PF-358 |
| PF-365 | ☐ `GET /api/v1/openapi.json` is actually reachable | Test asserts 200 + `content-type: application/json` on the booted app. **Verified defect in the current design:** `createPublicRouter` ends with a catch-all that calls `next(new ApiError('not_found', …))` followed by a terminal `apiErrorMiddleware()`, so `app.get('/api/v1/openapi.json', …)` registered *after* `app.use('/api/v1', v1)` — which is what `docs/architecture.md`'s composition root shows — can never be reached. It 404s in the envelope. Mount inside the router, ahead of the catch-all | MVP-7 | p.2, p.3 | PF-353, PF-194, PF-197 |
| PF-366 | ☐ The spec resolves with no credentials | A request carrying no `Authorization` header returns 200. Requires mounting ahead of `deps.bearerAuth` in `createPublicRouter`, whose current `router.use(deps.bearerAuth)` blankets every path. Second assertion in the same test: every *other* v1 route still returns 401 unauthenticated — the exemption is exactly one path, not a hole. A grader cannot resolve a spec that 401s | MVP-10 | p.2, p.13 | PF-365 |
| PF-367 | ☐ Spec route's bypass of limiter and audit is intentional and written down | Mounting ahead of `bearerAuth` also mounts ahead of `rateLimitMiddleware` and `publicAuditMiddleware` (that is the sketch's order). **Decision: accept the bypass** — there is no token to bucket against and no app to attribute an audit row to. Asserted by a test (spec request writes no audit row, consumes no bucket) and stated in `platform/README.md`, so L11/L12 do not treat the gap as their bug | — | — | PF-366 |
| PF-368 | ☐ Static copy committed at `docs/openapi.json` | A dedicated script (`pnpm openapi:public`) writes `docs/openapi.json`; a test asserts the file's parsed content deep-equals the body served by `GET /api/v1/openapi.json`. Must **not** reuse `pnpm openapi:generate`, which invokes `generateOpenApiFile()` in `api/src/swagger.ts` and writes the internal 3.0 spec to `api/openapi.json` + `api/openapi.yaml`. Different spec, different version, different path | — | p.13 | PF-353, PF-365 |
| PF-369 | ☐ CI fails when `docs/openapi.json` is stale | Job regenerates and runs `git diff --exit-code docs/openapi.json`; a PR that adds a route without regenerating fails with a message naming the file and the command to fix it. Without this, the committed submission artifact drifts from the live one and only the grader finds out | — | p.13, p.18 | PF-368 |
| PF-370 | ☐ A real OpenAPI **3.1** validator, pinned, proven to reject | No JSON-schema validator exists in the repo today — `api/package.json` has no `ajv`, no `@apidevtools/swagger-parser`, no `@readme/openapi-parser`. Add one that handles 3.1 (JSON Schema 2020-12 — a 3.0-era validator silently accepts or wrongly rejects). Acceptance: the validator **rejects** a deliberately malformed fixture spec committed beside the test. A validator that accepts everything is the failure mode, and it passes just as green | MVP-7 | p.2, p.5 | PF-008 |
| PF-371 | ☐ Unit test: generated document validates against the OpenAPI 3.1 JSON schema | `validate(generatePublicOpenAPIDocument())` passes, and on failure the test prints every validator error path — not just `false`. Runs in the `api` vitest suite invoked by CI (`.github/workflows/ci.yml`, the `pnpm --filter @ship/api exec vitest run` step), so it gates every PR, not only the E2E job | MVP-7, TS-5 | p.2, p.5 | PF-370, PF-353 |
| PF-372 | ☐ Validate the **served** bytes, not only the in-process object | Test boots the app, fetches `/api/v1/openapi.json`, `JSON.parse`s the response text and validates that. Catches what PF-371 structurally cannot: serialization damage — `undefined` keys dropped, a `Date` stringified, `res.send(object)` re-typing the body. Scenario 5 names the URL, not the function | TS-5 | p.5 | PF-371, PF-365 |
| PF-373 | ☐ Parity forward — every enumerated route has a spec entry | Registered through L07's `registerRouteAssertion(name, fn)` seam (PF-202), **not** a second route walk. For each `{method, path}` from `enumerateV1Routes()` (PF-200), assert `spec.paths[toOpenApiPath(path)][method]` exists; the failure message names `METHOD /path`. This is Testing Scenario 4 clause (a) | TS-4 | p.5 | PF-200, PF-202, PF-358 |
| PF-374 | ☐ `toOpenApiPath()` — one shared path-template normalizer, table-tested | Express `/documents/:id` ↔ OpenAPI `/documents/{id}`; the `/api/v1` prefix belongs to the mount and `servers[0].url`, never to a `paths` key. One exported function used by **both** the generator and PF-373. Table test covers `:id`, two params in one path, trailing slash, and an optional param. Two normalizers means parity fails on formatting or passes on a coincidence | TS-4 | p.5 | PF-358 |
| PF-375 | ☐ Parity reverse — every spec operation maps to a mounted route | For each `paths × method` in the generated document, assert a matching mounted route exists; a hand-added path entry with no route fails, naming it. The forward test cannot catch this direction, and it is the direction "hand-written specs lie" actually describes — a documented endpoint that does not exist | TS-4 | p.6, p.11 | PF-373, PF-374 |
| PF-376 | ☐ Parity fails loudly on an empty enumeration or an empty spec | Asserts `routes.length > 0` **and** `Object.keys(spec.paths).length > 0` before comparing, with distinct failure messages. Both parity tests pass vacuously on an empty input, and p.6 sets the target at 100% — 0 of 0 is 100%. Repo precedent for exactly this class of guard: `scripts/assert-tests-ran.sh <n>` already wraps the agent and E2E suites in CI | TS-4 | p.6 | PF-373, PF-375 |
| PF-377 | ☐ CI wiring: drift **fails the build**; additive changes get no exemption | Answers Pre-Search 3.3 (p.18) explicitly. **Decision: fail, not warn-with-diff-comment**, and no additive carve-out — a new route with no spec entry fails like any other drift, because "it's only additive" is how every drift starts. The parity + validation tests run in a blocking required check; a fixture PR adding an unregistered route is confirmed red. p.4 already requires drift to fail CI for the SDK-side test; same posture, one lane earlier | TS-4 | p.4, p.18 | PF-371, PF-373, PF-375 |
| PF-378 | ☐ Export `listSpecOperations(spec)` for L18 — and stop there | Returns `{operationId, method, path}[]`; test asserts non-empty for `documents` and asserts this module imports nothing from `sdk/`. Scenario 5's second half — *"walk every spec method and assert the SDK exposes a typed call for it"* — is **L18's** test using this exporter. L13 provides the spec-side walk and the stable `operationId` (PF-364); it does not assert anything about the SDK | TS-5 | p.4, p.5 | PF-364, PF-375 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L13-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L13-generator-core` | PF-351–357 | A public 3.1 generator exists, separate from the internal 3.0 one, and a generation failure stops the boot | Zero path-key overlap with the internal registry; emitted `openapi === '3.1.0'`; scope list deep-equals `scopeRegistry.list()`; broken-schema fixture makes `createApp()` throw |
| S2 | `pf/L13-route-metadata` | PF-358–364 | MVP gate 7's "generated from route metadata" half — one registration produces route + spec entry, for `documents` only | Fixture route appears in both the enumerator and `paths` with no second registration; `/issues`,`/sprints`,`/me` absent; `operationId` unique and stable |
| S3 | `pf/L13-serve-and-publish` | PF-365–369 | The spec resolves at the URL the PRD names, without credentials, and the committed copy cannot go stale | Unauthenticated `GET /api/v1/openapi.json` → 200 JSON while every other v1 route → 401; `git diff --exit-code docs/openapi.json` |
| S4 | `pf/L13-schema-validation` | PF-370–372 | MVP gate 7's "validating against the OpenAPI schema in a unit test" half; Scenario 5's first half | Malformed fixture rejected by the validator; generated doc validates; served bytes validate after `JSON.parse` |
| S5 | `pf/L13-parity-fitness` | PF-373–378 | Testing Scenario 4(a) both directions, wired to fail CI; the seam L18 needs for Scenario 5 | Forward and reverse parity green over a non-empty enumeration; fixture PR adding an unregistered route is red in CI |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **Fail-fast at boot (PF-357) is our decision, not the PRD's.** p.12 lists *"the OpenAPI generator
  throws at boot"* only as a Failure Modes paragraph the architecture document must contain — it
  asks the question and prescribes nothing. `docs/architecture.md` answers "the process refuses to
  start," and PF-357 implements that answer. The defensible alternative is boot-and-serve-503 on
  the spec route so an unrelated schema bug cannot take the whole API down during a graded demo.
  I kept fail-fast because it matches the committed architecture doc, and changing it means editing
  a graded deliverable. Worth re-litigating if the audit disagrees — it is a decision, not a
  requirement, and the ticket says so.
- **The security-scheme change (PF-356) contradicts the untracked sketch.** `platform/openapi/
  registry.ts` registers `type: 'http', scheme: 'bearer'`. An http-bearer scheme has no `scopes`
  object, so the generated spec cannot say which scope a route requires — and p.3 makes exactly
  that the contract. I moved it to an OAuth2 scheme fed by `ScopeRegistry`. This is a real change
  to code already on disk; if the audit prefers keeping http-bearer, the per-route scope must be
  documented some other way (a vendor extension, or the operation description) and PF-356 needs
  rewriting rather than deleting.
- **PF-360 (response-schema enforcement) is the most likely thing to get cut, and cutting it makes
  PF-373 much weaker.** Parity proves an entry *exists* for every route. It does not prove the
  entry is *true*. Without PF-360, a handler can drift from its declared response schema forever
  and every test in this lane stays green. The production log-only posture is my call, driven by
  the +10% P95 budget (p.6); the PRD does not discuss response validation at all.
- **PF-352 has no PRD citation and comes from a verified repo fact:** `extendZodWithOpenApi(z)` is
  called in both `api/src/openapi/registry.ts` and `api/src/platform/openapi/registry.ts` against
  the same `zod@3.25.76` singleton. I did not run the double-import to see what happens — the
  ticket demands the test rather than asserting the outcome. If it turns out to be harmless, the
  ticket shrinks to a one-line comment; if it is not, it is a boot-time-only failure.
- **PF-368/PF-369 are marked `—` on purpose.** The static `docs/openapi.json` copy is a Submission
  Requirement (p.13), not an MVP checkbox and not a Testing Scenario, so under the spine's rule it
  advances no graded acceptance criterion even though it is a required deliverable. Same reasoning
  for PF-352, PF-354, PF-357 and PF-367. If the audit thinks p.13 deliverables deserve their own
  citation namespace, that is a spine change, not a lane change — raise it there, not here.
- **Pre-Search 3.3's "what about additive changes?" is answered by fiat in PF-377** (no exemption).
  The PRD asks and does not answer. The counter-argument is real: an additive-only policy would let
  L10 land `/issues` routes before their spec entries and keep CI green for one commit. I judged
  that the exact hole this lane exists to close. p.16 also asks a **versioning policy** question
  (*"additive only, breaking changes via /v2/, or deprecation headers"*) — that is a different
  question about the public contract's evolution, it is not ticketed here, and I did not find an
  owner for it in the spine. Cross-lane finding for `lane-99-unassigned.md` if it is still unowned.
- **Deps stop at IDs that exist.** L09 (PF-241–270) and L08 (PF-211–240) are unwritten, so no
  ticket cites them even where the dependency is real: PF-362 needs L08's pagination Zod, PF-358
  and PF-363 need L09's documents handlers, and PF-365's mount point is L08's router composition.
  Those four Deps cells are under-stated by design — re-point them once those files land.
- **PF-373 must consume `registerRouteAssertion` (PF-202), not fork the walk.** L07's audit notes
  raise the same worry from the other side. Three lanes hang clauses off one enumerator; three
  enumerators would mean three different definitions of "every route" and Scenario 4 would be
  measuring nothing. Check that the shipped test registers rather than re-walks.
- **Scenario 5's second half is L18's, deliberately.** PF-378 exports the spec-side walk and
  nothing more. If L18's file, when written, contains its own spec parser, that is duplication to
  flag — not a second opinion.
- **Not covered here, on purpose:** rendered docs (Redoc/Swagger UI for the public spec) — p.18
  asks whether the spec is *"also published as a static doc,"* and I answered only the static-JSON
  half (PF-368) because the portal is L22's; the pre-registered grader OAuth app whose credentials
  make the spec useful (L21/L26); and the SDK generation-vs-hand-written tradeoff p.16 raises,
  which p.10 already settles as hand-written-and-parity-tested and which belongs to L17/L18.
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
