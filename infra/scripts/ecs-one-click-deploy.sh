#!/bin/sh
set -eu

# Host-local ECS deployment orchestration and bounded release retention.
# This script never deletes Docker volumes, database data, object storage, or
# images referenced by running containers. Production secrets stay in their
# pre-provisioned host paths and are never copied into a release checkout.
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
action=${1:-deploy}

: "${ECS_RELEASES_ROOT:=/srv/merchant-releases}"
: "${ECS_RELEASE_KEEP_COUNT:=2}"
: "${ECS_CANDIDATE_KEEP_COUNT:=$ECS_RELEASE_KEEP_COUNT}"
: "${ECS_CANDIDATES_ROOT:=/srv/release-candidates}"
: "${ECS_BUILD_CACHE_KEEP_STORAGE:=2GB}"
: "${ECS_BUILD_CACHE_UNTIL:=24h}"

case "$action" in deploy|cleanup|report) ;; *) echo 'usage: ecs-one-click-deploy.sh [deploy|cleanup|report]' >&2; exit 2 ;; esac
printf '%s' "$ECS_RELEASE_KEEP_COUNT" | grep -Eq '^[1-9][0-9]?$' || { echo 'ECS_RELEASE_KEEP_COUNT must be an integer from 1 to 99' >&2; exit 2; }
printf '%s' "$ECS_CANDIDATE_KEEP_COUNT" | grep -Eq '^[1-9][0-9]?$' || { echo 'ECS_CANDIDATE_KEEP_COUNT must be an integer from 1 to 99' >&2; exit 2; }
if [ "$action" = deploy ]; then
  : "${RELEASE_ID:?RELEASE_ID is required}"
  printf '%s' "$RELEASE_ID" | grep -Eq '^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' || { echo 'unsafe RELEASE_ID' >&2; exit 2; }
fi
[ -d "$ECS_RELEASES_ROOT" ] && [ ! -L "$ECS_RELEASES_ROOT" ] || { echo 'ECS_RELEASES_ROOT must be an existing non-symlink directory' >&2; exit 2; }
releases=$(CDPATH='' cd -- "$ECS_RELEASES_ROOT" && pwd -P)
[ "$releases" = "$ECS_RELEASES_ROOT" ] || { echo 'ECS_RELEASES_ROOT must be absolute and canonical' >&2; exit 2; }

owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
[ "$(owner_of "$releases")" = "$(id -u)" ] || { echo 'ECS_RELEASES_ROOT must be owned by the invoking user' >&2; exit 2; }
release_mode=$(mode_of "$releases"); case "$release_mode" in *[2367][0-7]|*[2367]) echo 'ECS_RELEASES_ROOT must not be writable by group or other users' >&2; exit 2 ;; esac

protected_file=$(mktemp "${TMPDIR:-/tmp}/merchant-protected-releases.XXXXXXXX")
protected_git_file=$(mktemp "${TMPDIR:-/tmp}/merchant-protected-git-shas.XXXXXXXX")
candidates_file=$(mktemp "${TMPDIR:-/tmp}/merchant-release-candidates.XXXXXXXX")
candidate_bundles_file=$(mktemp "${TMPDIR:-/tmp}/merchant-candidate-bundles.XXXXXXXX")
cleanup_temp() {
  rm -f -- "$protected_file" "$protected_git_file" "$candidates_file" "$candidate_bundles_file"
}

candidate_root=
if [ -e "$ECS_CANDIDATES_ROOT" ]; then
  [ -d "$ECS_CANDIDATES_ROOT" ] && [ ! -L "$ECS_CANDIDATES_ROOT" ] || { echo 'ECS_CANDIDATES_ROOT must be an existing non-symlink directory' >&2; exit 2; }
  candidate_root=$(CDPATH='' cd -- "$ECS_CANDIDATES_ROOT" && pwd -P)
  [ "$candidate_root" = "$ECS_CANDIDATES_ROOT" ] || { echo 'ECS_CANDIDATES_ROOT must be absolute and canonical' >&2; exit 2; }
  [ "$(owner_of "$candidate_root")" = "$(id -u)" ] || { echo 'ECS_CANDIDATES_ROOT must be owned by the invoking user' >&2; exit 2; }
  candidate_mode=$(mode_of "$candidate_root"); case "$candidate_mode" in *[2367][0-7]|*[2367]) echo 'ECS_CANDIDATES_ROOT must not be writable by group or other users' >&2; exit 2 ;; esac
fi
trap cleanup_temp EXIT HUP INT TERM

# Serialize the complete mutating workflow, not just the Compose cutover. The
# inner deploy runner has its own production lock, but it releases that lock
# before this wrapper prunes releases. Without this outer lock, another
# one-click rollout could stage a release that the first process then removes.
if [ "$action" = deploy ] || [ "$action" = cleanup ]; then
  orchestration_lock="$releases/.ecs-one-click-mutation.lock"
  command -v flock >/dev/null 2>&1 || { echo 'ECS one-click mutation requires flock' >&2; exit 2; }
  if [ ! -e "$orchestration_lock" ] && [ ! -L "$orchestration_lock" ]; then
    (umask 077; set -C; : > "$orchestration_lock") 2>/dev/null || true
  fi
  [ -f "$orchestration_lock" ] && [ ! -L "$orchestration_lock" ] || { echo 'ECS one-click lock must be a regular non-symlink file' >&2; exit 2; }
  [ "$(owner_of "$orchestration_lock")" = "$(id -u)" ] || { echo 'ECS one-click lock must be owned by the invoking user' >&2; exit 2; }
  lock_mode=$(mode_of "$orchestration_lock"); case "$lock_mode" in *[2367][0-7]|*[2367]) echo 'ECS one-click lock must not be writable by group or other users' >&2; exit 2 ;; esac
  exec 8>>"$orchestration_lock"
  flock -n 8 || { echo 'another ECS one-click deploy or cleanup is already in progress' >&2; exit 1; }
fi

protect() {
  value=$1
  [ -n "$value" ] || return 0
  printf '%s' "$value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || { echo "unsafe protected release ID: $value" >&2; exit 2; }
  printf '%s\n' "$value" >> "$protected_file"
}

for value in ${ECS_PROTECTED_RELEASE_IDS:-}; do protect "$value"; done
if command -v docker >/dev/null 2>&1; then
  # A failed or interrupted rollout can leave a created/stopped container whose
  # Compose metadata still points at its release checkout. Preserve those
  # forensic and recovery inputs just like a running release.
  for container in $(docker ps -aq 2>/dev/null || true); do
    container_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null || true)
    container_release=$(printf '%s\n' "$container_env" | sed -n 's/^RELEASE_ID=//p' | head -1)
    container_git=$(printf '%s\n' "$container_env" | sed -n 's/^RELEASE_GIT_SHA=//p' | head -1)
    protect "$container_release"
    printf '%s' "$container_git" | grep -Eq '^[a-f0-9]{40}$' && printf '%s\n' "$container_git" >> "$protected_git_file"
  done
fi
if [ -n "${PRODUCTION_API_BASE_URL:-}" ] && command -v curl >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  attempt=0
  while [ "$attempt" -lt 5 ]; do
    live_release=$(curl -fsS --max-time 10 "${PRODUCTION_API_BASE_URL%/}/releasez" 2>/dev/null | node -e '
      let value="";process.stdin.on("data",chunk=>value+=chunk);process.stdin.on("end",()=>{
        try { process.stdout.write(JSON.parse(value)?.data?.release?.release_id || "") } catch {}
      })
    ' 2>/dev/null || true)
    protect "$live_release"
    attempt=$((attempt + 1))
  done
fi
if [ -n "${ECS_ROLLBACK_PLAN_PATH:-}" ] && [ -f "$ECS_ROLLBACK_PLAN_PATH" ] && command -v node >/dev/null 2>&1; then
  rollback_release=$(node -e 'try{const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x?.target?.release_id||"")}catch{}' "$ECS_ROLLBACK_PLAN_PATH")
  protect "$rollback_release"
fi
[ -z "${RELEASE_ID:-}" ] || protect "$RELEASE_ID"
sort -u "$protected_file" -o "$protected_file"
while IFS= read -r protected_id; do
  identity="$releases/$protected_id/.candidate-identity"
  [ -f "$identity" ] && [ ! -L "$identity" ] || continue
  protected_git=$(sed -n 's/^git_sha=//p' "$identity")
  printf '%s' "$protected_git" | grep -Eq '^[a-f0-9]{40}$' && printf '%s\n' "$protected_git" >> "$protected_git_file"
done < "$protected_file"
sort -u "$protected_git_file" -o "$protected_git_file"

enumerate_releases() {
  find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c '
    for path do
      identity="$path/.candidate-identity"
      [ -f "$identity" ] && [ ! -L "$identity" ] || continue
      id=$(sed -n "s/^release_id=//p" "$identity")
      [ "$(printf "%s\n" "$id" | wc -l | tr -d " ")" = 1 ] || continue
      [ "$id" = "${path##*/}" ] || continue
      mtime=$(if stat -c %Y "$path" >/dev/null 2>&1; then stat -c %Y "$path"; else stat -f %m "$path"; fi)
      printf "%s\t%s\t%s\n" "$mtime" "$id" "$path"
    done
  ' sh {} + | sort -rn
}

prune_releases() {
  enumerate_releases > "$candidates_file"
  kept=0
  while IFS="$(printf '\t')" read -r mtime id path; do
    [ -n "$id" ] || continue
    if grep -Fqx "$id" "$protected_file" || [ -f "$path/.keep" ] || [ "$kept" -lt "$ECS_RELEASE_KEEP_COUNT" ]; then
      kept=$((kept + 1))
      printf 'KEEP\t%s\t%s\n' "$id" "$path"
      continue
    fi
    if [ "${CONFIRM_ECS_STORAGE_CLEANUP:-NO}" = YES ]; then
      case "$path" in "$releases"/*) ;; *) echo "refusing path outside releases root: $path" >&2; exit 2 ;; esac
      [ ! -L "$path" ] || { echo "refusing symlink release: $path" >&2; exit 2; }
      rm -rf -- "$path"
      printf 'DELETE\t%s\t%s\n' "$id" "$path"
    else
      printf 'WOULD_DELETE\t%s\t%s\n' "$id" "$path"
    fi
  done < "$candidates_file"
}

enumerate_candidate_bundles() {
  [ -n "$candidate_root" ] || return 0
  find "$candidate_root" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c '
    for path do
      identity="$path/candidate-identity.txt"
      [ -f "$identity" ] && [ ! -L "$identity" ] || continue
      git_sha=$(sed -n "s/^git_sha=//p" "$identity")
      [ "$(printf "%s\n" "$git_sha" | wc -l | tr -d " ")" = 1 ] || continue
      printf "%s" "$git_sha" | grep -Eq "^[a-f0-9]{40}$" || continue
      mtime=$(if stat -c %Y "$path" >/dev/null 2>&1; then stat -c %Y "$path"; else stat -f %m "$path"; fi)
      printf "%s\t%s\t%s\n" "$mtime" "$git_sha" "$path"
    done
  ' sh {} + | sort -rn
}

prune_candidate_bundles() {
  enumerate_candidate_bundles > "$candidate_bundles_file"
  kept=0
  while IFS="$(printf '\t')" read -r mtime git_sha path; do
    [ -n "$git_sha" ] || continue
    if grep -Fqx "$git_sha" "$protected_git_file" || [ -f "$path/.keep" ] || [ "$kept" -lt "$ECS_CANDIDATE_KEEP_COUNT" ]; then
      kept=$((kept + 1))
      printf 'KEEP_CANDIDATE\t%s\t%s\n' "$git_sha" "$path"
      continue
    fi
    if [ "${CONFIRM_ECS_STORAGE_CLEANUP:-NO}" = YES ]; then
      case "$path" in "$candidate_root"/*) ;; *) echo "refusing path outside candidates root: $path" >&2; exit 2 ;; esac
      [ ! -L "$path" ] || { echo "refusing symlink candidate: $path" >&2; exit 2; }
      rm -rf -- "$path"
      printf 'DELETE_CANDIDATE\t%s\t%s\n' "$git_sha" "$path"
    else
      printf 'WOULD_DELETE_CANDIDATE\t%s\t%s\n' "$git_sha" "$path"
    fi
  done < "$candidate_bundles_file"
}

prune_build_cache() {
  command -v docker >/dev/null 2>&1 || return 0
  if [ "${CONFIRM_ECS_STORAGE_CLEANUP:-NO}" = YES ]; then
    docker builder prune -f --filter "until=$ECS_BUILD_CACHE_UNTIL" --keep-storage "$ECS_BUILD_CACHE_KEEP_STORAGE"
  else
    docker system df
  fi
}

if [ "$action" = report ] || [ "$action" = cleanup ]; then
  echo "protected release IDs: $(tr '\n' ' ' < "$protected_file")"
  prune_releases
  prune_candidate_bundles
  prune_build_cache
  exit 0
fi

: "${ECS_CANDIDATE_BUNDLE_DIR:?ECS_CANDIDATE_BUNDLE_DIR is required}"

destination="$releases/$RELEASE_ID"
case "$destination" in "$releases"/*) ;; *) echo 'release destination escaped releases root' >&2; exit 2 ;; esac
[ ! -L "$destination" ] || { echo 'release destination must not be a symlink' >&2; exit 2; }

# Fail before the expensive npm install/build staging step when the host
# deployment contract is incomplete. The deploy runner still validates values,
# permissions, checksums, and every downstream evidence input independently.
missing=
for name in RENDERED_COMPOSE_PATH PRODUCTION_CONFIG_PATH ECS_DEPLOY_STATE_DIR ECS_PREIDENTITY_SERVICE_MAP_PATH ECS_DEPLOY_LOCK_PATH ECS_ROLLBACK_ENTRYPOINT ECS_ROLLBACK_PLAN_PATH ECS_ROLLBACK_COMPOSE_PATH ECS_ROLLBACK_ENV_FILE ECS_ROLLBACK_IMAGE_DIGESTS_JSON ECS_ROLLBACK_STATE_PATH PRODUCTION_API_BASE_URL PRODUCTION_APPROVED_ORIGIN PRODUCTION_CANARY_BEARER_TOKEN PRODUCTION_CANARY_WORKSPACE_ID POST_DEPLOY_CANARY_OUTPUT IMAGE_DIGESTS_JSON DEPLOYMENT_NONCE DATABASE_URL; do
  value=$(printenv "$name" 2>/dev/null || true)
  [ -n "$value" ] || missing="$missing $name"
done
[ -z "$missing" ] || { echo "one-click deployment configuration is incomplete; missing:$missing" >&2; exit 2; }
if [ ! -d "$destination" ]; then
  ECS_CANDIDATE_BUNDLE_DIR="$ECS_CANDIDATE_BUNDLE_DIR" ECS_RELEASES_ROOT="$releases" RELEASE_ID="$RELEASE_ID" \
    sh "$root/infra/scripts/stage-verified-ecs-release.sh"
fi
[ -f "$destination/.candidate-identity" ] || { echo 'staged release identity is missing' >&2; exit 2; }
echo "deploying verified release $RELEASE_ID from $destination"
(
  cd "$destination"
  CONFIRM_ECS_DEPLOY=YES \
  ECS_CANDIDATE_IDENTITY_PATH="$destination/.candidate-identity" \
  RELEASE_ID="$RELEASE_ID" \
  sh infra/scripts/deploy-verified-ecs-compose.sh
)

# Cleanup is deliberately post-success. A failed candidate stays intact for
# diagnosis, and no rollback/data volume is ever removed here.
CONFIRM_ECS_STORAGE_CLEANUP=YES
export CONFIRM_ECS_STORAGE_CLEANUP
prune_releases
prune_candidate_bundles
prune_build_cache
echo "verified deployment and bounded storage cleanup completed: $RELEASE_ID"
