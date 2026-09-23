#!/bin/sh
set -eu

# Materialize one reviewed candidate archive as a new, repository-external
# release checkout. Deployment remains a separate operator action.
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
. "$root/infra/scripts/ecs-build-lock.sh"
: "${ECS_CANDIDATE_BUNDLE_DIR:?ECS_CANDIDATE_BUNDLE_DIR is required}"
: "${ECS_RELEASES_ROOT:?ECS_RELEASES_ROOT is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"

printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || { echo 'unsafe RELEASE_ID' >&2; exit 2; }
for tool in git shasum python3 tar npm; do command -v "$tool" >/dev/null 2>&1 || { echo "release staging requires $tool" >&2; exit 2; }; done
[ -d "$ECS_CANDIDATE_BUNDLE_DIR" ] && [ ! -L "$ECS_CANDIDATE_BUNDLE_DIR" ] || { echo 'candidate bundle must be a non-symlink directory' >&2; exit 2; }
[ -d "$ECS_RELEASES_ROOT" ] && [ ! -L "$ECS_RELEASES_ROOT" ] || { echo 'releases root must be an existing non-symlink directory' >&2; exit 2; }
bundle=$(CDPATH='' cd -- "$ECS_CANDIDATE_BUNDLE_DIR" && pwd -P)
releases=$(CDPATH='' cd -- "$ECS_RELEASES_ROOT" && pwd -P)
[ "$bundle" = "$ECS_CANDIDATE_BUNDLE_DIR" ] || { echo 'candidate bundle path must be absolute and canonical' >&2; exit 2; }
[ "$releases" = "$ECS_RELEASES_ROOT" ] || { echo 'releases root path must be absolute and canonical' >&2; exit 2; }
case "$releases/" in "$root/"*) echo 'release checkout must be staged outside the mutable repository' >&2; exit 2 ;; esac
# The candidate controls package.json and therefore the build command.  Hashes
# only bind the files to candidate-identity.txt; they do not make an
# attacker-writable bundle trustworthy.  Refuse bundles that another local
# principal can replace before the verified archive is copied into staging.
BUNDLE="$bundle" python3 <<'PY'
import os, pathlib, stat

bundle = pathlib.Path(os.environ['BUNDLE'])
expected_uid = os.geteuid()
cursor = bundle
while True:
    # pathlib.Path.stat(follow_symlinks=...) is unavailable on the Python
    # version shipped by the ECS host. lstat() has the required no-follow
    # semantics and keeps the same symlink-rejection boundary.
    value = cursor.lstat()
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise SystemExit(f'candidate bundle path component is not a real directory: {cursor}')
    if cursor == bundle and value.st_uid != expected_uid:
        raise SystemExit('candidate bundle must be owned by the staging user')
    writable_by_others = value.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
    sticky_directory = value.st_mode & stat.S_ISVTX
    if writable_by_others and not sticky_directory:
        raise SystemExit(f'candidate bundle path is replaceable by another user: {cursor}')
    if cursor.parent == cursor:
        break
    cursor = cursor.parent
PY
owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
[ "$(owner_of "$releases")" = "$(id -u)" ] || { echo 'releases root must be owned by the staging user' >&2; exit 2; }
release_mode=$(mode_of "$releases"); case "$release_mode" in *[2367][0-7]|*[2367]) echo 'releases root must not be writable by group or other users' >&2; exit 2 ;; esac
destination="$releases/$RELEASE_ID"
ecs_build_lock_acquire
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'release destination already exists; refusing to overwrite' >&2; exit 2; }
stage_lock="$releases/.${RELEASE_ID}.staging.lock"
mkdir -m 0700 "$stage_lock" 2>/dev/null || { echo 'release staging is already in progress for this RELEASE_ID' >&2; exit 2; }
stage=
cleanup() {
  [ -z "$stage" ] || rm -rf -- "$stage"
  rmdir "$stage_lock" 2>/dev/null || true
  ecs_build_lock_cleanup
}
trap cleanup EXIT HUP INT TERM

archive="$bundle/candidate-source.tar"; identity="$bundle/candidate-identity.txt"
comparison="$bundle/files.txt"; sync_plan="$bundle/sync-plan.tsv"
for path in "$archive" "$identity" "$comparison" "$sync_plan"; do
  [ -f "$path" ] && [ ! -L "$path" ] || { echo "candidate input must be a regular non-symlink file: $path" >&2; exit 2; }
done
field() {
  key=$1
  count=$(awk -F= -v key="$key" '$1 == key { count++ } END { print count+0 }' "$identity")
  [ "$count" -eq 1 ] || { echo "candidate identity must contain exactly one $key" >&2; exit 2; }
  sed -n "s/^${key}=//p" "$identity"
}
git_sha=$(field git_sha); source_sha=$(field source_sha256)
comparison_sha=$(field comparison_manifest_sha256); sync_plan_sha=$(field sync_plan_sha256)
identity_schema=$(sed -n 's/^schema_version=//p' "$identity")
case "$identity_schema" in
  '') ;;
  candidate-identity/2)
    [ "$(field release_id)" = "$RELEASE_ID" ] || { echo 'candidate v2 release ID mismatch' >&2; exit 2; }
    plugin_sha=$(field plugin_descriptor_sha256)
    plugin_test_sha=$(field plugin_test_attestation_sha256)
    plugin_key_id=$(field plugin_key_id)
    printf '%s' "$plugin_sha" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'candidate plugin descriptor digest is invalid' >&2; exit 2; }
    printf '%s' "$plugin_test_sha" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'candidate plugin test digest is invalid' >&2; exit 2; }
    printf '%s' "$plugin_key_id" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' || { echo 'candidate plugin key ID is invalid' >&2; exit 2; }
    plugin_descriptor="$bundle/plugin-release-descriptor.json"
    plugin_test="$bundle/local-plugin-test-attestation.json"
    [ -f "$plugin_descriptor" ] && [ ! -L "$plugin_descriptor" ] || { echo 'candidate v2 plugin descriptor is missing or unsafe' >&2; exit 2; }
    [ -f "$plugin_test" ] && [ ! -L "$plugin_test" ] || { echo 'candidate v2 plugin test attestation is missing or unsafe' >&2; exit 2; }
    [ "$(shasum -a 256 "$plugin_descriptor" | awk '{print $1}')" = "${plugin_sha#sha256:}" ] || { echo 'candidate v2 plugin descriptor digest mismatch' >&2; exit 2; }
    [ "$(shasum -a 256 "$plugin_test" | awk '{print $1}')" = "${plugin_test_sha#sha256:}" ] || { echo 'candidate v2 plugin test attestation digest mismatch' >&2; exit 2; }
    plugin_public_key=/run/release-security/plugin-trust/plugin-release-public.pem
    plugin_trusted_key_id_path=/run/release-security/plugin-trust/key-id
    [ -f "$plugin_public_key" ] && [ ! -L "$plugin_public_key" ] || { echo 'candidate v2 trusted plugin public key is missing or unsafe' >&2; exit 2; }
    [ -f "$plugin_trusted_key_id_path" ] && [ ! -L "$plugin_trusted_key_id_path" ] || { echo 'candidate v2 trusted plugin key ID is missing or unsafe' >&2; exit 2; }
    python3 <<'PY'
import pathlib, stat
for name in ('plugin-release-public.pem', 'key-id'):
    path = pathlib.Path('/run/release-security/plugin-trust') / name
    for entry in (path, path.parent, path.parent.parent):
        item = entry.lstat()
        if item.st_uid != 0 or item.st_mode & (stat.S_IWGRP | stat.S_IWOTH) or stat.S_ISLNK(item.st_mode):
            raise SystemExit(f'candidate v2 plugin trust path is not root-owned and protected: {entry}')
PY
    [ "$plugin_key_id" = "$(sed -n '1p' "$plugin_trusted_key_id_path")" ] || { echo 'candidate v2 plugin key ID does not match trusted key' >&2; exit 2; }
    node "$root/scripts/plugin-release-descriptor.mjs" verify-cloud \
      --descriptor "$plugin_descriptor" --public-key "$plugin_public_key" \
      --key-id "$plugin_key_id" --release-id "$RELEASE_ID" --git-sha "$git_sha"
    plugin_platform=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.platform)' "$plugin_descriptor")
    node "$root/scripts/local-plugin-test-attestation.mjs" verify \
      --record "$plugin_test" --descriptor "$plugin_descriptor" --public-key "$plugin_public_key" \
      --key-id "$plugin_key_id" --release-id "$RELEASE_ID" --git-sha "$git_sha" --platform "$plugin_platform"
    ;;
  *) echo 'candidate identity schema is unsupported' >&2; exit 2 ;;
esac
printf '%s' "$git_sha" | grep -Eq '^[0-9a-f]{40}$' || { echo 'candidate Git SHA is invalid' >&2; exit 2; }
for binding in "$source_sha" "$comparison_sha" "$sync_plan_sha"; do
  printf '%s' "$binding" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'candidate identity digest is invalid' >&2; exit 2; }
done
actual_archive=$(shasum -a 256 "$archive" | awk '{print $1}')
actual_comparison=$(shasum -a 256 "$comparison" | awk '{print $1}')
actual_sync_plan=$(shasum -a 256 "$sync_plan" | awk '{print $1}')
[ "$source_sha" = "sha256:$actual_archive" ] || { echo 'candidate source archive digest mismatch' >&2; exit 2; }
[ "$comparison_sha" = "sha256:$actual_comparison" ] || { echo 'candidate comparison manifest digest mismatch' >&2; exit 2; }
[ "$sync_plan_sha" = "sha256:$actual_sync_plan" ] || { echo 'candidate sync plan digest mismatch' >&2; exit 2; }
embedded_sha=$(git get-tar-commit-id < "$archive" 2>/dev/null || true)
[ "$embedded_sha" = "$git_sha" ] || { echo 'candidate archive commit does not match candidate identity' >&2; exit 2; }

ARCHIVE="$archive" IDENTITY_SCHEMA="$identity_schema" python3 <<'PY'
import os, pathlib, tarfile
MAX_MEMBERS = 250_000
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
with tarfile.open(os.environ['ARCHIVE'], 'r:') as source:
    members = source.getmembers()
    if not members:
        raise SystemExit('candidate archive is empty')
    if len(members) > MAX_MEMBERS:
        raise SystemExit('candidate archive contains too many members')
    seen = set()
    total = 0
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or not member.name or '..' in path.parts:
            raise SystemExit(f'unsafe candidate archive path: {member.name}')
        normalized = path.as_posix().rstrip('/')
        if not normalized or normalized in seen:
            raise SystemExit(f'candidate archive contains a duplicate path: {member.name}')
        if os.environ.get('IDENTITY_SCHEMA') == 'candidate-identity/2' and (normalized == 'apps/plugin' or normalized.startswith('apps/plugin/') or normalized == '.codex-marketplace' or normalized.startswith('.codex-marketplace/')):
            raise SystemExit(f'cloud candidate archive contains local plugin source: {member.name}')
        seen.add(normalized)
        if not (member.isdir() or member.isfile()):
            raise SystemExit(f'candidate archive contains a link or special file: {member.name}')
        if member.mode & 0o7000:
            raise SystemExit(f'candidate archive contains privileged mode bits: {member.name}')
        if member.isfile():
            if member.size > MAX_FILE_BYTES:
                raise SystemExit(f'candidate archive member is too large: {member.name}')
            total += member.size
            if total > MAX_TOTAL_BYTES:
                raise SystemExit('candidate archive expands beyond the release limit')
PY

umask 077
stage=$(mktemp -d "$releases/.${RELEASE_ID}.staging.XXXXXXXX")
cp "$archive" "$stage/.candidate-source.tar"; chmod 0400 "$stage/.candidate-source.tar"
if [ "$identity_schema" = candidate-identity/2 ]; then
  cp "$plugin_descriptor" "$stage/.plugin-release-descriptor.json"
  cp "$plugin_test" "$stage/.local-plugin-test-attestation.json"
  chmod 0400 "$stage/.plugin-release-descriptor.json"
  chmod 0400 "$stage/.local-plugin-test-attestation.json"
fi
[ "$actual_archive" = "$(shasum -a 256 "$stage/.candidate-source.tar" | awk '{print $1}')" ] || { echo 'candidate archive changed while staging' >&2; exit 1; }
tar -xf "$stage/.candidate-source.tar" -C "$stage"
[ -f "$stage/package.json" ] && [ -f "$stage/package-lock.json" ] || { echo 'candidate archive lacks the locked Node workspace' >&2; exit 2; }

# Runtime credentials and server-only configuration stay outside this tree.
# Build workspace packages after the locked install so staged source tests and
# image builds resolve package exports from the candidate itself, while still
# keeping lifecycle scripts disabled during npm ci.
(cd "$stage" && npm ci --ignore-scripts --no-audit --no-fund && npm ci --prefix demo/merchant-studio --ignore-scripts --no-audit --no-fund && npm run build)
cat > "$stage/.candidate-identity" <<EOF
release_id=$RELEASE_ID
git_sha=$git_sha
source_sha256=$source_sha
comparison_manifest_sha256=$comparison_sha
sync_plan_sha256=$sync_plan_sha
EOF
if [ "$identity_schema" = candidate-identity/2 ]; then
  printf 'schema_version=candidate-identity/2\nplugin_descriptor_sha256=%s\nplugin_test_attestation_sha256=%s\nplugin_key_id=%s\n' "$plugin_sha" "$plugin_test_sha" "$plugin_key_id" >> "$stage/.candidate-identity"
fi
chmod 0400 "$stage/.candidate-identity"
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'release destination appeared during staging; refusing to overwrite' >&2; exit 2; }
mv "$stage" "$destination"
stage=
trap - EXIT HUP INT TERM
rmdir "$stage_lock"
ecs_build_lock_cleanup
printf 'verified ECS release staged: %s git_sha=%s source_sha256=%s\n' "$destination" "$git_sha" "$source_sha"
