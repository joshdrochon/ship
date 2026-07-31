#!/bin/bash
# Category 3 — the measurement p.4 actually asks for: P50/P95/P99 at 10, 25 and 50
# SIMULTANEOUS CONNECTIONS, before against after, under identical conditions.
#
# Why this exists, when bench-api.sh and bench-api-saturation.sh already do adjacent things:
#
#   bench-api.sh            fixed 12 req/s arrival rate. Stays under the rate limiter, so it
#                           measures service time honestly — but the server is ~97% idle and
#                           the VU count is not a real variable. Concurrency is ~0.16.
#   bench-api-saturation.sh raises the arrival rate so requests overlap, but it still uses an
#                           OPEN loop (constant-arrival-rate). In-flight count is an emergent
#                           property of rate x latency, not the thing being set. And it runs
#                           one server at a time, so before/after are minutes apart.
#
# This script closes both gaps at once:
#
#   1. constant-vus  -> a CLOSED loop. N virtual users each hold exactly one request in
#                       flight at all times, so "10 simultaneous connections" is literally
#                       true rather than inferred. This is the reading of p.4 that cannot be
#                       argued with.
#   2. A and B run CONCURRENTLY, old code on $A and new code on $B, sharing one database and
#                       one machine. Every burst of background load lands on both sides in
#                       the same instant. Rule 1's "identical conditions" is satisfied by
#                       simultaneity rather than by hoping the machine did not change.
#
# Both sides must run with API_RATE_LIMIT_MAX lifted; at 50 VUs a limiter would turn the run
# into a 429 benchmark. The limiter is lifted identically on both sides, so it is not a
# variable.
#
#   A=http://localhost:3103 B=http://localhost:3104 \
#     ENDPOINTS="/api/team/grid /api/auth/me" \
#     OUT=docs/audit/raw/cat3-concurrency-paired.json \
#     docs/audit/scripts/bench-api-concurrency.sh
#
# Requires: k6, two api servers on the same database, seeded + augmented
# (600 documents / 170 issues / 25 users / 35 sprints).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1

A="${A:-http://localhost:3103}"
B="${B:-http://localhost:3104}"
DURATION="${DURATION:-45s}"
LEVELS="${LEVELS:-10 25 50}"
OUT="${OUT:-/tmp/cat3-concurrency.json}"
ENDPOINTS="${ENDPOINTS:-/api/team/grid /api/auth/me}"

auth () { # auth <base-url> -> cookie header value
  local base="$1" csrf_hdrs csrf csrf_cookie login_hdrs sess
  csrf_hdrs=$(curl -s -D - -o /tmp/conc-csrf.json "$base/api/csrf-token")
  csrf=$(python3 -c 'import json;print(json.load(open("/tmp/conc-csrf.json"))["token"])')
  csrf_cookie=$(echo "$csrf_hdrs" | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | paste -sd'; ' -)
  login_hdrs=$(curl -s -D - -o /dev/null -X POST "$base/api/auth/login" \
    -H 'Content-Type: application/json' -H "x-csrf-token: $csrf" -H "Cookie: $csrf_cookie" \
    -d '{"email":"dev@ship.local","password":"admin123"}')
  sess=$(echo "$login_hdrs" | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1 | paste -sd'; ' -)
  printf '%s; %s' "$csrf_cookie" "$sess"
}

echo "authenticating against both servers..." >&2
COOKIE_A=$(auth "$A")
COOKIE_B=$(auth "$B")
CODE_A=$(curl -s -H "Cookie: $COOKIE_A" -o /dev/null -w '%{http_code}' "$A/api/documents")
CODE_B=$(curl -s -H "Cookie: $COOKIE_B" -o /dev/null -w '%{http_code}' "$B/api/documents")
[ "$CODE_A" = "200" ] || { echo "auth failed on side A ($A): $CODE_A" >&2; exit 1; }
[ "$CODE_B" = "200" ] || { echo "auth failed on side B ($B): $CODE_B" >&2; exit 1; }
echo "authenticated on both." >&2

cat > /tmp/k6-concurrency.js <<'K6'
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const durA = new Trend('dur_a'), durB = new Trend('dur_b');
const failA = new Rate('fail_a'), failB = new Rate('fail_b');

// constant-vus, not constant-arrival-rate: each VU holds one request open, so VUS is the
// number of simultaneous connections rather than an allocation ceiling. Both scenarios get
// the same VU count and start at the same instant.
export const options = {
  scenarios: {
    a: { executor: 'constant-vus', exec: 'hitA', startTime: '0s',
         vus: Number(__ENV.VUS), duration: __ENV.DURATION },
    b: { executor: 'constant-vus', exec: 'hitB', startTime: '0s',
         vus: Number(__ENV.VUS), duration: __ENV.DURATION },
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max', 'count'],
};

export function hitA() {
  const r = http.get(`${__ENV.A}${__ENV.EP}`, { headers: { Cookie: __ENV.COOKIE_A } });
  durA.add(r.timings.duration); failA.add(r.status !== 200);
  check(r, { 'A 200': (x) => x.status === 200 });
}
export function hitB() {
  const r = http.get(`${__ENV.B}${__ENV.EP}`, { headers: { Cookie: __ENV.COOKIE_B } });
  durB.add(r.timings.duration); failB.add(r.status !== 200);
  check(r, { 'B 200': (x) => x.status === 200 });
}
K6

echo "[" > "$OUT"; FIRST=1
for EP in $ENDPOINTS; do
  for VUS in $LEVELS; do
    echo "  $EP @ ${VUS} simultaneous connections per side, $DURATION" >&2
    # Re-authenticate before every level. A single session held across a 15-run sweep drifts
    # -- the app writes last_activity on each request and expires on idle, so a cookie taken
    # at minute zero is not the same credential at minute twenty. Re-auth makes each row
    # independent of the ones before it.
    COOKIE_A=$(auth "$A"); COOKIE_B=$(auth "$B")
    sleep 3
    A="$A" B="$B" COOKIE_A="$COOKIE_A" COOKIE_B="$COOKIE_B" EP="$EP" \
    VUS="$VUS" DURATION="$DURATION" \
      k6 run --quiet --summary-export=/tmp/k6-conc-summary.json /tmp/k6-concurrency.js >/dev/null 2>&1
    [ $FIRST -eq 0 ] && echo "," >> "$OUT"; FIRST=0
    python3 - "$EP" "$VUS" >> "$OUT" <<PY
import json,sys
d=json.load(open('/tmp/k6-conc-summary.json'))['metrics']
a,b=d['dur_a'],d['dur_b']
def g(m,k): return round(m[k],2) if k in m else None
row={'endpoint':sys.argv[1],'connections':int(sys.argv[2]),
     'before':{'p50':g(a,'med'),'p95':g(a,'p(95)'),'p99':g(a,'p(99)'),'max':g(a,'max'),'samples':a.get('count')},
     'after' :{'p50':g(b,'med'),'p95':g(b,'p(95)'),'p99':g(b,'p(99)'),'max':g(b,'max'),'samples':b.get('count')},
     'fail_before':round(d.get('fail_a',{}).get('value',0),4),
     'fail_after':round(d.get('fail_b',{}).get('value',0),4)}
for p in ('p50','p95','p99'):
    if row['before'][p] and row['after'][p]:
        row['delta_'+p+'_pct']=round((row['after'][p]-row['before'][p])/row['before'][p]*100,1)
# A row with ANY non-200 is not a latency measurement -- it is a measurement of whatever the
# error path costs. The first version of this script had no such flag, and the sweep produced
# a clean-looking -86.5% on an endpoint where 46% of the after-side responses were failures,
# plus rows whose P50 sat at exactly 2,005 ms because every request was waiting out the pool's
# 2 s connectionTimeoutMillis. Both looked like results. Mark the row instead of trusting it.
row['valid'] = (row['fail_before'] == 0 and row['fail_after'] == 0)
if not row['valid']:
    row['invalid_reason'] = ('non-200 responses on one or both sides; this row measures the '
                             'failure path, not endpoint latency. Do not quote it.')
print(json.dumps(row,indent=1))
PY
  done
done
echo "]" >> "$OUT"
echo "wrote $OUT" >&2
python3 -c "
import json,sys
rows=json.load(open('$OUT'))
for r in rows:
    mark='' if r['valid'] else '   <-- INVALID, non-200s (b=%.3f a=%.3f)'%(r['fail_before'],r['fail_after'])
    print(f\"{r['endpoint']:34s} {r['connections']:3d} conns   P50 {r['before']['p50']:8.2f} -> {r['after']['p50']:8.2f} ({r['delta_p50_pct']:+7.1f}%)   P95 {r['before']['p95']:8.2f} -> {r['after']['p95']:8.2f} ({r['delta_p95_pct']:+7.1f}%)  n={r['before']['samples']}/{r['after']['samples']}{mark}\")
bad=[r for r in rows if not r['valid']]
print()
print(f'{len(rows)-len(bad)}/{len(rows)} rows valid.')
if bad:
    print('DO NOT QUOTE the invalid rows -- they measure the error path. Raise DB_POOL_MAX on')
    print('both sides so the pool can serve the concurrency being tested, and re-run.')
    sys.exit(3)
" >&2
