# Three Discoveries — PlugForge (Week 6)

PRD p.13 asks for three things learned, and names strong candidates: the Device Authorization
Grant in TypeScript, Zod-driven OpenAPI generation with fitness-test parity, Stripe-style HMAC
with timestamp anti-replay, async-iterator pagination.

None of the three below is one of those, and that is deliberate. Each of those topics turned
out to be well-documented enough that building it taught me the spec rather than anything
about this system. What actually cost time — and changed how I work — was three cases where
something *passed* and was wrong.

Each entry states what I expected, what I found, and the artifact that proves it.

---

## 1. A column the guard reads and nothing writes

**Expected.** Migration 074 added `oauth_apps.is_public` and `authenticateClient` honoured
it. A test asserted the public-client path worked. I treated the feature as shipped.

**Found.** Nothing ever wrote the column. Every row in every deployed database kept the
`false` default, so a public client could *start* a device flow and never finish it — the
authorization step succeeded and the token exchange refused the client. The test that
"proved" the path passed because it built its own fixture with the flag set by hand. It
proved the code path existed. It proved nothing about any app a grader could actually
register.

The second half was worse. The seeder's `INSERT … ON CONFLICT (client_id) DO UPDATE` did not
list `is_public` in its update clause, so even after adding the field to the seed, a redeploy
against an existing database would keep the stale `false`. The fix had to touch the insert
*and* the conflict branch; fixing only the insert would have worked on a fresh database and
silently failed on every environment that already had rows — which is every environment that
matters.

**Proof.** `60fe2ba` *"fix(L02): set is_public on the seeded apps — F100"*. The commit
message records the measurement against the live deployment before the fix.
`api/src/db/platformApps.ts` now declares `isPublic` as a **required** field on
`PlatformAppSeed`, so adding a fourth app is a compile error until someone decides, and
`platformApps.test.ts` pins the agent as confidential and the grader apps as public.

**What I do differently.** When a test sets a flag on a fixture, it is testing the branch,
not the configuration. The question that finds this class of bug is: *which real, registered,
shipped row has this value, and what wrote it there?* And for anything seeded idempotently,
`ON CONFLICT DO UPDATE` is a second place the value has to appear — omitting it produces a
bug that only exists on environments with history.

---

## 2. The measurement harness was most of the measurement

**Expected.** `p95` numbers from the regression harness described the routes. When
`/api/documents` came back at 6 ms, that was the route costing 6 ms.

**Found.** The harness called `request(app)` per sampled request, which makes supertest bind
a fresh ephemeral server, accept one connection, and tear both down — **inside the timed
region**, sixty times per route. Most of the reported latency was that.

The control gave it away, and only because there was one. `GET /health` runs no query and
touches no database. It cannot regress. It was reporting **+32%**, and in one run **+108%**.
A route that does nothing had apparently gotten twice as slow.

Moving the bind out of the timed region dropped `/health` p95 from about 0.7 ms to 0.24 ms on
unchanged code. Roughly two-thirds of every number the harness had ever produced was the
instrument.

That sat under a green check for days, alongside two other defects it was hiding: a
"Part 1 baseline" captured four commits *into* Week 6 — so the before-picture already
contained half the after — and two trees running with different rate-limit ceilings, which
made one side answer `429` and record the error path as route latency.

**Proof.** `docs/regression-paired-runs.md` carries all three defects and the corrected
figures. `docs/measurement-rules.md` is the generalised version.
`scripts/perf-self-check.mjs` is the automated one: it measures the same tree twice and
refuses to report a verdict when the instrument's own noise exceeds the budget it is being
asked to enforce.

**What I do differently.** A/A before A/B — compare the thing to itself before comparing it
to anything else. And keep a control that *cannot* move; `/health` is worth its place in that
route list purely for the days it reports a regression, because on those days the instrument
is broken and you know it without knowing anything about the change.

Building the self-check taught the same lesson a second time. The first version measured
twice in one process and reported 98.9% "noise" that was not noise — every database route
slower on pass two, `/health` faster. A signature, not a spread: the fixture leaves dead
tuples, so the first pass gets clean tables and no later pass ever does. The second version
added `VACUUM` and still failed, because `measureRoutes` builds an app per pass and never
disposes it, so later passes compete with earlier apps' timers. I nearly shipped the first
one. It would have failed every run for its own reasons and been deleted inside a week.

---

## 3. The hard part of the Device Grant is tenancy, not polling

**Expected.** RFC 8628's difficulty would be the polling contract — `authorization_pending`,
`slow_down`, backoff, expiry. That is what the spec spends its words on and what every
tutorial covers.

**Found.** The polling was the easy half. The part with real consequences is that the consent
step takes a **browser session** and binds it to a **device code**, and those two things can
belong to different tenants.

A user signed into workspace A, approving a device code issued to an app registered in
workspace B, would mint a token stamped with B's workspace on A's session. Nothing in the RFC
prevents it, because the RFC has no concept of a workspace. The device code arrives with no
user attached — that is the entire point of the grant — so the binding is created at consent
time, which makes consent the only place the check can live.

It is also not one check. The app has to be re-looked-up and re-validated at *both* consent
POSTs: an app deactivated between issuance and approval must not be approvable, and the
hidden form field is input, not evidence.

I hit this live rather than reading it. Demoing the deployment, `dev@ship.local` tried to
approve a code for the pre-registered grader app and got `403 Wrong workspace` — correctly,
because those apps live in a dedicated grader tenant precisely so a grader's token cannot see
anyone else's data. The guard I had written stopped me.

**Proof.** `api/src/platform/oauth/deviceVerify.ts:310–322` — the workspace check, with the
comment recording that `issueTokenPair` stamps the token with `app.workspaceId`, and that
F43 closed the same hole on the authorization-code leg first. The grader tenancy is
`GRADER_WORKSPACE_ID` in `api/src/db/platformApps.ts`.

**What I do differently.** For any flow where authentication and authorization happen in
different requests, the question is *which* identity gets bound to *which* grant, and where.
Multi-tenancy turns that from bookkeeping into a data-leak boundary, and a spec written
before multi-tenancy was normal will not mention it.

---

## The thread

All three are the same shape: something reported success, and the success was the bug. A
passing test on a column nothing wrote. A green regression budget from an instrument
measuring itself. A flow that completed end-to-end in a single-tenant test and crossed a
tenant boundary in production shape.

The habit that would have caught all three is one question, asked before believing a green
result: **what would this look like if it were broken, and would I be able to tell?**
