# MVP demo runbook — the live instance

Everything below was executed against the deployed instance on **2026-08-14**, after
deploying `dd9f204`. Nothing here runs on localhost.

**URL:** `https://d258p92d3n1ebe.cloudfront.net/`
**Login:** `dev@ship.local` / `admin123`

Use **CloudFront only**. The Elastic Beanstalk hostname serves a blank page in a browser
(helmet sends `upgrade-insecure-requests` and EB has no TLS listener) and cannot hold a
session at all over plain HTTP, because the CSRF cookie is `secure`.

---

## The 60-second version

```bash
python3 scripts/demo-live.py
```

One command. It registers an OAuth app through the portal API, runs the full device
grant including both consent POSTs, exchanges the code for a token, reads the versioned
API, and then proves the guardrails. Real output from the live instance:

```
1. login as dev@ship.local          HTTP 200
   workspace: Ship Workspace (c2507996-74a3-444c-9beb-eb1866497fb6)
2. POST /api/apps (register)        HTTP 201
   client_id     = ship_app_Pj2eiNlNhs3FPEE3rvhSHQ
   client_secret = ship_secret_… (shown exactly once)
3. POST /oauth/device/code          HTTP 200
   user_code = CJE9-P73R
4. GET  /oauth/device/verify        HTTP 200
5. POST /oauth/device/verify        HTTP 200
6. POST .../decision allow          HTTP 200
7. POST /oauth/token                HTTP 200
   scope         = documents:read issues:read   expires_in=3600
   refresh_token = yes

8. GET /api/v1/documents            HTTP 200
   · weekly_plan    Week 14 Plan
   · weekly_retro   Week 13 Retro
   next_cursor = eyJpZCI6ImQwMDJjZjIzLTNlOWEtNDA1

10. POST /api/v1/documents          HTTP 403  (scope enforced)
11. GET  /api/v1/documents no token HTTP 401
12. GET  /api/v1/documents bad tok  HTTP 401
```

The last three lines are the ones worth pausing on. A read-only token is refused a
write, an absent token and a forged token are both refused, and `next_cursor` is an
opaque keyset cursor rather than an offset.

---

## Talking through it, screen by screen

### 1. The product (30s)

Log in. It is a working app, not a shell around an API — documents, issues, sprints, the
4-panel editor.

### 2. The developer portal — `/portal` (60s)

**There is no register-app form in the UI yet** (L22, still open). The portal renders the
app list, the per-app delivery log at `/portal/:appId`, and the shown-once secret reveal.
Apps are registered through `POST /api/apps`, which is what `scripts/demo-live.py` does.

So demo it in that order: run the script first, then open `/portal` and show the app it
just created. Click into it for `client_id`, scopes, and the delivery log. The reveal
panel is the beat worth pausing on — the secret is displayed once and the server kept
only a hash.

Pick an app holding `webhooks:manage` before opening the delivery log. The portal mints a
token scoped to that app's own scopes, so an app without it renders a scope error rather
than a log.

### 3. The contract — `/api/v1/openapi.json` (30s)

15 paths, generated from Zod next to each handler rather than hand-written, so it cannot
drift from the code. Same document as the committed `docs/openapi.json`.

```bash
curl -s https://d258p92d3n1ebe.cloudfront.net/api/v1/openapi.json | python3 -m json.tool | head -40
```

### 4. OAuth, and why it is not a password field (90s)

Run `scripts/demo-live.py` and narrate. The device grant is the interesting one: the
CLI never sees a credential, the user approves in a browser they already trust, and the
consent screen prints the code back so it can be compared against the terminal — that
comparison is the anti-phishing step.

### 5. Machine-to-machine (30s)

The agent is a first-party confidential client and uses Client Credentials, no human in
the loop:

```bash
SEC=$(aws ssm get-parameter --name /ship/dev/AGENT_CLIENT_SECRET \
        --with-decryption --query Parameter.Value --output text)

curl -s -X POST https://d258p92d3n1ebe.cloudfront.net/oauth/token \
  -d "grant_type=client_credentials&client_id=ship_app_firstparty_fleetgraph_agent&client_secret=$SEC&scope=documents:read issues:read sprints:read"
```

Returns a token scoped `documents:read issues:read sprints:read`. Try it with the *demo*
app instead and it is refused — `unauthorized_client`, because that one is a public
client and RFC 6749 §4.4 is confidential-only. The refusal is the demo.

---

## Things that will bite you on stage

| | |
|---|---|
| **Tokens live 3600s** | Re-run the script if the demo slips |
| **The WAF blocks `http://localhost` in a request body** | Registering an app with a loopback `redirect_uri` returns a CloudFront 403 that looks nothing like an app error. Use an `https://` URI |
| **The grader workspace is empty** | `ship_app_grader_readonly` and `ship_app_grader_demo` live in their own tenant, so their tokens correctly return `data: []`. Demo with an app registered in Ship Workspace, which is what the script does |
| **The device consent form wants `decision=allow`** | Not `approve`. `approve` is recorded as a denial |
| **`deploy.sh` does not ship the frontend** | It uploads only the API bundle. The SPA is a separate `aws s3 sync web/dist/ …` plus a CloudFront invalidation |

---

## Not demoed, deliberately

Webhook **delivery** to an external target. `SHIP_ALLOW_LOOPBACK_WEBHOOK_TARGETS` is
default-off on the deployed instance, so a loopback `target_url` is refused at
subscription time. Subscription CRUD, signing-secret rotation and the delivery log all
work; an end-to-end delivery needs a public receiver and has only ever been proven
against localhost.
