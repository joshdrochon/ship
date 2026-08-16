# `integrations/` — the 5-of-7 ledger

PRD p.8: *"Implement at Least 5 of the Following Integrations / Flows."* Seven
options, five required.

This file is the claim, and `integrations/testkit/tests/ledger.test.ts` is what
makes it falsifiable: every `shipped` row must name a directory that exists here
and contains at least one test file, and the `shipped` rows must number at least
five. Without that, "at least 5" is a sentence in a PR description nobody can
check.

## The ledger

| # | Option (p.8) | Status | Directory | Why |
|---|---|---|---|---|
| 1 | CLI tool with device flow | **shipped** | `cli` | `must-ship` in the PRD's own marking. The demo video (p.12) and the TTFE drill (p.5, Scenario 9) are both this. L19's lane; counted here, ticketed there. `docs/l19-five-line-story.md` is the transcript. |
| 2 | Slack integration | **shipped** | `slack` | The only `should-ship` after the CLI (p.8), named in the stack table (p.10) and in an interview question (p.13). The only integration here that is a genuinely EXTERNAL process consuming signed deliveries. |
| 3 | Browser SDK demo | **shipped** | `browser-demo` | Buys three things nothing else does: the *registered web app* Testing Scenario 2 (p.5) presumes, the only consumer of the browser `ITokenStore` p.4 requires, and the only place the < 250 KB budget (p.9) is measured against a real bundler. |
| 4 | GitHub integration | **cut** | — | Needs a GitHub App — private key, installation tokens, an org to install into — which is an external registration this lane cannot complete from a keyboard. It also needs an issue↔PR link model Ship's document schema does not have, so it is a schema change in L09/L10's territory as well as an integration. p.10 already marks the Octokit path `(stretch)`. |
| 5 | Refresh-token rotation drill | **shipped** | `drills/refresh-rotation` | L06 builds rotation and family revocation because p.3 requires them regardless; this converts a checkbox into a proof, and it proves the half only a CLIENT can see — that the access token issued alongside a revoked family stops working. |
| 6 | Idempotency-Key end-to-end | **shipped** | `drills/idempotency` | L15/L16 build replay and key pass-through. What was missing is a **subscriber that dedupes**, and p.16 asks for the documented subscriber contract by name. Nothing else in the spine produces one. |
| 7 | In-process plugin runtime | **cut** | — | p.8 marks it stretch and *explicitly experimental*. It needs a `document.beforeCreate` hook that does not exist: L14 publishes **after commit** by design (PF-404), so a synchronous pre-write hook is a new seam in another lane's domain layer at tier 8. And `isolated-vm` is a native addon — in `@ship/sdk` it would blow the < 250 KB budget (p.9) by itself. |

**Five shipped, two cut.** p.8 marks three of its seven options and leaves four
bare: `must-ship` on the CLI, `should-ship` on Slack, `(stretch)` and *"explicitly
experimental"* on the in-process plugin runtime. So one of the two cuts is the
only option the PRD ranks **below** the rest, and dropping it is the PRD's own
suggestion. The other cut, the GitHub integration, is unmarked — exactly like
the Browser SDK demo, the refresh-token rotation drill and the Idempotency-Key
drill, all three of which shipped. Nothing on p.8 ranks GitHub last; it was cut
on the grounds in its row (an external App registration this lane cannot
complete, plus an issue↔PR link model Ship's schema does not have), and that is
the honest reason to give.

## `testkit` is not one of the seven

`integrations/testkit` is a package here but it is **not** an integration and has
no ledger row. It is PF-721's single signed-delivery listener fixture, shared by
the Slack suite and the idempotency drill so there is exactly one definition of
"the delivery arrived" — two would diverge on raw-body handling first, which is
the failure PF-741 exists to prevent.

It is a `devDependency` of its consumers and a runtime dependency of none. That
distinction is the rule, not a convention: `scripts/lib/integration-packages.mjs`
permits it in `devDependencies` and refuses it in `dependencies`, because the
front-door claim is about what an integration's **process** depends on.

## The rules every directory here obeys

PRD p.11, Critical Guidance: *"External integrations live in integrations/ and
import only @ship/sdk — never api/src/. Enforced by a workspace dependency
rule."* Four mechanisms, because no one of them covers the others:

| Check | What it catches | What it cannot |
|---|---|---|
| ESLint fence 3 (`eslint.config.js`) | an `import` of `api/src`, `@ship/api`, `@ship/shared`, … | a dependency reached through `require()` or a computed dynamic import |
| `pnpm check:integration-deps` (PF-716/717) | a Ship-internal package in a manifest, declared and installed before anyone writes an import | anything about imports |
| `pnpm check:integration-credentials` (PF-722) | a `pg` client, a `DATABASE_URL` read, a `SESSION_SECRET` — runtime privilege the import fence compiles cleanly | a violation expressed only in a manifest |
| `pnpm lint:boundary` (PF-012/718) | the fences having been silently unwired, per package and per file extension | a violation in a package with no fixture |

Third-party npm dependencies are fine — `express`, `@slack/web-api`. An
integration is a stranger and strangers install packages. What is forbidden is a
second door into **this** repository.

The privileged half of every setup lives in `scripts/`, never here:
`l19-device-approve.ts` (approving a device grant), `l24-browser-demo-setup.ts`
(registering an OAuth app), `l24-drill-server.ts` (booting Ship),
`l24-internal-document.ts` (creating a document through the internal UI path).
Each is a **subprocess** with its own module graph, which makes "the integration
has no privileged path" true by construction rather than true by an import list
nobody re-reads.

## Running them

Counts re-measured 2026-08-15 by running **all nine**, against a booted Ship and a
database of this pass's own; `<n>` is what the run printed, not what a ticket
claimed.

```
pnpm --filter @ship/cli test                 # 83 · 11 files, no server needed
pnpm --filter @ship/cli test:server          # 19 · the five-line story, against a booted Ship
pnpm --filter @ship/browser-demo test        #  5 · bundle assertions
pnpm --filter @ship/browser-demo test:pkce   #  7 · Playwright, PKCE in a real browser
pnpm --filter @ship/integration-testkit test # 21 · the shared listener
pnpm --filter @ship/slack test               # 19 · the listener, against a stubbed Slack
pnpm slack:live                              # 10 · PF-743, the whole path, UI → Slack
pnpm drill:refresh                           # 21 · rotation and family revocation
pnpm drill:idempotency                       # 14 · dedupe, replay keys, the retry ladder
```

Two of those numbers were **wrong under a sentence claiming they had been
measured**, which is worse than a number nobody vouched for. `@ship/slack test`
read **17**: PF-742's two `issue.assigned` cases landed and the ledger never
followed them. `slack:live` read **5**: PF-743's rewrite took the walk from four
asserted hops to nine tests and the ledger never followed that either, and this
pass added a tenth (PF-742's subscription half, which had the same one-of-two
defect one level up). Both stale numbers were also encoded as CI floors in
`.github/workflows/ci.yml`, so for three days each job would have gone green on a
suite that had silently lost the cases in question. Raised with the counts.

All nine run in `.github/workflows/ci.yml` behind `scripts/assert-tests-ran.sh <n>`
(PF-720), so deleting a package's tests turns its job **red** rather than green. A
vitest run that matches no files exits 0 saying "no test files found", which reads
as a pass in a job list; the guard turns that into exit 2, which is documented as
VOID rather than as a failure.

Two of the nine were added to that workflow only in L24, and the sentence above
was **false for them until then** — `grep test:server .github/workflows/*.yml`
returned nothing, and `test:pkce` is the only automated proof that Authorization
Code + PKCE completes in a real browser, which p.5's Testing Scenario 2 and MVP-2
both rest on. Their jobs are `cli-server-suite` and `browser-demo-pkce`.

### GitLab, which is the graded remote

**Corrected 2026-08-15.** This paragraph used to say `test:server` and `test:pkce`
were *"still absent from `.gitlab-ci.yml`"*. They are not, and have not been since
L20 added them: `.gitlab-ci.yml:595` runs `assert-tests-ran.sh 19 -- pnpm --filter
@ship/cli test:server` and `:643` runs `assert-tests-ran.sh 7 -- pnpm --filter
@ship/browser-demo test:pkce`. The sentence named the two commands that were
fixed and stayed silent about the ones that were not, which is the wrong way
round — `.gitlab-ci.yml` is what this repo's own CI header names as authoritative
when the two pipelines drift, and GitLab is the graded remote.

**Corrected again 2026-08-16.** This section then said that **five** of the nine
commands were *"genuinely missing"* from `.gitlab-ci.yml` and that Slack had *"no
automated proof at all"* on the graded remote. All five landed on 2026-08-15 with
`pf/L20-ttfe-ci-docker`, and the paragraph did not follow. **All nine of the
commands above now run on GitLab**, each behind `scripts/assert-tests-ran.sh` so a
suite that reports zero tests exits 2 rather than reading as a pass:

| Command | GitLab job | `.gitlab-ci.yml` | Floor | Last run |
|---|---|---|---|---|
| `pnpm --filter @ship/cli test` | `integration-units` | `:843` | 83 | 68261 ✅ |
| `pnpm --filter @ship/cli test:server` | `cli-server-suite` | `:770` | 19 | 68259 ✅ |
| `pnpm --filter @ship/slack test` | `integration-units` | `:844` | 19 | 68261 ✅ |
| `pnpm slack:live` | `slack-live` | `:918` | 10 | 68264 ✅ |
| `pnpm --filter @ship/browser-demo test` | `integration-units` | `:845` | 5 | 68261 ✅ |
| `pnpm --filter @ship/browser-demo test:pkce` | `browser-demo-pkce` | `:818` | 7 | 68260 ✅ |
| `pnpm drill:refresh` | `drill-refresh` | `:908` | 21 | 68262 ✅ |
| `pnpm drill:idempotency` | `drill-idempotency` | `:913` | 14 | 68263 ✅ |
| `pnpm --filter @ship/integration-testkit test` | `integration-units` | `:850` | 21 | 68261 ✅ |

All nine were green in pipeline **20358**. So Slack — the only `should-ship`
integration after the CLI (p.8) — now has automated proof on the graded remote in
both forms, the unit suite and the live one, and both of the drills carrying p.8's
options 5 and 6 run there too. Reproduce with
`grep -n "assert-tests-ran" .gitlab-ci.yml`.

The floors are minimums (`assert-tests-ran.sh` compares with `>=`), not equalities.
A stale floor under-guards, so re-measure when a suite grows rather than guessing
upward.

The counts for `slack:live`, `drill:refresh` and `drill:idempotency` used to be
the CI minimums rather than a measurement, because those three need a booted Ship
and a database that L24 did not have. As of 2026-08-15 all three are measured:
`slack:live` → 10, `drill:refresh` → 21, `drill:idempotency` → 14, each against a
Ship booted by `scripts/l24-drill-server.ts`.

## What is NOT proven anywhere here

**No integration in this repo has been verified against a deployed Ship reaching
a deployed listener.** Every webhook-receiving test targets `127.0.0.1` behind
`SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS` (PF-575's named, default-off opt-in), and
that variable is set on no deployed instance. This is L99 **U6**, it is the
largest execution risk in the Slack slice, and it is a hosting question owned by
L21/L26.
