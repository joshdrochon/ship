#!/bin/bash
# Category 3 — API Response Time (p.4).
#
# Authenticates once, then benchmarks the 5 highest-traffic endpoints with k6 at
# 10 / 25 / 50 concurrent connections, recording P50 / P95 / P99.
#
# Endpoints were chosen by tracing the frontend's actual network requests across
# the common flows (p.4: "by tracing the frontend's network requests"), not guessed.
#
#   docs/audit/scripts/bench-api.sh              # all endpoints, all concurrencies
#   docs/audit/scripts/bench-api.sh --quick      # 10 VUs only
#
# Requires: k6, a running api on :3000, and seeded data meeting p.4's minimums
# (600 documents / 170 issues / 25 users — see augment-seed.mjs).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1

API="${API:-http://localhost:3000}"
OUT="${OUT:-/tmp/cat3-results.json}"

echo "authenticating..." >&2
# curl's cookie jar comes back empty for these session cookies, so read Set-Cookie
# straight off the responses. Two cookies are needed: connect.sid (CSRF session)
# and session_id (app session). Note /api/auth/me returns 200 even unauthenticated,
# so it cannot be used to verify login — /api/documents can.
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

DOC=$(docker exec ship-postgres-1 psql -U ship -d ship_dev -t -A \
      -c "select id from documents where document_type='wiki' limit 1" 2>/dev/null)

VUS_LIST="10 25 50"
[ "${1:-}" = "--quick" ] && VUS_LIST="10"

cat > /tmp/k6-bench.js <<'K6'
import http from 'k6/http';
import { check } from 'k6';
const API = __ENV.API, COOKIE = __ENV.COOKIE, EP = __ENV.EP;
// The API rate-limits to 1000 req/min in dev / 100 in prod (app.ts:81), per IP.
// An open-ended VU loop saturates that budget in under a second and every
// subsequent request is 429, so latency has to be sampled at a FIXED arrival
// rate below the limit while varying concurrency. RATE is req/s.
export const options = {
  scenarios: {
    load: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 12), timeUnit: '1s',
      duration: __ENV.DURATION || '20s',
      preAllocatedVUs: Number(__ENV.VUS), maxVUs: Number(__ENV.VUS),
    },
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max'],
};
export default function () {
  const r = http.get(`${API}${EP}`, { headers: { Cookie: COOKIE } });
  check(r, { 'status 200': (x) => x.status === 200 });
  if (r.status !== 200) { console.error(`${EP} -> ${r.status}`); }
}
K6

echo "[" > "$OUT"; FIRST=1
for EP in "/api/auth/me" "/api/documents" "/api/documents/$DOC/backlinks" "/api/team/grid" "/api/projects"; do
  for VUS in $VUS_LIST; do
    echo "  $EP @ ${VUS} VUs, ${RATE:-12} req/s" >&2
    sleep 8   # let the rate-limit window drain between runs
    R=$(API="$API" COOKIE="$COOKIE" EP="$EP" VUS="$VUS" RATE="${RATE:-12}" \
        k6 run --quiet --summary-export=/tmp/k6-summary.json /tmp/k6-bench.js 2>/dev/null; \
        cat /tmp/k6-summary.json)
    [ $FIRST -eq 0 ] && echo "," >> "$OUT"; FIRST=0
    python3 - "$EP" "$VUS" >> "$OUT" <<PY
import json,sys
d=json.load(open('/tmp/k6-summary.json'))
m=d['metrics']['http_req_duration']
reqs=d['metrics'].get('http_reqs',{}).get('count',0)
fail=d['metrics'].get('http_req_failed',{}).get('value',0)
print(json.dumps({'endpoint':sys.argv[1],'vus':int(sys.argv[2]),
 'p50':round(m.get('med',0),2),'p95':round(m.get('p(95)',0),2),
 'p99':round(m.get('p(99)',0),2),'max':round(m.get('max',0),2),
 'requests':reqs,'fail_rate':round(fail,4)}, indent=1))
PY
  done
done
echo "]" >> "$OUT"
echo "wrote $OUT" >&2
