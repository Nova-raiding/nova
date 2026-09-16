#!/bin/sh
set -eu

# Roll back the single ECS production environment to a previously reviewed
# immutable Compose release. Database migrations remain forward-only and all
# named volumes/data are preserved. This script must run on the ECS host.

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
: "${CONFIRM_ECS_ROLLBACK:?Set CONFIRM_ECS_ROLLBACK=YES to rollback}"
: "${ECS_ROLLBACK_PLAN_PATH:?ECS_ROLLBACK_PLAN_PATH is required}"
: "${ECS_ROLLBACK_COMPOSE_PATH:?ECS_ROLLBACK_COMPOSE_PATH is required}"
: "${ECS_ROLLBACK_ENV_FILE:?ECS_ROLLBACK_ENV_FILE is required}"
: "${ECS_ROLLBACK_IMAGE_DIGESTS_JSON:?ECS_ROLLBACK_IMAGE_DIGESTS_JSON is required}"
: "${ECS_ROLLBACK_STATE_PATH:?ECS_ROLLBACK_STATE_PATH is required}"
: "${ECS_DEPLOY_LOCK_PATH:?ECS_DEPLOY_LOCK_PATH is required}"
: "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required}"
: "${DATABASE_URL:?DATABASE_URL is required for the read-only migration check}"
[ "$CONFIRM_ECS_ROLLBACK" = YES ] || { echo 'ECS rollback refused' >&2; exit 2; }
printf '%s\n' "$PRODUCTION_API_BASE_URL" | grep -Eq '^https://' || { echo 'PRODUCTION_API_BASE_URL must use HTTPS' >&2; exit 2; }
printf '%s\n' "${ECS_COMPOSE_PROJECT:-merchant-production}" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,62}$' || { echo 'unsafe ECS_COMPOSE_PROJECT' >&2; exit 2; }
case "${ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS:-300}" in ''|*[!0-9]*) echo 'ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS must be an integer from 30 to 900' >&2; exit 2;; esac
[ "${ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS:-300}" -ge 30 ] && [ "${ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS:-300}" -le 900 ] || { echo 'ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS must be an integer from 30 to 900' >&2; exit 2; }
for path in "$ECS_ROLLBACK_PLAN_PATH" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_ENV_FILE"; do
  [ -f "$path" ] && [ ! -L "$path" ] || { echo "rollback input must be a regular non-symlink file: $path" >&2; exit 2; }
  case "$path" in /*) ;; *) echo "rollback input path must be absolute: $path" >&2; exit 2 ;; esac
done
command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo 'node is required' >&2; exit 2; }
command -v psql >/dev/null 2>&1 || { echo 'psql is required' >&2; exit 2; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required' >&2; exit 2; }

state_dir=$(dirname "$ECS_ROLLBACK_STATE_PATH")
[ -d "$state_dir" ] && [ ! -L "$state_dir" ] || { echo 'rollback state directory must already exist and must not be a symlink' >&2; exit 2; }
case "$ECS_ROLLBACK_STATE_PATH" in /*) ;; *) echo 'rollback state path must be absolute' >&2; exit 2 ;; esac
canonical_state_dir=$(CDPATH='' cd -- "$state_dir" && pwd -P)
[ "$canonical_state_dir" = "$state_dir" ] || { echo 'rollback state directory must be canonical' >&2; exit 2; }
case "$canonical_state_dir/" in "$root/"*) echo 'rollback state must be stored outside the mutable repository' >&2; exit 2;; esac
state_name=$(basename "$ECS_ROLLBACK_STATE_PATH")
printf '%s\n' "$state_name" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*\.json$' || { echo 'rollback state filename is unsafe' >&2; exit 2; }
[ ! -e "$ECS_ROLLBACK_STATE_PATH" ] && [ ! -L "$ECS_ROLLBACK_STATE_PATH" ] || { echo 'rollback state path already exists' >&2; exit 2; }
state_uid=$(stat -c %u "$canonical_state_dir")
state_mode=$(stat -c %a "$canonical_state_dir")
[ "$state_uid" = "$(id -u)" ] || { echo 'rollback state directory must be owned by the invoking user' >&2; exit 2; }
case "$state_mode" in *[2367][0-7]|*[0-7][2367]) echo 'rollback state directory must not be group/world writable' >&2; exit 2;; esac

# Serialize every production Compose mutation on this host with the exact lock
# also used by deploy-verified-ecs-compose.sh.
case "$ECS_DEPLOY_LOCK_PATH" in /*) ;; *) echo 'ECS_DEPLOY_LOCK_PATH must be absolute' >&2; exit 2;; esac
lock_parent=$(dirname "$ECS_DEPLOY_LOCK_PATH")
[ -d "$lock_parent" ] && [ ! -L "$lock_parent" ] || { echo 'ECS deploy lock parent must be an existing non-symlink directory' >&2; exit 2; }
canonical_lock_parent=$(CDPATH='' cd -- "$lock_parent" && pwd -P)
[ "$canonical_lock_parent" = "$lock_parent" ] || { echo 'ECS_DEPLOY_LOCK_PATH parent must be canonical' >&2; exit 2; }
case "$canonical_lock_parent/" in "$root/"*) echo 'ECS deploy lock must be outside the mutable repository' >&2; exit 2;; esac
lock_uid=$(stat -c %u "$canonical_lock_parent")
lock_mode=$(stat -c %a "$canonical_lock_parent")
[ "$lock_uid" = "$(id -u)" ] || { echo 'ECS deploy lock parent must be owned by the invoking user' >&2; exit 2; }
case "$lock_mode" in *[2367][0-7]|*[0-7][2367]) echo 'ECS deploy lock parent must not be group/world writable' >&2; exit 2;; esac
[ ! -L "$ECS_DEPLOY_LOCK_PATH" ] || { echo 'ECS deploy lock must not be a symlink' >&2; exit 2; }
exec 9>"$ECS_DEPLOY_LOCK_PATH"
[ -f "$ECS_DEPLOY_LOCK_PATH" ] && [ ! -L "$ECS_DEPLOY_LOCK_PATH" ] || { echo 'ECS deploy lock must be a regular non-symlink file' >&2; exit 2; }
flock -n 9 || { echo 'another ECS Compose deployment or rollback holds the production mutation lock' >&2; exit 1; }
umask 077
STATE_PATH="$ECS_ROLLBACK_STATE_PATH" node -e 'require("fs").writeFileSync(process.env.STATE_PATH,"",{flag:"wx",mode:0o600})' || { echo 'could not reserve rollback state path exclusively' >&2; exit 2; }
snapshot_dir=$(mktemp -d "$state_dir/.ecs-rollback-inputs.XXXXXXXX")
chmod 700 "$snapshot_dir"
cleanup() { rm -rf -- "$snapshot_dir"; }
trap cleanup EXIT HUP INT TERM

# Freeze every file consumed by validation and Compose to close the gap
# between checksum validation and the first container mutation.
plan_source_sha=$(shasum -a 256 "$ECS_ROLLBACK_PLAN_PATH" | awk '{print $1}')
compose_source_sha=$(shasum -a 256 "$ECS_ROLLBACK_COMPOSE_PATH" | awk '{print $1}')
env_source_sha=$(shasum -a 256 "$ECS_ROLLBACK_ENV_FILE" | awk '{print $1}')
digests_source_sha=$(printf '%s' "$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" | shasum -a 256 | awk '{print $1}')
cp "$ECS_ROLLBACK_PLAN_PATH" "$snapshot_dir/plan.json"
cp "$ECS_ROLLBACK_COMPOSE_PATH" "$snapshot_dir/compose.yml"
cp "$ECS_ROLLBACK_ENV_FILE" "$snapshot_dir/runtime.env"
chmod 600 "$snapshot_dir/plan.json" "$snapshot_dir/compose.yml" "$snapshot_dir/runtime.env"
[ "$plan_source_sha" = "$(shasum -a 256 "$snapshot_dir/plan.json" | awk '{print $1}')" ] || { echo 'rollback plan changed while copying' >&2; exit 1; }
[ "$compose_source_sha" = "$(shasum -a 256 "$snapshot_dir/compose.yml" | awk '{print $1}')" ] || { echo 'rollback Compose changed while copying' >&2; exit 1; }
[ "$env_source_sha" = "$(shasum -a 256 "$snapshot_dir/runtime.env" | awk '{print $1}')" ] || { echo 'rollback environment changed while copying' >&2; exit 1; }
ECS_ROLLBACK_PLAN_PATH="$snapshot_dir/plan.json"
ECS_ROLLBACK_COMPOSE_PATH="$snapshot_dir/compose.yml"
ECS_ROLLBACK_ENV_FILE="$snapshot_dir/runtime.env"
state() {
  phase=$1 detail=$2
  compose_ps_sha=
  compose_ps_path=
  if [ "${ROLLBACK_MUTATION_STARTED:-false}" = true ]; then
    compose_ps_path="${ECS_ROLLBACK_STATE_PATH}.compose-ps.json"
    compose_ps_tmp="$snapshot_dir/compose-ps.json"
    if compose ps --format json > "$compose_ps_tmp" 2>/dev/null; then
      chmod 600 "$compose_ps_tmp"
      mv -f -- "$compose_ps_tmp" "$compose_ps_path"
      compose_ps_sha=$(shasum -a 256 "$compose_ps_path" | awk '{print $1}')
    else
      compose_ps_path=
    fi
  fi
  phase=$phase detail=$detail ROLLBACK_COMPOSE_PS_PATH=$compose_ps_path ROLLBACK_COMPOSE_PS_SHA256=$compose_ps_sha node -e '
    const fs=require("fs"), path=require("path")
    const target=process.env.ECS_ROLLBACK_STATE_PATH
    const mutationStarted=process.env.ROLLBACK_MUTATION_STARTED==="true"
    const record={schema_version:"1",platform:"ecs_docker_compose",status:process.env.phase,detail:process.env.detail,target_release_id:process.env.TARGET_RELEASE_ID||null,updated_at:new Date().toISOString(),mutation_started:mutationStarted,requires_manual_recovery:mutationStarted&&process.env.phase!=="healthy",compose_ps_evidence:process.env.ROLLBACK_COMPOSE_PS_PATH?{path:process.env.ROLLBACK_COMPOSE_PS_PATH,sha256:process.env.ROLLBACK_COMPOSE_PS_SHA256}:null}
    const temporary=path.join(path.dirname(target),`.${path.basename(target)}.${process.pid}.tmp`)
    fs.writeFileSync(temporary,JSON.stringify(record,null,2)+"\n",{mode:0o600});fs.renameSync(temporary,target)
  '
}
fail() { state "$1" "$2"; echo "$2" >&2; exit 1; }
on_interrupt() {
  trap - HUP INT TERM
  if [ "${ROLLBACK_MUTATION_STARTED:-false}" = true ]; then
    state interrupted 'rollback was interrupted after mutation began; services may be partially switched and manual recovery is required' || true
  fi
  exit 130
}
trap on_interrupt HUP INT TERM
state validating 'validating approved release identity and forward-only database compatibility'

descriptor=$(mktemp "$snapshot_dir/descriptor.XXXXXX")
compose_sha=$(shasum -a 256 "$ECS_ROLLBACK_COMPOSE_PATH" | awk '{print $1}')
PLAN="$ECS_ROLLBACK_PLAN_PATH" COMPOSE_SHA="$compose_sha" ENV_SHA="$env_source_sha" DIGESTS_SHA="$digests_source_sha" PROJECT="${ECS_COMPOSE_PROJECT:-merchant-production}" DIGESTS="$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" node - "$descriptor" <<'NODE' || fail validation_failed 'rollback capsule is invalid'
const fs=require('fs')
const [output]=process.argv.slice(2)
const plan=JSON.parse(fs.readFileSync(process.env.PLAN,'utf8'))
const digestJson=JSON.parse(process.env.DIGESTS)
const sha=/^[0-9a-f]{64}$/, digest=/^sha256:[0-9a-f]{64}$/
const id=/^[A-Za-z0-9._-]+$/, git=/^[0-9a-f]{40}$/
function requireValue(ok,message){if(!ok)throw new Error(message)}
requireValue(plan?.schema_version==='1','rollback plan schema_version must be 1')
requireValue(plan?.kind==='ecs-compose-rollback-capsule','rollback capsule kind is invalid')
const created=Date.parse(plan.created_at), expires=Date.parse(plan.expires_at), now=Date.now()
requireValue(Number.isFinite(created)&&Number.isFinite(expires)&&plan.created_at===new Date(created).toISOString()&&plan.expires_at===new Date(expires).toISOString(),'rollback capsule timestamps must be canonical UTC')
requireValue(created<=now+5*60_000&&expires>now&&expires-created<=24*60*60_000,'rollback capsule is expired, future-dated, or valid for longer than 24 hours')
for(const side of ['current','target']){
  const value=plan[side]
  requireValue(value&&id.test(value.release_id),`${side} release_id is invalid`)
  requireValue(git.test(value.git_sha),`${side} git_sha is invalid`)
  requireValue(sha.test(value.manifest_sha256),`${side} manifest_sha256 is invalid`)
  requireValue(digest.test(value.image_set_digest),`${side} image_set_digest is invalid`)
}
requireValue(plan.target.compose_sha256===process.env.COMPOSE_SHA,'target Compose checksum does not match rollback plan')
requireValue(plan.target.env_sha256===process.env.ENV_SHA,'target environment checksum does not match rollback capsule')
requireValue(plan.target.image_digests_sha256===process.env.DIGESTS_SHA,'target image-digests checksum does not match rollback capsule')
requireValue(plan.compose_project===process.env.PROJECT,'Compose project does not match rollback capsule')
requireValue(plan.database?.strategy==='forward_only','database rollback strategy must be forward_only')
requireValue(plan.database.schema_downgrade===false,'database schema downgrade must be explicitly false')
requireValue(Number.isInteger(plan.database.live_migration_version)&&plan.database.live_migration_version>0,'live migration version is invalid')
requireValue(Number.isInteger(plan.database.target_migration_tail)&&plan.database.target_migration_tail>=plan.database.live_migration_version,'target image migration tail is incompatible with live schema')
requireValue(plan.volumes?.preserve===true,'rollback plan must preserve volumes')
requireValue(digestJson&&Object.getPrototypeOf(digestJson)===Object.prototype&&Object.keys(digestJson).length>0,'rollback image digests must be a non-empty object')
requireValue(Object.entries(digestJson).every(([key,value])=>id.test(key)&&digest.test(value)),'rollback image digests must be immutable')
fs.writeFileSync(output,JSON.stringify(plan))
NODE
field() { node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let y=x;for(const k of process.argv[2].split("."))y=y[k];process.stdout.write(String(y))' "$descriptor" "$1"; }
CURRENT_RELEASE_ID=$(field current.release_id); CURRENT_GIT_SHA=$(field current.git_sha)
CURRENT_MANIFEST_SHA256=$(field current.manifest_sha256); CURRENT_IMAGE_SET_DIGEST=$(field current.image_set_digest)
TARGET_RELEASE_ID=$(field target.release_id); export TARGET_RELEASE_ID
TARGET_GIT_SHA=$(field target.git_sha); TARGET_MANIFEST_SHA256=$(field target.manifest_sha256)
TARGET_IMAGE_SET_DIGEST=$(field target.image_set_digest); PLANNED_LIVE_MIGRATION=$(field database.live_migration_version)

actual_image_set=$(ruby "$root/infra/scripts/validate-ecs-compose-release.rb" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" --print-image-set-digest) || fail validation_failed 'could not compute target image-set digest'
actual_manifest=$(ruby "$root/infra/scripts/validate-ecs-compose-release.rb" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" --print-manifest-sha256) || fail validation_failed 'could not compute target manifest checksum'
[ "$actual_image_set" = "$TARGET_IMAGE_SET_DIGEST" ] || fail validation_failed 'target image-set digest does not match rollback plan'
[ "$actual_manifest" = "$TARGET_MANIFEST_SHA256" ] || fail validation_failed 'target manifest checksum does not match rollback plan'
RELEASE_ID="$TARGET_RELEASE_ID" RELEASE_GIT_SHA="$TARGET_GIT_SHA" ruby "$root/infra/scripts/validate-ecs-compose-release.rb" "$ECS_ROLLBACK_COMPOSE_PATH" "$ECS_ROLLBACK_IMAGE_DIGESTS_JSON" >/dev/null || fail validation_failed 'target Compose release contract failed'

# Prevent a stale operator from rolling back over a newer release.
live_release=$(curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/releasez") || fail validation_failed 'could not read current production release identity'
LIVE="$live_release" EXPECTED_ID="$CURRENT_RELEASE_ID" EXPECTED_GIT="$CURRENT_GIT_SHA" EXPECTED_MANIFEST="$CURRENT_MANIFEST_SHA256" EXPECTED_IMAGES="$CURRENT_IMAGE_SET_DIGEST" node -e '
const body=JSON.parse(process.env.LIVE), value=body.data?.release??body.release
const expected={release_id:process.env.EXPECTED_ID,release_git_sha:process.env.EXPECTED_GIT,manifest_sha256:process.env.EXPECTED_MANIFEST,image_set_digest:process.env.EXPECTED_IMAGES}
if(!value||Object.entries(expected).some(([key,want])=>value[key]!==want)){process.stderr.write("current production release identity does not match rollback plan\n");process.exit(1)}
' || fail validation_failed 'current production release identity does not match rollback plan'

live_migration=$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c 'SELECT max(version)::int FROM schema_migrations') || fail validation_failed 'could not read live database migration version'
[ "$live_migration" = "$PLANNED_LIVE_MIGRATION" ] || fail validation_failed 'live database migration version changed after rollback plan approval'

project=${ECS_COMPOSE_PROJECT:-merchant-production}
compose() { docker compose -p "$project" --env-file "$ECS_ROLLBACK_ENV_FILE" -f "$ECS_ROLLBACK_COMPOSE_PATH" "$@"; }
# Execute target-image code in an ephemeral container. It only reads the
# migration registry and live schema; it never invokes the migration runner.
compose run --rm --no-deps --entrypoint node --env "ROLLBACK_LIVE_MIGRATION=$live_migration" api --input-type=module -e '
  const {Pool}=await import("pg");const {loadMigrations,verifyAppliedMigrations}=await import("./dist/packages/persistence/src/migration.js")
  const expected=Number(process.env.ROLLBACK_LIVE_MIGRATION);const migrations=await loadMigrations();const versions=new Set(migrations.map(x=>x.version))
  if((migrations.at(-1)?.version??0)<expected)throw new Error("rollback image migration tail is older than live schema")
  for(let version=1;version<=expected;version+=1)if(!versions.has(version))throw new Error(`rollback image lacks migration ${version}`)
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});try{const client=await pool.connect();try{await client.query("BEGIN READ ONLY");const result=await client.query("SELECT version,name,checksum FROM schema_migrations ORDER BY version ASC");verifyAppliedMigrations(result.rows,migrations);if(Number(result.rows.at(-1)?.version)!==expected)throw new Error("live migration changed during compatibility probe");await client.query("ROLLBACK")}finally{client.release()}}finally{await pool.end()}
' || fail validation_failed 'target image failed forward-schema compatibility probe'

ROLLBACK_MUTATION_STARTED=true; export ROLLBACK_MUTATION_STARTED
state applying 'validated rollback is being applied; volumes and database are preserved'
# Update only the reviewed services. No data cleanup is part of rollback.
compose up -d --no-build \
  api api-replica ui ops-ui payment-gateway clamav \
  worker-sync worker-generation worker-publish worker-reconcile worker-automation worker-scan \
  || fail apply_failed 'Compose rollback apply failed after mutation began; services may be partially switched, data was preserved, and manual recovery is required'

deadline=$(( $(date +%s) + ${ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS:-300} ))
while :; do
  if curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/livez" >/dev/null 2>&1 &&
     curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz" >/dev/null 2>&1; then
    release_after=$(curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/releasez") || release_after=
    if LIVE="$release_after" EXPECTED_ID="$TARGET_RELEASE_ID" EXPECTED_GIT="$TARGET_GIT_SHA" EXPECTED_MANIFEST="$TARGET_MANIFEST_SHA256" EXPECTED_IMAGES="$TARGET_IMAGE_SET_DIGEST" node -e '
      const body=JSON.parse(process.env.LIVE),value=body.data?.release??body.release;const expected={release_id:process.env.EXPECTED_ID,release_git_sha:process.env.EXPECTED_GIT,manifest_sha256:process.env.EXPECTED_MANIFEST,image_set_digest:process.env.EXPECTED_IMAGES};process.exit(value&&Object.entries(expected).every(([k,v])=>value[k]===v)?0:1)
    ' 2>/dev/null; then break; fi
  fi
  [ "$(date +%s)" -lt "$deadline" ] || fail health_failed 'rollback containers did not become healthy with the target release identity; data is preserved and manual recovery is required'
  sleep 2
done
state healthy 'rollback completed and target release identity is healthy'
echo "verified ECS Compose rollback passed: release_id=$TARGET_RELEASE_ID manifest_sha256=$TARGET_MANIFEST_SHA256 image_set_digest=$TARGET_IMAGE_SET_DIGEST"
