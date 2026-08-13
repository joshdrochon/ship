# L15 · Webhook Subscriptions & HMAC Signing

| | |
|---|---|
| **Agent** | `webhooks-signing` |
| **Tier** | 5 — runs concurrently with L17 |
| **Block** | PF-421–450 (27 allocated, 3 reserved for audit) |
| **Blocks on** | L14 (PF-393 envelope schema, PF-397 `assertEventType`, PF-398 `IEventBus`, PF-399 `InProcessEventBus`, PF-404 publish-after-commit), L08 (PF-211 router, PF-223 `Page<T>`, PF-227 pagination line), L03 (PF-062 `webhooks:manage`, PF-067 `requireScope`) |
| **Unblocks** | L16 (deliverer, retry, DLQ, delivery log, replay), L18 (the SDK's `verifyWebhook`) |
| **MVP gate** | **None.** Webhooks are absent from all ten p.2 checkboxes. This lane exists for **Testing Scenario 6** (p.5) and is on TS-9's path |

**Where this lane starts and stops.** PRD Build Strategy §5 (p.11) names seven webhook slices —
*"event registry → event bus → subscriptions → signer → queue deliverer → delivery log → replay"*.
L14 shipped the first two. This lane owns **subscriptions** and **the signer**, and hands a fully
signed request to an injected `IWebhookDeliverer`. The HTTP courier, the retry ladder, the delivery
log, the DLQ and replay are L16's (PF-451–490, not yet written) — every ticket below stops at the
seam rather than reaching through it.

**Two PRD sentences generate most of the lane.** p.3, Webhook Subscriptions: *"Per-app
per-event-type subscriptions. Target URL, hashed signing secret, active flag. Manageable via
/api/v1/webhooks (gated by webhooks:manage scope)."* And p.3, HMAC-SHA256 Signing: *"Stripe-style
header: Ship-Signature: t=<unix-seconds>,v1=<hex-hmac>. Timestamp prevents replay; SDK rejects any
signature older than 5 minutes by default."* The Interface Definition on p.7 pins the verifier
contract L18 must satisfy — `verifyWebhook(headers, rawBody, secret, toleranceSec?)` with
`toleranceSec` defaulting to 300 — and this lane owns the **server signer** that contract is checked
against.

**The one thing in this lane that cannot be built as written.** p.3 says *hashed* signing secret.
A hash is one-way; the server must hold the secret in usable form to compute an HMAC on every send.
Those two requirements are mutually exclusive and PF-422 resolves them — encrypted at rest, not
hashed — with the full argument in the audit notes. Do not read past this: it is the lane's single
load-bearing deviation from the PRD's literal text.

**Three repo facts that shape the lane.**

1. `api/src/platform/webhooks/signer.ts` (untracked sketch) already computes
   `HMAC-SHA256(secret, \`${t}.${rawBody}\`)`, formats `t=…,v1=…`, and verifies with
   `timingSafeEqual` and a 300 s default tolerance. It has **no tests, no clock injection**
   (`verifySignature` takes `nowSeconds` as a parameter but nothing calls it), and is wired into
   nothing. The scheme choice it encodes matches `docs/architecture.md:146`, but it is *our* choice —
   the PRD asks the question and does not answer it (p.16, Pre-Search 2.3).
2. There is **no subscription table and no `oauth_apps` table** in `api/src/db/schema.sql`. The
   nearest precedent for secret-at-rest discipline is `api_tokens` (`schema.sql:254`), which stores
   `token_hash TEXT NOT NULL -- SHA-256 hash (never store plain token)` plus a `token_prefix TEXT`
   for identification. PF-423 copies the *prefix* idea and PF-422 deliberately does **not** copy the
   *hash* idea, for the reason above.
3. L14's `InProcessEventBus.publish()` awaits every handler before resolving (PF-399), and the
   publish sits on the request path after commit (PF-404). If this lane's pipeline handler performs
   the outbound POST inside `publish()`, a slow subscriber becomes API latency on
   `POST /api/v1/documents`. PF-441 is that ticket.

## Tickets

| ID | Title | Acceptance criterion | Advances | PRD | Deps |
|---|---|---|---|---|---|
| PF-421 | ☑ `webhook_subscriptions` migration — per-app, per-event-type, one row per pair | Migration `NNN_webhook_subscriptions.sql` from the block PF-021 reserved creates `id`, `app_id`, `workspace_id`, `event_type TEXT NOT NULL`, `target_url TEXT NOT NULL`, `secret_ciphertext`, `secret_prefix`, `secret_version INT NOT NULL DEFAULT 1`, `active BOOLEAN NOT NULL DEFAULT true`, `created_at`, `updated_at`, `deactivated_at`, plus `UNIQUE(app_id, event_type, target_url)` and a `(created_at, id)` index for PF-222's keyset check. **Decision: no `CHECK` constraint on `event_type`** — the closed set is L14's `EVENT_TYPES` and restating it in SQL makes a ninth event type a migration, which is exactly the OCP property PF-395 proves. Test: the unique constraint rejects a duplicate triple; a row with an unregistered `event_type` is rejected by PF-429, not by the database | CTR:Webhook Subscriptions | p.3 | PF-021, PF-391 |
| PF-422 | ☑ The signing secret **cannot** be hashed — decided: encrypted at rest, reversible | p.3 says *"hashed signing secret"*; p.12's Failure Modes row requires an answer for *"a subscriber's signing secret is rotated mid-flight"*, which presumes the server signs each attempt with the current secret. A hash cannot produce an HMAC. **Decision: AES-256-GCM at rest** — key from `WEBHOOK_SECRET_KEY` in the environment, never in the database, distinct from the DB credential; `secret_ciphertext` holds nonce ‖ ciphertext ‖ tag. Acceptance: a unit test round-trips encrypt→decrypt; a test asserts the raw secret appears in **no** column of a `SELECT *` over the table (byte scan of every text/bytea value); a test asserts decryption **fails closed** (throws, delivery aborts, nothing sent unsigned) when the key is absent or wrong. `client_secret` stays hashed and PF-424 states the asymmetry in one sentence in `platform/README.md`: a client secret is *presented to us* and can be compared; a webhook secret is *used by us* and must be recoverable. ⚑ see audit notes — this is the lane's headline deviation | CTR:Webhook Subscriptions | p.3, p.12 | PF-421 |
| PF-423 | ☑ Secret minted at creation, prefix stored in clear, raw value shown exactly once | `generateSigningSecret()` returns ≥ 256 bits of `crypto.randomBytes` entropy rendered as `whsec_<base64url>`; 10 000 generations yield 10 000 distinct values and none is shorter than the declared length. `secret_prefix` stores the first 8 characters after the `whsec_` tag so the portal and the delivery log can identify *which* secret without holding it. The raw value appears in the **create** response body and nowhere else — this is p.8's *"Subscription persisted; signing secret returned once"* and p.7's drill loop reading `sub.signing_secret` straight off the create result. Same discipline the MVP gate already requires of `client_secret` (p.2, *"raw secret shown exactly once on creation"*) | CTR:Webhook Subscriptions | p.7, p.8 | PF-422 |
| PF-424 | ☑ The secret is unreadable after creation — proven by a scan, not by a promise | Four assertions: (a) `GET /api/v1/webhooks/:id` and the list route return `secret_prefix` and never `signing_secret`, enforced by a `.strict()` Zod response schema that would fail to parse the field; (b) a test drives create → list → get → rotate and greps the **captured server log output** for the raw secret string, asserting zero hits; (c) no `ApiError.details` on any webhook route carries it (PF-198's per-code policy applies); (d) the repo's `toString`/serializer for the subscription row omits the ciphertext entirely. Answers the p.15 1.4 leakage question for the webhook secret the same way L02 answers it for `client_secret` | CTR:Webhook Subscriptions | p.8, p.15 | PF-423, PF-198 |
| PF-425 | ☑ `target_url` is validated at write time — absolute `https`, and not pointed at us | Zod refinement rejects, each with `validation_failed` naming `target_url`: a relative URL, a non-`https` scheme (`http`, `file`, `gopher`), a URL with credentials in the authority, and a host resolving to loopback / link-local / RFC 1918 space. **Decision: the private-range block is ours, not the PRD's** — an unvalidated `target_url` turns `POST /api/v1/webhooks` into a server-side request forgery primitive against anything reachable from the API container, and the delivery log would faithfully record the response body. `http://localhost` is permitted **only** when `NODE_ENV === 'test'`, gated by one named constant so the exception is greppable — the TTFE drill and TS-6 both point at a local listener | CTR:Webhook Subscriptions | p.3 | PF-421 |
| PF-426 | ☑ `active` is a matcher input, not a display flag — and deactivation is not deletion | p.3 lists `active flag` as a first-class column. Acceptance: a subscription with `active = false` receives **zero** deliveries for an event it would otherwise match (asserted on the injected deliverer's recorded requests, not on a log line); reactivating it resumes matching with **no** backfill of events published while it was inactive, and a test asserts that explicitly. `DELETE` sets `deactivated_at` and `active = false` rather than removing the row, so L16's delivery log keeps a resolvable `subscription_id` foreign key after a subscriber walks away | CTR:Webhook Subscriptions | p.3 | PF-421 |
| PF-427 | ☑ `IWebhookSubscriptionRepo` + an in-memory double, both constructed in the composition root only | Interface is `create`, `getById`, `listByApp`, `findActiveByEventType`, `deactivate`, `rotateSecret` — no Express types, no `pg` types in the signature; a unit test imports it in a bare Node context. `PgWebhookSubscriptionRepo` is constructed only in `productionDeps()` (PF-015) and `InMemoryWebhookSubscriptionRepo` only in `testDeps()` (PF-016); a grep fitness test fails on any other construction site. This is the `subsRepo(db)` argument in the composition-root sketch p.12 requires the architecture doc to show (*"wiring concrete OAuth, rate-limiter, event-bus, and webhook-deliverer implementations"*, plus *"the in-memory test wiring as a sibling diagram"*) | SUB:Architecture Document | p.12 | PF-421, PF-015, PF-016 |
| PF-428 | ☑ Every `/api/v1/webhooks` method declares `webhooks:manage` — no method is cheaper than another | Routes mount on L08's `createPublicRouter` (PF-211) via L13's `defineRoute` (PF-358) so one call registers handler, scope metadata and spec entry. Test: for each of the six methods (POST create, GET list, GET one, PATCH, DELETE, POST rotate) a token holding `documents:read` but not `webhooks:manage` gets 403 with `details.required_scope === 'webhooks:manage'`, and PF-079's fitness walk finds a registered scope on all six. **Read is not exempt** — the subscription list names an app's target URLs, which is reconnaissance | CTR:Webhook Subscriptions | p.3 | PF-062, PF-067, PF-211, PF-358 |
| PF-429 | ☑ `POST /api/v1/webhooks` — 201, the secret once, event type checked against the registry | Request body is `{event, target_url}` (`event`, singular, matching p.7's drill loop `client.webhooks.create({event, target_url})` — **not** `event_types[]`); the handler calls L14's `assertEventType` (PF-397) rather than restating the eight names, so an unknown type returns `validation_failed` whose message enumerates all eight. Response is 201 with `{id, event, target_url, active, signing_secret, created_at}` — `signing_secret` present here and in no other response in the codebase. The row is bound to the **calling token's app**, never to an `app_id` in the request body; a test sends a foreign `app_id` and asserts it is ignored, not honored | CTR:Webhook Subscriptions, TS-6 | p.3, p.7 | PF-423, PF-425, PF-397, PF-428 |
| PF-430 | ☑ `GET /api/v1/webhooks` — cursor-paginated, and scoped to the calling app alone | Declares `list: 'cursor'` per PF-228 (a DB-backed collection, so PF-227's rule applies — it is not a fixed-cardinality registry), returns `{data, next_cursor}` passing PF-223's `pageSchema`, and `assertKeysetIndexed('webhook_subscriptions')` (PF-222) passes against the index PF-421 ships. Isolation test: app A with 3 subscriptions and app B with 3 both list, each sees exactly its own 3, and a full cursor walk by A never surfaces a B row | CTR:Webhook Subscriptions, TS-4 | p.3 | PF-429, PF-223, PF-228, PF-222 |
| PF-431 | ☑ `GET /:id`, `PATCH /:id` (active only), `DELETE /:id` | `GET` returns the subscription without the secret (PF-424). `PATCH` accepts **only** `{active}` — a request attempting to change `event` or `target_url` returns `validation_failed` naming the immutable field, because mutating `target_url` in place would silently redirect an existing secret to a new host. `DELETE` is idempotent: the second call returns the same status as the first, no 500. p.4's portal row (*"managing subscriptions"*) is the consumer of all three | CTR:Developer Portal | p.3, p.4 | PF-429, PF-426 |
| PF-432 | ☑ Another app's subscription id is `not_found`, never `forbidden` | Four cases: app B issuing `GET`, `PATCH`, `DELETE`, and `POST /:id/rotate` against one of app A's subscription ids each returns 404 `not_found` — **not** 403, which would confirm the id exists and turn the endpoint into an existence oracle over UUIDs. A malformed (non-UUID) id also returns `validation_failed` rather than a database error. Asserted for all four verbs, because a single-verb check has historically been where this leaks | CTR:Webhook Subscriptions | p.3 | PF-431, PF-430 |
| PF-433 | ☑ `POST /api/v1/webhooks/:id/rotate` — new secret shown once, old secret dead immediately | Response body carries the new `signing_secret` exactly once and `secret_version` increments; the previous secret verifies **nothing** from the moment the row is written — a test signs with the old secret and asserts `verifySignature` returns false. **Decision: instant invalidation, no grace period**, matching L99's D3 lean for `client_secret` rotation and keeping one story for both secrets. The cost is real and is the whole subject of PF-443: a subscriber that has not updated its environment fails verification until it does, and the retry ladder is what covers that window (p.12, Failure Modes) | CTR:Webhook Subscriptions | p.3, p.12 | PF-423, PF-428 |
| PF-434 | ☐ **Decision:** the signed payload is `` `${t}.${rawBody}` `` — Pre-Search 2.3 answered | p.16 asks it and does not answer it: *"What exactly is signed — the raw request body, the body plus the timestamp, the body plus a versioned scheme tag? Why?"* **Answer: body plus timestamp, concatenated as `t` ‖ `.` ‖ raw bytes**, which is Stripe's construction and the one `docs/architecture.md:146` already commits to. Why not raw body alone: the timestamp would then be unauthenticated header data an attacker could rewrite, and the anti-replay property evaporates. Why the scheme tag is *not* inside the signed bytes: it lives in the header as the `v1=` key, so a future `v2` is an additional header field verified alongside `v1` rather than a breaking change to what is signed. Acceptance: a table-driven test pins the construction against committed vectors (PF-446), a test asserts a signature computed over the body alone does **not** verify, and the rationale plus the two rejected alternatives land in `docs/architecture.md` and in the Pre-Search answer for 2.3. ⚑ ours, not the PRD's — see audit notes | SUB:Pre-Search Document | p.16, p.3 | PF-001 |
| PF-435 | ☐ `Ship-Signature: t=<unix-seconds>,v1=<hex>` — the grammar is pinned to the byte | Header value matches `/^t=\d+,v1=[0-9a-f]{64}\$/` exactly: seconds not milliseconds, lowercase hex, 64 characters, comma with **no** surrounding whitespace, `t` before `v1`. A test asserts the emitted header matches p.7's literal example shape (`Ship-Signature: t=1715985600,v1=<hex-hmac-sha256>`). The parser is tolerant on input where the emitter is strict on output: it accepts extra unknown `key=value` pairs (forward compatibility with `v2`), and returns `null` — never throws — on a missing `t`, a missing `v1`, a non-numeric `t`, an empty value, or a duplicated key | CTR:HMAC-SHA256 Signing | p.3, p.7 | PF-434 |
| PF-436 | ☐ Raw bytes are signed and the same bytes are sent — one serialization, never two | The envelope is serialized to a `Buffer` **once**; that buffer is what the HMAC consumes and what becomes the `DeliveryRequest.rawBody`. Test: a payload containing a non-ASCII title, an emoji, and a `/` that `JSON.stringify` may or may not escape is signed and delivered, and the recorded request body is asserted **byte-identical** (`Buffer.compare === 0`) to the signed input. A second test proves the negative — re-serializing the parsed object and signing *that* produces a different digest for the same logical payload, which is the canonicalization bug this ticket exists to make impossible | CTR:HMAC-SHA256 Signing | p.16 | PF-434 |
| PF-437 | ☐ `t` comes from the injected `Clock`, so signing is deterministic and drift is visible | The signer takes `Clock` (PF-017) and reads `Math.floor(clock.nowMs() / 1000)`; a grep fitness test asserts `Date.now()` and `new Date()` appear nowhere in `platform/webhooks/signer.ts`. With a `FakeClock` pinned to a fixed instant the emitted header is byte-stable across runs — which is what lets PF-446's vectors be committed and PF-445's replay case be tested without sleeping (p.11: *"Timing-based webhook tests are flaky tests"* is the standing rule; the deterministic-clock discipline is p.11's). This is also the mechanical half of p.13's interview question *"What happens if your server's clock drifts?"* — a server running fast by more than the tolerance signs payloads every subscriber rejects, and PF-447 writes down the answer | CTR:HMAC-SHA256 Signing | p.11, p.13 | PF-435, PF-017 |
| PF-438 | ☐ `verifySignature(secret, header, rawBody, nowSeconds, toleranceSeconds = 300)` — the contract L18 compiles against | Server-side verifier, symmetric with the signer, and the reference implementation of the p.7 Interface Definition `verifyWebhook(headers, rawBody, secret, toleranceSec?)` — *"default 300"*, i.e. p.3's *"older than 5 minutes"*. Five assertions: a valid signature passes; a tampered body fails; `t` older than tolerance fails; `t` **further in the future** than tolerance also fails (the sketch's `Math.abs` is correct and this pins it); a missing `v1` fails (p.4: *"missing v1 header fails"*). Comparison is `timingSafeEqual` over equal-length buffers, with a length check first so a short hex string cannot throw. **The SDK export is L18's** — this ticket owns the server function and the vectors that prove the two agree | CTR:HMAC-SHA256 Signing | p.4, p.7 | PF-435, PF-436 |
| PF-439 | ☐ The signer's own unit suite: positive, negative, replay, tamper — named by the PRD | p.11 requires it in those words: *"The signer (HMAC-SHA256 with Stripe-style timestamp) has its own unit test suite — positive, negative, replay, tamper."* One file, four labelled describe blocks, and a test that asserts each block is non-empty so the suite cannot rot into ceremony. Beyond the four: a wrong secret of the correct length fails, a signature with one hex character flipped fails, a body differing by one trailing newline fails, and an empty body signs and verifies (a zero-length payload is not an error case) | CTR:HMAC-SHA256 Signing | p.11 | PF-438 |
| PF-440 | ☐ Subscription matcher — active subscriptions for (workspace, event type), zero matches is not an error | `findActiveByEventType(workspaceId, type)` drives one `DeliveryRequest` per matching subscription: three active subscriptions on `document.created` produce exactly three recorded requests with three distinct `subscription_id`s and three distinct signatures (distinct secrets ⇒ distinct digests over identical bytes). Zero matches produces zero requests, **no throw and no log-level error** — an unsubscribed workspace is the normal case, not a fault. Subscriptions for other event types and other workspaces are asserted absent from the recorded set. This is the `subscription matcher` node p.12 requires the pipeline diagram to show | CTR:Webhook Subscriptions, TS-6 | p.3, p.12 | PF-427, PF-426, PF-393 |
| PF-441 | ☐ The pipeline handler signs and hands off — the API response never waits on a subscriber | **Verified tension with L14:** `InProcessEventBus.publish()` awaits every handler (PF-399) and the publish sits on the request path after commit (PF-404), so an outbound POST performed inside the handler adds the subscriber's latency to `POST /api/v1/documents` and puts a third party inside our +10% regression budget. Acceptance: the bus handler matches, signs, enqueues, and returns; a test with a deliverer that never resolves asserts the HTTP response still returns (bounded, under 200 ms), and a test asserts the recorded `DeliveryRequest` is fully signed at hand-off. p.6's target is *webhook delivery* P95 < 2 s from the event, **not** API latency — conflating them is how both numbers get missed. The queue itself and its first attempt are L16's | TS-6 | p.6, p.11 | PF-440, PF-399, PF-404 |
| PF-442 | ☐ Signature computed **at send time, per attempt**, with the subscription's current secret | The `DeliveryRequest` handed to `IWebhookDeliverer` is built per attempt, not cached at enqueue: attempt 1 and attempt 2 of the same event carry **different** `t` values (advance the `FakeClock` between them) and therefore different `v1` digests, while `rawBody`, `event_id` and the idempotency key are byte-identical across both — the last of which is L14's PF-394 invariant and L16's replay contract. Test asserts all five relations in one pass. `docs/architecture.md:155` states this (*"Signature is computed at send time, per attempt"*); this ticket is what makes it true rather than aspirational, and it is the precondition for PF-443 | CTR:HMAC-SHA256 Signing | p.12 | PF-441, PF-437, PF-394 |
| PF-443 | ☐ Secret rotated mid-flight: the next attempt signs with the new secret | The Failure Modes row p.12 names this scenario by name (*"a subscriber's signing secret is rotated mid-flight"*). Test: queue a delivery, let attempt 1 be signed with secret A, call `POST /:id/rotate` before attempt 2 is built, and assert attempt 2 verifies against secret B and **fails** against secret A. Second assertion: the in-flight event's payload, `event_id` and idempotency key are unchanged by the rotation — rotation changes the signature, never the message. The paragraph that goes in `docs/architecture.md` states the consequence plainly: between rotation and the subscriber updating its environment, every attempt fails verification at the subscriber, and the 30-minute retry tail is the update window | SUB:Architecture Document | p.12 | PF-433, PF-442 |
| PF-444 | ☐ TS-6, server half: subscribe → create a document → exactly one correctly signed request | Integration test on `testDeps()` (PF-016): create a subscription for `document.created` through the public API, `POST /api/v1/documents` with a bearer token, and assert the injected deliverer recorded **exactly one** request whose `targetUrl` matches, whose body parses against L14's `eventEnvelopeSchema` (PF-393) with `data.id` equal to the created document, and whose `Ship-Signature` verifies under PF-438 with the secret returned at creation. Timing assertion is on the **event-to-hand-off** interval against the `FakeClock`, not wall time. This is p.5's first three clauses — *"Create a webhook subscription via the SDK; create a document; verify a signed POST arrives at the target URL within 2s"* — with the SDK client substituted by a direct HTTP call, because the SDK is L18's; the wire delivery is L16's | TS-6 | p.5, p.8 | PF-441, PF-429, PF-412 |
| PF-445 | ☐ TS-6, negative half: a tampered body and a stale timestamp both fail verification | Two assertions against the exact bytes PF-444 captured. **Tamper:** flip one character inside the recorded `rawBody` (a character inside `data.title`, not whitespace) and assert `verifySignature` returns `false` with the original header and the correct secret — p.5's *"tamper with the body and verify the helper rejects it"*. **Replay:** advance the `FakeClock` past 300 s and assert the unmodified body with its unmodified header now returns `false`, and that at 299 s it still returns `true` — the boundary is asserted from both sides. p.4 lists the third case and PF-438 already covers it: *"missing v1 header fails"* | TS-6 | p.4, p.5 | PF-444, PF-438 |
| PF-446 | ☐ Golden signature vectors committed as a fixture — the contract L18 verifies against | `platform/webhooks/__fixtures__/signature-vectors.json` holds ≥ 6 records of `{secret, timestamp, rawBody, expectedHeader}`, including a non-ASCII body, an empty body, and a body containing a literal `,` and `=` (the header's own delimiters). The server suite asserts it reproduces every `expectedHeader` byte-for-byte. **L18's SDK verifier is tested against this same file and must not import server code** — that is what makes p.7's `verifyWebhook` contract checkable across the workspace boundary L01's lint rule enforces, and what stops the two implementations from drifting into agreeing only with themselves. Vectors are generated once and committed; regenerating them on a change is a deliberate act with a diff, not a silent refresh | TS-6 | p.5, p.7 | PF-438, PF-437 |
| PF-447 | ☐ Tolerance window, clock drift, and the pipeline diagram — written down where they are graded | p.13 asks all three in the interview list: *"Show me your webhook signature scheme. Why a timestamp in the header — what attack does it prevent, and what is your tolerance window? What happens if your server's clock drifts?"* Acceptance: `docs/architecture.md` states (a) the attack — capture-and-resend of a valid signed request, which the timestamp inside the signed bytes defeats because it cannot be rewritten without invalidating `v1`; (b) the window — 300 s, chosen as Stripe's default and asserted as the SDK's default in PF-438; (c) drift — a server more than 300 s fast or slow signs payloads every subscriber rejects, the symptom is 100% verification failure across *all* subscribers simultaneously (distinguishable from a per-subscriber secret mismatch), and NTP on the host is the control; and (d) the pipeline figure p.12 requires, marking where the signature is computed. `docs/architecture.md:146` and `:155` already carry (d) and part of (c) — this ticket completes them and is the source for the *"Stripe-style HMAC + timestamp anti-replay"* discovery write-up p.13 names | SUB:Architecture Document | p.12, p.13 | PF-434, PF-438, PF-442 |

## Slices

One branch and one PR per slice, per PRD p.12. Branch name is `pf/L15-<slug>`; the PR body names
the acceptance criterion each slice advances and confirms its fitness test passed.

| Slice | Branch | Tickets | Advances | Fitness test |
|---|---|---|---|---|
| S1 | `pf/L15-subscription-store` | PF-421–427 | *"Per-app per-event-type subscriptions. Target URL, … active flag"* (p.3), with the secret-at-rest contradiction resolved and written down | PF-422 byte-scan finds the raw secret in no column and decryption fails closed; PF-424 log grep finds it in no log line; PF-427 grep asserts one construction site per repo implementation |
| S2 | `pf/L15-webhooks-api` | PF-428–433 | *"Manageable via /api/v1/webhooks (gated by webhooks:manage scope)"* (p.3) | PF-428 all six methods 403 without the scope, naming it; PF-430 cross-app list isolation over a full cursor walk; PF-432 foreign id is 404 on all four verbs |
| S3 | `pf/L15-signer` | PF-434–439 | *"Stripe-style header: Ship-Signature: t=…,v1=…"* (p.3); Pre-Search 2.3 answered (p.16) | PF-439's four-block suite (positive, negative, replay, tamper) with the non-empty-block assertion; PF-436 byte-identity between signed and sent bodies; PF-437 grep asserts no `Date.now()` in the signer |
| S4 | `pf/L15-pipeline-matcher` | PF-440–443 | Matcher → signer wired to the bus; signing at send time per attempt, so rotation mid-flight has a defined outcome (p.12) | PF-441 a never-resolving deliverer does not delay the HTTP response; PF-442 two attempts differ in `t` and `v1` and agree on body and idempotency key; PF-443 attempt 2 verifies under B and fails under A |
| S5 | `pf/L15-ts6-server-half` | PF-444–447 | Testing Scenario 6 (p.5), server half — signed request produced, verified, tampered rejected, replay rejected — plus the L18 contract fixture | PF-444 exactly one schema-valid signed request from a real public write; PF-445 tamper and 300 s boundary asserted from both sides; PF-446 vectors reproduce byte-for-byte |

## Notes for the audit agent

Read the full PRD, not just the pages cited above. Known thin spots and the calls made, so you can
confirm or refute rather than rediscover:

- **The lane's headline: "hashed signing secret" (p.3) is not implementable, and PF-422 breaks with
  the PRD's literal text.** HMAC-SHA256 is symmetric. The server must hold the secret in a form it
  can key an HMAC with on **every attempt** — which p.12's Failure Modes row presumes when it asks
  what happens when a secret is *"rotated mid-flight"*, and which `docs/architecture.md:155` states
  outright. A cryptographic hash is one-way, so "hashed at rest" and "sign every attempt" cannot
  both hold. Four ways out, all of which I considered:
  | Option | Mechanism | Verdict |
  |---|---|---|
  | A. Encrypt at rest (chosen) | AES-256-GCM, key in env, never in the DB | Confidentiality against a DB dump — the realistic leak — without breaking signing. Stripe's and GitHub's model. |
  | B. Plaintext column | Store it as-is | Honest but strictly worse than A at near-zero extra cost. A DB backup leaks every subscriber's secret. |
  | C. Literally hash it, sign with the hash | Store `sha256(secret)`, use *that* as the HMAC key, SDK hashes before verifying | **Security theater.** Whatever the server signs with is the key; an attacker holding the DB forges signatures either way. It also breaks p.7's `verifyWebhook(headers, rawBody, secret)` signature unless the SDK hashes internally — a hidden step in a published contract. |
  | D. Derive, store nothing | `secret = HMAC(master_key, subscription_id ‖ version)`; rotate by bumping version | Genuinely elegant — no secret material in the DB at all — but non-standard, cannot accept a subscriber-supplied secret, and harder to defend than "we do what Stripe does". |
  I shipped **A**. The asymmetry with `client_secret` is the part worth rehearsing before the
  Architecture Defense, because a grader reading p.3 will land on it: `client_secret` is *presented
  back to us* and can therefore be verified by comparing hashes, so hashing costs nothing; the
  webhook secret is *used by us to produce a MAC* and is never presented, so hashing costs
  everything and buys nothing. If the audit prefers B on the grounds that an env-held key alongside
  env-held DB credentials is a thin boundary, the argument is not stupid — but a leaked backup and a
  compromised host are different events with very different frequencies, and A distinguishes them.
  What I would **not** accept is C. **This also belongs in `lane-99-unassigned.md` as a PRD
  contradiction (a third `C`-row alongside C1 and C2), because it is the PRD contradicting itself
  across p.3 and p.12, not a defect in this lane.** I did not file it there myself — the spine says
  auditors file cross-lane findings, and it is squarely inside my own lane's text.
- **PF-434 (what exactly is signed) is our decision, not the PRD's.** p.16's Pre-Search 2.3 asks
  *"the raw request body, the body plus the timestamp, the body plus a versioned scheme tag?"* and
  offers no answer; the PRD's only constraint is the header shape on p.3 and p.7, which is
  compatible with all three. `docs/architecture.md:146` already commits to
  `HMAC-SHA256(secret, t + '.' + rawBody)` and the untracked `signer.ts` sketch implements it, so I
  ratified rather than re-opened. The reasoning is sound (an unauthenticated timestamp is a
  rewritable timestamp, and anti-replay dies with it), but note the doc and the sketch are both
  *ours* — this decision has never been checked against the PRD because the PRD does not contain it.
  The versioned-tag variant is not rejected so much as relocated: `v1=` lives in the header, so a
  future `v2` is additive. If the audit wants the scheme tag inside the signed bytes, that is a
  defensible alternative and the change is local to PF-434/PF-435/PF-446.
- **PF-441 contradicts nothing in L14, but it constrains L14's contract, and L14 does not know it
  yet.** PF-399 makes `publish()` await every handler and PF-404 puts the publish on the request
  path after commit. Both are right for the bus. But the moment this lane subscribes a handler that
  performs network I/O, `POST /api/v1/documents` inherits the subscriber's latency — and p.2's
  regression item (MVP 9, ≤ +10% on P95) is measured on exactly that route. My resolution is that
  the handler signs and enqueues and never awaits the wire. That pushes the async boundary into
  L16's deliverer, which is where p.11's *"in-memory deliverer for unit tests resolves
  synchronously"* sentence lives — note it says *for unit tests*, not in production, and I read it
  that way. If L16 reads it as "synchronous in production too", the two lanes disagree and the
  disagreement is worth settling before either lands.
- **The L15/L16 seam is a judgment call I made unilaterally.** I put `IWebhookDeliverer` (the
  interface, already sketched at `api/src/platform/webhooks/deliverer.ts`) and the
  bus→matcher→signer→hand-off wiring in this lane, because a signer with nothing to hand a signed
  request to cannot be tested end-to-end. L16 gets the HTTP concrete, the retry ladder, the delivery
  log, the DLQ and replay. L16 (PF-451–490) is unwritten, so it may reasonably claim the interface
  instead — if it does, PF-441/PF-442 keep their assertions and only their import path moves. What
  must **not** happen is both lanes defining a `DeliveryRequest`.
- **Nothing in this lane advances the MVP gate, and that is not a gap.** Webhooks appear in none of
  p.2's ten checkboxes. `Advances` therefore carries no `MVP-N` at all: 15 tickets are
  `CTR:Webhook Subscriptions` or `CTR:HMAC-SHA256 Signing` (both are real p.3 Core Technical
  Requirements rows), 6 are `TS-6`, 3 are `SUB:Architecture Document`, 1 is
  `SUB:Pre-Search Document`, and 1 is `CTR:Developer Portal`. **No ticket is `—`** — unusual for a
  plumbing-heavy lane, and worth a skeptical pass. The reason is that p.3's two rows are unusually
  prescriptive (they name the columns and the header format), so work that would be plumbing
  elsewhere is a literal requirement here. If the audit thinks PF-427 (repo interface) or PF-437
  (clock injection) are transitive at best, demoting either to `—` is defensible and I would not
  argue hard.
- **TS-9 also runs through this lane and I deliberately did not claim it.** The TTFE drill (p.5,
  *"receive verified webhook"*) passes through PF-444's exact machinery, but L20 owns that scenario
  end-to-end and L14 made the same call for the same reason. Two lanes both claiming TS-9 makes the
  traceability matrix look denser than the work is. Same for TS-7 and TS-8, which need L16's retry
  ladder and DLQ — this lane touches neither.
- **The 2 s target (p.6) is not asserted against wall time anywhere in this lane, on purpose.** p.6
  says *"Webhook delivery latency (P95, first attempt) <2s"* and p.5's TS-6 says *"within 2s"*. Both
  measure event → arrival at the subscriber, which includes L16's HTTP attempt. Every timing
  assertion here is against a `FakeClock` (p.11's standing rule: *"Timing-based webhook tests are
  flaky tests"*). That means **no ticket in L15 proves the 2 s number** — the honest owner is L16's
  first-attempt path plus L20's drill. If the audit wants a wall-clock assertion somewhere in this
  lane, PF-444 is the place, and I would push back: a sleep-free lane that measures nothing is
  better than a flaky lane that measures the wrong thing.
- **PF-425's SSRF block is mine, not the PRD's.** p.3 says only *"Target URL"*. But an unvalidated
  target turns an authenticated `webhooks:manage` token into a request-forgery primitive against
  anything the API container can reach — including a cloud metadata endpoint — and the delivery log
  L16 builds would faithfully record the response body for the attacker to read. I cited p.3 because
  validating the column the PRD names is implementing it, not extending it. If the audit disagrees
  with the citation, the ticket stands on its own and the PRD column can go to `—`.
- **The untracked sketches are spikes.** `signer.ts` (~60 lines) implements roughly PF-434, PF-435
  and PF-438 — correctly, as far as I can tell, including `timingSafeEqual`, the length guard and
  the symmetric `Math.abs` tolerance — but it has **zero tests**, takes `nowSeconds` as a parameter
  with no `Clock` (PF-437), and nothing constructs or calls it. `deliverer.ts` and `retry.ts` are
  L16's territory and are equally unwired. There is no subscription table, no repo, no route, and no
  bus subscription anywhere in the repo. Do not mark PF-434/435/438 done because `signer.ts` exists.
- **PF-421's FK to `oauth_apps` depends on a table L02 has not shipped and whose lane file is not
  written.** `api/src/db/schema.sql` has no `oauth_apps` (verified). The `app_id` column and its
  foreign key land with L02's migration or with PF-421's, whichever runs second — the migration
  block PF-021 reserves is shared and the ordering needs to be settled between the two lanes. I
  referenced L02 in prose only rather than citing ticket IDs from an unwritten file.
- **Not covered here, on purpose:** the HTTP deliverer and its timeout policy, the retry schedule
  and its jitter, 4xx-permanent vs 5xx-transient classification, the `webhook_deliveries` log, the
  DLQ, `/api/v1/webhooks/deliveries/:id/replay` and the `Idempotency-Key` passthrough (all p.4, all
  L16); the SDK's exported `verifyWebhook` and its `< 1 ms per call` budget (p.8, L18); the portal's
  subscription management and delivery-log views (p.4, L22); the OpenAPI `webhooks` section
  generated from `eventPayloadSchemas` (L13); and the fanout question p.15 asks (*"one
  document.created can produce N deliveries"*) which is a cost-analysis input for L26 and a capacity
  question for L16, not a signing question. If any of those is unowned at audit time it goes to
  `lane-99-unassigned.md`, not into this file.
- Cross-lane findings go to `lane-99-unassigned.md`, not into this file.

## Acceptance evidence

Landed slices, with the test that proves each ticket. Every run is
`pnpm --filter @ship/api test` against a lane-private database (`ship_l15`), after the
three builds F47 requires (`build:shared`, `@ship/agent`, `@ship/sdk`).

### S1 · `pf/L15-subscription-store` — PF-421 – PF-427

| Ticket | Proof |
|---|---|
| PF-421 | `subscriptionRepo.test.ts` → "schema facts only Postgres can answer": no CHECK on `event_type`, an unregistered type is accepted by the DB and rejected by the route, the deactivation-coherence CHECK fires, `app_id` CASCADEs, `user_id` SET NULLs. `subscriptionFitness.test.ts` → `assertKeysetIndexed('webhook_subscriptions')` returns no problems and both keyset columns are NOT NULL. Migration `047_webhook_subscriptions.sql`, from L15's reserved block |
| PF-422 | `secretCipher.test.ts` — 15 cases: round-trip; plaintext absent from the ciphertext *and* from its decoded bytes; 50 encryptions of one plaintext yield 50 ciphertexts (nonce freshness); throws on wrong key, tampered body, tampered tag, short payload, wrong key length, absent env var. `subscriptionSecretLeak.test.ts` → byte scan over a real `SELECT *`, every column coerced to bytes, zero hits for the secret or its untagged body |
| PF-423 | `signingSecret.test.ts` — 10 000 generations, 10 000 distinct; ≥ 256 bits; length pinned; base64url only (no `+`, `/`, `=`); prefix is 8 characters taken after the tag |
| PF-424 | `subscriptionRepo.test.ts` → the row type has no `signing_secret` and no `secret_ciphertext` property, on create and on read, for both implementations. `subscriptionSecretLeak.test.ts` → create → list → get → match → rotate under captured `console.*`, zero occurrences of either secret or either untagged body. **(a) — the `.strict()` response schema — lands with the routes in S2** |
| PF-425 | `targetUrl.test.ts` — 5 accepted shapes, 8 rejected by scheme/credentials/relativity, 18 rejected as private (including `169.254.169.254`, CGNAT, IPv4-mapped IPv6 in both spellings), the 172.16/12 edges pinned from outside, and the `NODE_ENV=test` exception asserted to cover the loopback only and not plaintext generally |
| PF-426 | `subscriptionRepo.test.ts` → an inactive subscription is not a match; the row survives deactivation so L16 keeps a resolvable FK; reactivation resumes matching with **no backfill**, asserted; `deactivate` is idempotent and the second call does not move `deactivated_at` |
| PF-427 | `subscriptionFitness.test.ts` → `new PgWebhookSubscriptionRepo(` and `new InMemoryWebhookSubscriptionRepo(` appear in `deps.ts` and nowhere else under `src/` (comment-stripped scan); `subscriptions.ts` imports no `express`, no `pg`, no `node:http`, and imports in a bare Node context. The full contract suite runs against **both** implementations via `describe.each` |

**Two defects found and fixed while writing PF-425's table**, both of which would have
shipped a check that looked right and blocked nothing:

- `new URL()` normalises `[::ffff:10.0.0.1]` to `[::ffff:a00:1]`, so the dotted-quad-only
  IPv4-mapped branch never matched. Both spellings are now asserted.
- `file:///etc/passwd` was reported as `no-host` because the host check ran before the
  scheme check — telling a caller to add a host rather than to stop using `file:`.

### S2 · `pf/L15-webhooks-api` — PF-428 – PF-433

47 cases in `api/src/platform/api/v1/webhooks/webhooks.routes.test.ts`, over the REAL
bearer middleware (`createBearerTestApp`), two apps on ONE server so cross-app isolation
is observable at all.

| Ticket | Proof |
|---|---|
| PF-428 | `WEBHOOK_ROUTES` is data and has exactly six entries; a table-driven case drives **each** of the six with a token holding `documents:read`/`documents:write` and asserts 403 with `details.missing_scope === 'webhooks:manage'`. Plus: the scope check fires **before** the id lookup (otherwise the 403/404 split leaks existence to a caller with no scope), and no token at all is 401 rather than 403 |
| PF-429 | 201 + `Location`; body parses against `webhookSubscriptionWithSecretSchema`; `signing_secret` present here and absent from get/list/patch bodies (asserted by string search AND by `.strict()` parse); an unregistered event type is 422 whose message contains all eight registered names, produced by `assertEventType` rather than a restated list; a foreign `app_id` is **rejected**, not ignored, and no row is created; all six `REJECTED_CREATE_FIELDS` named individually; four bad `target_url` shapes named on the field; duplicate triple is 422 not 500; two apps may share a target |
| PF-430 | A full cursor walk at `limit=2` by app A returns exactly A's three ids, no repeats, and none of B's three; every page parses `pageSchema(webhookSubscriptionSchema)`; `next_cursor` is **present and null** on the last page (`'next_cursor' in body`, not `== null`); an empty list is `{data: [], next_cursor: null}`; `?offset=` is 422; a cursor minted for `documents` is rejected here (PF-218 binding) |
| PF-431 | GET returns the row without the secret; PATCH `{active:false}` sets `deactivated_at` and `{active:true}` clears it; PATCH of `event` or `target_url` is 422 whose message says **immutable** rather than "unknown field"; DELETE returns 200, is idempotent with an unchanged `deactivated_at`, and the row is still GETtable afterwards |
| PF-432 | All **four** verbs (`GET`, `PATCH`, `DELETE`, `POST /rotate`) against app A's id as app B → 404 `not_found` with **no `details`**; app A's row is still `active` afterwards, so the attempt had no effect either; three malformed id shapes → 422 `validation_failed`; a well-formed unknown UUID → 404 |
| PF-433 | New secret ≠ old, `secret_version` 1→2, `secret_prefix` recomputed; the matcher immediately hands the signer the NEW secret and not the old one; rotating twice yields three distinct secrets and version 3 |

**Deviation from PF-429's literal text, stated:** the create response is the full
subscription representation **plus** `signing_secret`, not the six named fields. Two
shapes for one resource is the drift D7 rejected for payloads, and a consumer that stores
the create response can pass it anywhere a subscription is expected. p.7's drill reads
only `sub.signing_secret`, which is present.

**PF-425's private-host rejection is NOT asserted at the route layer, on purpose.** The
suite runs under `NODE_ENV=test`, where PF-425's named exception permits loopback targets
— TS-6 and the TTFE drill both point at a local listener. The route test asserts the
exception's POSITIVE half (a loopback target IS accepted, and `NODE_ENV` is checked so the
claim cannot rot) and leaves the rejection to `targetUrl.test.ts`, which passes an explicit
non-test environment. Asserting it at the route would require the route to disagree with
its own environment. Consequence for the demo recording is B8.
