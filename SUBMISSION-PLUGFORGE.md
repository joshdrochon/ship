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
| 1 | **GitHub Repository** | L26 | `github.com/joshdrochon/ship` (public, 200 anonymous) · GitLab `labs.gauntletai.com/joshrochon/ship` | ⚠ **Not ready** — see §1 |
| 2 | **Demo Video (3–5 min)** | L26 | not recorded; script is [`docs/l19-five-line-story.md`](docs/l19-five-line-story.md) | ⚠ **Not ready** |
| 3 | **Pre-Search Document** | L25 | [`PRESEARCH-PLUGFORGE.md`](PRESEARCH-PLUGFORGE.md) + [`docs/presearch-conversation.md`](docs/presearch-conversation.md) | ✅ **Ready** |
| 4 | **Architecture Document** | L26 | [`docs/architecture.md`](docs/architecture.md) | ⚠ **Not ready** — see §4 |
| 5 | **OpenAPI Spec** | L13 | live `…/api/v1/openapi.json` + [`docs/openapi.json`](docs/openapi.json) | ✅ **Ready**, one caveat — see §5 |
| 6 | **AI Cost Analysis** | L26 | *no Week 6 document exists* | ⛔ **Not ready** — see §6 |
| 7 | **Per-Epic Write-up** | L26 | `docs/per-epic-writeup.md` — **absent** | ⛔ **Not ready** |
| 8 | **Three Discoveries** | L26 | `docs/three-discoveries.md` — **absent** | ⛔ **Not ready** |
| 9 | **Deployed Application** | L21 | `https://d258p92d3n1ebe.cloudfront.net/` | ⚠ **Not ready** — see §9 |
| 10 | **Social Post** | L26 | not posted | ⚠ **Not ready** |

**1 of 10 Ready, 1 Ready-with-caveat, 8 open.** Counted honestly on 2026-08-14.

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

| Half | Result |
|---|---|
| Bundle size vs Part 1 baseline | **−0.00%** — within +10% ✅ |
| Per-route query counts (six routes, reported per route, never aggregated) | **0.00%** on all six ✅ |
| P95 latency | enforced and within budget; **not certified on an idle machine** — see L99 F80 |
| Playwright regression suite passes | **881 passed, 0 failed, exit 0** on the integration tree at `c728c40`, 2026-08-14 ✅ — see §11 |

---

## §1 · GitHub Repository — what is actually wrong

p.12 grades three things: *"Public; per-slice branches preserved; each PR description lists
which acceptance criterion that slice advances and confirms the fitness test passed."*

| Check | Measured 2026-08-14 | Verdict |
|---|---|---|
| Public | `github.com/joshdrochon/ship` → **200** from a logged-out client | ✅ |
| Public | `labs.gauntletai.com/joshrochon/ship` → **302** (redirects to sign-in) | GitLab is not the public one; GitHub is |
| Per-slice branches preserved | **119** `pf/*` branches exist locally · **11** on GitLab `origin` · **5** on GitHub | ⛔ |
| PR bodies compliant | not swept (PF-784) | ⛔ |

**108 of 119 slice branches exist only in a local checkout.** The branch-preservation
apparatus documented in `TICKETS-PLUGFORGE.md` — the agent PreToolUse hook, the `pre-push`
zero-SHA guard, GitLab's protected-`pf/*` rule — all works, and was verified end-to-end by
pushing a probe branch. It protects branches on the remote. It cannot preserve a branch that
was never pushed, and *unpushed* is the same evidence loss as *deleted* the moment the
working copy goes away.

**This is recoverable today and cheap.** `git push` is additive; nothing here asks anyone to
delete or force anything. It is left as a decision rather than done unilaterally because
pushing ~108 branches fires ~108 CI pipelines on a shared runner, and that cost belongs to
whoever is paying for the runner.

> ⚠ **Do not run `repo-cleanup`, `git branch -d`, or enable auto-delete-head-branch.** With
> 108 branches unpushed, local deletion is unrecoverable from either remote.

---

## §4 · Architecture Document — nine sections present, length is the failure

p.13 requires *"1–2 pages following the Section/Content table above. Committed at
`docs/architecture.md`."* (The same cap appears on p.11.)

All nine required headings are present and correctly named:

| p.12 section | Present |
|---|:--:|
| Module Layout | ✅ |
| SOLID Rationale | ✅ |
| Composition Root | ✅ |
| Public/Internal Boundary | ✅ |
| OAuth Flows | ✅ |
| Webhook Pipeline | ✅ |
| SDK Surface | ✅ |
| Agent-as-Citizen | ✅ |
| Failure Modes | ✅ |

**The document is 744 source lines** with five mermaid diagrams and thirteen extra
subsections beyond the nine the table asks for. No rendering of 744 lines is 1–2 pages. The
row cannot be called Ready on section coverage alone, and the fix is a cut, not an addition
— the depth is genuinely good and belongs somewhere, just not in the document with the
length cap on it.

Still unreconciled against the code (L99 §*Documentation drift*): **G1** (claims the agent's
OAuth app is seeded by migration; the repo seeds through `seed.ts`), **G2** (`request_id`
missing from the audit-field list, though p.18 names it and `ApiError` carries it), **G4**
(never names the agent's OAuth grant type, decided as Client Credentials / RFC 6749 §4.4 in
L99 D5a). **G3** is L21's and is verification-only here.

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
| Documents *byte*-identical | **No** — 63,436 live bytes vs 147,852 committed |
| Version | `3.1.0` |

**The byte difference is whitespace only.** The server emits compact JSON through
`res.json`; the committed copy is pretty-printed for review. PF-813's acceptance criterion
says *byte-identical*, which no server that pretty-prints for humans and compacts for the
wire can satisfy. Recorded as a criterion to correct rather than a defect to chase — the
useful assertion is parse-and-compare, and it passes.

---

## §6 · AI Cost Analysis — the file that exists is last week's

`docs/ai-cost-analysis.md` exists and opens with *"Brief p.11: Dev spend + reflection on AI
tool effectiveness for codebase comprehension"* — that is the **Week 5 ShipShape** row. It
is a good document for the week it was written for.

Week 6's p.13 row asks for three different things, and the file has **none** of them:

| p.13 requires | Present |
|---|:--:|
| Tracked dev spend (Epic 7 rewire per-day LLM spend; CI minutes for the TTFE drill; OAuth Playwright launches; OpenAPI generation overhead; portal storage/egress) | ⛔ |
| Production projections table (p.9's four tiers) | ⛔ |
| Explicit assumptions — webhook fanout, agent active rate, storage retention | ⛔ |

This is the row most likely to be mistaken for done because a file with the right name is
sitting in the right directory. It is not done. It has not been started.

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

### ⛔ The defect that keeps this row open: `/oauth/*` is not routed through CloudFront

Measured by origin header, not inferred:

| Path | CloudFront origin | Result |
|---|---|---|
| `/health`, `/api/v1/**`, `/api/**` | `nginx` (EB) | correct |
| `/`, `/login`, `/portal` | `AmazonS3` | correct |
| **`/oauth/authorize`, `/oauth/device/verify`, `/oauth/token`** | **`AmazonS3`** | **wrong — shadowed by the SPA fallback** |

Consequences, each observed:

1. `POST /oauth/device/code` and `POST /oauth/token` through CloudFront return a **CloudFront
   403** page — *"This distribution is not configured to allow the HTTP request method that
   was used"* — because the default (S3) behaviour is GET/HEAD only. **`ship login` cannot
   complete against the Week 6 URL.**
2. `GET /oauth/device/verify` through CloudFront returns the Ship SPA shell. The real page is
   server-rendered by the API (`api/src/platform/oauth/deviceVerify.ts`), and the SPA has no
   route of that name, so the grader never reaches the consent form.
3. Worse, and reachable from *either* entry point: the API's own device-code response is
   ```
   "verification_uri": "https://d258p92d3n1ebe.cloudfront.net/oauth/device/verify"
   ```
   so even a CLI pointed at the EB origin sends the user to the broken page.

The fix is a CloudFront cache behaviour for `/oauth/*` pointing at the EB origin with all
HTTP methods allowed and caching disabled — the same shape `/api/*` already has. It is a
Terraform/console change in L21's territory, not a code change.

**Until it lands, `ship login` → `ship docs create` → `ship webhooks tail` — the p.6
five-line story, which is simultaneously the Demo Video (row 2) and the Social Post
screenshot (row 10) — is not reproducible on the deployment.** The story itself works: the
verbatim transcript in [`docs/l19-five-line-story.md`](docs/l19-five-line-story.md) is a real
run. It was a run against a local server, and that distinction is the whole of this finding.

### Credentials in the README

`README.md` publishes both `client_id` values (`ship_app_grader_readonly`,
`ship_app_grader_demo`) and their scopes. The `client_secret` values are **not** in the
README — it gives an `aws ssm get-parameter` command instead, which requires AWS credentials
in the grader's shell. p.13 says *"credentials in the README"*. Whether an SSM lookup a
grader cannot perform satisfies that row is a judgement call, and it is flagged here rather
than quietly counted as satisfied.

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
- [ ] **No merged-branch pruning has occurred**, and the 108 unpushed `pf/*` branches are
      either pushed or consciously accepted as lost.
