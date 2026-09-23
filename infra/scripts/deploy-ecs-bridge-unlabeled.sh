#!/bin/sh
set -eu

# B-only takeover of the seven historical, label-free API/worker containers.
# The existing external 80/443 gateway and schema 242 are never mutated here.
control_root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
helper=/usr/local/libexec/merchant/ecs-preidentity-recovery
: "${CONFIRM_ECS_DEPLOY:?CONFIRM_ECS_DEPLOY=YES is required}"
: "${ECS_BRIDGE_SOURCE_ROOT:?verified B source root is required}"
: "${ECS_BRIDGE_FULL_COMPOSE_PATH:?full B rendered Compose is required}"
: "${ECS_BRIDGE_SCOPED_COMPOSE_PATH:?seven-service B rendered Compose is required}"
: "${ECS_CANDIDATE_IDENTITY_PATH:?B candidate identity is required}"
: "${ECS_CANDIDATE_SOURCE_ARCHIVE:?B candidate source archive is required}"
: "${ECS_RELEASE_IMAGES_PATH:?B six-image package is required}"
: "${ECS_EIGHT_IMAGE_SET_PATH:?B eight-image set is required}"
: "${ECS_PREIDENTITY_SERVICE_MAP_PATH:?protected old seven-service map is required}"
: "${ECS_ROLLBACK_PLAN_PATH:?protected old rollback plan is required}"
: "${ECS_ROLLBACK_COMPOSE_PATH:?protected old Compose/spec capsule is required}"
: "${ECS_ROLLBACK_ENV_FILE:?protected old environment capsule is required}"
: "${ECS_ROLLBACK_IMAGE_DIGESTS_PATH:?protected old image digests are required}"
: "${ECS_DEPLOY_STATE_DIR:?protected deployment state directory is required}"
: "${ECS_DEPLOY_LOCK_PATH:?protected deployment lock is required}"
: "${ECS_EXTERNAL_GATEWAY_ID:?exact old external gateway ID is required}"
: "${ECS_BRIDGE_CANDIDATE_PROJECT:?dedicated candidate Compose project is required}"
: "${PRODUCTION_CONFIG_PATH:?production config is required}"
: "${PRODUCTION_API_BASE_URL:?production API HTTPS base URL is required}"
: "${PRODUCTION_APPROVED_ORIGIN:?approved HTTPS origin is required}"
: "${DATABASE_URL:?production database URL is required}"
: "${DEPLOYMENT_NONCE:?deployment nonce is required}"
: "${RELEASE_ID:?B release ID is required}"
: "${IMAGE_DIGESTS_JSON:?full eight-image digest set is required}"
: "${PRODUCTION_CANARY_BEARER_TOKEN:?authenticated merchant canary token is required}"
: "${PRODUCTION_CANARY_WORKSPACE_ID:?merchant canary workspace is required}"
: "${POST_DEPLOY_CANARY_OUTPUT:?post-deploy canary output is required}"
[ "$CONFIRM_ECS_DEPLOY" = YES ] && [ "${DEPLOYMENT_SCOPE:-full}" = full ] && [ "${EXPECTED_MIGRATION_VERSION:-}" = 244 ] && [ "${BRIDGE_SCHEMA_COMPATIBILITY_MODE:-}" = prefix_242_or_244 ] || { echo 'B takeover requires full scope, candidate tail 244 and 242/244 bridge mode' >&2; exit 2; }
printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo 'unsafe B release ID' >&2; exit 2; }
printf '%s' "$ECS_EXTERNAL_GATEWAY_ID" | grep -Eq '^[0-9a-f]{64}$' || { echo 'external gateway ID must be full length' >&2; exit 2; }
printf '%s' "$ECS_BRIDGE_CANDIDATE_PROJECT" | grep -Eq '^bridge[a-z0-9_-]{1,56}$' || { echo 'dedicated candidate project is invalid' >&2; exit 2; }
[ "$ECS_BRIDGE_CANDIDATE_PROJECT" != merchant-production ] || exit 2
for tool in docker node ruby curl flock shasum git python3 cmp find; do command -v "$tool" >/dev/null 2>&1 || { echo "missing B takeover tool: $tool" >&2; exit 2; }; done
owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
protected() {
  path=$1
  [ -e "$path" ] && [ ! -L "$path" ] && [ "$(owner_of "$path")" = 0 ] || { echo "B protected path is missing, symlinked or unowned: $path" >&2; exit 2; }
  mode=$(mode_of "$path"); case "$mode" in *[2367][0-7]|*[2367]) echo "B protected path is group/other writable: $path" >&2; exit 2 ;; esac
  parent=$(dirname "$path")
  while [ "$parent" != / ]; do
    [ ! -L "$parent" ] && [ "$(owner_of "$parent")" = 0 ] || { echo "B protected path parent is unsafe: $parent" >&2; exit 2; }
    mode=$(mode_of "$parent"); case "$mode" in *[2367][0-7]|*[2367]) echo "B protected path parent is writable: $parent" >&2; exit 2 ;; esac
    parent=$(dirname "$parent")
  done
}
for path in "$helper" /run/release-security/evidence-trust/production-preidentity-recovery-sha256 "$ECS_PREIDENTITY_SERVICE_MAP_PATH" "$ECS_ROLLBACK_PLAN_PATH" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_ENV_FILE" "$ECS_ROLLBACK_IMAGE_DIGESTS_PATH" "$ECS_DEPLOY_STATE_DIR" "$ECS_DEPLOY_LOCK_PATH" "$ECS_BRIDGE_FULL_COMPOSE_PATH" "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" "$ECS_CANDIDATE_IDENTITY_PATH" "$ECS_CANDIDATE_SOURCE_ARCHIVE" "$ECS_RELEASE_IMAGES_PATH" "$ECS_EIGHT_IMAGE_SET_PATH" "$PRODUCTION_CONFIG_PATH"; do protected "$path"; done
[ -x "$helper" ] && [ -f "$helper" ] && [ -d "$ECS_DEPLOY_STATE_DIR" ] && [ -f "$ECS_DEPLOY_LOCK_PATH" ] || { echo 'B protected release controls are incomplete' >&2; exit 2; }
node_path=$(sed -n '1s/^#!//p' "$helper")
case "$node_path" in /*) protected "$node_path" ;; *) echo 'protected helper shebang does not name a reviewed runtime' >&2; exit 2 ;; esac
[ -x "$node_path" ] && [ -f "$node_path" ] || { echo 'protected helper Node runtime is invalid' >&2; exit 2; }
node "$control_root/infra/scripts/verify-ecs-bridge-control-install.mjs" "$control_root/infra/protected/ecs-preidentity-recovery.mjs" "$helper" /run/release-security/evidence-trust/production-preidentity-recovery-sha256
exec 9>>"$ECS_DEPLOY_LOCK_PATH"
flock -n 9 || { echo 'another release holds the production mutation lock' >&2; exit 1; }
full_compose_digest=$(shasum -a 256 "$ECS_BRIDGE_FULL_COMPOSE_PATH" | awk '{print $1}')
scoped_compose_digest=$(shasum -a 256 "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" | awk '{print $1}')
assert_frozen_compose() {
  [ "$(shasum -a 256 "$ECS_BRIDGE_FULL_COMPOSE_PATH" | awk '{print $1}')" = "$full_compose_digest" ] &&
    [ "$(shasum -a 256 "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" | awk '{print $1}')" = "$scoped_compose_digest" ] || { echo 'reviewed B Compose changed during bridge attempt' >&2; exit 1; }
}

# Read-only package, evidence, source, migration-prefix and rendered-image
# gates remain mandatory. The scoped Compose may only remove dependencies and
# add exact external network attachments for these seven unchanged services.
b_source=$(CDPATH='' cd -- "$ECS_BRIDGE_SOURCE_ROOT" && pwd -P)
protected "$b_source"
[ -f "$b_source/.candidate-identity" ] && [ -f "$b_source/.candidate-source.tar" ] && [ ! -L "$b_source/.candidate-identity" ] && [ ! -L "$b_source/.candidate-source.tar" ] || { echo 'staged B source identity/archive pair is missing' >&2; exit 2; }
protected "$b_source/.candidate-identity"
protected "$b_source/.candidate-source.tar"
cmp -s "$b_source/.candidate-identity" "$ECS_CANDIDATE_IDENTITY_PATH" && cmp -s "$b_source/.candidate-source.tar" "$ECS_CANDIDATE_SOURCE_ARCHIVE" || { echo 'staged B source package differs from reviewed B package' >&2; exit 2; }
staged_git_sha=$(sed -n 's/^git_sha=//p' "$ECS_CANDIDATE_IDENTITY_PATH")
[ "$(git get-tar-commit-id < "$ECS_CANDIDATE_SOURCE_ARCHIVE" 2>/dev/null)" = "$staged_git_sha" ] || { echo 'B source archive embedded Git commit differs from identity' >&2; exit 2; }
SOURCE_ARCHIVE="$ECS_CANDIDATE_SOURCE_ARCHIVE" SOURCE_ROOT="$b_source" python3 <<'PY'
import hashlib, os, pathlib, stat, tarfile
root = pathlib.Path(os.environ['SOURCE_ROOT']).resolve()
with tarfile.open(os.environ['SOURCE_ARCHIVE'], 'r:') as source:
    seen = set()
    for member in source.getmembers():
        if member.name in seen or member.issym() or member.islnk():
            raise SystemExit(f'B source archive has duplicate or linked member: {member.name}')
        seen.add(member.name)
        if not member.isfile():
            continue
        target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
        if root not in target.resolve().parents or not target.is_file():
            raise SystemExit(f'B staged source member missing or outside package: {member.name}')
        cursor = target
        while cursor != root:
            details = cursor.lstat()
            if stat.S_ISLNK(details.st_mode) or details.st_uid != 0 or details.st_mode & 0o022:
                raise SystemExit(f'B staged source member is mutable or linked: {member.name}')
            cursor = cursor.parent
        expected = hashlib.sha256()
        with source.extractfile(member) as archive_file:
            for chunk in iter(lambda: archive_file.read(1024 * 1024), b''):
                expected.update(chunk)
        actual = hashlib.sha256()
        with target.open('rb') as staged_file:
            for chunk in iter(lambda: staged_file.read(1024 * 1024), b''):
                actual.update(chunk)
        if expected.digest() != actual.digest():
            raise SystemExit(f'B staged source member differs from reviewed archive: {member.name}')
PY
RENDERED_COMPOSE_PATH="$ECS_BRIDGE_FULL_COMPOSE_PATH" sh "$b_source/infra/scripts/deploy-preflight-ecs.sh" "$PRODUCTION_CONFIG_PATH"
node "$b_source/infra/scripts/verify-bridge-b-package.mjs" \
  --candidate-identity "$ECS_CANDIDATE_IDENTITY_PATH" --source-archive "$ECS_CANDIDATE_SOURCE_ARCHIVE" \
  --release-images "$ECS_RELEASE_IMAGES_PATH" --eight-image-set "$ECS_EIGHT_IMAGE_SET_PATH" \
  --rendered-compose "$ECS_BRIDGE_FULL_COMPOSE_PATH" --rollback-plan "$ECS_ROLLBACK_PLAN_PATH" \
  --rollback-compose "$ECS_ROLLBACK_COMPOSE_PATH" --rollback-env "$ECS_ROLLBACK_ENV_FILE" \
  --rollback-image-digests-json "$ECS_ROLLBACK_IMAGE_DIGESTS_PATH"
node "$control_root/infra/scripts/validate-ecs-bridge-scoped-compose.mjs" "$ECS_BRIDGE_FULL_COMPOSE_PATH" "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" "$ECS_BRIDGE_CANDIDATE_PROJECT"
assert_frozen_compose
image_set_digest=$(ruby "$b_source/infra/scripts/validate-ecs-compose-release.rb" "$ECS_BRIDGE_FULL_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON" --print-image-set-digest)
manifest_sha256=$(ruby "$b_source/infra/scripts/validate-ecs-compose-release.rb" "$ECS_BRIDGE_FULL_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON" --print-manifest-sha256)
release_git_sha=$(sed -n 's/^git_sha=//p' "$ECS_CANDIDATE_IDENTITY_PATH")
[ "$(sed -n 's/^release_id=//p' "$ECS_CANDIDATE_IDENTITY_PATH")" = "$RELEASE_ID" ] || { echo 'B package release ID differs from request' >&2; exit 2; }
[ -z "$(docker ps -a -q --no-trunc --filter "label=com.docker.compose.project=$ECS_BRIDGE_CANDIDATE_PROJECT")" ] || { echo 'candidate project is not empty before nonce consumption' >&2; exit 2; }
for ref in $(docker compose -p "$ECS_BRIDGE_CANDIDATE_PROJECT" -f "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" config --images); do docker image inspect "$ref" >/dev/null || { echo 'a fixed B image is unavailable locally' >&2; exit 1; }; done

# This is a recovery precondition, not a soft warning: if the old public
# readyz is already failing, reverting B cannot reach a signed healthy end
# state. A stale scanner callback requires a real permitted canary, never a
# fabricated heartbeat or an extended TTL.
curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/livez" >/dev/null
curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz" >/dev/null
assert_frozen_compose

IMAGE_DIGEST="$image_set_digest" PRODUCTION_EVIDENCE_MANIFEST_SHA256="$manifest_sha256" RELEASE_GIT_SHA="$release_git_sha" PRODUCTION_EVIDENCE_REPO_ROOT="$b_source" \
  sh "$b_source/infra/scripts/consume-production-evidence-nonce.sh"
docker compose -p "$ECS_BRIDGE_CANDIDATE_PROJECT" -f "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" create --no-build --pull never --no-recreate -y \
  api-replica worker-automation worker-generation worker-publish worker-reconcile worker-scan worker-sync
assert_frozen_compose
candidate_map="$ECS_DEPLOY_STATE_DIR/${RELEASE_ID}.bridge-candidate-map.json"
node "$control_root/infra/scripts/create-ecs-bridge-candidate-map.mjs" "$ECS_BRIDGE_CANDIDATE_PROJECT" "$candidate_map"
state="$ECS_DEPLOY_STATE_DIR/${RELEASE_ID}.bridge-unlabeled.json"
attempt="attempt_$(printf '%s:%s:%s' "$RELEASE_ID" "$DEPLOYMENT_NONCE" "$$" | shasum -a 256 | awk '{print $1}')"
DATABASE_URL="$DATABASE_URL" "$helper" capture --mode bridge_unlabeled_code_only --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
  --attempt-id "$attempt" --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --candidate-service-map "$candidate_map" \
  --external-gateway-id "$ECS_EXTERNAL_GATEWAY_ID" --compose-project merchant-production \
  --candidate-release-id "$RELEASE_ID" --candidate-git-sha "$release_git_sha" --candidate-manifest-sha256 "$manifest_sha256" \
  --candidate-image-set-digest "$image_set_digest" --candidate-image-digests "$ECS_EIGHT_IMAGE_SET_PATH" \
  --candidate-compose "$ECS_BRIDGE_SCOPED_COMPOSE_PATH" --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH"
"$helper" phase --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" --phase nonce_consumed
mutation_started=false
rollback_on_failure() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$mutation_started" = true ]; then
    if DATABASE_URL="$DATABASE_URL" "$helper" bridge-recover-unlabeled --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
      --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --compose-project merchant-production \
      --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH" --production-api-base-url "$PRODUCTION_API_BASE_URL"; then
      finalization_deadline=$(( $(date +%s) + 45 ))
      while ! DATABASE_URL="$DATABASE_URL" "$helper" bridge-finalize --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
        --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --compose-project merchant-production \
        --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH" --production-api-base-url "$PRODUCTION_API_BASE_URL"; do
        if [ "$(date +%s)" -ge "$finalization_deadline" ]; then
          echo 'B original container IDs restored but old public identity is not verified; signed journal remains retryable' >&2
          break
        fi
        sleep 2
      done
    else echo 'signed B unlabeled recovery failed; old containers and journal retained for manual recovery' >&2; fi
  fi
  exit "$status"
}
trap rollback_on_failure EXIT HUP INT TERM
DATABASE_URL="$DATABASE_URL" "$helper" bridge-begin --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
  --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --compose-project merchant-production \
  --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH" --production-api-base-url "$PRODUCTION_API_BASE_URL"
mutation_started=true
DATABASE_URL="$DATABASE_URL" "$helper" bridge-switch-unlabeled --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
  --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --compose-project merchant-production \
  --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH" --production-api-base-url "$PRODUCTION_API_BASE_URL"
deadline=$(( $(date +%s) + ${ECS_POST_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300} ))
while ! curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/livez" >/dev/null 2>&1 || \
      ! curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo 'B API failed livez/readyz before bounded deadline' >&2; exit 1; }
  sleep 2
done
PUBLIC_RELEASE_ID="$RELEASE_ID" PUBLIC_GIT_SHA="$release_git_sha" PUBLIC_MANIFEST_SHA="$manifest_sha256" PUBLIC_IMAGE_SET="$image_set_digest" \
  PUBLIC_RELEASE_JSON="$(curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/releasez")" node <<'NODE'
const body = JSON.parse(process.env.PUBLIC_RELEASE_JSON)
const actual = body.data?.release ?? body.release
const expected = {release_id:process.env.PUBLIC_RELEASE_ID,release_git_sha:process.env.PUBLIC_GIT_SHA,manifest_sha256:process.env.PUBLIC_MANIFEST_SHA,image_set_digest:process.env.PUBLIC_IMAGE_SET}
for (const [key,value] of Object.entries(expected)) if (actual?.[key] !== value) throw new Error(`B public release identity mismatch before business canary: ${key}`)
NODE
curl --fail --silent --show-error --max-time 20 -H "authorization: Bearer $PRODUCTION_CANARY_BEARER_TOKEN" \
  -H "x-workspace-id: $PRODUCTION_CANARY_WORKSPACE_ID" "${PRODUCTION_API_BASE_URL%/}/v1/products?limit=1&offset=0" >/dev/null
if [ "${PLATFORM_OPERATIONS_MODE:-}" = manual ]; then
  sh "$b_source/infra/scripts/run-manual-operations-canary.sh"
else
  [ "${PLATFORM_OPERATIONS_MODE:-}" = official_api ] || { echo 'B full acceptance requires a reviewed operations mode' >&2; exit 1; }
  PLATFORM_CANARY_BASE_EVIDENCE="$CAPABILITY_EVIDENCE_PATH" PLATFORM_CANARY_OUTPUT="$POST_DEPLOY_CANARY_OUTPUT" \
    PRODUCTION_API_BASE_URL="$PRODUCTION_API_BASE_URL" RELEASE_GIT_SHA="$release_git_sha" RELEASE_MANIFEST_SHA256="$manifest_sha256" \
    RELEASE_IMAGE_SET_DIGEST="$image_set_digest" sh "$b_source/infra/scripts/run-production-canary.sh"
  trusted_key_id=$(sed -n '1p' /run/release-security/evidence-trust/production-evidence-key-id)
  npx --no-install tsx "$b_source/tests/capability-evidence-gate.ts" --file "$POST_DEPLOY_CANARY_OUTPUT" --require-canary --require-signed-production \
    --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" \
    --deployment-nonce "$DEPLOYMENT_NONCE" --public-key /run/release-security/evidence-trust/production-evidence-public.pem --key-id "$trusted_key_id"
fi
DATABASE_URL="$DATABASE_URL" "$helper" bridge-verify --state "$state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
  --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --compose-project merchant-production \
  --deployment-nonce "$DEPLOYMENT_NONCE" --production-api-base-url "$PRODUCTION_API_BASE_URL"
mutation_started=false
trap - EXIT HUP INT TERM
echo "B code-only takeover verified: release=$RELEASE_ID schema=242 gateway_unchanged=true"
