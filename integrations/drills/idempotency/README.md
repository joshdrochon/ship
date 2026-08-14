# Idempotency-Key drill — and the subscriber contract

PRD p.8, option 6 of the seven integrations. PF-728 – PF-732.
Pre-Search 2.3 (p.16) asks for this document by name.

```
pnpm drill:idempotency
```

One command. It boots a Ship with `SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS=true`
(PF-575's named, default-off opt-in — a subscription target of `127.0.0.1` is
otherwise refused, and rightly), runs the drill, and tears down.

## The contract a subscriber has to implement

This is the part the platform cannot do for you. Ship passes an
`Idempotency-Key` through; deduping on it is the subscriber's job, and getting
it wrong is silent.

| | |
|---|---|
| **Header** | `Idempotency-Key`, on every delivery, every attempt and every replay. Read case-insensitively. |
| **Value** | Opaque. Today it is `<event_id>:<subscription_id>`, but treat it as a string — the shape is not part of the contract and matching on it is how a subscriber breaks on the next release. |
| **Lifetime** | As long as the side effect is observable. The reference subscriber here keeps keys for the life of the process, which is right for a drill and wrong for production: persist the key **beside the side effect, in the same transaction**, or a crash between the two re-runs the work on the retry. |
| **Duplicate** | **200**, and the side effect does not run again. |
| **Failure** | Do **not** record the key on a 5xx. A failed attempt that remembers its key turns Ship's retry into a no-op, and the work never happens. |
| **Order** | Verify the signature **first**, over the raw bytes, before touching the key. |

### Why 200 on a duplicate, and not 409

A duplicate is the sender doing exactly what it promised — retrying something it
is not sure landed. The answer has to mean *you can stop now*, and under L16's
`classifyDeliveryOutcome` (decision D9) a 409 is a permanent 4xx: the delivery
would **dead-letter**, so the platform would record a failure for the one case
where the subscriber did everything right.

### Why verification comes before dedupe

A subscriber that dedupes first lets an unauthenticated caller poison its key
store. Send a forged request carrying a guessed key, and the genuine delivery
that follows is swallowed as a duplicate — silently, and forever.
`contract.test.ts` asserts this ordering with a forgery followed by the real
thing.

### Why a 5xx must not commit the key

The ordering that separates *deduping* from *dropping*. If a failed attempt
recorded its key, the retry Ship is about to send would be answered "seen that",
and the work would never happen. Asserted directly: three attempts, 500, 500,
200 → one side effect, and it is the third attempt that performs it.

## What the drill proves, and from where

Every assertion is made from the **subscriber's** side. The delivery log is the
platform's own account of what it believes it sent; this drill checks that
account against what arrived on the wire. Testing Scenario 8 (p.5) asserts the
replayed key from the developer portal — that is L16's and L22's half. This is
the far end.

| Ticket | Assertion |
|---|---|
| PF-728 | Subscription created through `client.webhooks.create`; deliveries land at PF-721's listener over real HTTP; the signature verifies over the raw bytes. A test greps this package for `webhook_deliveries` and for any import that is not `@ship/sdk`, the testkit fixture or a node builtin. |
| PF-729 | Two POSTs with one key → one side effect, two 200s. |
| PF-730 | Deliver, dead-letter, replay through `/api/v1/webhooks/deliveries/:id/replay`, assert the replayed request's key **string-equals** the first. |
| PF-731 | 500·500·500·200 across Ship's real ladder → four **identical** keys, one side effect. |
| PF-732 | Two documents → two **different** keys, two side effects. |

### PF-730 dead-letters with a 410, not by exhausting the ladder

A permanent 4xx dead-letters immediately (L16's classifier, D9). Exhausting six
attempts would take 1 + 4 + 16 + 60 + 300 = **381 seconds**, and this ticket is
about the replayed key rather than about the schedule. The 410 also makes the
assertion sharper: no side effect ever committed, so if the replay's key had
been forgotten the count would go to two, and it does not.

### PF-731 rides the real ladder and still does not sleep

Attempts 2, 3 and 4 arrive 1 s, 4 s and 16 s apart — the server's own schedule
(p.4), not the drill's. The drill waits on the **arrival of the fourth request**,
which is an event; `waitFor`'s `timeoutMs` can only ever reject. p.11 forbids
sleeping *for* an outcome; bounding one that never came is the opposite.

### Why PF-732 is the one that catches a constant key

A platform that emits the same key for every event passes PF-729, PF-730 and
PF-731 and fails only here. It pairs with L14's rule that `event.id` is the sole
idempotency basis, so the key's provenance is one hop rather than a coincidence —
the drill asserts the two side effects name two different `event.id`s.
