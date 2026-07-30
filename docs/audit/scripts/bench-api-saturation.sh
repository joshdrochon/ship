#!/bin/bash
# Category 3 companion to bench-api.sh — the concurrency half of p.4.
#
# bench-api.sh samples at a FIXED 12 req/s so it stays under the API rate limiter
# (app.ts: 1000/min in dev = 16.7 req/s). That is the right way to compare service
# time, but it also means the server is ~97% idle at every VU count, which is why the
# audit found P95 flat across 10 / 25 / 50 VUs (W3-3): the limiter binds long before
# concurrency does, so nothing ever queues and the VU count is not actually a variable.
#
# This script raises the arrival rate past the point where requests overlap so the
# concurrency levels p.4 asks for are real. It requires the limiter to be lifted, which
# is what API_RATE_LIMIT_MAX on the server is for. Both sides of a before/after pair
# must be run with the SAME rate and the SAME limiter ceiling.
#
#   API=http://localhost:3103 RATE=150 OUT=/tmp/sat.json \
#     docs/audit/scripts/bench-api-saturation.sh
#
# Requires: k6, a running api, seeded+augmented data (600 docs / 170 issues / 25 users).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1

API="${API:-http://localhost:3000}"
OUT="${OUT:-/tmp/cat3-saturation.json}"
RATE="${RATE:-150}"
DURATION="${DURATION:-15s}"
ENDPOINTS="${ENDPOINTS:-/api/documents /api/projects}"

# Same auth dance as bench-api.sh: curl's cookie jar comes back empty for these
# session cookies, so Set-Cookie is read off the responses directly. Two cookies are
# needed — connect.sid (CSRF session) and session_id (app session). /api/auth/me
# returns 200 even unauthenticated, so /api/documents is used to verify.
echo "authenticating..." >&2
CSRF_HDRS=$(curl -s -D - -o /tmp/csrf.json "$API/api/csrf-token")
CSRF=$(python3 -c 'import json;print(json.load(open("/tmp/csrf.json"))["token"])')
CSRF_COOKIE=$(echo "$CSRF_HDRS" | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | paste -sd'; ' -)

LOGIN_HDRS=$(curl -s -D - -o /dev/null -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' -H "x-csrf-token: $CSRF" -H "Cookie: $CSRF_COOKIE" \
  -d '{"email":"dev@ship.local","password":"admin123"}')
SESS=$(echo "$LOGIN_HDRS" | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | paste -sd'; ' -)
COOKIE="$CSRF_COOKIE; $SESS"

VERIFY=$(curl -s -H "Cookie: $COOKIE" -o /dev/null -w '%{http_code}' "$API/api/documents")
[ "$VERIFY" = "200" ] || { echo "auth failed: /api/documents returned $VERIFY" >&2; exit 1; }
echo "authenticated (verified against /api/documents)." >&2

cat > /tmp/k6-saturation.js <<'K6'
import http from 'k6/http';
import { check } from 'k6';
const API = __ENV.API, COOKIE = __ENV.COOKIE, EP = __ENV.EP;
export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE), timeUnit: '1s',
      duration: __ENV.DURATION,
      preAllocatedVUs: Number(__ENV.VUS), maxVUs: Number(__ENV.VUS),
    },
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
};
export default function () {
  const r = http.get(`${API}${EP}`, { headers: { Cookie: COOKIE } });
  check(r, { 'status 200': (x) => x.status === 200 });
}
K6

echo "[" > "$OUT"; FIRST=1
for EP in $ENDPOINTS; do
  for VUS in 10 25 50; do
    echo "  $EP @ ${VUS} VUs, ${RATE} req/s" >&2
    sleep 5
    API="$API" COOKIE="$COOKIE" EP="$EP" VUS="$VUS" RATE="$RATE" DURATION="$DURATION" \
      k6 run --quiet --summary-export=/tmp/k6-sat-summary.json /tmp/k6-saturation.js >/dev/null 2>&1
    [ $FIRST -eq 0 ] && echo "," >> "$OUT"; FIRST=0
    python3 - "$EP" "$VUS" "$RATE" >> "$OUT" <<PY
import json,sys
d=json.load(open('/tmp/k6-sat-summary.json'))
m=d['metrics']['http_req_duration']
print(json.dumps({'endpoint':sys.argv[1],'vus':int(sys.argv[2]),'rate':int(sys.argv[3]),
 'p50':round(m.get('med',0),2),'p95':round(m.get('p(95)',0),2),
 'p99':round(m.get('p(99)',0),2),'max':round(m.get('max',0),2),
 'requests':d['metrics'].get('http_reqs',{}).get('count',0),
 'fail_rate':round(d['metrics'].get('http_req_failed',{}).get('value',0),4)}, indent=1))
PY
  done
done
echo "]" >> "$OUT"
echo "wrote $OUT" >&2
