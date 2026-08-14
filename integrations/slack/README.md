# Ship → Slack

PRD p.8, option 2 of the seven — the only one after the CLI that the PRD marks
`should-ship`. PF-739 – PF-744.

An Express process that installs into a Slack workspace via Slack OAuth, receives
signed webhook deliveries from Ship, verifies them over the raw body, and posts
two event types into a channel. It is the only integration in this repo that is a
**genuinely external process consuming signed deliveries**, which is why it was
chosen (p.8) and why it is worth its cost.

```
pnpm --filter @ship/slack test        # the listener, against a stubbed Slack
pnpm slack:live                       # PF-743 — the whole path, against a booted Ship
pnpm --filter @ship/slack build && pnpm --filter @ship/slack start
```

## Configuration — all of it, or it does not boot

| Variable | What it is |
|---|---|
| `SLACK_CLIENT_ID` | The Slack app's id, used to build the install URL |
| `SLACK_CLIENT_SECRET` | Exchanged for a bot token at `/slack/oauth/callback` |
| `SLACK_SIGNING_SECRET` | Slack's own request signing secret |
| `SHIP_CLIENT_ID` | The Ship OAuth app this listener is |
| `SHIP_CLIENT_SECRET` | Its secret |
| `SHIP_BASE_URL` | Where "Open in Ship" points |
| `SHIP_WEBHOOK_SIGNING_SECRET` | The subscription's signing secret, shown once by `webhooks.create` |

Optional: `PORT`, `SLACK_CHANNEL`, `SLACK_INTEGRATION_PUBLIC_URL`, `SLACK_API_URL`.

A missing variable fails **at boot**, naming every one that is missing, with exit
code 78. Not at the first delivery: a listener that starts and then silently
drops signed deliveries is the worst failure available during a graded demo, and
it is the same shape L99 F91 records against `WEBHOOK_SECRET_KEY` on the server
side — resolved lazily, so the deployment boots green and 500s three layers from
the cause.

There is no `SLACK_BOT_TOKEN`. PF-740 rules it out: p.8 names Slack OAuth as part
of what this integration *is*, and a pasted token proves neither the install flow
nor the multi-workspace shape.

## The raw body is the whole point

The classic bug here is an app-wide `express.json()`. The handler then holds an
**object**, re-serialises it to verify, and computes an HMAC over bytes the
server never signed — different key order, different whitespace, different
unicode escapes. Every legitimate delivery is rejected, and the integration looks
broken end to end while each half looks correct in isolation.

So `express.raw()` is mounted on the delivery route and on nothing else, there is
no app-level parser, and `listener.test.ts` asserts that structurally rather than
trusting a comment.

Order of operations, and each step earns its position:

1. **verify** the Ship signature over the raw bytes — nothing runs before this
2. **parse** — only now are the bytes worth trusting
3. **filter** the event type — `document.created` and `issue.assigned`, nothing else
4. **post** to Slack
5. **classify** Slack's failure onto Ship's retry contract

A listener that parses first is one an unauthenticated caller can make do work; a
listener that filters first has already trusted the `type` field of an unverified
payload.

## What a message says — ours, and marked as such

The PRD never says what a Slack message should contain. p.8 names the two event
types and nothing else, so the format below is a judgement call rather than a
requirement:

```
New document in Ship: *Quarterly plan*
<https://ship.example/documents/doc_42|Open in Ship>
```

**The title appears only when the payload carries one.** L14's decision D7
settled the payload as the resource's public API representation and L15 gates
private documents at the matcher — so an absent `title` is a deliberate omission
by the platform, not a gap for the subscriber to fill. The renderer degrades to
id-and-link and never fetches the document to recover it. Doing that would use
this listener's own token to read around a decision the platform already made.

## PF-744 — how Slack's failures map onto Ship's retry contract

**A decision, and it is ours.** Pre-Search 2.3 (p.16) asks the question from the
platform's side and L16 answered it there (D9). This is the subscriber's side of
the same answer, and it is the only place in the plan where a real subscriber
makes the call — because only this process can tell a transient Slack outage from
a permanent misconfiguration. To Ship both look like "the subscriber errored".

| Slack says | This listener answers | Why |
|---|---|---|
| 5xx, or a network error | **502** | Retry on the ladder |
| `ratelimited` | **502** | Being rate-limited *by* Slack is the one failure a sender must not be dead-lettered for — D9's own example, from the other side |
| `channel_not_found`, `not_in_channel`, `is_archived`, `invalid_auth`, `account_inactive`, `token_revoked` | **422** | A human has to fix it; six attempts cannot |
| anything unrecognised | **502** | The two mistakes are not symmetric: retrying something permanent costs six attempts, dead-lettering something transient loses the message |

A signature that does not verify is **401** and not 422, so a developer reading
the delivery log is sent to the right half of the problem.

It stays correct under either resolution of D9, because it chooses which status
to *return* rather than how to interpret one.

## Deviation from PF-739's literal wording

The ticket says "Express + `@slack/bolt`", following p.10's stack table. This
ships **Express + `@slack/web-api`**, and the reason was measured rather than
assumed.

Bolt is a framework for apps that *receive* from Slack — events, slash commands,
interactivity, socket mode. This integration receives from **Ship** and only
*sends* to Slack: two calls, `chat.postMessage` and `oauth.v2.access`. And
`@slack/bolt@5` does not re-export `WebClient` at all (`tsc` says so, TS2614), so
using Bolt would mean either declaring it *and* `@slack/web-api` — a phantom
dependency, which is exactly what PF-716's manifest check exists to catch — or
standing up an `App` + `ExpressReceiver` whose entire receiving half is dead code.

`@slack/web-api` is the Slack-published client Bolt itself depends on for this
call. Filed as L99 **F153** so the swap is a decision on the record rather than a
quiet substitution.

## What is not proven here

The listener has no public URL. Every test in this package runs against
`127.0.0.1`, and `pnpm slack:live` runs against a locally booted Ship. **Nothing
in this repo verifies that a deployed Ship can reach a deployed listener**, and
that is L99 **U6** — the single largest execution risk in this slice. It is a
hosting question owned by L21/L26, not by this package.
