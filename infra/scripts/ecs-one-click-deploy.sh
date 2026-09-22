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
: "${ECS_BUILD_CACHE_KEEP_STORAGE:=2GB}"
: "${ECS_BUILD_CACHE_UNTIL:=24h}"

case "$action" in deploy|cleanup|report) ;; *) echo 'usage: ecs-one-click-deploy.sh [deploy|cleanup|report]' >&2; exit 2 ;; esac
printf '%s' "$ECS_RELEASE_KEEP_COUNT" | grep -Eq '^[1-9][0-9]?$' || { echo 'ECS_RELEASE_KEEP_COUNT must be an integer from 1 to 99' >&2; exit 2; }
[ -d "$ECS_RELEASES_ROOT" ] && [ ! -L "$ECS_RELEASES_ROOT" ] || { echo 'ECS_RELEASES_ROOT must be an existing non-symlink directory' >&2; exit 2; }
releases=$(CDPATH='' cd -- "$ECS_RELEASES_ROOT" && pwd -P)
[ "$releases" = "$ECS_RELEASES_ROOT" ] || { echo 'ECS_RELEASES_ROOT must be absolute and canonical' >&2; exit 2; }

owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
[ "$(owner_of "$releases")" = "$(id -u)" ] || { echo 'ECS_RELEASES_ROOT must be owned by the invoking user' >&2; exit 2; }
release_mode=$(mode_of "$releases"); case "$release_mode" in *[2367][0-7]|*[2367]) echo 'ECS_RELEASES_ROOT must not be writable by group or other users' >&2; exit 2 ;; esac

protected_file=$(mktemp "${TMPDIR:-/tmp}/merchant-protected-releases.XXXXXXXX")
candidates_file=$(mktemp "${TMPDIR:-/tmp}/merchant-release-candidates.XXXXXXXX")
cleanup_temp() { rm -f -- "$protected_file" "$candidates_file"; }
trap cleanup_temp EXIT HUP INT TERM

protect() {
  value=$1
  [ -n "$value" ] || return 0
  printf '%s' "$value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || { echo "unsafe protected release ID: $value" >&2; exit 2; }
  printf '%s\n' "$value" >> "$protected_file"
}

for value in ${ECS_PROTECTED_RELEASE_IDS:-}; do protect "$value"; done
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

prune_build_cache() {
  command -v docker >/dev/null 2>&1 || return 0
  if [ "${CONFIRM_ECS_STORAGE_CLEANUP:-NO}" = YES ]; then
    docker builder prune -f --filter "until=$ECS_BUILD_CACHE_UNTIL" --keep-storage "$ECS_BUILD_CACHE_KEEP_STORAGE"
    docker image prune -f
  else
    docker system df
  fi
}

if [ "$action" = report ] || [ "$action" = cleanup ]; then
  echo "protected release IDs: $(tr '\n' ' ' < "$protected_file")"
  prune_releases
  prune_build_cache
  exit 0
fi

: "${ECS_CANDIDATE_BUNDLE_DIR:?ECS_CANDIDATE_BUNDLE_DIR is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
destination="$releases/$RELEASE_ID"
if [ ! -d "$destination" ]; then
  ECS_CANDIDATE_BUNDLE_DIR="$ECS_CANDIDATE_BUNDLE_DIR" ECS_RELEASES_ROOT="$releases" RELEASE_ID="$RELEASE_ID" \
    sh "$root/infra/scripts/stage-verified-ecs-release.sh"
fi
[ -f "$destination/.candidate-identity" ] || { echo 'staged release identity is missing' >&2; exit 2; }
: "${RENDERED_COMPOSE_PATH:?RENDERED_COMPOSE_PATH must point to the reviewed immutable Compose file}"
: "${PRODUCTION_CONFIG_PATH:?PRODUCTION_CONFIG_PATH is required}"
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
prune_build_cache
echo "verified deployment and bounded storage cleanup completed: $RELEASE_ID"
