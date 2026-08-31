#!/bin/sh
set -eu

fail() {
  echo "container source freshness gate failed: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 <api-image@sha256|sha256:id> <worker-image@sha256|sha256:id> <expected-api-digest> <expected-worker-digest>" >&2
  exit 2
}

[ "$#" -eq 4 ] || usage
api_image_ref=$1
worker_image_ref=$2
expected_api_digest=$3
expected_worker_digest=$4

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
migrations_dir="$repo_root/packages/persistence/src/migrations"
source_root=$repo_root
manifest_generator="$script_dir/generate-container-source-manifest.mjs"
image_migrations_path='/app/dist/packages/persistence/src/migrations'
image_source_manifest_path='/app/.release-source'

# Tests may point the gate at isolated fixture directories and a fake Docker
# CLI through PATH. Production callers cannot replace either trusted path.
if [ "${CONTAINER_FRESHNESS_TEST_HOOK:-}" = 'enabled-for-tests-only' ] && [ "${NODE_ENV:-}" = 'test' ]; then
  migrations_dir=${CONTAINER_FRESHNESS_TEST_MIGRATIONS_DIR:-$migrations_dir}
  source_root=${CONTAINER_FRESHNESS_TEST_SOURCE_ROOT:-$source_root}
  image_migrations_path=${CONTAINER_FRESHNESS_TEST_IMAGE_MIGRATIONS_PATH:-$image_migrations_path}
else
  [ "${CONTAINER_FRESHNESS_TEST_HOOK+x}" != x ] || fail 'test hook is forbidden outside NODE_ENV=test'
  [ "${CONTAINER_FRESHNESS_TEST_MIGRATIONS_DIR+x}" != x ] || fail 'test migrations directory override is forbidden'
  [ "${CONTAINER_FRESHNESS_TEST_SOURCE_ROOT+x}" != x ] || fail 'test source root override is forbidden'
  [ "${CONTAINER_FRESHNESS_TEST_IMAGE_MIGRATIONS_PATH+x}" != x ] || fail 'test image path override is forbidden'
fi

command -v docker >/dev/null 2>&1 || fail 'docker CLI is required'
command -v node >/dev/null 2>&1 || fail 'node is required for deterministic source manifest verification'
command -v cmp >/dev/null 2>&1 || fail 'cmp is required for byte-exact source manifest verification'
[ -f "$manifest_generator" ] || fail "shared source manifest generator is missing: $manifest_generator"

is_digest() {
  printf '%s\n' "$1" | grep -Eq '^sha256:[0-9a-f]{64}$'
}

validate_image_binding() {
  image_ref=$1
  expected_digest=$2
  label=$3
  is_digest "$expected_digest" || fail "$label expected digest must be sha256 plus 64 lowercase hexadecimal characters"
  case "$image_ref" in
    sha256:*)
      is_digest "$image_ref" || fail "$label image ID is malformed"
      [ "$image_ref" = "$expected_digest" ] || fail "$label image ID does not match its expected digest"
      ;;
    *@sha256:*)
      actual_digest=${image_ref##*@}
      is_digest "$actual_digest" || fail "$label image reference has a malformed digest"
      [ "$actual_digest" = "$expected_digest" ] || fail "$label image reference does not match its expected digest"
      ;;
    *) fail "$label image must be an immutable repository@sha256 reference or sha256 image ID; tags are forbidden" ;;
  esac
}

validate_image_binding "$api_image_ref" "$expected_api_digest" 'API'
validate_image_binding "$worker_image_ref" "$expected_worker_digest" 'Worker'

hash_file() {
  target=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
  else
    fail 'sha256sum or shasum is required'
  fi
}

inventory_migrations() {
  directory=$1
  label=$2
  inventory=$3
  [ -d "$directory" ] || fail "$label migrations directory is missing: $directory"
  : > "$inventory"
  found=0
  for migration in "$directory"/*.sql; do
    [ -f "$migration" ] || continue
    [ ! -L "$migration" ] || fail "$label migration must not be a symbolic link: ${migration##*/}"
    found=1
    filename=${migration##*/}
    printf '%s\n' "$filename" | grep -Eq '^[0-9]{3}_[a-z0-9][a-z0-9_]*\.sql$' \
      || fail "$label migration filename is invalid: $filename"
    version=${filename%%_*}
    [ "$version" != '000' ] || fail "$label migration version 000 is forbidden"
    digest=$(hash_file "$migration")
    is_digest "sha256:$digest" || fail "$label migration SHA-256 is invalid: $filename"
    printf '%s|%s|%s\n' "$version" "$filename" "$digest" >> "$inventory"
  done
  [ "$found" -eq 1 ] || fail "$label contains no migration SQL files"
  duplicate=$(cut -d '|' -f 1 "$inventory" | sort | uniq -d | sed -n '1p')
  [ -z "$duplicate" ] || fail "$label contains duplicate migration version $duplicate"
}

tmp_parent=${TMPDIR:-/tmp}
[ -d "$tmp_parent" ] || fail "temporary directory parent is missing: $tmp_parent"
tmp_dir=$(mktemp -d "$tmp_parent/merchant-container-freshness.XXXXXX") || fail 'could not create temporary directory'
containers=''
cleanup() {
  for container_id in $containers; do
    docker container rm "$container_id" >/dev/null 2>&1 || true
  done
  case "$tmp_dir" in
    "$tmp_parent"/merchant-container-freshness.*) rm -rf -- "$tmp_dir" ;;
    *) echo "refusing to remove unexpected temporary path: $tmp_dir" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

workspace_inventory="$tmp_dir/workspace.inventory"
inventory_migrations "$migrations_dir" 'workspace' "$workspace_inventory"
workspace_latest=$(LC_ALL=C sort -t '|' -k1,1 "$workspace_inventory" | tail -n 1)
workspace_version=$(printf '%s\n' "$workspace_latest" | cut -d '|' -f 1)
workspace_filename=$(printf '%s\n' "$workspace_latest" | cut -d '|' -f 2)
workspace_digest=$(printf '%s\n' "$workspace_latest" | cut -d '|' -f 3)

generate_workspace_manifests() {
  api_output_prefix=$1
  worker_output_prefix=$2
  node "$manifest_generator" generate-pair "$source_root" \
    "$api_output_prefix" "$worker_output_prefix" >/dev/null \
    || fail 'could not generate the fixed API/Worker workspace source manifests'
}

generate_workspace_manifests "$tmp_dir/workspace-api" "$tmp_dir/workspace-worker"

verify_image() {
  image_ref=$1
  label=$2
  destination=$3
  profile=$4
  resolved_id=$(docker image inspect --format '{{.Id}}' "$image_ref" 2>/dev/null) \
    || fail "$label image is unavailable to Docker: $image_ref"
  line_count=$(printf '%s\n' "$resolved_id" | sed '/^$/d' | wc -l | tr -d ' ')
  [ "$line_count" = '1' ] || fail "$label image reference did not resolve to exactly one image ID"
  is_digest "$resolved_id" || fail "$label resolved image ID is malformed"

  container_id=$(docker create "$resolved_id" 2>/dev/null) \
    || fail "$label image could not be inspected without running it"
  printf '%s\n' "$container_id" | grep -Eq '^[0-9a-f]{12,64}$' \
    || fail "$label docker create returned an invalid container ID"
  containers="$containers $container_id"
  mkdir -p "$destination"
  docker cp "$container_id:$image_migrations_path/." "$destination" >/dev/null 2>&1 \
    || fail "$label image is missing migration assets at $image_migrations_path"

  image_manifest="$tmp_dir/$profile-image.manifest"
  image_manifest_digest="$tmp_dir/$profile-image.manifest.sha256"
  docker cp "$container_id:$image_source_manifest_path/$profile.manifest" "$image_manifest" >/dev/null 2>&1 \
    || fail "$label image is missing its fixed source manifest"
  docker cp "$container_id:$image_source_manifest_path/$profile.manifest.sha256" "$image_manifest_digest" >/dev/null 2>&1 \
    || fail "$label image is missing its source manifest total SHA-256"
  [ -f "$image_manifest" ] && [ ! -L "$image_manifest" ] \
    || fail "$label image source manifest must be a regular non-symbolic-link file"
  [ -f "$image_manifest_digest" ] && [ ! -L "$image_manifest_digest" ] \
    || fail "$label image source manifest digest must be a regular non-symbolic-link file"
  node "$manifest_generator" verify "$profile" "$image_manifest" "$image_manifest_digest" >/dev/null \
    || fail "$label image source manifest is malformed or internally inconsistent"
  cmp -s "$tmp_dir/workspace-$profile.manifest" "$image_manifest" \
    || fail "$label image source manifest has missing, extra, or content-mismatched build inputs"
  cmp -s "$tmp_dir/workspace-$profile.manifest.sha256" "$image_manifest_digest" \
    || fail "$label image source manifest total SHA-256 differs from the workspace"

  image_inventory="$tmp_dir/$label.inventory"
  inventory_migrations "$destination" "$label image" "$image_inventory"
  # POSIX sh functions share variables; restore the caller's short label after
  # inventory_migrations uses its own human-readable label.
  label=$2
  image_latest=$(LC_ALL=C sort -t '|' -k1,1 "$image_inventory" | tail -n 1)
  image_version=$(printf '%s\n' "$image_latest" | cut -d '|' -f 1)
  image_filename=$(printf '%s\n' "$image_latest" | cut -d '|' -f 2)
  image_digest=$(printf '%s\n' "$image_latest" | cut -d '|' -f 3)
  [ "$image_version" = "$workspace_version" ] \
    || fail "$label image latest migration is $image_version but workspace latest is $workspace_version"
  [ "$image_filename" = "$workspace_filename" ] \
    || fail "$label image latest migration filename differs from workspace: $image_filename != $workspace_filename"
  [ "$image_digest" = "$workspace_digest" ] \
    || fail "$label image migration SHA-256 differs from workspace for $workspace_filename"
  source_digest=$(sed -n '1p' "$image_manifest_digest")
  echo "$label image freshness passed: image_id=$resolved_id migration=$workspace_filename sha256=$workspace_digest source_manifest=$source_digest"
}

verify_image "$api_image_ref" 'API' "$tmp_dir/api" api
verify_image "$worker_image_ref" 'Worker' "$tmp_dir/worker" worker
generate_workspace_manifests "$tmp_dir/workspace-api-final" "$tmp_dir/workspace-worker-final"
inventory_migrations "$migrations_dir" 'workspace final check' "$tmp_dir/workspace-final.inventory"
cmp -s "$workspace_inventory" "$tmp_dir/workspace-final.inventory" \
  || fail 'workspace migrations changed while the freshness gate was running'
cmp -s "$tmp_dir/workspace-api.manifest" "$tmp_dir/workspace-api-final.manifest" \
  || fail 'workspace API source inputs changed while the freshness gate was running'
cmp -s "$tmp_dir/workspace-worker.manifest" "$tmp_dir/workspace-worker-final.manifest" \
  || fail 'workspace Worker source inputs changed while the freshness gate was running'
echo "container source freshness gate passed: migration=$workspace_filename sha256=$workspace_digest"
