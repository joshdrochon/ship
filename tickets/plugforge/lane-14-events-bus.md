# L14 · Event Registry & Event Bus

| | |
|---|---|
| **Agent** | `events-bus` |
| **Tier** | 4 — runs concurrently with L10, L13 |
| **Block** | PF-391–420 (22 allocated, 8 reserved for audit) |
| **Blocks on** | L09 (documents resource — the public write that `document.created` fires on) |
| **Unblocks** | L15 (subscriptions + HMAC signing), and through it L16 |
| **MVP gate** | None directly. Webhooks are not on the ten-item gate (p.2). This lane exists for **Testing Scenario 6** (p.5) and is on TS-9's path |

**Why this lane is only a registry and a bus.** PRD Build Strategy §5 (p.11) names seven webhook
slices — *"event registry → event bus → subscriptions → signer → queue deliverer → delivery log →
replay"*. This lane owns the first two and stops. It ships no HTTP, no subscription table, no HMAC,
no retry. What it must get right is the **call site**: p.3, Event Bus — *"Domain layer publishes on
writes — never the route layer."* That single sentence is the most-cited architectural rule in this
lane and the one the spine's Sequencing Risks table calls out by name. `docs/architecture.md:94`
draws it explicitly (`SVC->>BUS: publish(document.created) — domain publishes, never the route
layer`), with both surfaces — public `/api/v1/documents` and internal `/api/documents` — calling the
same service and getting one publish (`docs/architecture.md:79`, `:98`).

**The domain service does not exist yet, and that is this lane's real work.** `docs/architecture.md`
labels the service `documentService (utils/document-crud.ts)`, but that file exports only association
and history helpers (`logDocumentChange`, `getBelongsToAssociations`, `syncBelongsToAssociations`, …
— 619 lines, no create/update/delete). The write SQL lives inline in the route:
`api/src/routes/documents.ts:565` inside `router.post('/')` (`:536`), and
`api/src/routes/issues.ts:613` inside `router.post('/')` (`:558`). So "publish from the domain layer"
is not a one-line addition to an existing service — PF-403 extracts the seam first, and every publish
ticket depends on it. Treating the architecture doc as if the service already existed is the failure
mode here.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-391 | ☐ `EVENT_TYPES` — the eight types as one frozen data array | `EVENT_TYPES` in `platform/webhooks/events.ts` set-equals exactly the p.3 list — `document.created`, `document.updated`, `document.deleted`, `issue.created`, `issue.assigned`, `issue.status_changed`, `sprint.started`, `sprint.completed` — and has length 8; test fails on both a missing and an extra entry. `EventType = typeof EVENT_TYPES[number]`; a grep assertion proves no second hand-written union of these strings exists anywhere in the repo | TS-6, CTR:Event Registry | p.3 | PF-001 |
| PF-392 | ☐ One Zod payload schema per event type, exhaustive by construction | `eventPayloadSchemas: Record<EventType, ZodTypeAny>` — deleting an entry fails `pnpm type-check`, and a test iterates `EVENT_TYPES` asserting each schema exists, is `.strict()`, and rejects `{}`. p.3 requires *"Each with a Zod schema"*; the schemas are the source the OpenAPI webhooks section (L13) and the SDK event types (L17) both generate from — neither restates them | TS-6 | p.3 | PF-391 |
| PF-393 | ☐ Event envelope schema validates `data` against the type's own schema | `eventEnvelopeSchema` is `{id, type, created_at, workspace_id, data}`, `.strict()`, and `data` is dispatched on `type` — **not** `z.record(z.unknown())` as the current sketch has it. Test: an envelope with `type:'issue.assigned'` and `data:{id}` (no `assignee_id`) **fails** to parse. Envelope is what gets signed (L15), so a wrong-shaped payload must never reach the signer | TS-6 | p.3, p.7 | PF-392 |
| PF-394 | ☐ `event.id` minted once at publish, and it is the only idempotency basis | `id` is a UUID minted inside `publish()`; 1000 publishes yield 1000 distinct ids. The delivery log's `event_id` (p.4) and the `Idempotency-Key` L15/L16 derive are both **functions of this field and nothing else** — a test asserts a re-delivered envelope carries a byte-identical `id`, which is what makes TS-8's *"original idempotency key intact"* checkable downstream | TS-8 | p.4 | PF-393 |
| PF-395 | ☐ Open/Closed proof: a ninth event type is a registration, not a code edit | Test registers `plugin.installed` with its schema on a fresh registry, publishes it, and a subscriber receives it — with **zero** edits to `bus.ts` or any matcher/middleware; `git diff --stat` over `platform/webhooks/bus.ts` for that commit is empty. This is the events half of the OCP claim `docs/architecture.md:31` makes and p.12 requires the architecture doc to defend with a file path | — | p.12 | PF-391, PF-399 |
| PF-396 | ☐ `sprint.*` resolves its internal module through L03's resource map, never a local copy | `platform/webhooks/**` contains **no** `'weeks'` literal (grep fitness test); the sprint event publishers resolve the domain module through `platform/scopes/resource-map.ts` (PF-077, L03-owned). Verified repo facts behind the trap: the internal route is `/api/weeks` (`api/src/app.ts:240`) while `document_type` is already `'sprint'` (`api/src/db/schema.sql:100`) — the split is route-path and vocabulary, not table, so the public event name `sprint.started` needs no payload translation, only a module lookup | — | p.3 | PF-077 |
| PF-397 | ☐ Unknown event type is rejected by the registry, not by a route | Exported `assertEventType(s)` throws an error naming the eight valid types; `isEventType(s)` is the type guard. L15's subscription-create validation calls this instead of restating the list — test asserts `assertEventType('document.exploded')` throws and that the message enumerates all eight. Keeps the closed set in one place when a second consumer appears | — | p.3 | PF-391 |
| PF-398 | ☐ `IEventBus` — two methods, no transport knowledge | `publish(event): Promise<void>` and `subscribe(type \| '*', handler)`; the module imports nothing from `express`, `pg`, or `node:http` — a unit test imports it in a bare Node context with no HTTP stack. This is the DIP exhibit p.12 asks the architecture doc to name with a file path | — | p.3, p.12 | PF-001 |
| PF-399 | ☐ `InProcessEventBus` — must-ship, synchronous awaited dispatch, deterministic order | Every subscribed handler has run before `publish()`'s promise resolves (test asserts a mutation made by the handler is visible on the next line, with no `await` gap and no timer); targeted handlers run before wildcard, in registration order; `grep` asserts no `setTimeout`/`setInterval` in the module. p.11: the in-memory path *"resolves synchronously"* — that is what makes TS-6's 2 s budget a non-issue and the tests sleep-free | TS-6 | p.10, p.11 | PF-398 |
| PF-400 | ☐ A throwing handler isolates: later handlers still run, the write still succeeds | Handler A throws, handler B still receives the event, and `publish()` resolves rather than rejecting; the failure is logged with `event.id` and `event.type`. Test asserts all three. **Decision:** the bus is at-most-once *in-process* and never fails the domain write — a webhook subscriber must not be able to break `POST /documents`. Delivery durability is L16's problem, not the bus's | — | — | PF-399 |
| PF-401 | ☐ Liskov contract suite runs against any `IEventBus` implementation | `describeEventBusContract(makeBus)` is exported from the test helpers and is executed twice — against `InProcessEventBus` and against a `RecordingEventBus` double — both green with **zero** test-body edits. p.3 requires a queue-backed bus to be a *"Liskov-substitutable drop-in"*; the proof is that swapping the factory is the only change. Test asserts the shared suite is non-empty (a vacuous contract suite passes for both) | CTR:Event Bus | p.3 | PF-399 |
| PF-402 | ☐ The bus is constructed in the composition root only — including for seeds and migrations | `new InProcessEventBus()` appears in exactly one place: `productionDeps()` (PF-015); `testDeps()` (PF-016) supplies the recording double. A grep fitness test fails on any other construction site and on any module-level singleton import. Seeds and migrations get a no-op bus: `pnpm db:seed` publishes **zero** events — `api/src/db/seed.ts` inserts 14 documents, and a seed run that fanned those out to live subscriptions is a self-inflicted incident | — | p.12 | PF-015, PF-016 |
| PF-403 | ☐ Extract `documentService.create/update/delete` — the seam the publish hangs on | **Verified gap:** no such service exists. `api/src/utils/document-crud.ts` exports association/history helpers only; the create SQL is inline at `api/src/routes/documents.ts:565` inside `router.post('/')` (`:536`), and the hard delete at `:1153`. This ticket moves that SQL behind a service function taking `(ctx, input)` and an injected bus, with the route reduced to parse → call → respond. Proof of no behavior change: `api/src/routes/documents.test.ts` and the existing Playwright regression suite pass untouched, and the internal response body is byte-for-byte identical | — | p.3 | PF-398, PF-014 |
| PF-404 | ☐ `document.created` publishes **after commit**, never inside the transaction | **Verified:** the create path runs an explicit transaction — `await client.query('BEGIN')` at `api/src/routes/documents.ts:562`, with association inserts following the document insert. Publish happens after `COMMIT` returns. Test: force a rollback (an association insert against a non-existent `related_id`) and assert **zero** events on the recording bus; happy path asserts exactly one `document.created` whose `data.id` is the committed row's id. An event for a row that does not exist is unrecoverable at the subscriber | TS-6 | p.3, p.8 | PF-403 |
| PF-405 | ☐ One publish, both surfaces — internal session route and public v1 route | A create driven through internal `POST /api/documents` (session + CSRF) and one through public `POST /api/v1/documents` (bearer) each produce exactly **one** `document.created`, with identical envelope shape and differing only in `data`. p.8 states the trigger contract: *"Document created; document.created event published on the bus; subscribers receive POST."* `docs/architecture.md:98` marks the internal path *"same service, same publish"* — the test proves it rather than trusting it | TS-6 | p.3, p.8 | PF-404 |
| PF-406 | ☐ `issue.created` / `issue.assigned` / `issue.status_changed` publish from the issue write path | Create: `api/src/routes/issues.ts:613`. Updates: the PATCH path already computes a `changes[]` diff and writes it inside a transaction via `logDocumentChange(...)` at `:917` — that loop is the single choke point, so `issue.assigned` fires on `change.field === 'assignee_id'` and `issue.status_changed` on `=== 'state'` (both live in `properties` JSONB, `api/src/db/schema.sql:127`). Tests: a PATCH changing state emits one `issue.status_changed` whose `{from,to}` equal the history row's old/new values; a PATCH that changes nothing emits nothing | — | p.3 | PF-403 |
| PF-407 | ☐ `sprint.started` on the start transition; `sprint.completed` needs a write that does not exist yet | **Verified:** `POST /api/weeks/:id/start` (`api/src/routes/weeks.ts:1202`) writes `properties.status = 'active'` (`:1245`, bare `pool.query`, no transaction) — that is `sprint.started`, and the publish lands there. **`sprint.completed` has no producer:** `'completed'` is accepted by `updateSprintSchema` (`api/src/routes/weeks.ts:174`) but no code path ever writes it — status is otherwise computed from `sprint_number` + `workspace.sprint_start_date` (comments at `:157`, `:185`, `:824`), i.e. a week completes by the calendar, not by a write. Acceptance: `sprint.started` fires on the start transition (test), and `sprint.completed` fires from an explicit `PATCH` setting `status:'completed'` — with a test that **fails** if no write path sets it, so this cannot stay silently unfirable. ⚑ decision — see audit notes | — | p.3 | PF-396, PF-403 |
| PF-408 | ☐ Payload contents: identifiers only, never document content — decided and enforced | Answers Pre-Search 1.4 (p.15) — *"do you ship document content in `document.created`, or just the ID?"* **Decision: ids + immutable identifiers + `title`; never `content`, never `properties`.** `document.created.data` is exactly `{id, document_type, title, workspace_id, created_at}`; the schema is `.strict()`, so a `content` key fails to parse. Test: create a document whose TipTap body contains a sentinel string and assert the string appears in no published envelope. Rationale + the rejected alternatives land in `docs/architecture.md`. ⚑ this is a live decision, not a settled requirement — see audit notes | — | p.15 | PF-392 |
| PF-409 | ☐ `document.deleted` is the one event that cannot be "fetch on demand" | **Verified:** the delete route hard-deletes — `DELETE FROM documents WHERE id = $1 AND workspace_id = $2 RETURNING id` (`api/src/routes/documents.ts:1153`); the `deleted_at` soft-delete column exists (`api/src/db/schema.sql:136`) but this path does not use it. So an id-only payload is unresolvable: the subscriber's follow-up `GET` returns 404 forever. Acceptance: `document.deleted.data` carries `{id, document_type, workspace_id, deleted_at}` captured **before** the delete, the payload schema documents that this event is the only surviving record, and a test asserts the fields are populated from the pre-delete row | — | p.15 | PF-408, PF-403 |
| PF-410 | ☐ Private documents do not leak their title through the event payload | `documents.visibility` is `'private' \| 'workspace'` (`api/src/db/schema.sql:158`, default `'workspace'`) and internal reads filter on it (`VISIBILITY_FILTER_SQL`). A webhook subscriber is an app acting for a user, not a workspace member, so PF-408's `title` is the leak vector. Acceptance: for `visibility='private'`, `title` is **absent** from the payload (key omitted, not empty string) and a test asserts it; whether such a subscription should match at all is the matcher's decision and belongs to L15 — this ticket makes the payload safe either way | — | p.15 | PF-408 |
| PF-411 | ☐ Fitness test: nothing under `api/src/platform/api/v1/**` publishes | A fitness test scans `api/src/platform/api/v1/**` and `api/src/routes/**` and fails on any reference to `.publish(`, `IEventBus`, or an events-module import, naming file and line. The permitted publish call sites are an explicit allowlist of domain-service modules, and the test **also asserts the allowlist is non-empty and that each entry really contains a publish call** — an empty allowlist over an unwired codebase passes vacuously, which is exactly how this rule would rot. This is the mechanical form of p.3's *"never the route layer"* and of the spine's L14 sequencing risk | — | p.3 | PF-405, PF-406, PF-407 |
| PF-412 | ☐ TS-6 substrate: a real public write puts exactly one valid `document.created` on the bus | Integration test — `POST /api/v1/documents` with a bearer token against an app injected with the recording bus (`testDeps()`, PF-016) records exactly one envelope that parses against `eventEnvelopeSchema` and whose `data.id` equals the created document's id, before the HTTP response returns. This is TS-6's first half (*"create a document"* → event published); the signed POST, the 2 s budget and the tamper check are L15's. Test asserts on the parsed envelope, not on a log line | TS-6 | p.5, p.8 | PF-404, PF-393 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L14-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L14-event-registry` | PF-391–397 | Event types as data with a Zod schema each (p.3), open to a ninth without a code edit | PF-395 extension test: a new type reaches a subscriber with an empty diff on `bus.ts`; PF-396 grep asserts no `'weeks'` literal in `platform/webhooks/**` |
| S2 | `pf/L14-event-bus` | PF-398–402 | `IEventBus` with the in-process implementation must-ship and a queue-backed bus provably substitutable (p.3) | PF-401 contract suite runs green against two implementations unedited; PF-402 grep asserts one construction site |
| S3 | `pf/L14-domain-publish` | PF-403–407 | The publish call site is the domain service, on every write path, after commit | PF-404 rollback test: zero events on a rolled-back create; PF-405 one publish from each of the two surfaces |
| S4 | `pf/L14-payload-policy` | PF-408–410 | Pre-Search 1.4 answered and enforced: identifiers out, content never | PF-408 sentinel-string test finds the document body in no envelope; PF-410 asserts `title` absent for private docs |
| S5 | `pf/L14-publish-fitness` | PF-411–412 | Testing Scenario 6 (p.5), first half — a real write publishes; and the route layer provably never does | PF-411 route-layer scan with a non-empty allowlist; PF-412 end-to-end `POST /api/v1/documents` → one schema-valid envelope |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **PF-408 (payload contents) is the lane's real open decision and it is not settled.** Pre-Search
  1.4 (p.15) asks it and does not answer it. I shipped **identifiers + `title`, never `content`**.
  The case for it: exposure surface stays small, a leaked subscriber URL leaks metadata rather than
  document bodies, and payload size stays bounded so fanout cost is predictable (p.15's 1.1 fanout
  question). The case against it, which is genuinely strong: every subscriber must now make an
  authenticated `GET` per event, which doubles the integration's moving parts, puts an
  availability dependency on our API inside their handler, and defeats the offline/queued consumer
  entirely. Stripe ships the full object; that is the industry default we are departing from, and
  the Architecture Defense is a plausible place to be asked why. **`title` is the inconsistent
  part** — it is user content by any honest reading, and PF-410 exists only because I kept it. The
  clean positions are "ids only, no title" or "full object"; what I shipped is the middle. If the
  audit has budget, re-litigate PF-408 rather than rubber-stamping it. Note that PF-409 already
  proves the ids-only rule cannot be universal: a hard-deleted document is unfetchable, so
  `document.deleted` must carry its own data no matter which way PF-408 goes.
- **PF-407 `sprint.completed` may be unfirable, and that is a repo fact, not a guess.** Grep found
  no write that sets `properties.status = 'completed'` anywhere in `api/src/routes/weeks.ts`; the
  value exists only in the PATCH schema's enum (`:174`), and three comments (`:157`, `:185`,
  `:824`) say status is computed from `sprint_number` + `workspace.sprint_start_date`. The PRD
  lists the event (p.3) and says nothing about what produces it. Options: (a) add the explicit
  PATCH transition, which is what PF-407 does; (b) fire it from a scheduled job at the week
  boundary, which introduces a scheduler this platform does not have; (c) declare the type
  registered but unfired for the week and say so. I chose (a) as the smallest honest build. If the
  audit disagrees, the change is local to PF-407.
- **PF-403 is a refactor with real blast radius, and it is on the critical path of five other
  tickets.** Extracting `documentService` touches the most-exercised write path in Ship. The
  regression suite is the only guard named; if it is thin around `POST /api/documents` edge cases
  (visibility inheritance from `parent_id`, `belongs_to` association fan-out, the `sprint_id`
  backward-compat insert — all in `documents.ts:536–620`), the extraction can pass tests and still
  change behavior. Worth an explicit look at test coverage of that handler before the slice lands.
- **The bus sketch's justification for domain-layer publishing is partly wrong.** `bus.ts` says
  non-HTTP writers *"(the FleetGraph agent, seeds, migrations)"* must emit too. Verified: the agent
  writes only `fleetgraph_*` tables (`agent/src/data/boundary.ts:81, :179, :334, :405`) and touches
  `documents` nowhere outside tests and fixtures — so it is not a document writer today, and after
  the Epic 7 rewire (L23) it goes through the public API anyway. Seeds and migrations *are* real
  writers, and they must **not** publish (PF-402). The rule still holds — it is p.3's plain text —
  but the sketch's stated reason does not survive contact with the repo. Do not repeat it in the
  architecture doc.
- **PF-400 (`—` on PRD) is a decision, not a requirement.** Nothing in the PRD says whether a
  failing subscriber handler should fail the domain write. I chose isolation: log and continue,
  never reject the caller's promise. p.17's 3.1 question about at-least-once vs at-most-once is
  adjacent but is asked about the *deliverer*, not the bus, so I did not cite it. If the audit
  reads it as covering the bus too, the citation can be added; the behavior would not change.
- **PF-395's OCP framing borrows p.3's scope sentence.** The literal *"register at module load,
  never edit middleware"* text on p.3 is in the **Scope Registry** row, not the Event Registry row;
  the Event Registry row says only *"Event types as data … Each with a Zod schema."* The OCP claim
  for events comes from `docs/architecture.md:31` and from p.12's requirement that the architecture
  doc show SOLID with file paths. I cited p.12 rather than p.3 for that ticket for exactly this
  reason — flag it if you think the analogy is over-claimed.
- **`Advances` is `—` on 14 of 22 tickets, and I did not force matches.** Webhooks appear nowhere
  on the MVP gate (p.2), so this lane earns no gate credit at all; TS-6 is the only scenario it
  advances directly and TS-8 only through PF-394's idempotency basis. TS-9 (TTFE drill) also runs
  through PF-404/PF-412, but L20 owns that scenario end-to-end and I did not want two lanes both
  claiming it — if the audit prefers TS-9 on those two, that is a defensible re-tag.
- **Untracked sketches exist and are spikes, not done work.** `api/src/platform/webhooks/events.ts`
  (~45 lines) has the eight types and a `TODO(josh)` conceding the per-type schemas are not tight —
  its envelope uses `z.record(z.unknown())` for `data`, which PF-393 replaces, and its
  `document.created` already carries `title`, which is the PF-408/PF-410 decision made implicitly.
  `bus.ts` (~40 lines) has `IEventBus` + `InProcessEventBus` with no tests, no contract suite, and
  no injection. Nothing is wired into `app.ts`. Do not mark PF-391/392/398/399 done because the
  files are on disk.
- **PF-396 depends on a file that does not exist yet.** `platform/scopes/resource-map.ts` is L03's
  PF-077 and is not on disk (verified). L03's own notes flag that the map may belong in `api/v1/`
  rather than `scopes/` — if the audit moves it, PF-396's import path moves with it, but the
  no-`'weeks'`-literal assertion over `platform/webhooks/**` stands either way.
- **Not covered here, on purpose:** the subscription table and matcher, HMAC signing, the
  `Ship-Signature` header, delivery, retries, the DLQ and replay (L15/L16); the OpenAPI `webhooks`
  section generated from `eventPayloadSchemas` (L13); the SDK's event type exports (L17). If any of
  those is unowned at audit time it goes to `lane-99-unassigned.md`, not into this file.
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.
