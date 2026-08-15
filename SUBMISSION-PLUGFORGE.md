# Submission — PlugForge (Week 6)

**Start here if you are grading Week 6.** This file is the index for the ten rows of the
Submission Requirements table on PRD p.12–p.13. One row per deliverable, each with the
lane that owns it, the path or URL that resolves it, and a **Ready / Not ready** state.

> **`SUBMISSION.md` is the *Week 5* index (ShipShape audit) and `CREDENTIALS.md` is the
> Week 5 Render resource map.** Both are accurate for the week they describe and both point
> at `shipshape-fkub.onrender.com`, which is still live and is **not** this week's
> deployment. Week 6 runs on AWS — see the Deployed Application row. Nothing in this file
> should be read out of `SUBMISSION.md`, and nothing there should be read as Week 6.

A row is **Ready** only if a grader with a clean clone and no project state can reach the
artifact and find it saying what p.12–p.13 asks for. A file existing is not a Ready row.

---

## The ten rows

| # | Deliverable (verbatim, p.12–p.13) | Lane | Where it resolves | State |
|---|---|---|---|:--|
| 1 | **GitHub Repository** | L26 | `github.com/joshdrochon/ship` is **public** and now carries **165** `pf/*` branches; GitLab `origin` carries **161**. p.12's third clause — a PR description per slice — has **no artifact**: no per-slice PR or MR was ever opened | ⚠ **Not ready** — see §1 |
| 2 | **Demo Video (3–5 min)** | L26 | not recorded; script is [`docs/l19-five-line-story.md`](docs/l19-five-line-story.md) | ⚠ **Not ready** |
| 3 | **Pre-Search Document** | L25 | [`PRESEARCH-PLUGFORGE.md`](PRESEARCH-PLUGFORGE.md) + [`docs/presearch-conversation.md`](docs/presearch-conversation.md) | ✅ **Ready** |
| 4 | **Architecture Document** | L26 | [`docs/architecture.md`](docs/architecture.md) — all nine p.12 sections, each carrying the artifact its row asks for; over p.13's 1–2 page cap, knowingly (see §4). Reasoning in [`docs/architecture-appendix.md`](docs/architecture-appendix.md) | ✅ **Ready** — see §4 |
| 5 | **OpenAPI Spec** | L13 | live `…/api/v1/openapi.json` + [`docs/openapi.json`](docs/openapi.json) | ✅ **Ready**, one caveat — see §5 |
| 6 | **AI Cost Analysis** | L26 | [`docs/ai-cost-analysis-plugforge.md`](docs/ai-cost-analysis-plugforge.md) | ✅ **Ready** — see §6 |
| 7 | **Per-Epic Write-up** | L26 | [`docs/per-epic-writeup.md`](docs/per-epic-writeup.md) — seven epics, `before → fix → after → proof`; Epic 7's audit rows are a live capture, Epic 6's CI proof is recorded **unmet** | ✅ **Ready** — see §7 |
| 8 | **Three Discoveries** | L26 | [`docs/three-discoveries.md`](docs/three-discoveries.md) | ✅ **Ready** |
| 9 | **Deployed Application** | L21 | `https://d258p92d3n1ebe.cloudfront.net/` — all four surfaces 200 · README carries `client_id`s and scopes but **no `client_secret` value** | ✅ **Ready**, one decision — see §9 |
| 10 | **Social Post** | L26 | not posted | ⚠ **Not ready** |

**5 Ready · 2 Ready-with-a-caveat · 3 open.** Recounted 2026-08-15 after the as-built sweep
and the repo re-measurement.

- **Ready (5):** rows 3, 4, 6, 7, 8.
- **Ready with a caveat (2):** row 5 — spec is live, set-equal and **schema-validated**
  (exit 0), but not byte-identical to the committed copy; row 9 — every surface reachable,
  but the grader `client_secret` is behind an `aws ssm` command a grader cannot run.
- **Open (3):** row 1 — the public remote now carries the branches, so two of p.12's three
  clauses hold; the third has no artifact at all (§1); rows 2 and 10 are yours to record
  and post.

Row 1's history in one line: it read Ready on *"reachable by anyone with a GauntletAI
account"* (p.12 says **Public**; a 302 to a sign-in page is not public), then Not-ready on
*"the public remote has none of the branches"* — which is no longer true, the `pf/*`
branches are on GitHub. It stays Not-ready on the clause that never had an artifact: no
per-slice PR or MR exists on either remote.

---

## Deadline — unresolved contradiction (PF-782)

The PRD disagrees with itself about Final Submission:

| Source | Time |
|---|---|
| p.1, Project Overview table | Sunday **11:59 AM CT** |
| p.12, Submission Requirements | `Deadline: Sunday 11:59 PM CT` |

| Field | Value |
|---|---|
| Asked a grader? | **No — not yet asked.** |
| Date asked | — |
| Channel | — |
| Answer | — |

**Until a grader answers, the board plans against the earlier time: Sunday 11:59 AM CT.**
Assuming PM wins because it appears in the Submission Requirements section is a twelve-hour
bet on a document that disagrees with itself. This row closes when a real answer is recorded
above, not when someone decides which page looks more authoritative.

---

## MVP gate item 9 — regression budget (p.2, p.6)

Full evidence, every number and exit code: [`docs/mvp-gate-item-9.md`](docs/mvp-gate-item-9.md).
**The bundle and query figures below are read out of the newer generated
[`docs/regression-report.json`](docs/regression-report.json) / `.md` (compared 2026-08-14
21:50Z), not out of `mvp-gate-item-9.md`, whose bundle line still reports the 2026-08-13 run
at −0.00%.** Both runs pass; only the newer one describes the tree being submitted. Routed
to whoever owns `mvp-gate-item-9.md` — this lane does not.

| Half | Result |
|---|---|
| Bundle size vs Part 1 baseline | **+1.69%** — 747 644 B → 760 294 B, within +10% ✅ ([`docs/regression-report.md`](docs/regression-report.md), run of 2026-08-14) |
| Per-route query counts (six routes, reported per route, never aggregated) | **0.00%** on all six ✅ — bit-identical, 0/3/4/5/5/7 both sides |
| P95 latency | **within budget, largest regression +4.3%** against +10% — [`docs/regression-paired-runs.md`](docs/regression-paired-runs.md). Re-measured after review: the old baseline was not Part 1, and the harness was timing its own server binds |
| Playwright regression suite passes | **881 passed, 0 failed, exit 0** on the integration tree at `c728c40`, 2026-08-14 ✅ — see §11 |

---

## §1 · GitHub Repository — two clauses of three

p.12 grades three things: *"Public; per-slice branches preserved; each PR description lists
which acceptance criterion that slice advances and confirms the fitness test passed."*

| Check | Re-measured 2026-08-15 | Verdict |
|---|---|---|
| Public | `github.com/joshdrochon/ship` → **200** logged-out · `labs.gauntletai.com/joshrochon/ship` → **302 → `/users/sign_in`** | ✅ on GitHub |
| Per-slice branches preserved | **165 on GitHub** · **161 on GitLab `origin`** · **172 local** | ✅ on both remotes |
| PR descriptions naming criterion + fitness test | **no per-slice PR or MR exists.** GitLab has 19 MRs, 3 of them `pf/integration → main`; GitHub has 9 PRs, all Week 5. Neither remote has a single MR or PR whose source is a `pf/L*` branch | ✗ |

### Stated plainly

**The first two clauses are satisfied, and on the public remote.** `git ls-remote --heads
github 'refs/heads/pf/*'` returns **165**; the same command against `origin` returns 161.
GitHub still carries Week 5 on `main` (`5455f4e`), untouched, so the Week 5 Render
deployment is not replaced.

The two remotes are not identical and the difference is small and known:

| Direction | Count | Which |
|---|---|---|
| On GitHub, not on GitLab | 5 | `pf/L00-hook-probe`, `pf/L21-webhook-secret-key`, `pf/L22-pf673-criteria`, `pf/L24-tooling-defects`, `pf/integration-probe` |
| On GitLab, not on GitHub | 1 | `pf/L17-default-base-url` |

Four of the five GitHub-only branches are already merged into `pf/integration`
(`git merge-base --is-ancestor` against `origin/pf/integration`); the exception is
`pf/integration-probe`, a probe branch. No slice's work is missing from either remote —
only the ref is.

**The clause with no artifact.** p.12's third requirement is *"each PR description lists
which acceptance criterion that slice advances and confirms the fitness test passed."*
**Per-slice merge requests were not opened.** Work moved by merging the slice branch into
`pf/integration` locally and pushing; the only MRs that exist are three
`pf/integration → main` batches (`!17`, `!18`, `!19`) plus Week 5's. There is no way to
read this as satisfied, and the honest statement is that the artifact p.12 names does not
exist for any slice.

What does exist is the same information one layer down, in the slice's own commit bodies —
which is what [`docs/pr-compliance-sweep.md`](docs/pr-compliance-sweep.md) measured, and its
own methodology says so: *"for a merge with parents `P1 P2`, the slice's commits are exactly
`P1..P2`."* That is a commit-body sweep, not a PR-description sweep, and the row above is
labelled accordingly.

**The sweep is also stale.** It reported 55 of 66. Re-counted 2026-08-15, `pf/integration`
carries **88** slice merges, **23** of them landed after the sweep commit (`94f083e`) and
were never swept. Of those 23, **20** name at least one `PF-` ticket somewhere in their
commit bodies and **3** name none:
`pf/L21-branch-policy-enforcement`, `pf/L26-e2e-runner-fixes`, `pf/L26-e2e-safe-runner`.
Re-running the sweep over all 88 is the fix; nobody has.

**This still needs a decision, and it is a smaller one than it was.** Options:

| Option | Cost |
|---|---|
| Tell the grader plainly that per-slice PRs were not opened, and point at the commit bodies | Free, honest, concedes one of three clauses. **Lean: this one** — the alternatives fabricate a paper trail after the fact |
| Open ~88 retroactive PRs on GitHub | Days of work, and every description would be written after the merge it describes |
| Push the one GitLab-only branch to GitHub and the five GitHub-only ones to GitLab | Minutes; makes the two remotes set-equal. Does not touch the third clause |

**Superseded numbers, kept so the drift is visible.** This row has read *119 local / 11
GitLab / 5 GitHub*, then *127 / 127*, then *147 / 147 / 0*. The last of those is the one to
distrust hardest: it was taken before the `pf/*` branches were pushed to GitHub, and it is
what made this row read worse than it was. Only the 2026-08-15 figures are current, and
they move — branches are still being pushed, so re-run the three `ls-remote` counts rather
than quoting these.

> ⚠ **Still do not run `repo-cleanup`, `git branch -d`, or enable auto-delete-head-branch.**
> The branches are preserved *because* nobody has deleted them, not because anything would
> stop it.

### §1b · Branch ↔ slice mapping (PF-785) — measured, not bijective

All counts from `origin`, re-measured 2026-08-15. **161** remote branches; **160** match
`pf/LNN-<slug>`, the exception being `pf/integration`, the trunk. `LNN` spans L00–L26;
**`L00` resolves to no lane file** and two branches use it (`pf/L00-guard-verification`,
`pf/L00-protection-probe`).

| Direction | Count |
|---|---|
| Slice rows declared across the 26 lane files | 143 |
| Unique declared branch names | **135** |
| Declared → has a branch on `origin` | **113** |
| Declared → no branch anywhere | **22** |
| `origin` branch → not a declared slice (orphan) | **47** |

The 143→135 gap is eight double-declared rows in two lane files:
`lane-05-oauth-device.md` and `lane-24-integrations-extra.md` each carry a *Landed* table
under `## Slices` alongside the original planning table, so four slices in each are counted
twice.

The 22-with-no-branch concentrate in four lanes — **L20: 6 of 6 declared, L19: 4 of 5,
L26: 4 of 6, L22: 3 of 5** — the L26 four being this lane's own planning names, which
shipped under different branch names. The orphan count grew from 35 to 47 purely because
`origin` grew; the mismatch is not new work going undeclared so much as the lane files never
being edited after a rename — `pf/L24-browser-pkce` vs declared `pf/L24-browser-pkce-demo`,
`pf/L16-ceilings` vs declared `pf/L16-scenarios-and-ceilings`. **Separate the renames from
the genuine misses before anyone reads this as 69 problems**; a rename is a one-line
lane-file edit, a missing branch is not.

---

## §4 · Architecture Document — the cap is knowingly overridden

p.13 requires *"1–2 pages following the Section/Content table above."* The table it points at
is the nine-row Section/Content contract on **p.12** — Module Layout, SOLID Rationale,
Composition Root, Public/Internal Boundary, OAuth Flows, Webhook Pipeline, SDK Surface,
Agent-as-Citizen, Failure Modes.

**The two requirements cannot both hold, and the content contract wins.** p.12 asks for a
module tree with one sentence per module, one paragraph per SOLID principle with a file
path, annotated composition-root pseudo-code *plus* a sibling test-wiring diagram, four
sequence/flow diagrams, and one paragraph per failure mode. That does not fit in two pages.
`docs/architecture.md` is **well over the cap — 445 lines when measured 2026-08-15**, and
still growing as the last p.12 artifacts land, so re-run `wc -l` rather than quoting that
figure. All nine headings are present and correctly named, each carrying the artifact its
p.12 row asks for. The file states the override in its own opening paragraph rather than
leaving a grader to notice.

The reasoning underneath — rejected alternatives, decision records, measured numbers — is in
[`docs/architecture-appendix.md`](docs/architecture-appendix.md), linked from the main
document's first paragraph. Deleting that reasoning to buy length would have been the wrong
way to meet the cap; so would deleting a p.12 artifact.

Reconciliations resolved in the same pass:

| Gap | Resolution |
|---|---|
| **G1** — "claims the agent's app is seeded by migration" | **Not a defect.** The doc said seeded by `db:migrate`, and deliberately *not* by a numbered migration. Verified: `api/src/db/migrate.ts:125` calls `seedPlatformApps`. Kept, now stated in one line. |
| **G2** — `request_id` missing from the audit-field list | **Fixed.** The list is in the Module Layout `audit/` line and reads *timestamp, app client_id, user_id, route, scope, status, latency, request_id*. An earlier version of this row said no such list survived the trim — that was wrong; it survived and it carries the field. |
| **G4** — the agent's grant type is never named | **Fixed.** The OAuth Flows table and Agent-as-Citizen both name **Client Credentials, RFC 6749 §4.4**, and Agent-as-Citizen states why Device Grant and Auth Code were rejected. Verified against code: `api/src/platform/oauth/clientCredentialsGrant.ts` exports `CLIENT_CREDENTIALS_GRANT_TYPE = 'client_credentials'`, and `oauthSurface.test.ts` asserts the token endpoint's handler keys are exactly `['client_credentials', 'refresh_token']`. |

**G3** is L21's and remains verification-only. Re-verified 2026-08-15: the env-group defect
is gone (`grep -rn render_env_group terraform/` → zero hits; Render's env vars are still an
inline `env_vars = merge(…)` at `terraform/render/main.tf:237`), and the Deployment Topology
paragraph now describes the applied AWS stack. **One thing beside it did not come out:** the
appendix's Deployment Topology section still says *"PlugForge's own must-ship surface still
adds no AWS resources."* Neither p.5 nor p.2 — the only PRD pages naming Terraform — contains that
claim, so it is ours; and `terraform/platform-apps.tf` declares six resources that exist only
for PlugForge (`random_password` ×3 at `:41,:46,:51`; `aws_ssm_parameter` ×3 at
`:56,:67,:78`). Lane-21's PF-647 said the claim *"is now false and comes out with it"*; the
sentence is still in the file. One-sentence fix, routed to L21.

---

## §4b · As-built sweep (PF-793) — every asserted value against shipped code

The architecture doc's direction of travel is toward the code, not away from it. Sixteen
concrete values re-checked against the current tree on 2026-08-15. Doc rows are cited by
**section name**, not line number — both documents are under active edit and any line number
written here would be wrong by the time it is read. **All sixteen match.**

| # | Value | What the doc asserts | What the code does | Source | |
|---|---|---|---|---|:--|
| 1 | Client-secret hash | SHA-256, unsalted, hex (appendix, *Apps & secrets*) | `crypto.createHash('sha256').update(raw).digest('hex')`, one hashing site | `api/src/platform/apps/secrets.ts:122` | ✅ |
| 2 | Secret entropy | 32 bytes from `crypto.randomBytes` | `CLIENT_SECRET_ENTROPY_BYTES = 32` | `platform/apps/secrets.ts:73` | ✅ |
| 3 | Retry ladder | `1s · 4s · 16s · 1m · 5m · 30m` (*Webhook Pipeline*) | `RETRY_SCHEDULE_SECONDS = [1, 4, 16, 60, 300, 1800]` | `platform/webhooks/retry.ts:62` | ✅ |
| 4 | Jitter | ±10 %, bounded so it cannot reorder the ladder | `JITTER_FRACTION = 0.1`, applied as `1 − f + jitter()·2f` | `webhooks/retry.ts:78,137` | ✅ |
| 5 | Signed string | `t + "." + rawBody` (*Webhook Pipeline*) | ``Buffer.concat([Buffer.from(`${t}.`), rawBody])`` | `webhooks/signer.ts:91-93` | ✅ |
| 6 | Header format | `Ship-Signature: t=<unix>,v1=<hex>` | `SIGNATURE_HEADER = 'Ship-Signature'`; `/^t=\d+,v1=[0-9a-f]{64}$/` | `webhooks/signer.ts:67`, `:88` | ✅ |
| 7 | Signature tolerance | 300 s (*Webhook Pipeline*) | `DEFAULT_TOLERANCE_SECONDS = 300` on **both** sides of the wire | `webhooks/signer.ts:79` · `sdk/src/webhooks.ts:50` | ✅ |
| 8 | Error-union members | five: `auth · rate_limit · not_found · validation · server` (*SDK Surface*) | same five, same order | `sdk/src/errors.ts:46-50` | ✅ |
| 9 | Wire error codes | six (appendix, *Contract details*) | `unauthorized, forbidden, not_found, validation_failed, rate_limited, server_error` | `sdk/src/errors.ts:65-72` | ✅ |
| 10 | Agent scopes | `documents:read`, `issues:read`, `sprints:read` — read-only (*Agent-as-Citizen*) | exactly those three seeded | `api/src/db/platformApps.ts:117` | ✅ |
| 11 | Idempotency-Key | derived from `event_id` **and** `subscription_id`, persisted then read back | `idempotencyKeyFor()` returns `` `${eventId}:${subscriptionId}` ``; replay reuses `original.idempotency_key` | `webhooks/pipeline.ts:180-182` · `webhooks/replay.ts:112` | ✅ |
| 12 | Token-store mode | `~/.ship/credentials.json`, 0600, atomic (*SDK Surface*) | `CREDENTIAL_FILE_MODE = 0o600`, temp-file + `rename` | `sdk/src/auth/fileTokenStore.ts:39,101-106` | ✅ |
| 13 | Cursor envelope | **three** keys `{id, timestamp, resource}`, both documents | `resource` is a required field and `decodeCursor` returns `foreign-resource` on mismatch | `platform/api/v1/pagination.ts:96,160,174` | ✅ |
| 14 | Retry-ladder reachability | six rungs, `MAX_ATTEMPTS` 6, waits sit between attempts so only **five** are consumed and 30 m is unreachable; `LADDER_TOTAL_WAIT_SECONDS` 381 s (*Webhook Pipeline*) | `MAX_ATTEMPTS = 6`, `WAITS_CONSUMED = MAX_ATTEMPTS - 1`, `LADDER_TOTAL_WAIT_SECONDS = 381` | `webhooks/retry.ts:72,75,90` | ✅ |
| 15 | Agent scopes, second telling | appendix seeded-apps table says `documents:read`, `issues:read`, `sprints:read`, **read-only**, and records that the agent carried `issues:write` until 2026-08-12 | no write scope is seeded | `api/src/db/platformApps.ts:117` | ✅ |
| 16 | Demo-app scopes | appendix seeded-apps table: `documents:read`, `documents:write`, `webhooks:manage` | same three seeded | `platformApps.ts:184` · registered `scopes.ts:64` | ✅ |

**What changed since the previous run of this sweep.** It advertised four divergences plus
one imprecision. All five are closed on the current tree and this section no longer claims
them:

- **Cursor envelope (was #13).** Both documents now describe three keys and say why the third
  one exists. It was the load-bearing one — `resource` is what turns a `/documents` cursor
  replayed against `/issues` into a `validation_failed` instead of a plausible wrong page.
- **Agent scopes, second telling (was #15).** The appendix's seeded-apps table reads
  read-only and no longer lists `issues:write`; it now records the removal and names the
  test (`agentAppCitizen.test.ts`) that asserts the list is exactly those three.
- **Retry-ladder reachability (was flagged as an imprecision).** The main document now
  carries the five-waits / 381 s / unreachable-30 m explanation itself, rather than leaving
  it only in the appendix.
- **SDK footprint (was #14, *"160.4 KB"*).** That number is gone. The appendix now reports
  **218.4 KB** gzipped over 169 published files from a fresh `pnpm --filter @ship/sdk size`,
  and discloses in the same sentence that the committed `sdk/size-report.json` predates it
  and reads **213 786 B = 208.8 KB** over 163 files. Both are inside the 256 000 B budget
  (`withinBudget: true` in the report). A disclosed staleness with the regeneration command
  next to it is not a divergence, so it is not counted as one — but regenerating the report
  would close it for free.

- **Demo-app scopes (was #16).** The appendix's seeded-apps row for
  `ship_app_grader_demo` now reads `documents:read`, `documents:write`, `webhooks:manage`,
  matching `PLATFORM_APP_SEEDS`. That third scope is what lets a grader run
  `ship webhooks tail`, the last step of p.11's five-line story.

**Nothing is outstanding on this row.** Both documents are still being edited, so the
standing instruction is to re-run this sweep rather than trust the ✅ column: every row above
names a file and a symbol, and each check is one `grep`.

---

## §5 · OpenAPI Spec — Ready, with one wording caveat

p.13: *"Live at `/api/v1/openapi.json` on the deployed instance, plus a static copy at
`docs/openapi.json` in the repo."*

| Check | Result |
|---|---|
| Live, uncredentialed, from outside the repo | `https://d258p92d3n1ebe.cloudfront.net/api/v1/openapi.json` → **200 `application/json`** |
| Same on the EB origin | `http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com/api/v1/openapi.json` → **200** |
| Static copy in repo | [`docs/openapi.json`](docs/openapi.json) present |
| Paths set-equal | **14 live / 14 committed, set-equal** |
| Documents identical | **semantically identical** (`json.load` equality) |
| Documents *byte*-identical | **No** — 63,492 live bytes vs 147,908 committed (`cmp` differs at char 2) |
| Version | `3.1.0` both copies |
| **Validated against the OpenAPI 3.1 schema** | **`npx --yes @redocly/cli@latest lint` → exit 0, 0 errors** ✅ |

**Schema validation was the clause nobody had run, and it now passes.** Re-measured
2026-08-15 against the live bytes, not the committed copy:

```
$ npx --yes @redocly/cli@latest lint live-spec.json
Your API description is valid. 🎉
```

Exit **0**, **0 errors**, 3 warnings — `info-license` (no `license` on `info`),
`no-ambiguous-paths` (`/webhooks/deliveries/{id}` vs `/webhooks/{id}/rotate`), and
`operation-4xx-response` (`GET /openapi.json` declares no 4XX). None is an error and none
blocks p.13. This also discharges PRD Testing Scenario 5's first half (p.5, *"Validate the
generated `/api/v1/openapi.json` against the OpenAPI 3.1 JSON schema"*).

**The byte difference is whitespace only.** The server emits compact JSON through
`res.json`; the committed copy is pretty-printed for review. Top-level keys match
(`components, info, openapi, paths, servers, webhooks`) and `json.load(a) == json.load(b)`
is `True` over the whole document.

> **Decision needed, and it is small.** PF-813's own criterion says *byte-identical*.
> p.13 does not — it asks for a live URL **and** a static copy, and both exist and agree.
> Either correct the criterion to parse-and-compare (which passes today, and is the
> assertion that actually catches drift), or commit a minified `docs/openapi.json` so the
> bytes match. The second touches L13's generated artifact and would make the repo copy
> unreadable in review. **Lean: correct the criterion** — byte equality here tests the
> JSON serializer's whitespace, not the contract.

---

## §6 · AI Cost Analysis — written, and the headline is $0.00

[`docs/ai-cost-analysis-plugforge.md`](docs/ai-cost-analysis-plugforge.md). The file named
`docs/ai-cost-analysis.md` is **Week 5's** and cites the ShipShape brief; neither
supersedes the other.

All three halves p.13 names are present: tracked dev spend, a production projections
table, and explicit assumptions for webhook fanout, agent active rate and storage
retention.

**Marginal AI spend attributable to PlugForge: $0.00**, and it is measured rather than
claimed. `aws ce get-cost-and-usage` for 2026-08-08 → 2026-08-16 returns **no Bedrock line
at all** — not a zero row, no row — and the deployed environment carries four application
environment variables (`AWS_REGION`, `ENVIRONMENT`, `NODE_ENV`, `PORT`), so it holds
neither `ANTHROPIC_API_KEY` nor `BEDROCK_ENDPOINT` and the agent cannot make an LLM call
there even if scheduled. Total AWS spend for the window is −$0.0000031 net of credits.

That number is only interesting because of what it proves: the platform does zero AI work,
which p.9 and p.11 both require. The document opens with that as a runnable command rather
than a sentence — `grep -rlE "@langchain|anthropic|openai" api/src/platform/ | wc -l`
returns **0**, against **11** for `agent/src` (re-run 2026-08-15).

The projections are explicitly a model, not a measurement — the service is days old and has
no production traffic. Every constant in the arithmetic is read out of the code and cited
to its line (`RETRY_SCHEDULE_SECONDS`, `ATTEMPT_MULTIPLIER_CEILING`, `BYTES_PER_ROW`,
`RAW_RETENTION_DAYS`, `ROLLUP_RETENTION`, `DLQ_RETAINED_INDEFINITELY`), so a reader who
disagrees with an assumption can swap it and redo the sum.

---

## §9 · Deployed Application — and the URL a grader should actually use

p.13: *"Public URL with a pre-registered OAuth app (read-only scopes) for graders, plus
credentials in the README. Dev portal reachable; OpenAPI spec resolvable."*

### The three URLs, and which one is which

| URL | What it is | Use it? |
|---|---|---|
| `https://d258p92d3n1ebe.cloudfront.net/` | **Week 6.** CloudFront: SPA from S3, `/api/*` and `/health` proxied to the EB origin. | **Yes — this is the Week 6 URL** |
| `http://ship-api-prod.eba-nvpntpge.us-east-1.elasticbeanstalk.com` | Same AWS environment, API origin, no TLS. Serves the whole API including `/oauth/*`. | Only where CloudFront cannot reach — see below |
| `https://shipshape-fkub.onrender.com` | **Week 5 FleetGraph**, running `main`. No `/api/v1` at all. | **No** |

`.claude/CLAUDE.md` names a fourth, `ship-api-prod.eba-xsaqsg9h…` — that CNAME **does not
resolve** (retired environment). Corrected in this pass.

Opening the EB URL in a browser gives a white screen: `helmet` sends
`upgrade-insecure-requests` and the EB environment has no TLS, so the page's own assets are
requested over `https` against a listener that is not there. The API answers fine to `curl`.

### Verified 2026-08-14

| Check | Result |
|---|---|
| Public URL loads | ✅ CloudFront `/` → 200 HTML |
| Dev portal reachable | ✅ `/portal` → 200 |
| OpenAPI spec resolvable, no credentials | ✅ 200 (both URLs) |
| `/health` | ✅ 200 JSON, both URLs |
| Pre-registered read-only grader app | ✅ `ship_app_grader_readonly` documented in `README.md` |
| `/api/v1/documents` unauthenticated | ✅ 401 with the `ApiError` envelope and a `request_id` |

### ✅ Resolved: `/oauth/*` now routes through CloudFront

This row was held open by an ordered cache behaviour that did not exist, so `/oauth/*` fell
through to the S3 default and the SPA shadowed the API. `terraform/s3-cloudfront.tf` now
carries an `/oauth/*` behaviour pointing at the EB origin.

Re-measured 2026-08-14 evening, by origin header rather than inference:

| Check | Before | Now |
|---|---|---|
| `POST /oauth/device/code` | CloudFront **403** (S3 default is GET/HEAD only) | **200**, real device code |
| `POST /oauth/token` | CloudFront **403** | **401** from the API — a real OAuth error, which is the correct answer to bogus credentials |
| `GET /oauth/device/verify` | Ship SPA shell | **302** to login, `server: nginx` — the API's own page |

The third consequence listed before — that the API advertises
`verification_uri: https://d258p92d3n1ebe.cloudfront.net/oauth/device/verify`, so even a CLI
pointed at the EB origin sent the user to the broken page — is resolved by the same change:
that URL is now the working one.

Proven end to end rather than by status code: `scripts/demo-live.py` runs the full device
grant against this deployment — register app, device code, both consent POSTs, token, then
an authenticated `/api/v1` read — and finishes with a read-only token correctly refused a
write. See [`docs/demo-runbook.md`](docs/demo-runbook.md).

### Credentials in the README

`README.md` publishes both `client_id` values (`ship_app_grader_readonly` at `README:93`,
`ship_app_grader_demo` at `:94`) and their scopes. The `client_secret` values are **not** in
the README — `:109` and `:111` give `aws ssm get-parameter` commands instead, which need AWS
credentials for account `379484935796`. A grader has none, so for them that command is not a
credential. p.13 says *"credentials in the README"*.

**Re-checked 2026-08-15 and the blocker is not access.** The parameters read fine with the
repo's own identity (`arn:aws:iam::379484935796:user/ship-terraform`), and
`terraform/platform-apps.tf`'s own header already concedes the requirement — the secrets are
`random_password` + SSM rather than show-once *specifically* so they can be read back,
because *"the README has to publish the grader's secret (p.13), so a value nobody can read
back would defeat the deliverable."*

> **This is a decision, not a task, and it is deliberately left to you.** Publishing a live
> `client_secret` into a repo that is public on GitHub is a real trade. In its favour: p.13
> requires it, the apps are scoped to a dedicated grader workspace, the read-only app cannot
> write, and the Terraform was designed around publishing them. Against: it is a live
> credential in a public repo, and rotating it later means a `-replace` plus a redeploy.
> **Lean: publish the read-only app's secret only** — it is the one p.13's gate-item app
> needs, it can only read one sandbox workspace, and leaving the write-scoped demo secret
> behind SSM keeps the blast radius at zero. Not done here.

### Re-verified from outside, 2026-08-15

| Check | Result |
|---|---|
| `/` | **200** `text/html` |
| `/portal` | **200** — route at `web/src/main.tsx:325`, `portal/:appId` at `:326` |
| `/api/v1/openapi.json` | **200** `application/json`, no credentials sent |
| `POST /oauth/device/code` | **200** `application/json` — real device code, through CloudFront |
| `GET /oauth/device/verify` | **302**, `server: nginx` — the API's own page, not the SPA shell |

**Root and `/portal` return byte-identical 4 798-byte SPA shells.** That is correct for a
client-routed SPA and it means `curl` learned nothing about whether the portal works.
**`curl` cannot see CSP violations, JS errors, or failed asset loads, so three 200s are not
proof the app renders, and this file does not claim it does.** Confirming render needs a
browser; `docs/infra/grader-access.md` §6 is the only place in the repo that asserts the
deployment is up.

**The README was stale on `/oauth/*` and is fixed in this pass.** It still carried a warning
that `/oauth/*` did not route through CloudFront and that `ship login` could not complete
there, sending graders to the plain-HTTP EB origin — directly contradicting this section.
Rather than pick a side, both paths were re-measured (the two `/oauth/*` rows above): the
README was the stale half. Its warning is now a dated confirmation and the EB-origin
workaround block is replaced with single-host commands.

---

## §11 · Playwright regression suite (MVP-9, second half) — **green**

p.2 requires the existing Playwright regression suite to pass. The prior recorded green run
was on the **L01 tree** (`41393f6`, 2026-08-12) — not the integration tree that carries every
lane's work. Re-run on the integration tree, 2026-08-14, commit **`c728c40`**, 4 workers:

| Run | Tree | Result |
|---|---|---|
| 1 | `pf/integration` as inherited | **877 passed · 1 failed · 4 did not run** — exit 1 |
| 2 | `oauth-pkce.spec.ts` alone, stale assertion fixed | 3 passed · 1 failed · 1 did not run — exit 1 |
| 3 | full, assertion fixed, fixture not yet | 832 passed · 2 failed · 48 did not run — exit 1 |
| **4** | **full, both fixes in — `c728c40`** | **881 passed · 1 flaky · 0 failed — exit 0 (10.5m)** |

**Run 4 is the certifying run.** Two defects were fixed to get there, and neither was in the
platform:

1. **A stale assertion was hiding four tests.** `oauth-pkce.spec.ts` asserted
   `404 / not_found` on `GET /api/v1/documents` and received **200**. Its own comment said
   *"⚑ becomes 200 when L09's PF-245 lands"* and named the lines that would change; PF-245 had
   landed. Because the file is `retries: 0, mode: 'serial'` — correct, since a retry forfeits
   p.9's 0%-flake target — the failure skipped the remaining four tests in the block,
   including the graded PKCE P95 measurement. One out-of-date line was hiding a graded test
   while the suite read as a single known failure.
2. **The P95 measurement could not pass against the shipped throttle.** With (1) fixed it ran
   and 429'd: it drives 20 iterations × 2 `/oauth/*` requests = **40**, and `/oauth` is
   throttled at **30/min keyed by IP** — one key for the whole harness. Arithmetic, not
   flake. Fixed in `e2e/fixtures/isolated-env.ts` via `OAUTH_RATE_LIMIT_PER_MINUTE`, the
   override that exists for this. **Production behaviour is unchanged**, and the alternative
   — lowering the sample count — was rejected because it shrinks a graded measurement to fit
   a harness artifact.

Recorded honestly: run 4 reported **1 flaky** — `session-timeout.spec.ts:689 › Stay Logged In
calls extend session endpoint`, which failed once and passed on retry. Run 3's extra failure
(`program-mode-week-ux.spec.ts:380`) did not reproduce in run 4 and correlates with machine
load — these four runs were taken back to back on a box that was also running the container
fleet. Both belong to L99 F80's warning about timing anything on this hardware.

---

## Assembly checklist (PF-815) — before submitting

- [ ] All ten rows above read **Ready** with a resolving path or URL.
- [ ] PF-782's deadline answered by a grader and recorded, and the submission is before it.
- [ ] A clean clone plus the URLs in this file reproduces every deliverable, with no
      reference to the author's working tree.
- [ ] **No merged-branch pruning has occurred.** Verified 2026-08-15 by `ls-remote`: **165**
      `pf/*` on GitHub, **161** on GitLab `origin`, **172** local. The set difference is
      **not** empty — five branches are on GitHub only and one on GitLab only, listed in §1.
      Re-run the counts before submitting; they move.
- [ ] Row 1's third clause conceded in writing to the grader — no per-slice PR or MR exists
      (§1). The two-remote branch delta closed or explained.
- [ ] `docs/pr-compliance-sweep.md` re-run over all **88** slice merges, or its 55-of-66
      headline dated so a reader knows 23 slices postdate it (§1).
- [ ] §4b's sixteen as-built rows re-run against the final tree — they were all green on
      2026-08-15, but both architecture documents were still being edited that day.
- [ ] `sdk/size-report.json` regenerated so it and the appendix report the same footprint.
- [ ] `docs/mvp-gate-item-9.md`'s bundle line updated from −0.00% to the +1.69% of the
      2026-08-14 run.
- [ ] Decision taken on the grader `client_secret` (§9) and on PF-813's byte-identity
      clause (§5).
