#!/bin/sh
set -eu

# Safe orchestration for ECS capacity observations. The default action is a
# network-free plan. The runner deliberately produces raw observations with
# cloud_gate=false; a human-reviewed, independently attested capacity report is
# still required by deploy-preflight-ecs.sh.
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
action=${1:-plan}

case "$action" in plan|capture|validate) ;; *) echo 'usage: capture-ecs-capacity-evidence.sh [plan|capture|validate]' >&2; exit 2 ;; esac
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${CAPACITY_CAPTURE_TARGET_URL:?CAPACITY_CAPTURE_TARGET_URL is required}"
: "${CAPACITY_CAPTURE_OUTPUT:?CAPACITY_CAPTURE_OUTPUT is required}"
: "${CAPACITY_PROFILE:=pilot_50}"

printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || { echo 'unsafe RELEASE_ID' >&2; exit 2; }
case "$CAPACITY_PROFILE" in pilot_50|wave_100|wave_250|target_500) ;; *) echo 'CAPACITY_PROFILE must be pilot_50, wave_100, wave_250 or target_500' >&2; exit 2 ;; esac
case "$CAPACITY_CAPTURE_TARGET_URL" in https://*) ;; *) echo 'capacity capture target must use HTTPS' >&2; exit 2 ;; esac
case "$CAPACITY_CAPTURE_TARGET_URL" in
  https://yxsona.com*|https://ops.yxsona.com*) echo 'capacity capture is forbidden against the production domains; use an isolated preproduction environment' >&2; exit 2 ;;
esac
case "$CAPACITY_CAPTURE_OUTPUT" in /*) ;; *) echo 'CAPACITY_CAPTURE_OUTPUT must be an absolute path' >&2; exit 2 ;; esac

output_parent=$(dirname "$CAPACITY_CAPTURE_OUTPUT")
[ -d "$output_parent" ] && [ ! -L "$output_parent" ] || { echo 'capacity capture output parent must be an existing non-symlink directory' >&2; exit 2; }
canonical_parent=$(CDPATH='' cd -- "$output_parent" && pwd -P)
[ "$canonical_parent" = "$output_parent" ] || { echo 'capacity capture output parent must be absolute and canonical' >&2; exit 2; }
owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
[ "$(owner_of "$output_parent")" = "$(id -u)" ] || { echo 'capacity capture output parent must be owned by the invoking user' >&2; exit 2; }
output_mode=$(mode_of "$output_parent"); case "$output_mode" in *[2367][0-7]|*[2367]) echo 'capacity capture output parent must not be writable by group or other users' >&2; exit 2 ;; esac
[ ! -L "$CAPACITY_CAPTURE_OUTPUT" ] || { echo 'capacity capture output must not be a symlink' >&2; exit 2; }
[ "$action" = validate ] || [ ! -e "$CAPACITY_CAPTURE_OUTPUT" ] || { echo 'capacity capture output already exists; evidence is append-only' >&2; exit 2; }

if [ "$action" = plan ]; then
  RELEASE_ID="$RELEASE_ID" CAPACITY_PROFILE="$CAPACITY_PROFILE" CAPACITY_CAPTURE_TARGET_URL="$CAPACITY_CAPTURE_TARGET_URL" CAPACITY_CAPTURE_OUTPUT="$CAPACITY_CAPTURE_OUTPUT" node - <<'NODE'
const plan = {
  schema_version: '1',
  action: 'capacity_capture_plan',
  network_activity: false,
  release_id: process.env.RELEASE_ID,
  profile: process.env.CAPACITY_PROFILE,
  target_url: process.env.CAPACITY_CAPTURE_TARGET_URL,
  output: process.env.CAPACITY_CAPTURE_OUTPUT,
  target_kind: 'isolated_preproduction',
  produces_cloud_gate_evidence: false,
  required_confirmation: `CAPACITY_CAPTURE_CONFIRM=${process.env.RELEASE_ID}`,
  next_command: 'sh infra/scripts/capture-ecs-capacity-evidence.sh capture',
  post_capture_validation: 'sh infra/scripts/capture-ecs-capacity-evidence.sh validate',
  warning: 'The capture is a long-running load test. It produces raw observations only and cannot satisfy the production capacity gate by itself.',
}
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
NODE
  exit 0
fi

if [ "$action" = validate ]; then
  [ -f "$CAPACITY_CAPTURE_OUTPUT" ] && [ ! -L "$CAPACITY_CAPTURE_OUTPUT" ] || { echo 'capacity capture output file not found' >&2; exit 2; }
  npx --no-install tsx tests/capacity-evidence-gate.ts --file "$CAPACITY_CAPTURE_OUTPUT" --release-id "$RELEASE_ID" --profile "$CAPACITY_PROFILE"
  node --input-type=module - "$CAPACITY_CAPTURE_OUTPUT" "$RELEASE_ID" <<'NODE'
import { readFileSync } from 'node:fs'
const [path, releaseId] = process.argv.slice(2)
const value = JSON.parse(readFileSync(path, 'utf8'))
if (value.release_id !== releaseId) throw new Error('raw capacity observations are not bound to the requested release')
if (value.mode !== 'real_cloud') throw new Error('raw capacity observations must use real_cloud mode')
if (value.cloud_gate !== false) throw new Error('raw capture must not claim cloud_gate=true')
if (value.coverage !== 'api_http_and_job_admission') throw new Error('raw capture coverage is missing or unexpected')
console.log(`raw capacity observations validated (not production gate evidence): ${path}`)
NODE
  exit 0
fi

[ "${CAPACITY_CAPTURE_TARGET_KIND:-}" = isolated_preproduction ] || { echo 'capture requires CAPACITY_CAPTURE_TARGET_KIND=isolated_preproduction' >&2; exit 2; }
[ "${CAPACITY_CAPTURE_CONFIRM:-}" = "$RELEASE_ID" ] || { echo "capture requires CAPACITY_CAPTURE_CONFIRM=$RELEASE_ID" >&2; exit 2; }
: "${CAPACITY_WORKLOAD_TOKEN:?CAPACITY_WORKLOAD_TOKEN is required for capture}"
: "${CAPACITY_CAPTURE_EXPECTED_GIT_SHA:?CAPACITY_CAPTURE_EXPECTED_GIT_SHA is required for capture}"
printf '%s' "$CAPACITY_CAPTURE_EXPECTED_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo 'CAPACITY_CAPTURE_EXPECTED_GIT_SHA must be a full lowercase Git SHA' >&2; exit 2; }

# Bind the target to the exact reviewed release before sending any load. The
# identity probe is a single GET, does not follow redirects, and fails closed.
CAPACITY_CAPTURE_TARGET_URL="$CAPACITY_CAPTURE_TARGET_URL" \
CAPACITY_CAPTURE_RELEASE_ID="$RELEASE_ID" \
CAPACITY_CAPTURE_EXPECTED_GIT_SHA="$CAPACITY_CAPTURE_EXPECTED_GIT_SHA" \
CAPACITY_WORKLOAD_TOKEN="$CAPACITY_WORKLOAD_TOKEN" node --input-type=module <<'NODE'
const base = new URL(process.env.CAPACITY_CAPTURE_TARGET_URL)
const response = await fetch(new URL('/releasez', base), {
  redirect: 'manual',
  headers: { authorization: `Bearer ${process.env.CAPACITY_WORKLOAD_TOKEN}` },
})
if (!response.ok) throw new Error(`capacity target release identity probe failed with HTTP ${response.status}`)
const body = await response.json()
const release = body?.data?.release
if (release?.release_id !== process.env.CAPACITY_CAPTURE_RELEASE_ID) throw new Error('capacity target release_id does not match the requested release')
if (release?.release_git_sha !== process.env.CAPACITY_CAPTURE_EXPECTED_GIT_SHA) throw new Error('capacity target release_git_sha does not match the reviewed commit')
if (release?.ready !== true && body?.data?.ready !== true) throw new Error('capacity target release identity is not ready')
console.log(`capacity target identity verified: ${release.release_id} ${release.release_git_sha}`)
NODE

# The raw report declares api_http_and_job_admission coverage, so the isolated
# target must actually exercise job admission instead of recording zero jobs.
CAPACITY_WORKLOAD_MODE=real_cloud \
CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD=true \
CAPACITY_WORKLOAD_URL="$CAPACITY_CAPTURE_TARGET_URL" \
CAPACITY_WORKLOAD_PROFILE="$CAPACITY_PROFILE" \
CAPACITY_WORKLOAD_RELEASE_ID="$RELEASE_ID" \
CAPACITY_WORKLOAD_SOFTWARE_VERSION="$RELEASE_ID" \
CAPACITY_WORKLOAD_OUTPUT="$CAPACITY_CAPTURE_OUTPUT" \
CAPACITY_WORKLOAD_SETUP_JOBS=true \
CAPACITY_WORKLOAD_TOKEN="$CAPACITY_WORKLOAD_TOKEN" \
  npx --no-install tsx "$root/tests/capacity-workload.ts"

echo 'raw observation capture completed; this is not production capacity gate evidence'
echo "validate with: RELEASE_ID=$RELEASE_ID CAPACITY_PROFILE=$CAPACITY_PROFILE CAPACITY_CAPTURE_TARGET_URL=$CAPACITY_CAPTURE_TARGET_URL CAPACITY_CAPTURE_OUTPUT=$CAPACITY_CAPTURE_OUTPUT sh infra/scripts/capture-ecs-capacity-evidence.sh validate"
