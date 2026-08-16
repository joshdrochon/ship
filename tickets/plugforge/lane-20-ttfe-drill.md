# L20 · TTFE Drill & CI Harness

| | |
|---|---|
| **Agent** | `ttfe-drill` |
| **Tier** | 8 — the deepest lane on the board; everything it asserts was built by someone else |
| **Block** | PF-586–615 (26 written, 4 reserved for audit) |
| **Blocks on** | L19 (CLI — PF-556–581; **landed mid-authoring**, and it built the seam from its side: PF-581 exports every command as an importable function *"so L20's drill drives the CLI without scraping a terminal"*), L16 (PF-451–484 — `HttpDeliverer`, delivery log, `latency_ms`); transitively L17 (PF-491–515 client, token store), L18 (PF-521–548 resource clients, `deviceLogin`, `verifyWebhook`), L15 (PF-421–447 subscriptions + signer), L14 (PF-391–412 event bus), L01 (PF-001–026 workspaces, boundary lint, composition root) |
| **Unblocks** | L26 (PF-808 — Epic 6's submission proof is *this drill passing in CI*) |
| **Testing Scenarios** | **TS-9** (p.5) — *"Run the Time-to-First-Event drill end-to-end (see Signature Challenge): from a clean container, `pnpm install @ship/sdk` → `ship login` → create document → receive verified webhook in under 30 minutes elapsed."* Unclaimed by any other lane before this file existed |

**This is the PRD's signature technical challenge and it says so in those words.** p.6: *"This is the
project's signature technical challenge and the moment the three-part arc clicks shut."* The question
it asks is *"on a clean container, with only the published docs and the SDK, how long does it take a
developer to go from nothing to a verified signed webhook in their terminal?"* — and it sets the
consequence for missing: *"Anything over 30 minutes means the platform is a curl tutorial."* p.14
closes the document with *"The TTFE drill is the rubric."* Nothing else on this board is described
that way.

**The drill is a submission artifact, not just a test.** p.13's Per-Epic Write-up row: *"For Epic 6,
proof is the TTFE drill passing in"* CI. So a green local run is not the deliverable — a green
*pipeline* is, and it has to still resolve when a grader clicks it.

**Every assertion here belongs to somebody else's code.** This lane writes no platform feature. It
writes the one test that fails when any of eleven lanes has drifted, and it is the only place in the
build where a real elapsed millisecond exists end-to-end. That is also why it is the last tier: a
drill authored before its dependencies exist would be written against imagined signatures.

**Four repo facts that shape this lane, verified by reading the code:**

1. **`playwright.config.ts:60` is `retries: process.env.CI ? 2 : 1`.** p.9 requires a **0% flake
   rate over 20 consecutive CI runs** and glosses it as *"any flake = bug in the drill or the
   platform."* A retry is exactly the mechanism that turns a flake into a pass, so a drill written
   as a Playwright test forfeits that target on line 60 of a config it never reads. The drill runs
   under **vitest** with `retry: 0` (PF-586, PF-605). This also keeps it out of the 874-test, 150-minute
   `e2e` job and out of the way of the repo's standing rule against invoking `pnpm test:e2e` directly.
2. **`.gitlab-ci.yml`'s `workflow.rules` sets `merge_request_event → when: never`.** p.6 requires the
   drill to run *"in CI on every PR"*; here that is served by the **branch** pipeline for the same
   SHA, deliberately, because a jobless MR pipeline once failed and blocked merges while every real
   check was green (the comment at the top of that file records it). A `ttfe` job given MR-only
   rules would never execute (PF-608).
3. **Testcontainers work on this runner, and dind does not.** `agent-test` reaches the runner's
   *mounted* Docker socket with `TESTCONTAINERS_HOST_OVERRIDE: host.docker.internal` and
   `TESTCONTAINERS_RYUK_DISABLED: 'true'`; the `docker:27-dind` service it used to run never
   attached to the job network and killed 10 of 20 spec files in `beforeAll`. PF-587 provisions its
   Ship instance the way `agent-test` does, not the way `docker-image` does.
4. **The sketches on disk are stubs.** `integrations/cli/src/index.ts` prints
   `not implemented yet — see TODO(josh) E6` for all three commands and has no `@ship/sdk` import;
   `sdk/src/auth/flows.ts` is `export {}`; there is no `tests/` directory under `integrations/cli/`
   and no `drill` script in the root `package.json`. Nothing in this lane is partially done.

**What this lane does not own.** The `ship login` / `ship docs create` / `ship webhooks tail`
commands (L19 — the drill asserts them at PF-611, it does not implement them), `verifyWebhook`
itself (L18 PF-542–547), the signer (L15), the deliverer and delivery log (L16), the dev portal
(L22), and the Epic 6 write-up prose (L26 PF-808). Cross-lane findings go to
`lane-99-unassigned.md`.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-586 | ☑ `pnpm drill ttfe` — one command, from a clean working directory, and deliberately not a Playwright test | p.6 names the invocation literally: *"`pnpm drill ttfe` runs the full loop end-to-end against a containerized Ship instance from a clean working directory."* Root `package.json` gains a `drill` script so that exact string works. "Clean working directory" is asserted, not assumed: the drill runs on a fresh checkout with no `pnpm dev` first, no `api/.env.local`, no seeded database and nothing already listening — it provisions everything it needs and destroys it. It runs under **vitest**, not Playwright: `playwright.config.ts:60` grants two retries in CI, which forfeits p.9's 0%-flake target before a line of drill code is written | TS-9 | p.5, p.6 | PF-005 |
| PF-587 | ☑ The drill starts the Ship instance it tests — containerized, throwaway, and never a dev or deployed database | *"against a containerized Ship instance"* (p.6). Postgres comes from **testcontainers** — the mechanism this repo already uses in `e2e/fixtures/isolated-env.ts` and the agent suite — followed by migrations and `createApp()` wired with the **production** deps factory (PF-015), not `testDeps()`: the drill must exercise the real `HttpDeliverer` over a real socket or it proves nothing p.11's unit suites do not already prove. Three assertions: the drill refuses to start, with a named error, if `DATABASE_URL` points at anything it did not create; two concurrent drill runs do not collide on ports or schema; nothing survives teardown | TS-9 | p.6, p.11 | PF-014, PF-015 |
| PF-588 | ☑ The drill file is `integrations/cli/tests/ttfe.drill.ts` and its import graph contains **only** `@ship/sdk` | p.7 gives the path literally in the Example Drill Loop header. p.11 is categorical: *"External integrations live in integrations/ and import only @ship/sdk — never api/src/."* L01's boundary rule (PF-011) and its negative fixture (PF-012) already enforce this; the drill is added to the lint job's scope (PF-013). ⚑ The tension is real and must be resolved structurally, not waived: PF-587 has to boot a server, which needs server code. So the **harness that boots Ship lives outside `integrations/`** and is invoked as a child process over HTTP, while the drill file itself touches nothing but `@ship/sdk` and its own listener. A drill that imports `createApp` directly is a drill in which the boundary claim it exists to demonstrate is false | TS-9 | p.7, p.11 | PF-011, PF-012, PF-013 |
| PF-589 | ☑ **Decision: real install of the packed artifact, two cadences, symlink rejected** | Pre-Search 3.2 (p.17) asks it outright — *"How is the TTFE drill written — full `pnpm install` in a fresh container, or workspace symlink with the install"* step mocked, *"Which proves more, and which is fast enough for CI?"* **Answer: real install in both modes.** Default mode runs `pnpm pack` on `@ship/sdk` and installs the resulting tarball into an empty directory **outside** the workspace; `--clean` mode (PF-590) does the same in a cold container. A workspace symlink resolves `sdk/src` through tsconfig `paths` and therefore never executes the published artifact — the `exports` map, the `files` allowlist, the built `dist/` and peer-dependency resolution all go untested, and each is a live way `pnpm install @ship/sdk` fails for a stranger while CI is green. L99's F14 is exactly that class of bug (`verifyWebhook` top-level-imports `node:crypto`, found independently by two lanes). p.8's install row asks for *"Workspace package resolves"*, *"types load in editor"* and *"no peer-dependency errors"* — a symlink checks none of the three honestly. **Location clause corrected in place 2026-08-15 — the decision is written down, but not where this row said it was.** Original: *"Written into `docs/architecture.md`."* It is not there: `grep -n "PF-589\|symlink\|packed artifact" docs/architecture.md` returns nothing. It lives in **`docs/architecture-appendix.md:677`**, under the heading *"### Decision: a real install of the packed artifact, two cadences, symlink rejected (PF-589)"*. That distinction matters for a submission row rather than being pedantic, because the appendix opens by disclaiming its own weight: *"Nothing in this file is required reading to grade the Architecture Document row"* (`architecture-appendix.md:11`). So the decision record exists and is complete, but it sits in the explicitly-not-graded half of the pair, and this row may not claim the graded half. **As-built acceptance:** the decision and its rationale are recorded in `docs/architecture-appendix.md:677`; L25's Pre-Search 3.2 answer consumes it. Moving it into `docs/architecture.md` was not done here — that file is under concurrent edit by the doc-truth pass, and racing it would have produced a merge conflict on a graded artifact the night before submission | SUB:Pre-Search Document | p.8, p.17 | PF-004, PF-514 |
| PF-590 | ☑ `--clean` mode: no repo mount, no warm store, no cache — the only mode allowed to claim ≤ 30 min | The identical stage script, run inside a `node:22-bookworm` container started with **no bind mount of the repo**, an empty pnpm store, and exactly two inputs: the packed tarball served over HTTP and the published docs. It reaches the Ship instance over the network like any external consumer. Its budget is p.8's *"≤ 30 min real elapsed"*, not 60 s — the two numbers pull in opposite directions and this is where that is resolved, by giving each target its own mode rather than by picking one. It runs on a schedule and before Final Submission, **not** on every PR: at a cold store it costs minutes, and p.15 asks for a daily CI-minute ceiling. Its elapsed time lands in the same artifact as the fast mode carrying a `mode` field, so the two figures can never be reported as each other. **CLOSED ☑ 2026-08-16 by `pf/L26-close-the-weak`. `pnpm drill ttfe --clean` runs; it used to `exit 2`.** Measured twice on this machine: graded totals **12393 ms** and **11467 ms** — **0.21 min of the 30 min budget**, a 145× margin. All four properties are done rather than aliased onto the fast path, and each is asserted into `test-results/ttfe.json` so a reader need not trust the flag: `repoBindMounted: false` (the `docker run` passes no `-v`, no `--mount`, no `--network`, and `cleanConsumerParity.test.ts` greps the argument list for them), `pnpmStoreWarm: false` (a consequence of a fresh container, not a flag — pnpm itself is fetched by `corepack prepare pnpm@10.27.0` inside it), `tarballOverHttp: true` (`pnpm add http://host.docker.internal:PORT/ship-sdk.tgz` off a one-file static server), and `sdkRebuiltFromSource: true` (`sdk/dist` **and its `.tsbuildinfo`** removed, then rebuilt). Ship is booted on the host by `scripts/ttfe/harness.ts` and reached over the network, which is this ticket's own wording; that boot is `setupMs`, never the graded total. The stage script is `scripts/ttfe/clean/consumer.mjs`, a second copy of the six-stage loop against `@ship/sdk` and node builtins alone — the drill spec imports repo test support and L19's CLI commands and neither exists in a container with no repo mounted — with `integrations/cli/tests/cleanConsumerParity.test.ts` asserting the two copies agree on the six stage ids and order, the pinned pnpm version and the two stdout prefixes (**7/7 passing**). **Three real bugs the first runs found**, recorded because they were: deleting `sdk/dist` without its `.tsbuildinfo` makes tsc a no-op and packs a tarball whose `exports.import` and `types` point at absent files, exiting 0; the fast drill's `verifyUrl` assertion is host-specific and honestly false through a container boundary; and a stage that threw was reported as the stage after it, because the failing id was inferred from `records.length` after the recorder's `finally` had counted it. **Two things this does NOT close, stated rather than left to be found:** the number is **not load-certified** (`loadRatio` 1.608 on 10 cores, over F80's 0.8 veto — the verdict survives at 145× margin but the timing is not quotable as a platform figure), and the base image was cached on both runs (`imageWasCached: true`), so a genuinely bare machine pays ~1.6 GB more, timed separately as `imagePullMs`. **The second conjunct of p.8's AND is untouched: *"following only the published docs"* is PF-601 and no script can close it, including this one.** | PERF:TTFE on a clean machine ≤ 30 min | p.8, p.15 | PF-589 |
| PF-591 | ☑ Six named stages, each recording elapsed milliseconds — the PRD's six, in the PRD's order | p.6: *"each stage of the drill (install, login, register subscription, create document, receive webhook, verify signature) records elapsed milliseconds."* Exactly those six ids, exported as one frozen array so a stage cannot be renamed, reordered or quietly dropped. Timing comes from a monotonic source — `performance.now()`, which is what p.7's own sketch uses — never `Date.now()`. Three assertions: all six stages report a record; every `elapsedMs` is a finite non-negative number; the six stage times plus measured inter-stage gaps reconcile with the total to within 1 ms, so no work can hide between stages. Five stages that sum to 8 s inside a 55 s run is a measurement bug, and without the reconciliation nobody sees it | TS-9 | p.6, p.7 | PF-586 |
| PF-592 | ☑ Timings are a machine-readable artifact, not a log line | The run writes `test-results/ttfe.json`: `{mode, commit, startedAtIso, stages[{id, elapsedMs}], totalMs, pass}`, published as a CI artifact next to the existing `junit.xml` and `playwright-report/` paths. A human-readable table still goes to stdout, but the gate and the trend both read the JSON. Four separate consumers depend on this one file — PF-600's P95, PF-606's 20-run soak, PF-604's CI-minute figure and PF-610's submission evidence — and four consumers scraping four log formats is how a graded number quietly stops being comparable between runs | — | p.6, p.9 | PF-591 |
| PF-593 | ☑ A failing drill names the stage, its elapsed ms, and the assertion — first line, before anything else | p.14 ends the PRD with *"The TTFE drill is the rubric"*, and this is the output a grader reads when it goes red. Every stage failure leads with the stage id and its elapsed ms, then expected vs. actual; a timeout **inside** a stage is reported as that stage timing out, not as a generic runner timeout that names nothing; and the run still writes `ttfe.json` with `pass: false` plus the stages that did complete, because a failure that produces no artifact also produces no diagnosis. Test: force a failure in each of the six stages in turn and assert the message names that stage | — | p.6, p.14 | PF-592 |
| PF-594 | ☑ Install stage — the three assertions p.8's row names, not one | *"Workspace package resolves; types load in editor; no peer-dependency errors."* Three separate assertions in the drill. (a) `import { ShipClient } from '@ship/sdk'` resolves from the throwaway install directory **and** the module evaluates at runtime — resolution and evaluation are different failures, and F14's `node:crypto` import fails only the second. (b) `tsc --noEmit` over a two-line consumer file in that directory succeeds and the package's `types` entry resolves: *"types load in editor"* is checkable only as "the declaration files resolve for a consumer outside the workspace." (c) The installer's own output carries no peer-dependency warning or error, asserted on the captured output rather than eyeballed | TS-9 | p.8 | PF-589, PF-004 |
| PF-595 | ☑ Auth stage — user code displayed, polling succeeds within 60 s, token persists in the configured store | p.8's Auth row, three assertions. (a) `onUserCode` is invoked with a non-empty user code **and** a verification URL before the first poll — L18's PF-537 passes both, and a device flow that never displays the code is unusable however fast it completes. (b) The poll resolves inside 60 s of drill time while honoring the server's `interval` and any `slow_down` (PF-538); the drill authorizes the device code out of band against its own containerized instance, which is the single step a scripted drill cannot perform the way a human does, and the audit notes say so. (c) *"persists in configured store"* is proven by **reuse, not by inspection**: a second `ShipClient` constructed from the store alone makes a successful `.me()` call. Reading the file back only proves something was written | TS-9 | p.8 | PF-537, PF-538, PF-504, PF-506 |
| PF-596 | ☑ Subscribe stage — subscription persisted, signing secret returned once, appears in the dev portal | p.8's Subscribe row, three assertions. (a) `client.webhooks.create({event, target_url})` returns an id that a subsequent `get`/`list` resolves. (b) `signing_secret` is present on the create response and **absent** from every later read — asserted positively and negatively in the same stage, against L15's PF-423/PF-424 and L18's PF-525 two-type split. (c) *"appears in dev portal"* is supplied by L22's PF-674 — an assertion the drill **calls**, not a second Playwright suite, so the drill keeps its 60 s budget and the portal claim is checked rather than assumed. Until L22 lands, the fallback is the portal's own data source: it consumes the public API and adds no privileged internal route, so a subscription visible at `GET /api/v1/webhooks` is the portal's content. The drill must not grow a headless-browser dependency either way | TS-9 | p.8 | PF-524, PF-525, PF-429, PF-674 |
| PF-597 | ☑ Trigger stage — document created, `document.created` on the bus, subscriber receives the POST | p.8's Trigger row, three assertions, and the stage that spans the most lanes. (a) `client.documents.create({ title: "hello" })` — p.7's literal call — returns a document that `client.documents.get` resolves. (b) Exactly one `document.created` is published for that write: L14's PF-412 pins the server-side property, and the drill asserts its observable consequence, one delivery rather than two. (c) The drill's listener receives a POST carrying `Ship-Signature` and `Idempotency-Key` inside the stage budget. A stage asserting only (a) passes green on a platform whose event bus is disconnected, which is precisely the contract regression p.11 says this drill exists to catch | TS-9 | p.7, p.8 | PF-521, PF-412, PF-466 |
| PF-598 | ☑ Verify stage — valid passes, tampered fails, timestamp older than 5 min fails, on the bytes that actually arrived | p.8's Verify row, three assertions, run against the received delivery and **never** a re-signed fixture. (a) `verifyWebhook(headers, rawBody, sub.signing_secret)` returns `true` — p.7's loop uses it as the `waitFor` predicate, so the drill cannot complete without it. (b) One flipped byte in `rawBody` returns `false`. (c) A header whose `t` is 301 s old returns `false` at the documented 300 s default. L18 owns the helper and its seven-case negative matrix (PF-542–546); this stage owns the three rows the Evaluation Criteria table names, asserted on a live delivery — the case golden vectors structurally cannot cover, because vectors prove the verifier agrees with the signer while this proves the wire agrees with both | TS-9 | p.7, p.8 | PF-542, PF-543, PF-544, PF-435 |
| PF-599 | ☑ The listener is a real HTTP server and the drill captures raw bytes off it | The drill starts an `http.Server` on an ephemeral port and passes its URL as `target_url`. It captures the **unparsed** body as a string before any JSON parsing: a signature computed over a re-serialized body is a signature over different bytes, which is the consumer-side half of L15's one-serialization rule (PF-436) and the single most likely reason a correct verifier returns `false` on a correct delivery. `waitFor(predicate, { timeoutMs })` (p.7) resolves on the first delivery satisfying the predicate and rejects naming the stage on timeout. **No stubbing of `IWebhookDeliverer`** — the drill exercises `HttpDeliverer` over a socket, which is the whole difference between this and L15/L16's in-memory suites. ⚑ The listener's URL is `http://127.0.0.1:PORT`, which L15's PF-425 rejects except under `NODE_ENV === 'test'`; the drill therefore runs with that value set, and L19's PF-575 is asking L15 to widen the same gate for the *demo* path. If PF-425's constant is narrowed further, this stage breaks and nothing else in the repo notices | — | p.7 | PF-466, PF-436, PF-425 |
| PF-600 | ☑ Total elapsed < 60 s asserted in the drill, **and** a P95 tracked across runs — two gates, on purpose | p.8's example ends on `expect(performance.now() - t0).toBeLessThan(60_000)`; ship that assertion literally, measured from the first stage's start to the last stage's end. But p.8's target is a **P95**, which no single run can produce: the CI job appends `totalMs` from `ttfe.json` to a rolling series, and a check fails when the P95 over the last 20 recorded runs exceeds 60 000 ms. The per-run assertion catches a regression on the PR that caused it; the P95 catches a slow drift that never trips any individual run. Reporting one and calling it the other is the easiest way to claim this target without meeting it | PERF:TTFE drill runtime in CI (P95) < 60 s | p.8 | PF-591, PF-592 |
| PF-601 | ☐ The ≤ 30 min clean-machine figure is **measured by a person following only the published docs**, and recorded | p.6 frames the claim as *"on a clean container, with only the published docs and the SDK"*; p.8 budgets it at *"≤ 30 min real elapsed"*. PF-590 proves the loop works from a cold container, but it runs a script, and a script cannot discover that a step is missing from the README — which is the failure mode the 30-minute number is actually measuring. Acceptance: one timed run by a human starting from the repo's published docs and nothing else, recording elapsed minutes, every documentation gap hit, and the fix for each. Figure and log join the submission artifact set. A number nobody ever measured is a claim, not a target | PERF:TTFE on a clean machine ≤ 30 min | p.6, p.8 | PF-590 |
| PF-602 | ☑ Signature verification < 1 ms — gated on L18's recorded benchmark, from the same build the drill just ran | p.8's Signature Challenge table sets the target; p.6 requires *"Signature verification by the SDK in one line."* L18's PF-547 records the per-call figure over ≥ 1000 iterations. This ticket asserts the figure exists, is under 1 ms, and was produced by the **same packed `@ship/sdk` build** the drill installed — a benchmark of a different build is not a measurement of this one, and the packed artifact is the only build an external developer ever runs. The drill also records the wall time of its own single verify call into `ttfe.json` for the trend, but one call is noise and is explicitly **not** the gate | PERF:webhook signature verification < 1 ms | p.6, p.8 | PF-547, PF-542 |
| PF-603 | ☑ Event → POST arrival measured on the wire — the first real proof of p.6's < 2 s webhook target | ⚑ **L99's U5 records that no lane proves this**, and asks L16 or L20 to claim it. This lane claims it. L15's timing assertions all run on `FakeClock` per p.11's no-sleeps rule, and L16's `latency_ms` (PF-461) brackets the HTTP call only — so the drill is the one place an end-to-end elapsed time exists at all. Acceptance: the trigger and receive stages together yield `documentCreatedAt → firstPostReceivedAt` in real milliseconds, recorded in `ttfe.json`, with the P95 over the same 20-run series as PF-600 under 2 000 ms. **This does not breach p.11** — the prohibition is on `setTimeout` waits inside tests of the retry ladder; the drill waits on an arriving request, never on a clock, and PF-605's grep enforces the difference | PERF:webhook delivery P95 < 2 s | p.6, p.11 | PF-597, PF-599, PF-461 |
| PF-604 | ◐ The drill's CI cost is a measured number, handed to the cost analysis rather than estimated inside it | p.9: *"CI minutes for the TTFE drill — every PR runs the full end-to-end loop. Time it on Day 1 and budget the"* weekly CI bill explicitly. p.15's 1.2 asks the daily ceiling given the drill **plus** the OAuth Playwright flow **plus** the full regression suite. Acceptance: the job records its own wall-clock duration — fast mode and `--clean` reported separately, since they differ by an order of magnitude — into `ttfe.json`, and one line states minutes-per-PR × PRs-per-day. p.9 also names delivery-log storage growing *"with every drill run"*, so the rows each run creates (one document, one subscription, ≥ one delivery) are counted with it. The narrative belongs to L26's AI Cost Analysis; the measurement belongs here | SUB:AI Cost Analysis | p.9, p.15 | PF-592 |
| PF-605 | ☑ Zero retries, zero sleeps — the drill may not be made to pass by running it again | p.9's target is *"0% (any flake = bug in the drill or the platform)"*, and a retry is precisely the mechanism that converts a flake into a pass, so that phrasing forbids retries rather than merely discouraging them. Acceptance: the drill's vitest config sets `retry: 0`, the CI job adds no retry wrapper, and a fitness grep over the drill and its harness finds no fixed-duration sleep — no bare `setTimeout(` wait, no `await new Promise(r => setTimeout(...))`. Every wait is on a condition with a named timeout (PF-599). ⚑ Repo fact: `playwright.config.ts:60` is `retries: process.env.CI ? 2 : 1`, so a drill written into that suite inherits two retries and forfeits this target silently — the second reason PF-586 keeps it out | PERF:drill flake rate 0% over 20 CI runs | p.9, p.11 | PF-586, PF-599 |
| PF-606 | ☑ The 20-run soak, actually run and recorded — 20/20, or a named bug | p.9 measures flake *"over 20 consecutive CI runs"* and reads any flake as a bug in the drill or the platform. Acceptance: 20 consecutive runs against one commit, each in a fresh container, each appending its `ttfe.json` to the series; the pass count must be 20 of 20. A failing run is **not** re-run to clear it — it is diagnosed, and the diagnosis names either the drill or the platform, which is what the PRD's own gloss demands. Commit the run count, the commit SHA and the per-run totals as evidence: an unrecorded soak is indistinguishable from a soak nobody ran | PERF:drill flake rate 0% over 20 CI runs | p.9 | PF-605, PF-592 |
| PF-607 | ☑ Negative control — the drill is observed catching a contract regression the unit suites miss | p.11 claims the drill *"will catch contract regressions faster than any unit test"* and p.14 asks the interviewee to *"Walk through a bug the TTFE drill caught that your unit tests missed."* Both are assertions about a test that, until it has been seen failing for the right reason, nobody has evidence for. Acceptance: a fixture branch introduces exactly one real contract break — candidates that stay green under every existing unit suite: the signer emits `t` in milliseconds rather than seconds (against L15's PF-435 grammar), `create()` stops returning `signing_secret`, or the packed `exports` map loses its types entry. Assert the drill goes red and names the failing stage, and assert `pnpm test` stays green on that same commit. The write-up in p.14's answer comes from this run | — | p.11, p.14 | PF-593, PF-594 |
| PF-608 | ☑ CI wiring — a blocking job on every branch pipeline, on both platforms, live from Day 5 | p.6: *"Drill runs in CI on every PR."* p.11: *"Time-to-first-event drill in CI from Day 5 onward. Once the SDK and one resource exist, the drill exists."* Acceptance: a `ttfe` job in `.gitlab-ci.yml` stage `verify`, `needs: ['build']`, `allow_failure: false`, mirrored in `.github/workflows/ci.yml` beside the existing eight checks. Three repo-specific constraints, each of which has already broken a job in that file: (a) `workflow.rules` sets `merge_request_event → never`, so *"every PR"* is served by the **branch** pipeline for the same SHA — giving this job MR-only rules means it never runs; (b) copy `agent-test`'s `TESTCONTAINERS_HOST_OVERRIDE: host.docker.internal` and `TESTCONTAINERS_RYUK_DISABLED: 'true'` and add **no** `docker:dind` service, which demonstrably never attaches on this runner; (c) wrap the invocation in `scripts/assert-tests-ran.sh 1 --` so a drill executing zero stages exits 2 rather than reading as a pass | TS-9 | p.6, p.11 | PF-013, PF-587 |
| PF-609 | ☑ The regression threshold is one configured value, and crossing it fails the build | p.6: *"Any regression past the configured threshold fails the build."* Acceptance: every threshold lives in exactly one committed file — total budget (60 000 ms), per-stage budgets, and the P95 window size — read by the drill, the P95 check and the CI job alike, with a grep asserting no second literal `60_000`/`60000` anywhere else. Raising a threshold then becomes a reviewable diff with the number visible in it, which is the point: p.8's budget is graded, and a budget that can be relaxed inside a test body is not a budget. A run over threshold exits non-zero naming the threshold, the measured value, and the file to argue with | TS-9 | p.6, p.8 | PF-600, PF-592 |
| PF-610 | ☐ Epic 6's proof artifact — the drill passing **in CI**, durably linked | p.13's Per-Epic Write-up row: *"For Epic 6, proof is the TTFE drill passing in"* CI. Not passing locally, not a screenshot of a terminal. Acceptance: a permanent link to a green `ttfe` job on a real pipeline with its `ttfe.json` attached, plus PF-606's soak record and PF-601's clean-machine log, assembled into the artifact set L26 consumes (it owns the write-up prose and final assembly; this lane owns producing evidence). Resolvability is part of the criterion, not a nicety — this repo has already shipped a submission whose first link 404'd for the whole window in which every other check stayed green, which is why `.gitlab-ci.yml` grew a `doc-links` job | SUB:Per-Epic Write-up | p.12, p.13 | PF-606, PF-601, PF-592 |
| PF-611 | ☑ **Testing Scenario 9**, recorded as one pass/fail — and driven through the CLI, not only the SDK | The graded scenario (p.5): *"from a clean container, `pnpm install @ship/sdk` → `ship login` → create document → receive verified webhook in under 30 minutes elapsed."* Acceptance: the five stages plus the total run as a single test that cannot report a partial pass — no stage is skippable, an unreached stage is a failure rather than an absence, and all six stage records are asserted present before any timing is asserted. Second half: the loop is also driven through the **CLI**, because p.5 and p.6 both write it as `ship login` / `ship docs create` / `ship webhooks tail` — if the CLI cannot drive the loop then the platform's headline story is unproven no matter how green the SDK path is. That half **imports L19's exported command functions** (`runLogin`, `runDocsCreate`, `runWebhooksTail` — PF-581, built for exactly this) with an injected output sink, and branches on PF-561's exported exit codes. It does not re-implement command logic and it does not scrape a terminal: a drill that re-implements is timing a parallel path that can drift from what the demo actually runs, which L19's audit notes ask the auditor to flag. ⚑ Sequencing: the SDK-path drill lands first (Day 5, p.11); the CLI-path assertion lands when L19's commands do | TS-9 | p.5, p.6 | PF-594, PF-595, PF-596, PF-597, PF-598, PF-581, PF-561 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L20-<slug>`; the PR body names the
acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L20-drill-harness` | PF-586–590 | p.6's first Required Capability — `pnpm drill ttfe` end to end against a containerized instance from a clean working directory, installing the **packed** SDK rather than a symlink | `pnpm drill ttfe` runs on a fresh checkout with no prior `pnpm dev`; the drill refuses a `DATABASE_URL` it did not create; boundary lint finds no `api/src/` in the drill's import graph; `--clean` completes in a container with no repo mounted and a cold store |
| S2 | `pf/L20-timing` | PF-591–593 | p.6's second Required Capability — the six named stages each recording elapsed milliseconds, in a file four consumers can read | Six stage records present and monotonic; stage times plus gaps reconcile with the total to within 1 ms; a forced failure in each stage names that stage and still writes `ttfe.json` with `pass: false` |
| S3 | `pf/L20-stage-assertions` | PF-594–599 | **p.8's Evaluation Criteria table, one assertion per row** — the table a grader walks, walked | Install: resolves, evaluates, types resolve for an outside consumer, no peer-dep output. Auth: code + URL displayed, poll inside 60 s, a second client built from the store alone calls `.me()`. Subscribe: persisted, secret present once and absent thereafter, visible over the portal's data source. Trigger: document resolves, exactly one delivery, POST carries both headers. Verify: valid true, tampered false, 301 s-old false — on the received bytes |
| S4 | `pf/L20-targets` | PF-600–604 | p.8's Performance Targets — Signature Challenge, plus the two targets that had no owner (< 2 s delivery, CI minutes) | `toBeLessThan(60_000)` asserted per run **and** P95 over 20 runs under 60 s; a human-timed clean-machine run recorded with its doc gaps; < 1 ms from L18's benchmark on the packed build; event→POST P95 under 2 000 ms; drill minutes-per-PR stated as a number |
| S5 | `pf/L20-flake-and-negative-control` | PF-605–607 | p.9's *"0% (any flake = bug in the drill or the platform)"* over 20 consecutive runs, and proof the drill can go red for the right reason | `retry: 0` in config and no retry wrapper in CI; grep finds no fixed-duration sleep in the drill or harness; 20/20 recorded against one commit with no re-runs; a fixture contract break turns the drill red and names the stage while `pnpm test` stays green |
| S6 | `pf/L20-ci-and-evidence` | PF-608–611 | p.6's *"Drill runs in CI on every PR"* and p.13's *"For Epic 6, proof is the TTFE drill passing in"* CI — plus **Testing Scenario 9** as one recorded pass/fail | `ttfe` job green on a branch pipeline with `allow_failure: false`, mirrored on GitHub, wrapped in `assert-tests-ran.sh 1 --`; thresholds grep to exactly one file; a resolvable link to a green pipeline with its artifact; TS-9 asserted whole, then re-asserted through the CLI when L19 lands |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **The real-install-vs-symlink answer (PF-589) is the load-bearing decision here and I would defend
  it on the merits.** The PRD asks which proves more and which is fast enough for CI, and treats
  those as a trade. They are only a trade if there is one mode. Packing the SDK and installing the
  tarball into a directory outside the workspace costs seconds, not minutes, once the pnpm store is
  warm — and it is the only version of the install stage that touches the artifact an external
  developer receives. A symlinked drill that never exercises a real install cannot honestly claim
  the clean-machine number, and saying so in the write-up is worth more than the seconds saved. The
  residual honesty gap, stated rather than hidden: the fast mode installs from a **local tarball**,
  not from a registry, so registry resolution and network variance are exercised only by `--clean`.
  If the audit wants the fast mode to hit a local Verdaccio too, that is defensible and costs a
  container; I did not take it because it buys coverage of npm's availability, not of ours.
- **Where I put each target, and why the two do not collide.** < 60 s in CI is the fast mode
  (PF-600), ≤ 30 min clean machine is `--clean` plus one human-timed run (PF-590, PF-601). The
  human run is the part people skip and it is the part p.6 actually describes — *"with only the
  published docs"* is a statement about documentation, and no script can fail because a README
  omits a step. If only one of the two survives a scope cut, keep the human run: a green
  `--clean` with an undocumented step still means the platform is a curl tutorial to a stranger.
- **PF-603 claims L99's U5, which was parked for L16 or L20.** L15's timings are all `FakeClock` and
  L16's `latency_ms` brackets only the HTTP call, so nothing measured event→arrival end to end
  before this. The drill does, in real time, once, per run — which is a sample of one per run and
  needs the 20-run series to be a P95 at all. That is the weakest of the four targets I claim and
  the audit should know it: if the soak series is short, the number is a mean wearing a P95's name.
  L16's first-attempt path is the other honest owner and could carry it with far more samples.
- **`TS-9` is on twelve tickets, which is more concentration than any other lane's scenario, and it
  is deliberate.** Scenario 9 is written as *"Run the Time-to-First-Event drill end-to-end (see
  Signature Challenge)"* — it incorporates p.6's four Required Capabilities and p.8's Evaluation
  Criteria table **by reference**, which is why capability tickets (PF-586, PF-591, PF-608, PF-609)
  carry `TS-9` rather than `—`. If the audit reads the reference more narrowly, those four drop to
  `—` and nothing else in the file changes. What must not happen is `CTR:` being stretched onto them:
  the spine scopes `CTR` to the Core Technical Requirements tables on p.2–5, and the Signature
  Challenge is p.6–8.
- **Four `PERF:` values and one `SUB:AI Cost Analysis`, using the spine's taxonomy as written.** L16
  and L18 both hit the p.6/p.8 target tables before `PERF` existed and both filed `—` while raising
  it as a spine change; the spine now carries the prefix, so this lane uses it. Two of my `PERF`
  rows come from p.8's Signature Challenge table, one from p.9's continuation of it (the flake
  rate), one from p.6's main Performance Targets table. If the audit wants those distinguished, the
  `<row name>` text already does it.
- **PF-596's "appears in dev portal" assertion resolved itself mid-authoring, and the two lanes
  agree without having coordinated.** L22 landed while this file was being written carrying PF-674 —
  *"The TTFE drill's portal assertion … Kept to an assertion the drill calls, not a second Playwright
  suite, so the drill stays under p.6's < 60 s CI target"* — which is the same shape PF-596 was
  written to need and for the same stated reason. It also carries `TS-9` in its own `Advances`
  column, so that scenario is now claimed by two lanes; that is correct rather than duplicative
  (L22 supplies one assertion, this lane runs the loop), but the audit should confirm it stays a
  handshake and not two portal checks. The fallback path in PF-596 exists only for the window before
  PF-674 lands.
- **PF-588's boundary tension is real and I resolved it structurally rather than waiving it.** The
  drill file may import only `@ship/sdk` (p.11, PF-011), yet something has to boot a Ship server.
  Splitting the harness out of `integrations/` and invoking it as a child process is the honest fix;
  the tempting one — an eslint-disable on one import line — would make the drill the single place in
  the repo where the boundary claim it exists to demonstrate is false. Worth re-checking at audit
  that the shipped layout kept the split.
- **The `pnpm test:e2e` rule and the Playwright retry config both point the same way, and only one
  of them is written down.** `.claude/CLAUDE.md` forbids invoking `pnpm test:e2e` directly; nothing
  documents that `playwright.config.ts:60` grants two CI retries, which is what would quietly void
  p.9's flake target. PF-586 and PF-605 both record it. If someone later moves the drill into the
  Playwright suite for convenience, the flake number becomes meaningless and no test fails to say so
  — the grep in PF-605 is the only guard, and it guards sleeps, not retries. A `retries: 0`
  assertion on whatever runner config the drill ends up under would close that; I did not ticket it
  separately because it is one line inside PF-605.
- **L19 landed mid-authoring and every contact point checks out — verify it stays true.**
  `lane-19-cli-integration.md` was not on disk when this file was started and is now, and it was
  written from the other side of the same seam: **PF-581** exports every command as a typed function
  with an injectable output sink and clock, in as many words *"so L20's drill drives the CLI without
  scraping a terminal"*; **PF-561** publishes exit codes as a frozen table *"L20's drill and any CI
  harness branch on"*; **PF-563** puts the device code and verification URL on stderr on a stable
  parseable line for exactly this consumer; **PF-571**'s `--json` keeps stdout machine-readable.
  PF-611 now depends on PF-581 and PF-561. One standing risk L19 names and I repeat: if the drill
  re-implements command logic instead of importing PF-581's exports, it times a parallel path that
  can drift from the demo — that is duplication to flag at audit, not a second opinion.
- **PF-599 depends on a permission L15 grants only under `NODE_ENV === 'test'`.** PF-425 rejects
  loopback `target_url`s outside the test runner, which is fine for this drill and is *not* fine for
  L19's `ship webhooks tail --listen` during a live demo — PF-575 is L19's ask to widen it. The drill
  is therefore the one consumer that passes today and the one that would break silently if the gate
  were tightened rather than widened. Worth one line in whatever settles PF-575.
- **L26's PF-808 is the downstream consumer of PF-610 and is not in its `Deps`, deliberately.** The
  dependency runs the other way: L26 consumes the evidence this lane produces. Its lane file exists
  and the row reads *"Epic 6 proof — the TTFE drill passing in CI"*, so the handshake is confirmed
  from both sides; PF-610 owns producing a link that still resolves at grading time, L26 owns the
  write-up around it.
- **What I could not ticket.** The PRD never says *which* documentation the clean-machine run is
  allowed to consult (README, `docs/architecture.md`, the OpenAPI spec, all three), so PF-601 says
  "the repo's published docs" and leaves the boundary to whoever runs it. It never states the
  P95 window for the < 60 s target — I chose the same 20 runs p.9 uses for flake so the two share
  one series, which is a convenience, not a citation. It never says whether the drill's document
  and subscription should be cleaned up or left as demo data (PF-604 counts the rows either way).
  And it gives no guidance on where an externally-reachable listener lives for the *demo* as opposed
  to the drill — L99's U6 is that finding, it is still unowned, and the drill dodges it only because
  its listener is in-process.
- **Not covered here, on purpose:** `verifyWebhook` itself and its negative matrix (L18 PF-542–546),
  the signer and its golden vectors (L15), the deliverer, retry ladder and delivery log (L16), the
  event bus (L14), the CLI commands (L19), the dev portal (L22), the demo video and the Epic 6
  write-up prose (L26 PF-806/PF-808), and L25's written Pre-Search 3.2 answer — PF-589 makes the
  decision, L25's PF-765 records it. If any of those is unowned at audit time it goes to
  `lane-99-unassigned.md`, not into this file.

## What landed — the build agent's own record

Written by the lane agent, not the auditor. Statuses in the table above are the source of truth;
this is the reasoning behind the three that are not `☑`, plus the measurements, so an auditor
confirms or refutes rather than rediscovers.

### The shipped shape

```
pnpm drill ttfe                        scripts/ttfe/drill.mjs → vitest, retry: 0
  ├─ integrations/cli/tests/ttfe.drill.ts          the loop: only @ship/sdk + node + vitest
  ├─ integrations/cli/tests/ttfe/                  stages, recorder, listener, install, harness client
  ├─ scripts/ttfe/harness.ts                       OUTSIDE integrations/: pg, api/src, spawned
  └─ ttfe.thresholds.json                          every budget, exactly once (PF-609)
```

**Test counts, all executed:** 20 in `ttfeRecorder.test.ts` (fast, in `pnpm --filter @ship/cli test`,
which now runs 41), 3 in `ttfe.drill.ts` (the loop, PF-602's benchmark link, PF-611's CLI path),
4 in `ttfe.negative.drill.ts` (PF-607's contract break, its unit-suite control, PF-587's refusal,
PF-587's concurrency + teardown). The full CLI suite is green and so is `pnpm lint:boundary` — all
six fences fire, and `integrations/cli → @ship/sdk` is still the only workspace dependency.

### Measured, with the load ratio F80 asks for

Fast mode, `admin-server` harness (a fresh database on a running Postgres rather than a new
container), 20 consecutive runs on one commit:

| | |
|---|---|
| `totalMs` | **6.3–7.0 s** against a 60 000 ms budget |
| stages | install 1.3–2.3 s · login 5.0–5.4 s · subscribe 18–138 ms · create 25–126 ms · receive ~0 ms · verify 1–2 ms |
| `eventToPostMs` | **9.6–12.9 ms** against p.6's 2 000 ms (L99 U5, first end-to-end measurement) |
| `setupMs` | 3.7–5 s (container/database + 60 migrations + server boot) — outside the graded total, by p.8's own `t0` |
| job wall clock | 17–22 s per run |
| **load ratio** | **1.4–2.8**, against F80's 0.8 veto — every run has `loadCertified: false` |

**The login stage is 75% of the budget and it is the device grant's poll interval, not the
platform.** RFC 8628 §3.2's default is 5 s and the drill honours it rather than shortening it; a
drill that reduced the interval to look fast would be measuring a flow no user runs.

`receive_webhook` reads ~0 ms because the POST lands during stage 4 — filed as L99 F133 so nobody
quotes the stage as the delivery figure.

### Not done, and why — the honest list

| Ticket | State | Why |
|---|---|---|
| PF-590 `--clean` | **not built.** `pnpm drill ttfe --clean` exits 2 with a message pointing at `docs/ttfe-drill.md` | It needs a container image, a tarball served over HTTP and a scheduled pipeline slot. The fast mode is a REAL install of the packed artifact, but from a local tarball on a machine with a warm store — so registry resolution and network variance remain unexercised, and that is stated in `docs/architecture.md` rather than glossed |
| PF-601 human-timed run | **not run** | It needs a person, a clean machine and a stopwatch. p.6's *"with only the published docs"* is a claim about DOCUMENTATION, and no script can fail because a README omits a step. This is the target I would keep if only one of PF-590/PF-601 survives a cut. **Re-examined 2026-08-15 and the verdict held.** p.8's clause is an AND: *"on a clean machine"* is scriptable and is PF-590; *"following only the published docs"* is not, and is this ticket. A harness that extracted its commands from the fenced blocks in the docs would get closer — an omitted command would fail the run — but it still cannot fail on a missing prerequisite, an ambiguous instruction or an assumption a stranger does not share, and the author still picks which document and which fences count. So the ≤ 30 min figure stays **unmeasured** rather than being replaced by a number that would not be the graded claim. Decomposed in `docs/ttfe-drill.md` → *"The clause has two conjuncts"*; the coverage-matrix row says the same. Cost to close: about an hour of one person's time |
| PF-610 durable link | **produced** — `https://labs.gauntletai.com/joshrochon/ship/-/jobs/66739`, with `test-results/ttfe.json` and `ttfe-series.jsonl` attached | Artifacts expire in 1 month, which is inside the grading window but not outside it. L26 owns whether that needs extending before Final |
| PF-604 CI minutes | **measured** | `ttfe` 56.4 s + `ttfe-controls` 50.1 s = **1.8 min per pipeline**, jobs 66739/66740. The drill's own graded loop is 7.4 s of that; the rest is the pnpm install, the `build` artifact download and the testcontainer. Rows created per run: 1 document, 1 subscription, ≥1 delivery, plus the CLI path's second set |
| PF-606 soak | **CLOSED — 20/20 in CI.** Job **67859** (`ttfe-soak`), pipeline **20338**, ref `pf/L20-flake-and-clean`, commit `93d6fe6`, 2026-08-15T23:00Z. Also 20/20 locally on `d4c2642` (below) | The row above used to end *"the last thing standing between this lane and p.9"*, and the blocker it named was real: `test-results/ttfe-series.jsonl` is per-job, so every CI run reported a window of 1 and nothing assembled twenty artifacts. `scripts/ttfe/soak.sh` existed and **no pipeline invoked it**. Fixed by running the twenty inside ONE job rather than by accumulating across pipelines — an accumulated window spans twenty commits and `check-series.mjs --soak` fails such a window on purpose, and this runner has no shared cache to carry a series anyway (*"No URL provided, cache will not be uploaded to shared cache server"* in every trace). **The claim's shape, stated so nobody widens it:** twenty consecutive drill runs inside one CI job against one commit, not twenty separate pipeline runs. `load-certified 0/20` — contention makes flake likelier, so 20/20 under load is the stronger result, but the 8500 ms P95 beside it is not a certified timing |
| PF-608 CI job | **green, observed** — pipeline **20237**, jobs **66739** (`ttfe`, 56.4 s) and **66740** (`ttfe-controls`, 50.1 s), commit `ab3f3fa` | See "The drill had never executed" below. Both `allow_failure: false`, both `assert-tests-ran.sh`-wrapped, testcontainers and no dind |

### The drill had never executed in CI — two bugs, one shape

Written after the fact, against pipeline **20237** on `pf/L20-ttfe-ci-docker`.

The row above used to read *"wired, never observed green"*, and the reason was not that the
drill was slow or flaky. **It had never run.** Every pipeline from **19893 to 20223** — 35 of
them, unbroken since the job landed — failed the same way, and both jobs are
`allow_failure: false`, so the board was red on Epic 6's proof for as long as that proof
existed.

| # | What failed | Why it hid |
|---|---|---|
| 1 | `docker pull postgres:16` → `/usr/bin/bash: line 196: docker: command not found`, exit 127 | The job's comment reasons correctly about DooD — the runner does mount `/var/run/docker.sock`, and its `config.toml` says so. What it missed is that `node:22-bookworm` ships no `docker` CLI. Testcontainers never wanted one: it speaks the Engine API over the socket through dockerode. `agent-test` sits ten lines above with the same image and the same two `TESTCONTAINERS_` vars and starts a Postgres per spec file across 24 files (job 65909, 228 tests, 36.9 s) |
| 2 | `sh: tsx: command not found` → `ttfe harness exited 127 before printing its ready line` | Reached only once (1) was removed. `tsx` is a devDependency of `api`, and pnpm links a package's bins into *its own* `node_modules/.bin`. So `api/node_modules/.bin/tsx` exists and `<root>/node_modules/.bin/tsx` does not, and all four `npx tsx` spawns resolved nothing from the repo root |

Bug 2 hid the way bug 1 did: **on the machine this lane was written on, a stale
`<root>/node_modules/.bin/tsx` exists** from an earlier install in which tsx *was* a root
dependency. A stale symlink is not a dependency, and `pnpm install --frozen-lockfile` — which
is what CI runs — does not produce one. Letting `npx` fetch tsx instead was rejected: with a
registry reachable it downloads the *latest* tsx and the graded drill then measures a
toolchain the lockfile does not name.

Neither fix touched the drill. `retry: 0` stands, no sleeps were added, no threshold moved,
both jobs stayed `allow_failure: false`, and `assert-tests-ran.sh` still wraps both at 3 and 4.
`check-fitness.mjs` gained two claims so this cannot come back: no owned file may spawn `npx`,
and the two copies of the tsx resolver — duplicated because `scripts/` and `integrations/` may
not import across the p.11 fence — must list identical candidates.

### Bug 2 was repo-wide, and it is why `.gitlab-ci.yml` ran none of the nine

The drill was where it was found, not where it lived. Chasing it out of the drill turned up
**five spawn sites and three `package.json` scripts**, every one of which resolves `tsx` from
the workspace root where pnpm never put it:

| Where | What it broke |
|---|---|
| `scripts/ttfe/harness.ts` ×2 | the TTFE drill |
| `integrations/cli/tests/ttfe/shipInstance.ts`, `ttfe.negative.drill.ts` | the drill and its controls |
| `integrations/cli/tests/server/support/harness.ts` | `@ship/cli test:server` — `approval subprocess failed (127)` |
| `integrations/drills/idempotency/tests/support/world.ts` | `drill:idempotency` |
| `integrations/drills/refresh-rotation/tests/support/login.ts` | `drill:refresh` |
| `integrations/slack/tests/live/wholePath.test.ts` | `slack:live` |
| `scripts/l24-drill-server.ts:145` | all three of the above, at boot |
| `package.json` lines 28–30, bare `tsx` | `drill:refresh`, `drill:idempotency`, `slack:live` before anything boots |

`package.json` declares no `tsx` in `dependencies` or `devDependencies` at all. The correct
shape was already in the same file two lines down — `baseline:measure` uses
`pnpm --filter @ship/api exec tsx` — so the three scripts now match it.

**Consequence, and the reason this belongs in a lane file rather than a commit message:**
`integrations/README.md` claims *"Every one of those runs in CI behind
`scripts/assert-tests-ran.sh <n>`"* for nine commands, and `.gitlab-ci.yml` ran **zero**.
p.8's "at least five integrations" ships exactly five with no margin, so on the graded remote
nothing verified any of them. Slack — the PRD's only `should-ship` after the CLI — had no
automated proof at all.

**All nine now run, in six jobs**, every count re-measured on this tree after merging
`pf/integration`:

| Command | Tests | Job |
|---|---|---|
| `@ship/cli test` | 83 | `integration-units` |
| `@ship/slack test` | 19 | `integration-units` |
| `@ship/browser-demo test` | 5 | `integration-units` |
| `@ship/integration-testkit test` | 21 | `integration-units` |
| `@ship/cli test:server` | 19 | `cli-server-suite` |
| `@ship/browser-demo test:pkce` | 7 | `browser-demo-pkce` |
| `drill:refresh` | 21 | `drill-refresh` |
| `drill:idempotency` | 14 | `drill-idempotency` |
| `slack:live` | 10 | `slack-live` |

Three of those counts had drifted while this branch was open — cli 58→83, slack 17→19,
`slack:live` 5→10 — so the guards are floors measured here, not inherited. `slack:live` is a
misleading name and it cost a round trip: it needs **no Slack credentials**; "live" means a
live Ship.

`@ship/integration-testkit test` was the last to land and was held back for one pipeline
because it was **red**, not because of the environment: PF-721's "one listener,
repository-wide" named `cli/tests/support/stubShip.ts` (L19) and `cli/tests/ttfe/listener.ts`
(**this lane**, PF-599) as unlisted socket binders. L24 has since allow-listed both with
reasons and it passes 21/21.

**Three environment facts these jobs paid for, in pipelines rather than in review:**

1. The `build` artifact carries `shared/agent/api/web/sdk` dist and **nothing under
   `integrations/`**. `@ship/slack test` imports `@ship/integration-testkit` at runtime, so
   without an explicit testkit build it collects zero tests and `assert-tests-ran.sh`
   correctly calls a SHORT RUN (job 67103).
2. `oauth_apps` is **empty** after migrate + seed unless `AGENT_/GRADER_/DEMO_CLIENT_SECRET`
   are set — verified directly: 0 rows without, 3 with. Every device login then answers
   `invalid_client`, so a missing row presents as a plausible auth failure (jobs 67101,
   67104).
3. The drills **cannot share a database**. Each leaves subscriptions behind and a signing
   secret is encrypted at rest under `WEBHOOK_SECRET_KEY`, so the second drill dies with
   `WebhookSecretCryptoError … NOTHING was delivered`. Ordering the lines would have gone
   green while leaving a suite that passes because of what ran before it — the shape p.9 sets
   at zero. One job per drill gets one `postgres:16` service per drill.

### Measured in CI, first time — job 66739

| | |
|---|---|
| `totalMs` | **7384 ms** against the 60 000 ms budget (p.8) |
| stages | install 2197 ms · login 5080 · subscribe 47 · create 58 · receive 0 · verify 1 |
| `eventToPostMs` | **12 ms** against p.6's 2 000 ms |
| series check | `pass rate 1/1 · totalMs P95 7384 ms · event→POST P95 12 ms` |
| job wall clock | `ttfe` **56.4 s**, `ttfe-controls` **50.1 s** |
| load-certified | **0/1** — F80's veto still fires on this runner, so the number is reported and not certified |

Close to the local admin-server figures (6.3–7.0 s), which is the useful part: CI runs the
**testcontainer** path, and the lane's local 20-run soak had only ever exercised admin-server
mode. `install` is 2197 ms rather than 1.3–2.3 s local despite a cold-ish store, and `login`
is still RFC 8628's 5 s poll interval — 69% of the graded total, and not the platform.

### Two decisions an auditor should check rather than accept

1. **PF-593's six forced failures are tested on the recorder, not by six live runs.** Six container
   boots, six installs and six device flows to prove a property of a `catch` block is ~6 minutes of
   CI to test string formatting. `ttfeRecorder.test.ts` forces a failure in each of the six ids in
   turn against the same class the live drill uses. What that does not cover is that a REAL failure
   reaches that path — which is what PF-607's control does, once, for real.
2. **PF-596's portal assertion is the public API, not a browser.** L22's PF-674 handshake says the
   portal consumes `/api/v1` and adds no privileged route, so a subscription visible at
   `GET /api/v1/webhooks` is the portal's content. The drill grew no headless-browser dependency.

### Three findings that changed the drill itself

L99 **F130** (`npx` orphans its child, so "nothing survives teardown" was false while green),
**F131** (importing the built file by path bypasses the `exports` map, so the negative control could
not fail), **F132** (deleting the `types` condition is not a contract break — one of PF-607's own
three suggestions, and it does not work). The first two were defects in this lane's code, found by
its own controls, which is the strongest available evidence that the controls are not decorative.

### ⚑ Branch discipline — one branch, not six, and the coordinator should decide

The `## Slices` table above declares six branches. This lane shipped on **one**:
`pf/L20-drill-core`, off `pf/integration`, three commits. Flagged rather than papered over,
because p.12's *"per-slice branches preserved"* is a graded artifact.

The reason, and it is a reason rather than an excuse: S2 and S3 are the *same file*. The six stages,
their timings and their assertions are one `it()` block by PF-611's own requirement that TS-9 cannot
report a partial pass — so `pf/L20-timing` and `pf/L20-stage-assertions` would have been two branches
neither of which could run. S1 and S6 genuinely are separable and were not separated, which is the
part I would not defend.

What I did **not** do is create six refs pointing at the same commit to make a checkbox true. That
produces the evidence p.12 asks for and destroys what it is evidence of. If the coordinator wants
the six names to exist, the honest version is a rebase into six commits with the branches placed on
them, and that is a decision about graded artifacts rather than a cleanup I should take on my own.

### PF-606 — the soak, run and recorded

`scripts/ttfe/soak.sh 20` against commit `d4c2642`, **testcontainers mode** — the mode CI uses, so
every run paid for a fresh `postgres:16` container, 60 migrations and a server boot. No re-runs, no
filtering, no retries: `vitest.drill.config.ts` is `retry: 0` and the script never re-invokes a
failed run. `check-series.mjs --soak` verified the window is 20 runs of exactly **one** commit
before it counted anything.

```
ttfe soak: 20/20 passed
  pass rate            20/20
  totalMs P95          7872 ms  (budget 60000)
  event→POST P95       51 ms  (budget 2000)
  load-certified runs  0/20
```

| | across 20 runs |
|---|---|
| `totalMs` | 6293 – 8018 ms · **P95 7872 ms** |
| `eventToPostMs` | 8.9 – 51.1 ms · **P95 51 ms** |
| install | 1169 – 1921 ms |
| login | 5061 – 5504 ms — RFC 8628's 5 s poll interval, honoured rather than shortened |
| register subscription | 16 – 556 ms |
| create document | 29 – 267 ms |
| receive webhook | 0 – 10 ms (F133) |
| verify signature | 1 – 2 ms |
| `setupMs` | 3944 – 18 416 ms — **outside** the graded total |
| load ratio | 0.965 – 2.609 (uptime 21.84 → 9.05 across the run) |

**Two caveats, and neither is small.**

1. **This is not p.9's soak.** p.9 says *"20 consecutive CI runs"*, and these are 20 consecutive
   LOCAL runs. PF-606's own acceptance criterion — 20 against one commit, each in a fresh container,
   20 of 20, recorded — is met verbatim; the CI half belongs to PF-608, which is wired and has never
   been observed green.

   **Superseded 2026-08-15.** The CI soak now exists: job **67859** (`ttfe-soak`), pipeline
   **20338**, commit `93d6fe6`, **20/20**, `totalMs` P95 8500 ms, event→POST P95 30 ms, verified
   from the published `ttfe-series.jsonl` (20 lines, one commit, `mode: fast`, `pass` true on all
   20) rather than from the status badge. The local run below stays on the record — it is what the
   CI result is compared against, and deleting it would hide that the two agree. What the CI soak
   is **not** is twenty separate pipeline runs; see the row in *"Not done, and why"* above and
   `docs/ttfe-drill.md` → *"The 20-run soak"*.
2. **Every sample is above F80's load veto.** `loadCertified` is `false` on all 20 and the quietest
   run was ratio 0.965. The margin makes the verdict safe — 7.9 s P95 against 60 s is 7.6× — but the
   number is not certified and should not be presented as if it were. L99 F134.

**The one result worth reading twice:** `setupMs` moved **4.7×** across the run (18.4 s → 3.9 s) as
the machine drained, while `totalMs` moved **1.3×**. Container start and migrations are what
contention actually hits; the six graded stages barely notice it. That is an argument for keeping
setup out of the graded total, and it is measured rather than assumed.
