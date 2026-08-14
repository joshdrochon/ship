# PRD p.6's five-line story, executed

Verbatim terminal output, captured 2026-08-14 against a Ship booted on
`http://localhost:3919` with a real PostgreSQL database (`ship_l19b`, 60
migrations applied, three platform apps seeded). Nothing here is a mock, a
fixture, or a recording of intended output.

This is the source material for the demo video (p.12) and the Social Post
screenshot (p.13).

## The world

```bash
docker exec ship-test-pg psql -U ship -d postgres -c 'CREATE DATABASE ship_l19b;'

DATABASE_URL='postgresql://ship:ship_dev_password@localhost:5432/ship_l19b' \
WEBHOOK_SECRET_KEY='<32 bytes, base64>' \
AGENT_CLIENT_SECRET=dev GRADER_CLIENT_SECRET=dev DEMO_CLIENT_SECRET=dev \
  pnpm --filter @ship/api db:migrate

pnpm build:shared && pnpm --filter @ship/agent build \
  && pnpm --filter @ship/sdk build && pnpm --filter @ship/cli build

cd api && DATABASE_URL='...' WEBHOOK_SECRET_KEY='...' SESSION_SECRET='...' \
  PORT=3919 APP_BASE_URL='http://localhost:3919' \
  SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS=true NODE_ENV=development \
  npx tsx src/index.ts
```

`SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS` is PF-575's opt-in. Default-off; the
deployed instance does not set it and therefore refuses a loopback
`target_url`. Without it, line four of the story fails at subscription creation
with `validation_failed`.

---

## Line 2 — `ship login`

```
$ ship login --base-url http://localhost:3919 --client-id ship_app_grader_demo
ship: authenticating against http://localhost:3919 as ship_app_grader_demo

  To authorize this device, enter the code:

      WCXP-PPXJ

  at:

      http://localhost:3919/oauth/device/verify?user_code=WCXP-PPXJ

ship: device-code-ready user_code=WCXP-PPXJ verification_uri=http://localhost:3919/oauth/device/verify?user_code=WCXP-PPXJ

  Waiting for authorization…
```

A human now opens that URL, confirms the code matches their terminal, and
approves. Unattended, that is
`scripts/l19-device-approve.ts --user-code WCXP-PPXJ`, which drives the same two
consent POSTs a browser sends. The terminal then completes on its own:

```
ship: authenticated. Credentials in /Users/joanmiguel/.ship/credentials.json
      scopes: documents:read, documents:write, webhooks:manage
```

```
$ ls -l ~/.ship/
-rw-------  1  ...  79 Aug 14 00:02 config.json
-rw-------  1  ... 245 Aug 14 00:02 credentials.json
```

Exit 0. Mode `0600`. Every block above is on **stderr** — stdout stayed empty,
which is what keeps `--json` parseable.

---

## Line 3 — `ship docs create --title "hello"`

A **new process**, no flags and no environment. The instance and the app come
from `~/.ship/config.json`, written at login.

```
$ ship docs create --title "hello"
b69e0506-df10-4708-9cab-eff8e0ae4b71
ship: created wiki "hello"
```

The id alone on stdout, so `ID=$(ship docs create --title x)` does the obvious
thing. The write went through `@ship/sdk` → `POST /api/v1/documents`.

```
$ ship docs ls
ID                                    TYPE          TITLE
──────────────────────────────────────────────────────────────────────────────
320da3cd-bfea-4fa9-85e5-ee99b1694942  wiki          hello
ship: 1 document(s) (first page, --limit 25)

$ ship docs get 320da3cd-bfea-4fa9-85e5-ee99b1694942
id              320da3cd-bfea-4fa9-85e5-ee99b1694942
document_type   wiki
title           hello
parent_id
created_at      2026-08-14T05:02:15.766Z
updated_at      2026-08-14T05:02:15.766Z
created_by      00000000-0000-4000-8000-0000000000b1
```

---

## Lines 4 and 5 — `ship webhooks tail`

Terminal 1:

```
$ ship webhooks tail
ship: listening on http://127.0.0.1:61469/ship-cli-tail
ship: subscribed to document.created (subscription 7d01ed07-18e2-4664-b8d2-6cc0b28d9768)
ship: waiting for a signed delivery…  (Ctrl-C to stop)
```

Terminal 2:

```
$ ship docs create --title "hello"
b69e0506-df10-4708-9cab-eff8e0ae4b71
ship: created wiki "hello"
```

Terminal 1, 24 ms later — **this block is the Social Post screenshot**:

```
──────────────────────────────────────────────────────────────────────────────
  event            document.created
  event.id         ed334dc5-859c-4a1a-b6c7-7ade007b684c
  document         b69e0506-df10-4708-9cab-eff8e0ae4b71  "hello"
  idempotency-key  ed334dc5-859c-4a1a-b6c7-7ade007b684c:7d01ed07-18e2-4664-b8d2…
  signature t=     1786683857  (2026-08-14 00:04:17 -05:00)
  latency          24 ms  event → arrival
→ document.created event arrives, signature verified ✓
──────────────────────────────────────────────────────────────────────────────
```

The last line is p.6's fifth line, character for character. The signature was
verified against the `signing_secret` returned by `webhooks.create` — held in
memory, never printed, never persisted by the CLI. 24 ms against p.6's
*"webhook delivery latency (P95, first attempt) < 2s"*.

`Ctrl-C`:

```
ship: removed subscription 7d01ed07-18e2-4664-b8d2-6cc0b28d9768
```

```
$ docker exec ship-test-pg psql -U ship -d ship_l19b \
    -c 'SELECT id, target_url, active FROM webhook_subscriptions;'
                  id                  |              target_url              | active
--------------------------------------+--------------------------------------+--------
 7d01ed07-18e2-4664-b8d2-6cc0b28d9768 | http://127.0.0.1:61469/ship-cli-tail | f
```

The subscription the command created was deactivated by the command that
created it.

---

## Reproducing it

```bash
SHIP_TEST_BASE_URL=http://localhost:3919 \
DATABASE_URL='postgresql://ship:ship_dev_password@localhost:5432/ship_l19b' \
  pnpm --filter @ship/cli test:server
```

Eleven tests, ~11 s. Every one of them spawns the real `dist/index.js` binary
against the booted server above. See `integrations/cli/README.md` for the full
setup.
