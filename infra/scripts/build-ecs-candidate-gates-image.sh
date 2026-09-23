#!/bin/sh
set -eu

# Local construction only. Images are transferred to ECS as encrypted archives;
# this script never creates or pushes to a paid registry.
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
revision=${ECS_CANDIDATE_GIT_SHA:-}
tag=${ECS_CANDIDATE_BUILD_TAG:-}
printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'ECS_CANDIDATE_GIT_SHA must be a full commit SHA' >&2; exit 2;
}
command -v git >/dev/null 2>&1 || { echo 'git is required' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 2; }
command -v shasum >/dev/null 2>&1 || { echo 'shasum is required' >&2; exit 2; }
command -v tar >/dev/null 2>&1 || { echo 'tar is required' >&2; exit 2; }
[ "$(git -C "$root" rev-parse HEAD)" = "$revision" ] || {
  echo 'candidate revision does not match HEAD' >&2; exit 2;
}
[ -z "$(git -C "$root" status --porcelain --untracked-files=normal)" ] || {
  echo 'candidate build requires a clean committed source tree' >&2; exit 2;
}
case "$tag" in
  '') tag="storenova-candidate-gates:$revision" ;;
  *@sha256:*|*:latest) echo 'build tag must be a local non-latest tag' >&2; exit 2 ;;
esac

archive=$(mktemp "${TMPDIR:-/tmp}/candidate-source.XXXXXXXX")
context=$(mktemp -d "${TMPDIR:-/tmp}/candidate-context.XXXXXXXX")
trap 'rm -f "$archive"; rm -rf "$context"' EXIT HUP INT TERM
cloud_source_v2=${ECS_CLOUD_SOURCE_V2:-0}
case "$cloud_source_v2" in
  0) git -C "$root" archive --format=tar "$revision" \
       ':(exclude)artifacts' ':(exclude)screenshots' > "$archive" ;;
  1)
    : "${ECS_CANDIDATE_BUNDLE_DIR:?cloud candidate gate build requires verified candidate bundle}"
    source_archive="$ECS_CANDIDATE_BUNDLE_DIR/candidate-source.tar"
    source_identity="$ECS_CANDIDATE_BUNDLE_DIR/candidate-identity.txt"
    for input in "$source_archive" "$source_identity"; do
      [ -f "$input" ] && [ ! -L "$input" ] || { echo 'cloud candidate source or identity is missing or unsafe' >&2; exit 2; }
    done
    [ "$(sed -n 's/^schema_version=//p' "$source_identity")" = candidate-identity/2 ] || { echo 'cloud candidate identity schema mismatch' >&2; exit 2; }
    [ "$(sed -n 's/^git_sha=//p' "$source_identity")" = "$revision" ] || { echo 'cloud candidate Git SHA mismatch' >&2; exit 2; }
    cp "$source_archive" "$archive"
    [ "$(sed -n 's/^source_sha256=//p' "$source_identity")" = "sha256:$(shasum -a 256 "$archive" | awk '{print $1}')" ] || { echo 'cloud candidate source digest mismatch' >&2; exit 2; }
    [ "$(git get-tar-commit-id < "$archive" 2>/dev/null)" = "$revision" ] || { echo 'cloud candidate archive commit mismatch' >&2; exit 2; }
    ;;
  *) echo 'ECS_CLOUD_SOURCE_V2 must be 0 or 1' >&2; exit 2 ;;
esac
source_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
tar -xf "$archive" -C "$context"
[ -f "$context/infra/docker/candidate-gates.Dockerfile" ] || {
  echo 'candidate Dockerfile is absent from committed source' >&2; exit 2;
}
# A commit archive has no host credentials or untracked build output.
docker build --pull=false --no-cache \
  --build-arg "CANDIDATE_GIT_SHA=$revision" \
  --build-arg "CANDIDATE_SOURCE_SHA256=sha256:$source_sha" \
  --build-arg "CANDIDATE_CLOUD_SOURCE_V2=$cloud_source_v2" \
  -f "$context/infra/docker/candidate-gates.Dockerfile" -t "$tag" "$context"
image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")
image_source=$(docker image inspect --format '{{index .Config.Labels "com.storenova.candidate.source_sha256"}}' "$tag")
image_cloud=$(docker image inspect --format '{{index .Config.Labels "com.storenova.candidate.cloud_source_v2"}}' "$tag")
[ "$image_revision" = "$revision" ] && [ "$image_source" = "sha256:$source_sha" ] && [ "$image_cloud" = "$cloud_source_v2" ] || {
  echo 'candidate image labels do not match source archive' >&2; exit 1;
}
echo "local candidate gate image built: $tag revision=$revision source_sha256=sha256:$source_sha"
