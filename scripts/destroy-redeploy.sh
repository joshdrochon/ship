#!/usr/bin/env bash
#
# Tear the Render environment down and rebuild it from the Terraform config alone.
#
# ── Why this is a script and not a runbook ───────────────────────────────────
# The brief (p.3) asks for the destroy-and-redeploy test "to prove the IaC is
# the source of truth". A cycle performed by hand proves it once, for the person
# who happened to be at the keyboard, and its evidence is a paste of terminal
# output nobody can reproduce. FG-203 asks for it re-runnable instead, which is
# a different and stronger claim: anyone can run this and get the same
# environment back.
#
# ── The four things that make this survivable ────────────────────────────────
# 1. The image is checked BEFORE anything is destroyed. `runtime_source.image`
#    deploys a tag that already exists; if that tag were missing from GHCR the
#    apply would fail with nothing left to roll back to. This is the one
#    precondition whose failure is unrecoverable, so it is the first gate.
#
# 2. `prevent_destroy` on render_postgres is removed by this script and restored
#    by an EXIT trap, so an abort mid-run cannot leave the guard off. The guard
#    is what stopped an earlier config from planning a destroy of a healthy
#    database on every run; it belongs in main.tf, and this is the only thing
#    allowed to lift it, briefly, on purpose.
#
# 3. The database is recreated, not restored, and that is by design rather than
#    an oversight. `Dockerfile:137` runs `migrate; seed; serve` on every boot and
#    seed.js checks for each record before inserting, so schema and seed data
#    come back on their own. What does not come back is the agent's runtime
#    output — notification rows, checkpointer threads, watermarks. Those are
#    reproducible (the cron regenerates within one 3-minute interval) and their
#    evidence already lives outside this database, in eight public LangSmith
#    traces and the run log in FLEETGRAPH.md.
#
# 4. The service URL WILL change. Render assigns a new random slug to a new
#    service, so shipshape-7buc becomes shipshape-something-else. That is not a
#    failure of the test, it is the test's most awkward true consequence, and it
#    is why the last step rewrites every tracked reference and then runs
#    check-doc-links.sh as the gate. Skipping that step is how SUBMISSION.md
#    came to link a 404 the last time this environment moved.
#
# ── Running it ───────────────────────────────────────────────────────────────
#   ./scripts/destroy-redeploy.sh --dry-run     # preflight + plan, destroys nothing
#   ./scripts/destroy-redeploy.sh --yes         # the real cycle
#
# Needs, in .env: GITLAB_TOKEN (state backend), TF_VAR_render_api_key,
# TF_VAR_render_owner_id, TF_VAR_anthropic_api_key, TF_VAR_ship_api_token, and
# optionally TF_VAR_langchain_api_key. Absent the LangSmith key, tracing is
# omitted rather than set empty — see cron.tf.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF="$ROOT/terraform/render"
RUN_DIR="${RUN_DIR:-$ROOT/.destroy-redeploy}"
DRY_RUN=0
CONFIRMED=0

for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --yes)     CONFIRMED=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '   \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$RUN_DIR"

# ---------------------------------------------------------------- credentials
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
set +a
export TF_HTTP_USERNAME="${TF_HTTP_USERNAME:-gitlab-ci-token}"
export TF_HTTP_PASSWORD="${TF_HTTP_PASSWORD:-${GITLAB_TOKEN:-}}"

# ---------------------------------------------------------------- 1. preflight
say "1 · Preflight"

command -v terraform >/dev/null || die "terraform not on PATH"
command -v docker    >/dev/null || die "docker not on PATH (needed to verify the image)"
[ -n "${TF_HTTP_PASSWORD:-}" ] || die "GITLAB_TOKEN unset — the http state backend needs it"
for v in TF_VAR_render_api_key TF_VAR_render_owner_id; do
  [ -n "${!v:-}" ] || die "$v unset"
done
ok "terraform $(terraform version -json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).terraform_version')"

terraform -chdir="$TF" init -input=false -no-color >/dev/null || die "terraform init failed"
ok "state backend reachable"

# The tag to redeploy. deploy/green is what CI promotes and what /health reports,
# so it is the environment's own answer to "what should be running here".
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT" rev-parse deploy/green 2>/dev/null || true)}"
[ -n "$IMAGE_TAG" ] || die "no deploy/green tag and no IMAGE_TAG override — refusing to guess"
ok "image tag $IMAGE_TAG"

# THE gate. Everything after this is recoverable; a missing image is not.
IMAGE="ghcr.io/joshdrochon/ship:$IMAGE_TAG"
docker manifest inspect "$IMAGE" >/dev/null 2>&1 \
  || die "$IMAGE is not in the registry — destroying now would leave nothing to redeploy"
ok "image present in GHCR"

# ---------------------------------------------------------------- 2. snapshot
say "2 · Snapshot the environment we are about to remove"

terraform -chdir="$TF" state pull > "$RUN_DIR/state-before.json"
[ -s "$RUN_DIR/state-before.json" ] || die "state pull came back empty"
ok "state → $RUN_DIR/state-before.json ($(wc -c < "$RUN_DIR/state-before.json" | tr -d ' ') bytes)"

terraform -chdir="$TF" output -json > "$RUN_DIR/outputs-before.json"
OLD_URL=$(node -pe 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); o.service_url?.value ?? ""' "$RUN_DIR/outputs-before.json")
[ -n "$OLD_URL" ] || die "could not read service_url from outputs"
ok "current URL $OLD_URL"

if [ "$DRY_RUN" = 1 ]; then
  say "Dry run — planning the destroy, executing nothing"
  # prevent_destroy makes `plan -destroy` error by design. That error IS the
  # expected result here, and seeing it is the point of the dry run.
  terraform -chdir="$TF" plan -destroy -no-color -input=false -lock=false \
    -var "image_tag=$IMAGE_TAG" 2>&1 | tail -12 || true
  say "Dry run complete. Nothing was destroyed."
  exit 0
fi

if [ "$CONFIRMED" != 1 ]; then
  die "refusing to destroy without --yes"
fi

# ---------------------------------------------------------------- 3. disarm
say "3 · Lift prevent_destroy (restored automatically on exit)"

MAIN="$TF/main.tf"
cp "$MAIN" "$RUN_DIR/main.tf.orig"

restore_guard() {
  if [ -f "$RUN_DIR/main.tf.orig" ]; then
    cp "$RUN_DIR/main.tf.orig" "$MAIN"
    printf '   \033[32m✓\033[0m prevent_destroy restored in main.tf\n'
  fi
}
trap restore_guard EXIT

# Only the flag flips, so the lifecycle block and its comment survive the round
# trip and `git diff` after a successful run is empty.
sed -i.bak 's/prevent_destroy = true/prevent_destroy = false/' "$MAIN"
rm -f "$MAIN.bak"
grep -q 'prevent_destroy = false' "$MAIN" || die "could not lift prevent_destroy — main.tf may have changed shape"
ok "prevent_destroy = false, for this run only"

# ---------------------------------------------------------------- 4. destroy
say "4 · Destroy"

terraform -chdir="$TF" destroy -auto-approve -no-color -input=false \
  -var "image_tag=$IMAGE_TAG" 2>&1 | tee "$RUN_DIR/destroy.log" | tail -6
grep -qE 'Destroy complete! Resources: [0-9]+ destroyed' "$RUN_DIR/destroy.log" \
  || die "destroy did not report completion — read $RUN_DIR/destroy.log before retrying"
ok "$(grep -oE 'Destroy complete! Resources: [0-9]+ destroyed' "$RUN_DIR/destroy.log")"

restore_guard
trap - EXIT

# ---------------------------------------------------------------- 5. rebuild
say "5 · Re-apply from config alone"

terraform -chdir="$TF" apply -auto-approve -no-color -input=false \
  -var "image_tag=$IMAGE_TAG" 2>&1 | tee "$RUN_DIR/apply.log" | tail -8
grep -qE 'Apply complete! Resources: [0-9]+ added' "$RUN_DIR/apply.log" \
  || die "apply did not complete — $RUN_DIR/apply.log, and state-before.json is your reference"
ok "$(grep -oE 'Apply complete! Resources: [0-9]+ added, [0-9]+ changed, [0-9]+ destroyed' "$RUN_DIR/apply.log")"

terraform -chdir="$TF" output -json > "$RUN_DIR/outputs-after.json"
NEW_URL=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).service_url.value' "$RUN_DIR/outputs-after.json")
ok "new URL $NEW_URL"

# ---------------------------------------------------------------- 6. verify
say "6 · Verify the rebuilt environment"

# Render pulls the image and boots migrate+seed+serve. Cold start is the one
# unbounded term in the latency budget, so this polls rather than sleeps.
DEADLINE=$(( $(date +%s) + 600 ))
until [ "$(date +%s)" -ge "$DEADLINE" ]; do
  body=$(curl -s -m 15 "$NEW_URL/health" 2>/dev/null || true)
  rev=$(printf '%s' "$body" | node -pe 'try{JSON.parse(require("fs").readFileSync(0,"utf8")).revision}catch(e){""}' 2>/dev/null || true)
  [ "$rev" = "$IMAGE_TAG" ] && break
  printf '   … waiting for /health to report %s\n' "${IMAGE_TAG:0:7}"
  sleep 15
done
[ "${rev:-}" = "$IMAGE_TAG" ] || die "/health never reported $IMAGE_TAG within 10 minutes"
ok "/health reports the expected revision (FG-199)"

ready=$(curl -s -m 20 "$NEW_URL/ready" || true)
printf '%s' "$ready" > "$RUN_DIR/ready-after.json"
printf '%s' "$ready" | grep -q '"status":"ready"' || die "/ready is not ready: $ready"
ok "/ready 200 with dependencies up (FG-200)"
printf '%s' "$ready" | grep -q '"postgres":{"status":"ok"' \
  && ok "postgres reachable — migrate+seed ran on boot (FG-202)"

CRON_ID=$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agent_cron_id.value' "$RUN_DIR/outputs-after.json")
[ -n "$CRON_ID" ] || die "no cron id in outputs"
ok "cron job recreated: $CRON_ID (FG-201)"

# ---------------------------------------------------------------- 7. propagate
say "7 · Propagate the new URL"

if [ "$OLD_URL" = "$NEW_URL" ]; then
  ok "URL unchanged — nothing to rewrite"
else
  # Tracked Markdown only. Untracked files and the run logs keep the old URL on
  # purpose: they are the record of what this cycle replaced.
  # `while read`, not `mapfile` — macOS ships bash 3.2 and mapfile is a 4.x
  # builtin, so the array form fails on the machine most likely to run this.
  # Match the bare host, not the full URL. The first run of this rewrote every
  # `https://shipshape-7buc.onrender.com` and left a prose `shipshape-7buc`
  # standing in FLEETGRAPH.md — invisible to check-doc-links.sh too, since that
  # only extracts complete URLs. Slugs get mentioned in sentences, not just in
  # links.
  OLD_HOST=${OLD_URL#https://}
  OLD_SLUG=${OLD_HOST%%.*}
  HITS=$(git -C "$ROOT" ls-files '*.md' | xargs grep -l "$OLD_SLUG" 2>/dev/null || true)
  if [ -z "$HITS" ]; then
    warn "no tracked Markdown referenced $OLD_URL"
  else
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      # docs/audit/ and CHANGES/ are historical record; they are allowlisted in
      # check-doc-links.sh for exactly this reason and must not be rewritten.
      case "$f" in
        docs/audit/*|CHANGES/*) warn "left historical: $f" ; continue ;;
      esac
      NEW_SLUG=${NEW_URL#https://}; NEW_SLUG=${NEW_SLUG%%.*}
      sed -i.bak -e "s|$OLD_URL|$NEW_URL|g" -e "s|$OLD_SLUG|$NEW_SLUG|g" "$ROOT/$f" \
        && rm -f "$ROOT/$f.bak"
      ok "rewrote $f"
    done <<< "$HITS"
  fi
  warn "$OLD_URL is now dead — add it to scripts/doc-links-allowlist.txt for any file"
  warn "that cites it as history, and update CREDENTIALS.md if it exists (FG-206, FG-208)"
fi

# ---------------------------------------------------------------- 8. gate
say "8 · Link check — the gate"

"$ROOT/scripts/check-doc-links.sh" || die "documented links are dead after the rebuild; fix before calling this done"

say "Cycle complete"
printf '   was: %s\n   now: %s\n   logs: %s\n\n' "$OLD_URL" "$NEW_URL" "$RUN_DIR"
