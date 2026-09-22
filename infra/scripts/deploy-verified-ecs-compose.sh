#!/bin/sh
set -eu

# Apply an already-rendered, digest-pinned ECS Compose release. This script is
# intentionally host-local: transport and SSH remain an operator boundary.
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
readonly ECS_PREIDENTITY_RECOVERY_ENTRYPOINT=/usr/local/libexec/merchant/ecs-preidentity-recovery

: "${CONFIRM_ECS_DEPLOY:?Set CONFIRM_ECS_DEPLOY=YES after reviewing the exact candidate}"
: "${PRODUCTION_CONFIG_PATH:?PRODUCTION_CONFIG_PATH is required}"
: "${RENDERED_COMPOSE_PATH:?RENDERED_COMPOSE_PATH is required}"
: "${ECS_CANDIDATE_IDENTITY_PATH:?ECS_CANDIDATE_IDENTITY_PATH is required}"
: "${ECS_DEPLOY_STATE_DIR:?ECS_DEPLOY_STATE_DIR is required}"
: "${ECS_PREIDENTITY_SERVICE_MAP_PATH:?ECS_PREIDENTITY_SERVICE_MAP_PATH is required}"
: "${ECS_DEPLOY_LOCK_PATH:?ECS_DEPLOY_LOCK_PATH is required}"
: "${ECS_ROLLBACK_ENTRYPOINT:?ECS_ROLLBACK_ENTRYPOINT is required}"
: "${ECS_ROLLBACK_PLAN_PATH:?ECS_ROLLBACK_PLAN_PATH is required}"
: "${ECS_ROLLBACK_COMPOSE_PATH:?ECS_ROLLBACK_COMPOSE_PATH is required}"
: "${ECS_ROLLBACK_ENV_FILE:?ECS_ROLLBACK_ENV_FILE is required}"
: "${ECS_ROLLBACK_IMAGE_DIGESTS_JSON:?ECS_ROLLBACK_IMAGE_DIGESTS_JSON is required}"
: "${ECS_ROLLBACK_STATE_PATH:?ECS_ROLLBACK_STATE_PATH is required}"
: "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required}"
: "${PRODUCTION_APPROVED_ORIGIN:?PRODUCTION_APPROVED_ORIGIN is required}"
: "${PRODUCTION_CANARY_BEARER_TOKEN:?PRODUCTION_CANARY_BEARER_TOKEN is required}"
: "${PRODUCTION_CANARY_WORKSPACE_ID:?PRODUCTION_CANARY_WORKSPACE_ID is required}"
: "${POST_DEPLOY_CANARY_OUTPUT:?POST_DEPLOY_CANARY_OUTPUT is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${IMAGE_DIGESTS_JSON:?IMAGE_DIGESTS_JSON is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"

[ "$CONFIRM_ECS_DEPLOY" = YES ] || { echo 'ECS deployment refused: confirmation must equal YES' >&2; exit 2; }
printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo 'unsafe RELEASE_ID' >&2; exit 2; }
printf '%s' "${ECS_COMPOSE_PROJECT:-merchant-production}" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,62}$' || { echo 'unsafe ECS_COMPOSE_PROJECT' >&2; exit 2; }
printf '%s' "${ECS_COMPOSE_WAIT_TIMEOUT_SECONDS:-300}" | grep -Eq '^[1-9][0-9]{0,3}$' || { echo 'invalid ECS_COMPOSE_WAIT_TIMEOUT_SECONDS' >&2; exit 2; }
printf '%s' "${ECS_POST_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300}" | grep -Eq '^[1-9][0-9]{0,3}$' || { echo 'invalid ECS_POST_DEPLOY_HEALTH_TIMEOUT_SECONDS' >&2; exit 2; }
APP_URL="$PRODUCTION_API_BASE_URL" APPROVED_ORIGIN="$PRODUCTION_APPROVED_ORIGIN" node -e '
  const app=new URL(process.env.APP_URL),approved=new URL(process.env.APPROVED_ORIGIN)
  const exactOrigin=url=>url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==="/"&&url.href===url.origin+"/"
  const safeBase=url=>url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash&&(url.pathname==="/"||/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname))
  const prefix=app.pathname==="/"?"":app.pathname.replace(/\/$/,"")
  if(!exactOrigin(approved)||!safeBase(app)||app.origin!==approved.origin||![app.origin+prefix,app.origin+prefix+"/"].includes(process.env.APP_URL)) throw new Error("production API URL must be a canonical path under the approved HTTPS origin")
' || { echo 'PRODUCTION_API_BASE_URL must be a canonical HTTPS path under PRODUCTION_APPROVED_ORIGIN' >&2; exit 2; }
for path in "$PRODUCTION_CONFIG_PATH" "$RENDERED_COMPOSE_PATH" "$ECS_CANDIDATE_IDENTITY_PATH"; do
  [ -f "$path" ] && [ ! -L "$path" ] || { echo "deployment input must be a regular non-symlink file: $path" >&2; exit 2; }
done
[ -x "$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" ] && [ -f "$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" ] && [ ! -L "$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" ] || { echo 'protected preidentity recovery entrypoint is not installed safely' >&2; exit 2; }
[ -f "$ECS_PREIDENTITY_SERVICE_MAP_PATH" ] && [ ! -L "$ECS_PREIDENTITY_SERVICE_MAP_PATH" ] || { echo 'preidentity reviewed service map must be a regular non-symlink file' >&2; exit 2; }
for path in "$ECS_ROLLBACK_PLAN_PATH" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_ENV_FILE"; do
  [ -f "$path" ] && [ ! -L "$path" ] || { echo "rollback capsule input must be a regular non-symlink file: $path" >&2; exit 2; }
  case "$path" in /*) ;; *) echo "rollback capsule input must be absolute: $path" >&2; exit 2 ;; esac
done
[ -d "$ECS_DEPLOY_STATE_DIR" ] && [ ! -L "$ECS_DEPLOY_STATE_DIR" ] || { echo 'ECS_DEPLOY_STATE_DIR must be an existing non-symlink directory' >&2; exit 2; }
case "$ECS_DEPLOY_STATE_DIR" in /*) ;; *) echo 'ECS_DEPLOY_STATE_DIR must be absolute' >&2; exit 2 ;; esac
case "$ECS_DEPLOY_LOCK_PATH" in /*) ;; *) echo 'ECS_DEPLOY_LOCK_PATH must be absolute' >&2; exit 2 ;; esac
[ -x "$ECS_ROLLBACK_ENTRYPOINT" ] && [ -f "$ECS_ROLLBACK_ENTRYPOINT" ] && [ ! -L "$ECS_ROLLBACK_ENTRYPOINT" ] || { echo 'ECS_ROLLBACK_ENTRYPOINT must be a regular non-symlink executable' >&2; exit 2; }
case "$ECS_ROLLBACK_ENTRYPOINT" in /*) ;; *) echo 'ECS_ROLLBACK_ENTRYPOINT must be absolute' >&2; exit 2 ;; esac
state_dir=$(CDPATH='' cd -- "$ECS_DEPLOY_STATE_DIR" && pwd -P)
rollback_dir=$(CDPATH='' cd -- "$(dirname "$ECS_ROLLBACK_ENTRYPOINT")" && pwd -P)
lock_dir=$(CDPATH='' cd -- "$(dirname "$ECS_DEPLOY_LOCK_PATH")" && pwd -P)
[ "$state_dir" = "$ECS_DEPLOY_STATE_DIR" ] || { echo 'ECS_DEPLOY_STATE_DIR must be canonical' >&2; exit 2; }
[ "$rollback_dir/$(basename "$ECS_ROLLBACK_ENTRYPOINT")" = "$ECS_ROLLBACK_ENTRYPOINT" ] || { echo 'ECS_ROLLBACK_ENTRYPOINT must be canonical' >&2; exit 2; }
[ "$lock_dir/$(basename "$ECS_DEPLOY_LOCK_PATH")" = "$ECS_DEPLOY_LOCK_PATH" ] || { echo 'ECS_DEPLOY_LOCK_PATH must be canonical' >&2; exit 2; }
case "$state_dir/" in "$root/"*) echo 'deployment state must be stored outside the mutable repository' >&2; exit 2 ;; esac
case "$rollback_dir/" in "$root/"*) echo 'rollback entrypoint must be provisioned outside the mutable repository' >&2; exit 2 ;; esac
case "$lock_dir/" in "$root/"*) echo 'deployment lock must be provisioned outside the mutable repository' >&2; exit 2 ;; esac
for tool in docker curl node ruby git shasum flock cmp python3; do command -v "$tool" >/dev/null 2>&1 || { echo "ECS deployment requires $tool" >&2; exit 2; }; done

owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
assert_protected() {
  protected=$1 label=$2
  [ ! -L "$protected" ] || { echo "$label must not be a symlink" >&2; exit 2; }
  [ "$(owner_of "$protected")" = 0 ] || { echo "$label must be owned by root" >&2; exit 2; }
  mode=$(mode_of "$protected"); case "$mode" in *[2367][0-7]|*[2367]) echo "$label must not be writable by group or other users" >&2; exit 2 ;; esac
}
assert_parent_chain() {
  parent=$1 label=$2
  while [ "$parent" != / ]; do assert_protected "$parent" "$label parent"; parent=$(dirname "$parent"); done
}
assert_protected "$state_dir" 'deployment state directory'
assert_parent_chain "$state_dir" 'deployment state directory'
[ -f "$ECS_DEPLOY_LOCK_PATH" ] && [ ! -L "$ECS_DEPLOY_LOCK_PATH" ] || { echo 'ECS_DEPLOY_LOCK_PATH must be a pre-provisioned regular file' >&2; exit 2; }
assert_protected "$ECS_DEPLOY_LOCK_PATH" 'deployment lock'
assert_parent_chain "$lock_dir" 'deployment lock'
assert_protected "$ECS_ROLLBACK_ENTRYPOINT" 'rollback entrypoint'
assert_protected "$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" 'preidentity recovery entrypoint'
assert_protected "$ECS_PREIDENTITY_SERVICE_MAP_PATH" 'preidentity reviewed service map'
for protected_input in "$ECS_ROLLBACK_PLAN_PATH" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_ENV_FILE"; do
  assert_protected "$protected_input" 'rollback capsule input'
  assert_parent_chain "$(dirname "$protected_input")" 'rollback capsule input'
done
rollback_state_dir=$(CDPATH='' cd -- "$(dirname "$ECS_ROLLBACK_STATE_PATH")" && pwd -P)
[ "$rollback_state_dir/$(basename "$ECS_ROLLBACK_STATE_PATH")" = "$ECS_ROLLBACK_STATE_PATH" ] || { echo 'ECS_ROLLBACK_STATE_PATH must be absolute and canonical' >&2; exit 2; }
assert_protected "$rollback_state_dir" 'rollback state directory'
assert_parent_chain "$rollback_state_dir" 'rollback state directory'
[ ! -e "$ECS_ROLLBACK_STATE_PATH" ] || { echo 'ECS_ROLLBACK_STATE_PATH already exists' >&2; exit 2; }
exec 9>>"$ECS_DEPLOY_LOCK_PATH"
flock -n 9 || { echo 'another ECS Compose deployment or rollback holds the production mutation lock' >&2; exit 1; }

identity_git_sha=$(sed -n 's/^git_sha=//p' "$ECS_CANDIDATE_IDENTITY_PATH")
identity_source_sha=$(sed -n 's/^source_sha256=sha256://p' "$ECS_CANDIDATE_IDENTITY_PATH")
identity_release_id=$(sed -n 's/^release_id=//p' "$ECS_CANDIDATE_IDENTITY_PATH")
for identity_field in release_id git_sha source_sha256 comparison_manifest_sha256 sync_plan_sha256; do
  [ "$(awk -F= -v key="$identity_field" '$1 == key { count++ } END { print count+0 }' "$ECS_CANDIDATE_IDENTITY_PATH")" -eq 1 ] || {
    echo "candidate identity must contain exactly one $identity_field" >&2; exit 2;
  }
done
[ "$identity_release_id" = "$RELEASE_ID" ] || { echo 'candidate identity release ID does not match requested release' >&2; exit 2; }
printf '%s' "$identity_source_sha" | grep -Eq '^[0-9a-f]{64}$' || { echo 'candidate identity source digest is invalid' >&2; exit 2; }
if [ -f "$root/.candidate-identity" ] && [ ! -L "$root/.candidate-identity" ] && [ -f "$root/.candidate-source.tar" ] && [ ! -L "$root/.candidate-source.tar" ]; then
  cmp -s "$root/.candidate-identity" "$ECS_CANDIDATE_IDENTITY_PATH" || { echo 'staged candidate identity does not match the deployment input' >&2; exit 2; }
  git_sha=$(sed -n 's/^git_sha=//p' "$root/.candidate-identity")
  embedded_sha=$(git get-tar-commit-id < "$root/.candidate-source.tar" 2>/dev/null || true)
  [ "$embedded_sha" = "$git_sha" ] || { echo 'staged source archive commit does not match the release identity' >&2; exit 2; }
  current_source_sha=$(shasum -a 256 "$root/.candidate-source.tar" | awk '{print $1}')
  ARCHIVE="$root/.candidate-source.tar" CHECKOUT="$root" python3 <<'PY'
import hashlib, os, pathlib, tarfile
root = pathlib.Path(os.environ['CHECKOUT']).resolve()
with tarfile.open(os.environ['ARCHIVE'], 'r:') as source:
    for member in source.getmembers():
        if not member.isfile():
            continue
        target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
        resolved = target.resolve()
        cursor = target
        unsafe_link = False
        while cursor != root:
            if cursor.is_symlink():
                unsafe_link = True
                break
            cursor = cursor.parent
        if unsafe_link or not target.is_file() or root not in resolved.parents:
            raise SystemExit(f'staged source member is missing or unsafe: {member.name}')
        expected = source.extractfile(member)
        digest = hashlib.sha256()
        while chunk := expected.read(1024 * 1024):
            digest.update(chunk)
        actual = hashlib.sha256()
        with target.open('rb') as value:
            while chunk := value.read(1024 * 1024):
                actual.update(chunk)
        if digest.digest() != actual.digest():
            raise SystemExit(f'staged source member differs from the verified archive: {member.name}')
PY
else
  git_sha=$(git -C "$root" rev-parse HEAD)
  [ -z "$(git -C "$root" status --porcelain --untracked-files=all)" ] || { echo 'ECS deployment requires a clean committed worktree' >&2; exit 2; }
  current_source_sha=$(git -C "$root" archive --format=tar "$git_sha" \
    ':(exclude)artifacts' ':(exclude)screenshots' | shasum -a 256 | awk '{print $1}')
fi
[ "$identity_git_sha" = "$git_sha" ] || { echo 'candidate identity Git SHA does not match the release checkout' >&2; exit 2; }
[ "$identity_source_sha" = "$current_source_sha" ] || { echo 'candidate identity source digest does not match committed release bytes' >&2; exit 2; }

verified_compose=$(mktemp "${TMPDIR:-/tmp}/merchant-ecs-compose.XXXXXXXX.yml")
verified_config=$(mktemp "${TMPDIR:-/tmp}/merchant-ecs-config.XXXXXXXX.yml")
mutation_started=false
rollback_attempted=false
runtime_cutover_started=false
external_gateway_state=
external_gateway_handoff_started=false
candidate_gateway_image=
candidate_gateway_network=
state_path=
cleanup() { rm -f -- "$verified_compose" "$verified_config"; }
external_gateway_action() {
  node "$root/infra/scripts/ecs-external-gateway-handoff.mjs" "$1" \
    --state "$external_gateway_state" --lock-path "$ECS_DEPLOY_LOCK_PATH" \
    --container-id "$ECS_EXTERNAL_GATEWAY_ID" --project "$ECS_EXTERNAL_GATEWAY_PROJECT" --service pilot-gateway \
    --required-network "$candidate_gateway_network"
}
restore_external_gateway() {
  # Stop only a gateway proven to belong to this candidate. Never remove it.
  # Other workload rollback still requires the ordinary signed identity checks.
  node --input-type=module - "$project" "$RELEASE_ID" "$candidate_gateway_image" <<'NODE' || return 1
import { execFileSync } from 'node:child_process'
const [project, release, image] = process.argv.slice(2)
const docker = args => execFileSync('/usr/bin/docker', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']})
try {
  const ids = docker(['ps','-a','-q','--no-trunc','--filter',`label=com.docker.compose.project=${project}`,'--filter','label=com.docker.compose.service=pilot-gateway']).trim().split(/\s+/).filter(Boolean)
  if (ids.length > 1) throw new Error('ambiguous candidate gateway')
  for (const id of ids) {
    const x = JSON.parse(docker(['inspect',id]))[0]
    const expected = JSON.parse(docker(['image','inspect',image]))[0]
    if (!x || x.Id !== id || x.Image !== expected.Id || x.Config?.Labels?.['com.storenova.release.id'] !== release || x.Config?.Labels?.['com.docker.compose.project'] !== project || x.Config?.Labels?.['com.docker.compose.service'] !== 'pilot-gateway') throw new Error('candidate gateway identity mismatch')
    if (x.State?.Running) docker(['stop','--time','30',id])
  }
} catch { console.error('candidate gateway could not be safely stopped; external recovery requires inspection'); process.exit(1) }
NODE
  external_gateway_action restore
}
rollback_on_failure() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$external_gateway_handoff_started" = true ]; then
    # This restores the old public listener, not the old API/worker release.
    restore_external_gateway || echo 'external gateway recovery failed; protected snapshot retained for operator recovery' >&2
  fi
  if [ "$mutation_started" = true ] && [ "$rollback_attempted" = false ]; then
    rollback_attempted=true
    recovery_succeeded=false
    if [ "$runtime_cutover_started" = false ]; then
      echo "ECS deployment failed before runtime cutover; invoking protected preidentity forward recovery" >&2
      # The helper verifies and locks inherited FD 9 against the canonical lock,
      # independently re-inspects the old workload/DB, and refuses partial cutover.
      DATABASE_URL="$DATABASE_URL" "$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" recover --state "$state_path" --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" \
        --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH" \
        --recovery-compose "$ECS_ROLLBACK_COMPOSE_PATH" --recovery-env "$ECS_ROLLBACK_ENV_FILE" \
        --recovery-image-digests "$rollback_capsule_dir/image-digests.json" --compose-project "$project" \
        --lock-path "$ECS_DEPLOY_LOCK_PATH" --production-api-base-url "$PRODUCTION_API_BASE_URL" && recovery_succeeded=true
    fi
    if [ "$recovery_succeeded" = false ]; then
      echo "ECS deployment failed after mutation; invoking protected rollback entrypoint" >&2
      flock -u 9
      # Ordinary rollback deliberately retains its complete /releasez current
      # identity check; no preidentity exception is passed into that executor.
      ECS_FAILED_RELEASE_ID="$RELEASE_ID" ECS_COMPOSE_PROJECT="$project" ECS_DEPLOY_LOCK_PATH="$ECS_DEPLOY_LOCK_PATH" \
        ECS_ROLLBACK_PLAN_PATH="$ECS_ROLLBACK_PLAN_PATH" ECS_ROLLBACK_COMPOSE_PATH="$ECS_ROLLBACK_COMPOSE_PATH" \
        ECS_ROLLBACK_ENV_FILE="$ECS_ROLLBACK_ENV_FILE" ECS_ROLLBACK_IMAGE_DIGESTS_JSON="$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" \
        ECS_ROLLBACK_STATE_PATH="$ECS_ROLLBACK_STATE_PATH" PRODUCTION_API_BASE_URL="$PRODUCTION_API_BASE_URL" DATABASE_URL="$DATABASE_URL" \
        sh "$root/infra/scripts/invoke-ecs-automatic-rollback.sh" || echo 'protected rollback entrypoint failed; production remains blocked' >&2
    fi
  fi
  cleanup
  exit "$status"
}
trap rollback_on_failure EXIT HUP INT TERM

# Work only from immutable copies, then detect source or copy changes both
# before and after the preflight (TOCTOU protection).
compose_source_before=$(shasum -a 256 "$RENDERED_COMPOSE_PATH" | awk '{print $1}')
config_source_before=$(shasum -a 256 "$PRODUCTION_CONFIG_PATH" | awk '{print $1}')
cp "$RENDERED_COMPOSE_PATH" "$verified_compose"
cp "$PRODUCTION_CONFIG_PATH" "$verified_config"
chmod 0400 "$verified_compose" "$verified_config"
[ "$compose_source_before" = "$(shasum -a 256 "$verified_compose" | awk '{print $1}')" ] || { echo 'rendered Compose changed while copying' >&2; exit 1; }
[ "$config_source_before" = "$(shasum -a 256 "$verified_config" | awk '{print $1}')" ] || { echo 'production config changed while copying' >&2; exit 1; }
RENDERED_COMPOSE_PATH="$verified_compose" sh "$root/infra/scripts/deploy-preflight-ecs.sh" "$verified_config"
[ "$compose_source_before" = "$(shasum -a 256 "$RENDERED_COMPOSE_PATH" | awk '{print $1}')" ] || { echo 'rendered Compose source changed after preflight' >&2; exit 1; }
[ "$config_source_before" = "$(shasum -a 256 "$PRODUCTION_CONFIG_PATH" | awk '{print $1}')" ] || { echo 'production config source changed after preflight' >&2; exit 1; }
[ "$compose_source_before" = "$(shasum -a 256 "$verified_compose" | awk '{print $1}')" ] || { echo 'verified Compose changed during preflight' >&2; exit 1; }
[ "$config_source_before" = "$(shasum -a 256 "$verified_config" | awk '{print $1}')" ] || { echo 'verified production config changed during preflight' >&2; exit 1; }
assert_inputs_unchanged() {
  [ "$compose_source_before" = "$(shasum -a 256 "$RENDERED_COMPOSE_PATH" | awk '{print $1}')" ] || { echo 'rendered Compose source changed during deployment' >&2; exit 1; }
  [ "$config_source_before" = "$(shasum -a 256 "$PRODUCTION_CONFIG_PATH" | awk '{print $1}')" ] || { echo 'production config source changed during deployment' >&2; exit 1; }
  [ "$compose_source_before" = "$(shasum -a 256 "$verified_compose" | awk '{print $1}')" ] || { echo 'verified Compose changed during deployment' >&2; exit 1; }
  [ "$config_source_before" = "$(shasum -a 256 "$verified_config" | awk '{print $1}')" ] || { echo 'verified production config changed during deployment' >&2; exit 1; }
}

image_set_digest=$(ruby "$root/infra/scripts/validate-ecs-compose-release.rb" "$verified_compose" "$IMAGE_DIGESTS_JSON" --print-image-set-digest)
manifest_sha256=$(ruby "$root/infra/scripts/validate-ecs-compose-release.rb" "$verified_compose" "$IMAGE_DIGESTS_JSON" --print-manifest-sha256)
project=${ECS_COMPOSE_PROJECT:-merchant-production}
if [ -n "${ECS_EXTERNAL_GATEWAY_ID:-}" ]; then
  : "${ECS_EXTERNAL_GATEWAY_PROJECT:?reviewed external gateway project is required}"
  [ "$ECS_EXTERNAL_GATEWAY_PROJECT" != "$project" ] || { echo 'external gateway must belong to a different Compose project' >&2; exit 1; }
  external_gateway_state="$ECS_DEPLOY_STATE_DIR/${RELEASE_ID}.external-gateway.json"
  gateway_descriptor=$(docker compose -p "$project" -f "$verified_compose" config --format json | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));const g=c.services?.["pilot-gateway"],a=c.services?.["api-replica"],n=c.networks?.default?.name,i=g?.image;if(!i||!/@sha256:[0-9a-f]{64}$/.test(i)||!n||!Object.hasOwn(g.networks??{},"default")||!Object.hasOwn(a?.networks??{},"default"))process.exit(1);process.stdout.write(i+"\n"+n)')
  candidate_gateway_image=$(printf '%s\n' "$gateway_descriptor" | sed -n '1p')
  candidate_gateway_network=$(printf '%s\n' "$gateway_descriptor" | sed -n '2p')
  # Snapshot before any mutation, with the inherited production lock held.
  external_gateway_action snapshot
  # A cross-project rollback must not attempt to bind the old listener's ports.
  docker compose -p "$project" -f "$ECS_ROLLBACK_COMPOSE_PATH" config --format json | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const s of Object.values(c.services??{}))for(const p of s.ports??[]){if(typeof p!=="object"||["80","443"].includes(String(p.published)))process.exit(1)}' || { echo 'external gateway handoff requires a rollback Compose without public 80/443 bindings' >&2; exit 1; }
else
  node "$root/infra/scripts/ecs-external-gateway-handoff.mjs" check-ports --candidate-project "$project"
fi
release_images=$(docker compose -p "$project" -f "$verified_compose" config --images) || {
  echo 'could not enumerate verified release images' >&2; exit 1;
}
[ -n "$release_images" ] || { echo 'verified release contains no images' >&2; exit 1; }
printf '%s\n' "$release_images" | while IFS= read -r image; do
  [ -n "$image" ] || continue
  local_image_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || {
    echo "verified release image is unavailable locally: $image" >&2; exit 1;
  }
  printf '%s' "$local_image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
    echo "verified release image resolved to an invalid local image ID: $image" >&2; exit 1;
  }
done
umask 077
rollback_capsule_dir="$ECS_DEPLOY_STATE_DIR/${RELEASE_ID}.rollback-capsule"
mkdir -m 0700 "$rollback_capsule_dir" 2>/dev/null || { echo 'rollback capsule snapshot already exists or cannot be created' >&2; exit 1; }
cp "$ECS_ROLLBACK_PLAN_PATH" "$rollback_capsule_dir/plan.json"
cp "$ECS_ROLLBACK_COMPOSE_PATH" "$rollback_capsule_dir/compose.yml"
cp "$ECS_ROLLBACK_ENV_FILE" "$rollback_capsule_dir/runtime.env"
printf '%s' "$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" > "$rollback_capsule_dir/image-digests.json"
printf '%s' "$IMAGE_DIGESTS_JSON" > "$rollback_capsule_dir/candidate-image-digests.json"
chmod 0400 "$rollback_capsule_dir/plan.json" "$rollback_capsule_dir/compose.yml" "$rollback_capsule_dir/runtime.env" "$rollback_capsule_dir/image-digests.json" "$rollback_capsule_dir/candidate-image-digests.json"
ECS_ROLLBACK_PLAN_PATH="$rollback_capsule_dir/plan.json"
ECS_ROLLBACK_COMPOSE_PATH="$rollback_capsule_dir/compose.yml"
ECS_ROLLBACK_ENV_FILE="$rollback_capsule_dir/runtime.env"
rollback_compose_sha=$(shasum -a 256 "$ECS_ROLLBACK_COMPOSE_PATH" | awk '{print $1}')
rollback_env_sha=$(shasum -a 256 "$ECS_ROLLBACK_ENV_FILE" | awk '{print $1}')
rollback_digests_sha=$(printf '%s' "$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" | shasum -a 256 | awk '{print $1}')
PLAN="$ECS_ROLLBACK_PLAN_PATH" COMPOSE_SHA="$rollback_compose_sha" ENV_SHA="$rollback_env_sha" DIGESTS_SHA="$rollback_digests_sha" \
PROJECT="$project" CANDIDATE_ID="$RELEASE_ID" CANDIDATE_GIT="$git_sha" CANDIDATE_MANIFEST="$manifest_sha256" CANDIDATE_IMAGES="$image_set_digest" \
DIGESTS="$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" node <<'NODE'
const fs=require('fs')
const plan=JSON.parse(fs.readFileSync(process.env.PLAN,'utf8')),digests=JSON.parse(process.env.DIGESTS)
const created=Date.parse(plan.created_at),expires=Date.parse(plan.expires_at),now=Date.now()
function required(value,message){if(!value)throw new Error(message)}
required(plan.schema_version==='1'&&plan.kind==='ecs-compose-rollback-capsule','rollback capsule schema or kind is invalid')
required(Number.isFinite(created)&&Number.isFinite(expires)&&plan.created_at===new Date(created).toISOString()&&plan.expires_at===new Date(expires).toISOString(),'rollback capsule timestamps must be canonical UTC')
required(created<=now+300000&&expires>now&&expires-created<=86400000,'rollback capsule is expired, future-dated, or valid for longer than 24 hours')
required(plan.compose_project===process.env.PROJECT,'rollback capsule Compose project mismatch')
const current={release_id:process.env.CANDIDATE_ID,git_sha:process.env.CANDIDATE_GIT,manifest_sha256:process.env.CANDIDATE_MANIFEST,image_set_digest:process.env.CANDIDATE_IMAGES}
required(Object.entries(current).every(([key,value])=>plan.current?.[key]===value),'rollback capsule current identity does not match the candidate')
required(plan.target?.compose_sha256===process.env.COMPOSE_SHA&&plan.target?.env_sha256===process.env.ENV_SHA&&plan.target?.image_digests_sha256===process.env.DIGESTS_SHA,'rollback capsule artifact checksum mismatch')
required(plan.database?.strategy==='forward_only'&&plan.database?.schema_downgrade===false&&plan.volumes?.preserve===true,'rollback capsule data-preservation contract is invalid')
required(digests&&Object.keys(digests).length>0&&Object.values(digests).every(value=>/^sha256:[0-9a-f]{64}$/.test(value)),'rollback capsule image digests are invalid')
NODE
state_path="$ECS_DEPLOY_STATE_DIR/${RELEASE_ID}.predeploy.json"
attempt_id="attempt_$(printf '%s:%s:%s' "$RELEASE_ID" "$DEPLOYMENT_NONCE" "$$" | shasum -a 256 | awk '{print $1}')"
DATABASE_URL="$DATABASE_URL" "$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" capture --state "$state_path" --attempt-id "$attempt_id" \
  --lock-path "$ECS_DEPLOY_LOCK_PATH" \
  --service-map "$ECS_PREIDENTITY_SERVICE_MAP_PATH" --compose-project "$project" \
  --candidate-release-id "$RELEASE_ID" --candidate-git-sha "$git_sha" --candidate-manifest-sha256 "$manifest_sha256" \
  --candidate-image-set-digest "$image_set_digest" --candidate-image-digests "$rollback_capsule_dir/candidate-image-digests.json" \
  --deployment-nonce "$DEPLOYMENT_NONCE" --recovery-plan "$ECS_ROLLBACK_PLAN_PATH"
[ -s "$state_path" ] || { echo 'pre-deploy state capture failed' >&2; exit 1; }

# Consume only after every read-only gate passes and immediately before the
# first mutation. A consumed nonce is never deleted or reused after failure.
assert_inputs_unchanged
IMAGE_DIGEST="$image_set_digest" PRODUCTION_EVIDENCE_MANIFEST_SHA256="$manifest_sha256" RELEASE_GIT_SHA="$git_sha" PRODUCTION_EVIDENCE_REPO_ROOT="$root" \
  sh "$root/infra/scripts/consume-production-evidence-nonce.sh"
"$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" phase --state "$state_path" --lock-path "$ECS_DEPLOY_LOCK_PATH" --phase nonce_consumed

# Migration must finish before any candidate runtime container is recreated.
# Destructive service, volume, and database cleanup is deliberately absent.
assert_inputs_unchanged
"$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" phase --state "$state_path" --lock-path "$ECS_DEPLOY_LOCK_PATH" --phase migration_started
mutation_started=true
docker compose -p "$project" -f "$verified_compose" run --rm --no-deps --pull never migrate
assert_inputs_unchanged
# The read-only preflight accepts only an immutable prefix of this candidate's
# chain. Before any runtime container is recreated, prove the migration job
# advanced both runtime roles to the complete reviewed chain.
MIGRATION_CHAIN_MODE=complete sh "$root/infra/scripts/verify-database-migration-chain.sh"
"$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" phase --state "$state_path" --lock-path "$ECS_DEPLOY_LOCK_PATH" --phase migration_complete
assert_inputs_unchanged
"$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" phase --state "$state_path" --lock-path "$ECS_DEPLOY_LOCK_PATH" --phase runtime_cutover_started
runtime_cutover_started=true
if [ -n "$external_gateway_state" ]; then
  external_gateway_handoff_started=true
  external_gateway_action stop
fi
docker compose -p "$project" -f "$verified_compose" up -d --no-build --pull never --remove-orphans --wait --wait-timeout "${ECS_COMPOSE_WAIT_TIMEOUT_SECONDS:-300}" \
  api api-replica ui ops-ui payment-gateway worker-sync worker-generation worker-publish worker-reconcile worker-automation worker-scan clamav pilot-gateway

health_deadline=$(( $(date +%s) + ${ECS_POST_DEPLOY_HEALTH_TIMEOUT_SECONDS:-300} ))
while ! curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/livez" >/dev/null 2>&1 || \
      ! curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$health_deadline" ] || { echo 'candidate did not become healthy before the bounded deadline' >&2; exit 1; }
  sleep 2
done
release_payload=$(curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/releasez")
EXPECTED_RELEASE_ID="$RELEASE_ID" EXPECTED_RELEASE_GIT_SHA="$git_sha" EXPECTED_MANIFEST_SHA256="$manifest_sha256" EXPECTED_IMAGE_SET_DIGEST="$image_set_digest" \
  node -e 'const body=JSON.parse(require("fs").readFileSync(0,"utf8"));const got=body.data?.release??body.release;const expected={release_id:process.env.EXPECTED_RELEASE_ID,release_git_sha:process.env.EXPECTED_RELEASE_GIT_SHA,manifest_sha256:process.env.EXPECTED_MANIFEST_SHA256,image_set_digest:process.env.EXPECTED_IMAGE_SET_DIGEST};if(!got||Object.entries(expected).some(([key,value])=>got[key]!==value)){throw new Error("releasez does not match the verified ECS candidate")}' <<EOF
$release_payload
EOF
if [ "${DEPLOYMENT_SCOPE:-full}" = full ]; then
  curl --fail --silent --show-error --max-time 20 \
    -H "authorization: Bearer $PRODUCTION_CANARY_BEARER_TOKEN" \
    -H "x-workspace-id: $PRODUCTION_CANARY_WORKSPACE_ID" \
    "${PRODUCTION_API_BASE_URL%/}/v1/products?limit=1&offset=0" >/dev/null
  if [ "${PLATFORM_OPERATIONS_MODE:-}" = manual ]; then
    sh "$root/infra/scripts/run-manual-operations-canary.sh"
  else
    [ "${PLATFORM_OPERATIONS_MODE:-}" = official_api ] || { echo 'PLATFORM_OPERATIONS_MODE must be manual or official_api' >&2; exit 1; }
    PLATFORM_CANARY_BASE_EVIDENCE="$CAPABILITY_EVIDENCE_PATH" PLATFORM_CANARY_OUTPUT="$POST_DEPLOY_CANARY_OUTPUT" \
    PRODUCTION_API_BASE_URL="$PRODUCTION_API_BASE_URL" RELEASE_GIT_SHA="$git_sha" RELEASE_MANIFEST_SHA256="$manifest_sha256" \
    RELEASE_IMAGE_SET_DIGEST="$image_set_digest" sh "$root/infra/scripts/run-production-canary.sh"
    trust_root=/run/release-security/evidence-trust/production-evidence-public.pem
    trusted_key_id=$(sed -n '1p' /run/release-security/evidence-trust/production-evidence-key-id)
    npx --no-install tsx "$root/tests/capability-evidence-gate.ts" --file "$POST_DEPLOY_CANARY_OUTPUT" --require-canary --require-signed-production \
      --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$git_sha" \
      --deployment-nonce "$DEPLOYMENT_NONCE" --public-key "$trust_root" --key-id "$trusted_key_id"
  fi
else
  echo "post-deploy business acceptance deferred: deployment_scope=${DEPLOYMENT_SCOPE}"
fi
"$ECS_PREIDENTITY_RECOVERY_ENTRYPOINT" phase --state "$state_path" --lock-path "$ECS_DEPLOY_LOCK_PATH" --phase runtime_identity_verified

mutation_started=false
trap - EXIT HUP INT TERM
cleanup
echo "verified ECS Compose deployment passed: release_id=$RELEASE_ID manifest_sha256=$manifest_sha256 state=$state_path"
