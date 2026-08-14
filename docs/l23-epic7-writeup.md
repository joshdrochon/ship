# Epic 7 — the agent as a platform citizen

**PF-713.** The four sections L26's PF-807 checks and PF-809 embeds. PRD p.13's
interview question is *"The agent is now a platform citizen — it goes through the
SDK and OAuth like any external app. What did this cost you in code, and what did
it buy you architecturally?"*

---

## Before

FleetGraph was a privileged insider by construction, and the privilege had one
direction that mattered.

| Path | Where |
|---|---|
| Direct SQL to the whole schema | `agent/src/data/pool.ts`, `agent/src/data/boundary.ts`, every file under `agent/src/detectors/` |
| A Ship API token with no scope column behind it | `agent/src/actions/client.ts`, `SHIP_API_TOKEN` |

Ship's `api_tokens` table has no scopes. So the agent's read surface was
*the entire database*, and the only thing keeping it narrow was that its SQL
happened to be narrow. The blast radius of a leaked agent token was "everything",
and nothing anywhere could have told you otherwise.

There was a second edge in the diagram that read like a back door and is not:
`api/src/routes/fleetgraph/agentBridge.ts` imports `@ship/agent` to trigger a
chat turn. That is Ship invoking its own app, the same direction as a user
pressing a button. It survives the rewire and `docs/architecture.md` now labels
it as the trigger direction rather than deleting it.

---

## Fix

Four pieces, and the first one had to be built rather than consumed.

**1. `grant_type=client_credentials` (RFC 6749 §4.4).** Measured on
`pf/integration` before building anything: the grant map carried
`TODO(L05/D5): client_credentials` and the token endpoint answered
`unsupported_grant_type`. L04 (auth code), L05 (device) and L06 (token
lifecycle) are the three grant lanes and none of them is this one, so it landed
here. Registered as a new key in the grant map — the dispatcher was not edited,
which is now four lanes deep on that property.

Two eligibility gates, and the second is not in any ticket:

- **First-party only.** A client-credentials token has no consenting human
  behind it. Handing that shape to third-party developers would let any
  registered app read workspace data with nobody having approved it.
- **Confidential only.** `authenticateClient` authenticates a *public* app on
  `client_id` alone (migration 074, L99 F70/F100) — correctly, because a CLI and
  an SPA cannot keep a secret. But `client_id` is printed in the README. Without
  this gate, anyone who read the README could mint a token carrying a public
  app's full scope set. `ship_app_grader_demo` is public *and* holds
  `documents:write` + `webhooks:manage`, so this was not theoretical.

**2. `ShipClient.clientCredentials()` in `@ship/sdk`.** In the SDK rather than
hand-rolled in the agent, because p.11 requires the agent reach Ship only
through `@ship/sdk` — and a helper the first-party agent needed but the
published SDK did not ship would be the clearest possible evidence that we are
not eating our own dog food (p.10).

**3. `agent/src/data/citizenReader.ts`.** A `Queryable`, so it goes in through
the parameter every detector and fetch node already had. Zero changed signatures
under `detectors/**` and `graph/nodes/**`.

It is a **router, not a translator**: recognised statements are served from the
public API, statements touching only `fleetgraph_*` go to the pool, and
**anything else throws**, naming the table. The throw is the design. A silent
fallback would make the front-door claim unfalsifiable — every future detector
edit would quietly widen the exception surface and nothing would say so.

**4. The recommendation pattern, and `SHIP_AGENT_VIA_SDK`.** Under D5b the agent
is read-only, so `comment` and `history_note` write a `kind='recommendation'`
row into `fleetgraph_notifications` instead. The flag defaults **off** and is
read in exactly one non-test module.

---

## After

**Three scopes**, exactly, each earned by a named reader:
`documents:read`, `issues:read`, `sprints:read`. No write scope, no
`webhooks:manage`. The seeded row carried `issues:write` until 2026-08-12 under
a comment claiming least privilege; `agentAppCitizen.test.ts` now asserts the
list exactly and names any offender.

**The front-door claim is bounded, and the boundary is a literal array.**
`SQL_EXCEPTIONS` in `citizenReader.ts` carries three entries, each with the
reason its table has no public route: `document_history` (a public history route
is the sprawl p.2 warns against), `users` (no public users resource; the display
name degrades to the id), and `document_associations` (rescued in principle by
D13's `issueSchema.belongs_to`, but two detectors are not re-pointed at it yet —
this entry should shrink to nothing, not stay).

So the honest sentence is **"every Ship-data read the agent makes goes through
the public API, except the three tables named in `SQL_EXCEPTIONS`, which are
asserted"** — not "every action, without qualification".

`workspaces` is in neither the allowed set nor the exception list, and a test
pins that. It is tenant configuration and should never be on a public API;
PF-289 resolves the sprint window from `sprintSchema` instead.

---

## Proof

### Real rows, from a real run

`api/src/platform/api/v1/agentCitizenFitness.test.ts` boots a server with the
real public router, the real bearer middleware and the real `PgAuditSink`, mints
a token over the wire, runs a detector through the reader, and reads the trail
back with L12's `listCalls({ clientId })`. These are its rows, captured with
`L23_KEEP_AUDIT_ROWS=1`:

```
        occurred_at         |                 client_id                  | user_id |        call         |  scope_used  | status | latency_ms
----------------------------+--------------------------------------------+---------+---------------------+--------------+--------+------------
 2026-08-14 06:24:11.886+00 | ship_app_firstparty_fleetgraph_agent_…      |  NULL   | POST /api/v1/issues | issues:write |    403 |   1.418958
 2026-08-14 06:24:11.866+00 | ship_app_firstparty_fleetgraph_agent_…      |  NULL   | GET /api/v1/issues  | issues:read  |    200 |   4.287375
 2026-08-14 06:24:11.83+00  | ship_app_firstparty_fleetgraph_agent_…      |  NULL   | GET /api/v1/issues  | issues:read  |    200 |   6.189709
 2026-08-14 06:24:11.818+00 | ship_app_firstparty_fleetgraph_agent_…      |  NULL   | GET /api/v1/me      |    NULL      |    200 |   3.503417
```

Read those four rows carefully, because they are the whole epic:

- **`client_id` is the agent's own app.** L99's B11 — portal traffic being
  indistinguishable from a developer's own — does not apply here, because the
  agent has its own registration.
- **`user_id` is NULL on every row.** Client credentials binds no user. That is
  a third documented meaning for that nullable field on top of L12's PF-326 two,
  and it is what tells a reader nobody approved these calls interactively.
- **`scope_used` is `issues:read` on the reads and NULL on `/me`.** The null is
  L10's PF-271 being correct: `/me` declares `scope: null` because none of p.3's
  seven names the authenticated identity.
- **The 403 is deliberate.** `POST /api/v1/issues` under `issues:write` is
  PF-703 checking that the *platform* enforces read-only, independently of the
  agent's own refusal in `act.ts`. Q3's original complaint was that `api_tokens`
  could not enforce that boundary at all. Now it does, and the refusal is in the
  audit trail.

### The half the rows cannot prove

The query in `docs/l23-epic7-proof.sql` proves that **some** calls went through.
It cannot prove that **every** action did, because the rows it reads are exactly
the rows a missing call would not have written. A grep cannot see an absence.

That half is PF-697's table invariant, asserted for the *same run*: the flag-on
path touched **no Ship table over SQL** (`tablesTouchedBySql()` returned `[]`,
`invariantViolations()` returned `[]`, every statement `servedBy: 'sdk'`). The
query and the fitness test are presented together for exactly that reason.

---

## What it cost, in numbers

| | |
|---|---|
| Files changed | 24 (12 new, 12 edited) |
| Tests added | 84 (22 grant · 16 seeded-app · 6 SDK · 15 read-only act · 13 flag · 14 reader · 12 fitness, less overlap) |
| Migrations | 1 (`075_fleetgraph_notification_kind.sql`, one nullable column) |
| Changed signatures under `detectors/**` and `graph/nodes/**` | **0** |
| Pre-existing lint errors added | **0** (F94's five, unchanged) |

**Two behavioural changes, stated as changes and not as improvements:**

1. **The agent no longer comments on documents.** The finding still reaches the
   accountable person, through `fleetgraph_notifications` instead.
2. **The agent no longer writes `document_history`.** This is a real loss, not a
   neutral swap: that row is rendered in Ship's own UI and made *"what did the
   agent do last week"* answerable with one query by someone who does not know
   which documents to look at. **The trail moves from `document_history` to
   `public_api_calls` + `fleetgraph_notifications`, so the query a reader would
   have run changes.**

**One measured shortfall (F143).** `issueSchema` carries no `started_at`, so
`stalledWork`'s `context.started_at` is a date on the SQL path and `null` on the
SDK path. PF-694 asked for byte-identical `Signal[]` and `reviewBottleneck`
delivers it; `stalledWork` does not. Measurement, threshold, bucket, fingerprint
and accountable user are identical, so suppression and delivery are unaffected —
what is lost is one line of context in the judgment prompt. The test asserts the
difference by name rather than loosening the comparison, so the day L10 adds the
field it goes red and someone deletes it.

## The claim, and where it is qualified

p.14 closes with *"an agent that goes through the front door beats one with a
privileged shortcut."* That holds, with two qualifications a reader can check:

- The front door covers **reads**. The write actions did not move to the front
  door; they stopped existing, and the information moved to a different surface.
- **Three tables are still read over SQL**, named in `SQL_EXCEPTIONS` with a
  reason each, and the invariant test fails loudly if a fourth appears.

Part 2's suite passes with the flag on and off **at the suite level, with one
e2e assertion forked and named and one composition-root spec running in its own
state** — 191/191 per leg, measured. It is not byte-for-byte identical in both
states, and `docs/l23-flag-matrix.md` says which tests and why.
