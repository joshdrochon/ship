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

**Five shipped, two cut.** The two cuts are the two the PRD ranks lowest — it
marks neither, while marking the CLI `must-ship` and Slack `should-ship`, both of
which are shipped.

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

```
pnpm --filter @ship/cli test                 # 21 · no server needed
pnpm --filter @ship/cli test:server          # the five-line story, against a booted Ship
pnpm --filter @ship/browser-demo test        #  5 · bundle assertions
pnpm --filter @ship/browser-demo test:pkce   #  7 · Playwright, PKCE in a real browser
pnpm --filter @ship/integration-testkit test # 11 · the shared listener
pnpm --filter @ship/slack test               # 17 · the listener, against a stubbed Slack
pnpm slack:live                              #  5 · PF-743, the whole path, UI → Slack
pnpm drill:refresh                           # 21 · rotation and family revocation
pnpm drill:idempotency                       # 14 · dedupe, replay keys, the retry ladder
```

Every one of those runs in CI behind `scripts/assert-tests-ran.sh <n>` (PF-720),
so deleting a package's tests turns its job **red** rather than green. A vitest
run that matches no files exits 0 saying "no test files found", which reads as a
pass in a job list; the guard turns that into exit 2, which is documented as
VOID rather than as a failure.

## What is NOT proven anywhere here

**No integration in this repo has been verified against a deployed Ship reaching
a deployed listener.** Every webhook-receiving test targets `127.0.0.1` behind
`SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS` (PF-575's named, default-off opt-in), and
that variable is set on no deployed instance. This is L99 **U6**, it is the
largest execution risk in the Slack slice, and it is a hosting question owned by
L21/L26.
