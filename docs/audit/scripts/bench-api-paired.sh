#!/bin/bash
# Category 3 — before/after in the SAME run, against two servers at once.
#
# Why this exists. `bench-api.sh` measures one server at a time, so a before/after pair is
# two runs separated by minutes. On a machine shared with other agents that is a problem:
# the P95 of a 240-sample run moved by up to 60% between VU levels of the *same* build
# purely from background load, which is wider than the 20% effect p.5 asks us to resolve.
# Sequential A-then-B cannot tell a real improvement from the machine emptying out.
#
# This runs both builds concurrently — old code on $A, new code on $B — with k6 alternating
# between them at a fixed total arrival rate. Every burst of background load lands on both
# sides at once, so the comparison survives a noisy machine. It is a stricter reading of
# Rule 1's "identical conditions" than two sequential runs can be: the conditions are not
# merely similar, they are the same instant.
#
# It does NOT replace bench-api.sh — that stays the canonical, committed measurement and is
# what the baseline was taken with. This is the corroborating measurement.
#
#   A=http://localhost:3103 B=http://localhost:3104 RATE=24 DURATION=60s \
#     OUT=/tmp/paired.json docs/audit/scripts/bench-api-paired.sh
#
# Requires: k6, two running api servers on the same database with the same data volume.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.." || exit 1

A="${A:-http://localhost:3103}"
B="${B:-http://localhost:3104}"
RATE="${RATE:-24}"
DURATION="${DURATION:-60s}"
VUS="${VUS:-25}"
OUT="${OUT:-/tmp/cat3-paired.json}"
ENDPOINTS="${ENDPOINTS:-/api/documents /api/projects}"

auth () { # auth <base-url> -> cookie header value
  local base="$1" csrf_hdrs csrf csrf_cookie login_hdrs sess
  csrf_hdrs=$(curl -s -D - -o /tmp/paired-csrf.json "$base/api/csrf-token")
  csrf=$(python3 -c 'import json;print(json.load(open("/tmp/paired-csrf.json"))["token"])')
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
for pair in "A:$A:$COOKIE_A" "B:$B:$COOKIE_B"; do
  side="${pair%%:*}"; rest="${pair#*:}"; base="${rest%%:*}"
  code=$(curl -s -H "Cookie: ${rest#*:}" -o /dev/null -w '%{http_code}' "$base/api/documents")
  [ "$code" = "200" ] || { echo "auth failed on side $side ($base): $code" >&2; exit 1; }
done
echo "authenticated on both." >&2

cat > /tmp/k6-paired.js <<'K6'
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const EP = __ENV.EP;
const durA = new Trend('dur_a'), durB = new Trend('dur_b');
const failA = new Rate('fail_a'), failB = new Rate('fail_b');

// Two scenarios at half the total rate each, started together. Interleaving at the
// scheduler level means neither side gets a systematically quieter slice of the machine.
export const options = {
  scenarios: {
    a: { executor: 'constant-arrival-rate', exec: 'hitA', startTime: '0s',
         rate: Number(__ENV.HALF), timeUnit: '1s', duration: __ENV.DURATION,
         preAllocatedVUs: Number(__ENV.VUS), maxVUs: Number(__ENV.VUS) },
    b: { executor: 'constant-arrival-rate', exec: 'hitB', startTime: '0s',
         rate: Number(__ENV.HALF), timeUnit: '1s', duration: __ENV.DURATION,
         preAllocatedVUs: Number(__ENV.VUS), maxVUs: Number(__ENV.VUS) },
  },
  summaryTrendStats: ['med', 'p(95)', 'p(99)', 'max', 'count'],
};

export function hitA() {
  const r = http.get(`${__ENV.A}${EP}`, { headers: { Cookie: __ENV.COOKIE_A } });
  durA.add(r.timings.duration); failA.add(r.status !== 200);
  check(r, { 'A 200': (x) => x.status === 200 });
}
export function hitB() {
  const r = http.get(`${__ENV.B}${EP}`, { headers: { Cookie: __ENV.COOKIE_B } });
  durB.add(r.timings.duration); failB.add(r.status !== 200);
  check(r, { 'B 200': (x) => x.status === 200 });
}
K6

HALF=$(python3 -c "print(${RATE}/2)")

echo "[" > "$OUT"; FIRST=1
for EP in $ENDPOINTS; do
  echo "  $EP — A vs B, ${RATE} req/s total, $DURATION" >&2
  sleep 3
  A="$A" B="$B" COOKIE_A="$COOKIE_A" COOKIE_B="$COOKIE_B" EP="$EP" \
  HALF="$HALF" VUS="$VUS" DURATION="$DURATION" \
    k6 run --quiet --summary-export=/tmp/k6-paired-summary.json /tmp/k6-paired.js >/dev/null 2>&1
  [ $FIRST -eq 0 ] && echo "," >> "$OUT"; FIRST=0
  python3 - "$EP" "$RATE" >> "$OUT" <<PY
import json,sys
d=json.load(open('/tmp/k6-paired-summary.json'))['metrics']
a,b=d['dur_a'],d['dur_b']
def g(m,k,alt=None):
    for key in ([k]+([alt] if alt else [])):
        if key in m: return round(m[key],2)
    return None
row={'endpoint':sys.argv[1],'rate':float(sys.argv[2]),
     'before':{'p50':g(a,'med'),'p95':g(a,'p(95)'),'p99':g(a,'p(99)'),'max':g(a,'max'),'samples':a.get('count')},
     'after' :{'p50':g(b,'med'),'p95':g(b,'p(95)'),'p99':g(b,'p(99)'),'max':g(b,'max'),'samples':b.get('count')},
     'fail_before':round(d.get('fail_a',{}).get('value',0),4),
     'fail_after':round(d.get('fail_b',{}).get('value',0),4)}
if row['before']['p95'] and row['after']['p95']:
    row['delta_p95_pct']=round((row['after']['p95']-row['before']['p95'])/row['before']['p95']*100,1)
    row['delta_p50_pct']=round((row['after']['p50']-row['before']['p50'])/row['before']['p50']*100,1)
print(json.dumps(row,indent=1))
PY
done
echo "]" >> "$OUT"
echo "wrote $OUT" >&2
python3 -c "
import json;
for r in json.load(open('$OUT')):
    print(f\"{r['endpoint']:20s} P50 {r['before']['p50']:6.2f} -> {r['after']['p50']:6.2f} ({r['delta_p50_pct']:+.1f}%)   P95 {r['before']['p95']:6.2f} -> {r['after']['p95']:6.2f} ({r['delta_p95_pct']:+.1f}%)  n={r['before']['samples']}/{r['after']['samples']}\")
" >&2
