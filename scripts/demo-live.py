#!/usr/bin/env python3
"""End-to-end platform demo against the DEPLOYED Ship instance.

Registers an OAuth app through the developer portal API, runs the full OAuth
device grant (including the browser consent POSTs), and calls the versioned
public API with the resulting token. Everything over the public URL."""
import http.cookiejar, json, re, sys, urllib.parse, urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://d258p92d3n1ebe.cloudfront.net"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def req(path, data=None, headers=None, form=False):
    url = path if path.startswith("http") else BASE + path
    body, h = None, {"User-Agent": "ship-demo"}
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
            h["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            body = json.dumps(data).encode()
            h["Content-Type"] = "application/json"
    h.update(headers or {})
    try:
        r = op.open(urllib.request.Request(url, data=body, headers=h))
        return r.getcode(), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def csrf():
    return json.loads(req("/api/csrf-token")[1])["token"]


def hidden(html, where):
    m = re.search(r'name="_csrf"\s+value="([^"]+)"', html)
    if not m:
        raise SystemExit(f"no _csrf in {where}: {html[:300]}")
    return m.group(1)


print(f"BASE = {BASE}\n")

# 1 ── operator session
t = csrf()
code, body = req(
    "/api/auth/login",
    {"email": "dev@ship.local", "password": "admin123"},
    {"x-csrf-token": t},
)
print(f"1. login as dev@ship.local          HTTP {code}")
if code != 200:
    raise SystemExit(body[:300])
ws = json.loads(body)["data"]["currentWorkspace"]
print(f"   workspace: {ws['name']} ({ws['id']})")

# 2 ── register an app through the portal API
t = csrf()
code, body = req(
    "/api/apps",
    {
        "name": "MVP Demo Client",
        # NOT http://localhost — the CloudFront WAF blocks a request body
        # containing a loopback URL, and the 403 comes back as a CloudFront
        # error page that looks nothing like an app error.
        "redirect_uris": ["https://example.com/callback"],
        "requested_scopes": ["documents:read", "issues:read"],
    },
    {"x-csrf-token": t},
)
print(f"2. POST /api/apps (register)        HTTP {code}")
if code != 201:
    raise SystemExit(body[:400])
app = json.loads(body)["data"]
CLIENT = app["client_id"]
SECRET = app.get("client_secret")
print(f"   client_id     = {CLIENT}")
print(f"   client_secret = {SECRET[:12]}… (shown exactly once)")
print(f"   scopes        = {app.get('requested_scopes')}")

# 3 ── device grant
code, body = req(
    "/oauth/device/code",
    {"client_id": CLIENT, "scope": "documents:read issues:read"},
    form=True,
)
print(f"3. POST /oauth/device/code          HTTP {code}")
if code != 200:
    raise SystemExit(body[:400])
dc = json.loads(body)
print(f"   user_code = {dc['user_code']}")

# 4 ── consent, as the browser does it
code, entry = req(f"/oauth/device/verify?user_code={urllib.parse.quote(dc['user_code'])}")
print(f"4. GET  /oauth/device/verify        HTTP {code}")
if code != 200:
    raise SystemExit(entry[:400])

code, consent = req(
    "/oauth/device/verify",
    {"user_code": dc["user_code"], "_csrf": hidden(entry, "entry")},
    form=True,
)
print(f"5. POST /oauth/device/verify        HTTP {code}")
if code != 200:
    raise SystemExit(re.sub(r"<[^>]+>", " ", consent)[:400])

code, decided = req(
    "/oauth/device/verify/decision",
    {
        "user_code": dc["user_code"],
        "decision": "allow",
        "_csrf": hidden(consent, "consent"),
    },
    form=True,
)
print(f"6. POST .../decision allow          HTTP {code}")
if code != 200:
    raise SystemExit(re.sub(r"<[^>]+>", " ", decided)[:400])

# 5 ── token
payload = {
    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    "device_code": dc["device_code"],
    "client_id": CLIENT,
}
code, body = req("/oauth/token", payload, form=True)
if code != 200 and SECRET:
    payload["client_secret"] = SECRET
    code, body = req("/oauth/token", payload, form=True)
print(f"7. POST /oauth/token                HTTP {code}")
if code != 200:
    raise SystemExit(body[:400])
tr = json.loads(body)
at = tr["access_token"]
print(f"   access_token  = {at[:20]}…")
print(f"   scope         = {tr.get('scope')}   expires_in={tr.get('expires_in')}")
print(f"   refresh_token = {'yes' if tr.get('refresh_token') else 'no'}")

# 6 ── the public API, with real data
code, body = req("/api/v1/documents?limit=3", headers={"Authorization": f"Bearer {at}"})
print(f"\n8. GET /api/v1/documents            HTTP {code}")
d = json.loads(body)
for row in d.get("data", []):
    print(f"   · {row.get('document_type'):<14} {row.get('title')}")
print(f"   next_cursor = {str(d.get('next_cursor'))[:32]}")

code, body = req("/api/v1/issues?limit=3", headers={"Authorization": f"Bearer {at}"})
print(f"9. GET /api/v1/issues               HTTP {code}")
for row in json.loads(body).get("data", []):
    print(f"   · {row.get('title')}")

# 7 ── the guardrails
code, _ = req(
    "/api/v1/documents",
    {"title": "refused", "document_type": "wiki"},
    {"Authorization": f"Bearer {at}"},
)
print(f"\n10. POST /api/v1/documents          HTTP {code}  (403 = scope enforced)")
code, _ = req("/api/v1/documents")
print(f"11. GET  /api/v1/documents no token HTTP {code}  (401)")
code, _ = req("/api/v1/documents", headers={"Authorization": "Bearer ship_at_bogus"})
print(f"12. GET  /api/v1/documents bad tok  HTTP {code}  (401)")

print(f"\nDEMO CLIENT_ID={CLIENT}")
print(f"DEMO ACCESS_TOKEN={at}")
