#!/bin/sh
set -eu

# Materialize one reviewed candidate archive as a new, repository-external
# release checkout. Deployment remains a separate operator action.
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
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
owner_of() { if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi; }
mode_of() { if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi; }
[ "$(owner_of "$releases")" = "$(id -u)" ] || { echo 'releases root must be owned by the staging user' >&2; exit 2; }
release_mode=$(mode_of "$releases"); case "$release_mode" in *[2367][0-7]|*[2367]) echo 'releases root must not be writable by group or other users' >&2; exit 2 ;; esac
destination="$releases/$RELEASE_ID"
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'release destination already exists; refusing to overwrite' >&2; exit 2; }
stage_lock="$releases/.${RELEASE_ID}.staging.lock"
mkdir -m 0700 "$stage_lock" 2>/dev/null || { echo 'release staging is already in progress for this RELEASE_ID' >&2; exit 2; }
stage=
cleanup() {
  [ -z "$stage" ] || rm -rf -- "$stage"
  rmdir "$stage_lock" 2>/dev/null || true
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

ARCHIVE="$archive" python3 <<'PY'
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
[ "$actual_archive" = "$(shasum -a 256 "$stage/.candidate-source.tar" | awk '{print $1}')" ] || { echo 'candidate archive changed while staging' >&2; exit 1; }
tar -xf "$stage/.candidate-source.tar" -C "$stage"
[ -f "$stage/package.json" ] && [ -f "$stage/package-lock.json" ] || { echo 'candidate archive lacks the locked Node workspace' >&2; exit 2; }

# Runtime credentials and server-only configuration stay outside this tree.
(cd "$stage" && npm ci --ignore-scripts --no-audit --no-fund)
cat > "$stage/.candidate-identity" <<EOF
release_id=$RELEASE_ID
git_sha=$git_sha
source_sha256=$source_sha
comparison_manifest_sha256=$comparison_sha
sync_plan_sha256=$sync_plan_sha
EOF
chmod 0400 "$stage/.candidate-identity"
[ ! -e "$destination" ] && [ ! -L "$destination" ] || { echo 'release destination appeared during staging; refusing to overwrite' >&2; exit 2; }
mv "$stage" "$destination"
stage=
trap - EXIT HUP INT TERM
rmdir "$stage_lock"
printf 'verified ECS release staged: %s git_sha=%s source_sha256=%s\n' "$destination" "$git_sha" "$source_sha"
