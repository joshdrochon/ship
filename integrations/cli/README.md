# `ship` — the reference CLI

The proof that Ship's public API is usable by someone who is not us.

This package imports **`@ship/sdk` and nothing else**. It has no database
credential, no access to `api/src/`, and no privileged path of any kind — it is
a third-party integration that happens to live in the same repository. That
constraint is enforced by ESLint (PRD p.11), by a workspace-dependency check,
and by a grep over `src/**` in `tests/boundary.test.ts`. If a command here needs
something the SDK cannot do, that is an SDK gap and it gets fixed in the SDK.

---

## One-command setup (PF-580)

From a clean clone — this is the whole of it:

```bash
pnpm cli:setup
```

That is one script in the root `package.json`, and it installs only what the CLI
needs (`@ship/sdk` and this package — not the API, not the web app) and builds
them. `tests/server/readmeSetup.test.ts` reads the line above **out of this
README** and executes it in a clean checkout, so the command in this block
cannot rot without the suite failing.

Then authenticate and smoke-test against the **deployed** instance:

```bash
node integrations/cli/dist/index.js login \
  --base-url https://d258p92d3n1ebe.cloudfront.net \
  --client-id ship_app_grader_readonly
node integrations/cli/dist/index.js docs ls
```

`--base-url` is passed **once**, on `login`, and persisted — that is why the
second line needs no flag. It is shown explicitly here because an explicit
instance is clearer than an implicit one, not because the default is wrong:
the SDK's `DEFAULT_BASE_URL` now points at this deployment
(`https://d258p92d3n1ebe.cloudfront.net`), so `ship login` with no flags
resolves to the same place. It previously pointed at Part 1's host
(`https://ship.awsdev.treasury.gov`), which answers `403` to an anonymous
`/api/v1` request — that was L99 finding F172 and it is fixed.

`SHIP_BASE_URL` in the environment sits between the two: explicit `--base-url`
wins, then `SHIP_BASE_URL`, then the default. Note that `SHIP_API_URL`, which
appears in the repository README's curl examples, is **not** read by the CLI.

`login` prints a code and a URL; open the URL, paste the code, approve. The
instance and the app are saved to `~/.ship/config.json`, so **no later command
needs a flag**. The credential itself is `~/.ship/credentials.json` at mode
`0600`.

Both commands take the published instance by default. Point them somewhere else
with `--base-url <url>` on `login` (it is persisted) or `SHIP_BASE_URL` in the
environment.

**What the test proves, and what it does not.** `readmeSetup.test.ts` copies
this repository's tracked files into an empty directory — no `node_modules`, no
`dist` — runs the command above verbatim, and reaches an authenticated
`docs ls`. It runs on the host against whatever `SHIP_TEST_BASE_URL` points at,
**not** inside a container and **not** against the deployed instance, because
this lane has no reachable deployed PlugForge instance to point at. PF-580 asks
for both; that half is open, not quietly claimed.

### The pre-registered apps

`client_id` is not a secret — it is compiled into every public client on the
planet by design. These are seeded by `db:migrate`, so they provably exist in
every deployed environment.

| `client_id` | Scopes | What it is for |
| --- | --- | --- |
| `ship_app_grader_readonly` | `documents:read`, `issues:read`, `sprints:read` | **The grader's app.** Read-only, per MVP gate item 10 (p.2). |
| `ship_app_grader_demo` | `documents:read`, `documents:write`, `webhooks:manage` | The app p.6's five-line story runs as. Needed because the grader's app cannot write, and therefore cannot run the headline command. |

Both are **public clients** (RFC 6749 §2.1) — a CLI on a stranger's laptop has
nowhere to keep a secret, so it redeems its grant with `client_id` alone. A
human still has to approve the device code in a browser; `client_id` alone
starts a flow, it does not finish one.

> The documented smoke command is `docs ls`, **not** `docs create`. The grader's
> app is read-only on purpose. To reproduce the demo, use
> `--client-id ship_app_grader_demo`.

---

## The five-line story (PRD p.6)

```
$ ship login                             # device flow
$ ship docs create --title "hello"
$ ship webhooks tail                     # streams signed deliveries
→ document.created event arrives, signature verified ✓
```

`ship webhooks tail` needs a **local** Ship — see the next section for why, and
`docs/l19-five-line-story.md` for a verbatim transcript of it running.

---

## Decision — argv parsing is hand-rolled, not `commander` (PF-557)

p.10's Technical Stack row reads *"CLI in Node + commander or oclif"*, and the
sketch adds *"plain argv parsing is acceptable for the week."* Three defensible
answers; this package takes the third, and the reason is a boundary, not taste.

L01's `ALLOWED_INTEGRATION_DEPS` is a **one-element set**: `@ship/sdk`. It is
the mechanical form of p.11's Critical Guidance, and it is what makes "the SDK
is the front door" checkable instead of asserted — the CLI's dependency list is
the one place a stray `axios` or `node-fetch` would prove otherwise. Adding
`commander` means widening another lane's fitness check to admit a second name,
and once the set has two entries the argument for a third is easier than the
argument for the second was.

What that check buys is worth more than what `commander` saves. `src/argv.ts` is
~90 lines with no dependency and no surprises; the `--help` text (`src/usage.ts`)
is hand-written either way, because p.8's command menu and the demo both read
off it and a generated one drifts from the menu.

**What would change this:** subcommand nesting deeper than `group sub`, or
shell-completion generation. Neither is in scope for this week.

Cost, recorded honestly: no completions, no `did you mean …?`, and every new
flag is a line in `parseArgv`. Accepted.

---

## Decision — how a signed delivery reaches a laptop (PF-573)

p.6 promises *"streams signed deliveries to stdout"* and p.11 calls it *"the
demo moment"*. But a webhook is an **inbound POST** and a laptop has no public
address. Four options were on the table:

| Option | Verdict |
| --- | --- |
| **Loopback listener** — bind `127.0.0.1:<ephemeral>`, subscribe to it | **Chosen, and the default.** The only mode that produces what p.13's screenshot claims: an event *arriving*. Requires that Ship can reach the laptop. |
| **Long-poll the delivery log** — `GET /api/v1/webhooks/deliveries` | **Chosen as the fallback,** behind `--poll`. Works against a deployed instance that cannot reach you, and is honest about being a log tail. |
| Public tunnel (ngrok, cloudflared) | **No.** A third-party account and an outage vector inside a graded demo and every CI run. |
| Ship-hosted relay (WebSocket/SSE) | **No.** Nicer product; an entire new public surface the PRD never asks for. |

### `--listen` (default)

Binds an ephemeral loopback port, creates a `document.created` subscription
pointed at it, holds the returned `signing_secret` **in memory only** (the SDK
returns it exactly once), and verifies the signature on a POST that genuinely
arrived. On `SIGINT`/`SIGTERM` it deletes the subscription it created. A crash
leaves at most one orphan; `ship webhooks tail --cleanup` removes subscriptions
this CLI created and abandoned, identified by the `/ship-cli-tail` marker it set
itself — never by deleting subscriptions it did not create.

**Reachability constraint, and the flag it needs.** A loopback `target_url` is
refused by the platform's SSRF check, which is correct: an unvalidated
`target_url` turns a `webhooks:manage` token into a request-forgery primitive
against anything reachable from the API container. So a local instance has to
**opt in**:

```bash
SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS=true pnpm dev:api
```

Default-off, and off by *absence* — only the exact string `true` enables it. The
deployed instance never sets it and therefore provably rejects a loopback target
regardless of `NODE_ENV`. The variable is spelled in exactly one place in the
source (`api/src/platform/webhooks/targetUrl.ts`), and a test asserts that.

### `--poll`

Long-polls page 1 of the delivery log and de-duplicates on delivery id. Use it
against a deployed instance that cannot reach you.

It prints `signature not verifiable in poll mode` and **never** the checkmark.
That is deliberate: the delivery log persists the `Ship-Signature` header but
deliberately does not expose the signed `raw_body`, and without the body there
is nothing to verify a digest against. Printing `✓` there would put an unearned
checkmark in the one artifact that is graded on it.

---

## Commands

```
ship login                       Authenticate via the OAuth device flow
ship docs ls [--limit n] [--all] List documents
ship docs get <id>               Show one document
ship docs create --title <t>     Create a document
ship webhooks tail [--listen|--poll] [--cleanup] [--exit-on-invalid]
```

Global: `--base-url <url>`, `--client-id <id>`, `--json`, `--help`.

**Base URL resolution**, highest first: `--base-url` → `SHIP_BASE_URL` → the
instance saved at login → the SDK's published default. The CLI computes no URL
of its own; a grep finds no `/api/v1` literal in `src/**`.

**`--json`** puts exactly one JSON value on stdout and every human word on
stderr, so `ship docs ls --json | jq .` parses. `webhooks tail --json` is
newline-delimited, because it streams.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | unexpected |
| 2 | usage |
| 3 | auth required — run `ship login` |
| 4 | rate limited |
| 5 | signature verification failed (`--exit-on-invalid`) |

---

## Tests

Three suites, deliberately separate.

```bash
pnpm --filter @ship/cli test          # fast: argv, exit codes, boundary, golden output
pnpm --filter @ship/cli test:server   # the real binary against a real booted Ship
pnpm drill ttfe                       # L20's TTFE drill — see below
```

The fast suite runs anywhere, with no database and no server — it is what a
contributor runs. It cannot tell you whether the CLI works.

### Running the server-backed suite

It needs a booted Ship and that instance's database. Nothing is skipped when
they are absent; the suite fails loudly, because a suite that silently passes
having run nothing is exactly how a green board can mean nothing was ever
executed.

```bash
# 1. a database
createdb ship_l19b   # or: docker exec ship-test-pg psql -U ship -d postgres -c 'CREATE DATABASE ship_l19b;'
DATABASE_URL=postgresql://ship:ship_dev_password@localhost:5432/ship_l19b \
WEBHOOK_SECRET_KEY=$(head -c 32 /dev/urandom | base64) \
AGENT_CLIENT_SECRET=dev GRADER_CLIENT_SECRET=dev DEMO_CLIENT_SECRET=dev \
  pnpm --filter @ship/api db:migrate

# 2. a server — note both opt-ins
cd api && DATABASE_URL=... WEBHOOK_SECRET_KEY=... PORT=3919 \
  APP_BASE_URL=http://localhost:3919 \
  SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS=true \
  npx tsx src/index.ts

# 3. the suite
pnpm build:shared && pnpm --filter @ship/sdk build && pnpm --filter @ship/cli build
SHIP_TEST_BASE_URL=http://localhost:3919 DATABASE_URL=... \
  pnpm --filter @ship/cli test:server
```

`WEBHOOK_SECRET_KEY` must be a 32-byte base64 value or `webhooks.create`
returns 500.

**Approving the device code without a human.** The suite spawns
`scripts/l19-device-approve.ts`, which opens a Ship session and drives the two
consent POSTs a browser would send. It lives outside `integrations/` and runs as
a **subprocess**, because it needs `DATABASE_URL` and this package may not have
one. It does not touch `oauth_device_codes` directly — flipping the row would
make the test green while proving nothing about `/oauth/device/verify`, which is
the surface Testing Scenario 3 is actually about.

### The TTFE drill (L20)

`tests/ttfe.drill.ts` lives in this package because p.7 puts it here, but it is
**L20's file, not this lane's**. It needs no setup at all — no database, no
server, no `pnpm dev`:

```bash
pnpm drill ttfe              # the loop; refuses to start if DATABASE_URL is set
pnpm drill ttfe --controls   # the negative controls
```

It provisions its own throwaway Postgres, applies the migrations, boots
`api/src/index.ts` on a free port and destroys all of it afterwards. The part
that concerns *this* package: the drill's second test drives the same loop
through `runLogin` / `runDocsCreate` / `runWebhooksTail` from `src/public.ts`
(PF-581) with an injected sink, so a change to a command's contract fails the
drill rather than drifting away from the demo unnoticed. Full detail in
`docs/ttfe-drill.md`.
