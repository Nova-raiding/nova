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

archive=$(mktemp "${TMPDIR:-/tmp}/candidate-source.XXXXXXXX.tar")
context=$(mktemp -d "${TMPDIR:-/tmp}/candidate-context.XXXXXXXX")
trap 'rm -f "$archive"; rm -rf "$context"' EXIT HUP INT TERM
git -C "$root" archive --format=tar "$revision" > "$archive"
source_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
tar -xf "$archive" -C "$context"
[ -f "$context/infra/docker/candidate-gates.Dockerfile" ] || {
  echo 'candidate Dockerfile is absent from committed source' >&2; exit 2;
}
# A commit archive has no host credentials or untracked build output.
docker build --pull=false --no-cache \
  --build-arg "CANDIDATE_GIT_SHA=$revision" \
  --build-arg "CANDIDATE_SOURCE_SHA256=sha256:$source_sha" \
  -f "$context/infra/docker/candidate-gates.Dockerfile" -t "$tag" "$context"
image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")
image_source=$(docker image inspect --format '{{index .Config.Labels "com.storenova.candidate.source_sha256"}}' "$tag")
[ "$image_revision" = "$revision" ] && [ "$image_source" = "sha256:$source_sha" ] || {
  echo 'candidate image labels do not match source archive' >&2; exit 1;
}
echo "local candidate gate image built: $tag revision=$revision source_sha256=sha256:$source_sha"
