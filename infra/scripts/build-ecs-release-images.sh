#!/bin/sh
set -eu

# Build and publish the six repository-owned ECS release images from one
# committed source archive. This script never renders Compose, starts a
# container, or changes a deployment. Its only remote write is pushing the
# explicitly named release repositories to the configured registry.

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
. "$root/infra/scripts/ecs-build-lock.sh"
revision=${ECS_RELEASE_GIT_SHA:-}
release_id=${RELEASE_ID:-}
repository=${ECS_RELEASE_IMAGE_REPOSITORY:-}
output_dir=${ECS_RELEASE_IMAGE_OUTPUT_DIR:-"$root/artifacts/release-images/$release_id"}
cache_limit=${ECS_BUILD_CACHE_KEEP_STORAGE:-2GB}
source_archive=${ECS_RELEASE_SOURCE_ARCHIVE:-}
source_identity=${ECS_RELEASE_SOURCE_IDENTITY:-}
ops_login_url=${ECS_OPS_UI_LOGIN_URL:-}
ops_auth_mode=${ECS_OPS_AUTH_MODE:-}

printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'ECS_RELEASE_GIT_SHA must be a full commit SHA' >&2; exit 2;
}
printf '%s' "$release_id" | grep -Eq '^(release|ecs)-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' || {
  echo 'RELEASE_ID must be a safe release-* or ecs-* identifier' >&2; exit 2;
}
printf '%s' "$repository" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.:_-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)+$' || {
  echo 'ECS_RELEASE_IMAGE_REPOSITORY must be a registry/repository prefix without a tag or digest' >&2; exit 2;
}
case "$repository" in *@*|*'://'*) echo 'ECS_RELEASE_IMAGE_REPOSITORY must not contain a digest or URL scheme' >&2; exit 2 ;; esac
case "${repository#*/}" in *:*) echo 'ECS_RELEASE_IMAGE_REPOSITORY must not contain an image tag' >&2; exit 2 ;; esac
printf '%s' "$cache_limit" | grep -Eq '^[1-9][0-9]*(B|KB|MB|GB|TB)$' || {
  echo 'ECS_BUILD_CACHE_KEEP_STORAGE must be a positive Docker storage size such as 2GB' >&2; exit 2;
}
case "$output_dir" in /*) ;; *) echo 'ECS_RELEASE_IMAGE_OUTPUT_DIR must be absolute' >&2; exit 2 ;; esac
case "$ops_auth_mode" in
  password) [ -z "$ops_login_url" ] || { echo 'ECS_OPS_UI_LOGIN_URL must be empty when ECS_OPS_AUTH_MODE=password' >&2; exit 2; } ;;
  oidc) [ -n "$ops_login_url" ] || { echo 'ECS_OPS_UI_LOGIN_URL is required when ECS_OPS_AUTH_MODE=oidc' >&2; exit 2; } ;;
  *) echo 'ECS_OPS_AUTH_MODE must be explicitly set to password or oidc' >&2; exit 2 ;;
esac
if [ "$ops_auth_mode" = oidc ]; then
  OPS_LOGIN_URL=$ops_login_url node <<'NODE'
const value = process.env.OPS_LOGIN_URL
let url
try { url = new URL(value) } catch { throw new Error('ECS_OPS_UI_LOGIN_URL must be an absolute HTTPS URL') }
if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
  throw new Error('ECS_OPS_UI_LOGIN_URL must be HTTPS without credentials or a fragment')
}
NODE
fi

for command_name in docker shasum tar node; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "$command_name is required" >&2; exit 2; }
done
[ ! -e "$output_dir" ] && [ ! -L "$output_dir" ] || { echo 'ECS release image output directory must not already exist' >&2; exit 2; }
ecs_build_lock_acquire
# Refuse a pre-created target and validate every existing ancestor before any
# registry write. This prevents a privileged build account from following a
# planted symlink or writing through a group/world-writable handoff directory.
output_dir=$(OUTPUT_DIR=$output_dir node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const output = path.resolve(process.env.OUTPUT_DIR)
if (fs.existsSync(output)) throw new Error('ECS release image output directory must not already exist')
let cursor = path.dirname(output)
const missing = []
while (!fs.existsSync(cursor)) {
  missing.push(cursor)
  const parent = path.dirname(cursor)
  if (parent === cursor) throw new Error('no existing output directory ancestor')
  cursor = parent
}
const anchor = cursor
const anchorStat = fs.lstatSync(anchor)
if (!anchorStat.isDirectory()) throw new Error(`unsafe output ancestor: ${anchor}`)
if (typeof process.getuid === 'function' && anchorStat.uid !== process.getuid()) throw new Error(`output ancestor is not owned by the build user: ${anchor}`)
if ((anchorStat.mode & 0o022) !== 0) throw new Error(`output ancestor is group/world writable: ${anchor}`)
// Canonicalize trusted system aliases such as macOS /var -> /private/var, then
// create every missing child ourselves below the owned, non-writable anchor.
const canonicalAnchor = fs.realpathSync(anchor)
let canonicalOutput = canonicalAnchor
for (const directory of missing.reverse()) {
  canonicalOutput = path.join(canonicalOutput, path.basename(directory))
  fs.mkdirSync(canonicalOutput, { mode: 0o700 })
}
canonicalOutput = path.join(canonicalOutput, path.basename(output))
fs.mkdirSync(canonicalOutput, { mode: 0o700 })
process.stdout.write(canonicalOutput)
NODE
)

archive=$(mktemp "${TMPDIR:-/tmp}/ecs-release-source.XXXXXXXX")
context=$(mktemp -d "${TMPDIR:-/tmp}/ecs-release-context.XXXXXXXX")
records=$(mktemp "${TMPDIR:-/tmp}/ecs-release-images.XXXXXXXX.tsv")
built_tags=''
build_started=NO
cleanup() {
  rm -f "$archive" "$records"
  rm -rf "$context"
  if [ "$build_started" = YES ]; then
    if [ -n "$built_tags" ]; then
      # Pushed immutable references are the release artifact. Local mutable tags
      # are transient build handles and otherwise retain duplicate image graphs.
      # shellcheck disable=SC2086
      docker image rm $built_tags >/dev/null 2>&1 || true
    fi
    docker builder prune -f --keep-storage "$cache_limit" >/dev/null 2>&1 || true
  fi
  ecs_build_lock_cleanup
}
trap cleanup EXIT HUP INT TERM

if [ -z "$source_archive" ] && [ -f "$root/.candidate-source.tar" ]; then
  source_archive="$root/.candidate-source.tar"
fi
if [ -z "$source_identity" ] && [ -f "$root/.candidate-identity" ]; then
  source_identity="$root/.candidate-identity"
fi
if [ -n "$source_archive" ] || [ -n "$source_identity" ]; then
  [ -n "$source_archive" ] && [ -n "$source_identity" ] || {
    echo 'candidate archive and identity must be provided together' >&2; exit 2;
  }
  [ -f "$source_archive" ] && [ ! -L "$source_archive" ] || {
    echo 'ECS release source archive must be a regular non-symlink file' >&2; exit 2;
  }
  [ -f "$source_identity" ] && [ ! -L "$source_identity" ] || {
    echo 'ECS release source identity must be a regular non-symlink file' >&2; exit 2;
  }
  identity_revision=$(sed -n 's/^git_sha=//p' "$source_identity")
  identity_release=$(sed -n 's/^release_id=//p' "$source_identity")
  identity_source=$(sed -n 's/^source_sha256=sha256://p' "$source_identity")
  [ "$identity_revision" = "$revision" ] || { echo 'candidate identity Git SHA does not match release revision' >&2; exit 2; }
  [ "$identity_release" = "$release_id" ] || { echo 'candidate identity release ID does not match RELEASE_ID' >&2; exit 2; }
  printf '%s' "$identity_source" | grep -Eq '^[0-9a-f]{64}$' || { echo 'candidate identity source digest is invalid' >&2; exit 2; }
  actual_source=$(shasum -a 256 "$source_archive" | awk '{print $1}')
  [ "$actual_source" = "$identity_source" ] || { echo 'candidate source archive digest mismatch' >&2; exit 2; }
  cp "$source_archive" "$archive"
else
  command -v git >/dev/null 2>&1 || { echo 'git is required when no staged candidate archive is supplied' >&2; exit 2; }
  [ "$(git -C "$root" rev-parse HEAD)" = "$revision" ] || {
    echo 'release revision does not match HEAD' >&2; exit 2;
  }
  [ -z "$(git -C "$root" status --porcelain --untracked-files=normal)" ] || {
    echo 'release image build requires a clean committed source tree' >&2; exit 2;
  }
  git -C "$root" archive --format=tar "$revision" \
    ':(exclude)artifacts' ':(exclude)screenshots' > "$archive"
fi
source_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
tar -xf "$archive" -C "$context"

build_image() {
  artifact=$1
  dockerfile=$2
  shift 2
  [ -f "$context/$dockerfile" ] || { echo "release Dockerfile is absent: $dockerfile" >&2; exit 2; }
  tag="$repository/$artifact:$release_id"
  built_tags="$built_tags $tag"
  docker build --pull=false \
    --label "org.opencontainers.image.revision=$revision" \
    --label "com.storenova.release.id=$release_id" \
    --label "com.storenova.release.source_sha256=sha256:$source_sha" \
    "$@" -f "$context/$dockerfile" -t "$tag" "$context"
  docker push "$tag"
  image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$tag")
  image_release=$(docker image inspect --format '{{index .Config.Labels "com.storenova.release.id"}}' "$tag")
  image_source=$(docker image inspect --format '{{index .Config.Labels "com.storenova.release.source_sha256"}}' "$tag")
  [ "$image_revision" = "$revision" ] && [ "$image_release" = "$release_id" ] && [ "$image_source" = "sha256:$source_sha" ] || {
    echo "release image labels do not match committed source: $artifact" >&2; exit 1;
  }
  immutable_ref=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" | awk -v prefix="$repository/$artifact@sha256:" 'index($0, prefix) == 1 { print; exit }')
  printf '%s' "$immutable_ref" | grep -Eq '^.+@sha256:[0-9a-f]{64}$' || {
    echo "registry did not return an immutable digest for $artifact" >&2; exit 1;
  }
  digest=${immutable_ref##*@}
  printf '%s\t%s\t%s\n' "$artifact" "$digest" "$immutable_ref" >> "$records"
}

# Prune before and after the build. The dedicated upper bound prevents an
# interrupted sequence of releases from accumulating an unbounded BuildKit
# cache while still retaining the hottest shared npm and compiler layers.
build_started=YES
docker builder prune -f --keep-storage "$cache_limit" >/dev/null

build_image merchant-api infra/docker/api.Dockerfile
if [ -n "${APK_REPOSITORY:-}" ]; then
  build_image merchant-worker infra/docker/worker.Dockerfile --build-arg "APK_REPOSITORY=$APK_REPOSITORY"
else
  build_image merchant-worker infra/docker/worker.Dockerfile
fi
if [ -n "${ECS_MERCHANT_UI_WORKSPACE_ID:-}" ]; then
  build_image merchant-ui infra/docker/ui.Dockerfile \
    --build-arg "RELEASE_ID=$release_id" --build-arg "RELEASE_GIT_SHA=$revision" \
    --build-arg "VITE_API_BASE_URL=${ECS_MERCHANT_UI_API_BASE_URL:-/api}" \
    --build-arg "VITE_WORKSPACE_ID=$ECS_MERCHANT_UI_WORKSPACE_ID"
else
  build_image merchant-ui infra/docker/ui.Dockerfile \
    --build-arg "RELEASE_ID=$release_id" --build-arg "RELEASE_GIT_SHA=$revision" \
    --build-arg "VITE_API_BASE_URL=${ECS_MERCHANT_UI_API_BASE_URL:-/api}"
fi
if [ "$ops_auth_mode" = oidc ]; then
  build_image merchant-ops-ui infra/docker/ops-console.Dockerfile \
    --build-arg OPS_CONSOLE_BUILD_MODE=production \
    --build-arg "OPS_CONSOLE_AUTH_MODE=$ops_auth_mode" \
    --label "com.storenova.ops-auth-mode=$ops_auth_mode" \
    --build-arg "VITE_API_BASE=${ECS_OPS_UI_API_BASE:-/api}" --build-arg VITE_BASE=/ops/ \
    --build-arg "VITE_OPS_LOGIN_URL=$ops_login_url" \
    --build-arg "RELEASE_ID=$release_id" --build-arg "RELEASE_GIT_SHA=$revision"
else
  # The password bundle uses the real same-origin Store Nova login endpoint;
  # no SSO route is guessed or embedded.
  build_image merchant-ops-ui infra/docker/ops-console.Dockerfile \
    --build-arg OPS_CONSOLE_BUILD_MODE=production \
    --build-arg "OPS_CONSOLE_AUTH_MODE=$ops_auth_mode" \
    --label "com.storenova.ops-auth-mode=$ops_auth_mode" \
    --build-arg "VITE_API_BASE=${ECS_OPS_UI_API_BASE:-/api}" --build-arg VITE_BASE=/ops/ \
    --build-arg "RELEASE_ID=$release_id" --build-arg "RELEASE_GIT_SHA=$revision"
fi
build_image payment-gateway services/payment-gateway/Dockerfile
build_image pilot-gateway infra/docker/pilot-gateway-https.Dockerfile

RECORDS_PATH=$records OUTPUT_DIR=$output_dir RELEASE_REVISION=$revision RELEASE_NAME=$release_id SOURCE_DIGEST="sha256:$source_sha" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const rows = fs.readFileSync(process.env.RECORDS_PATH, 'utf8').trim().split('\n').map(line => line.split('\t'))
if (rows.length !== 6 || rows.some(row => row.length !== 3)) throw new Error('release image record set is incomplete')
const digests = Object.fromEntries(rows.map(([artifact, digest]) => [artifact, digest]))
const references = Object.fromEntries(rows.map(([artifact, , reference]) => [artifact, reference]))
const metadata = {
  schema_version: 1,
  release_id: process.env.RELEASE_NAME,
  release_git_sha: process.env.RELEASE_REVISION,
  source_sha256: process.env.SOURCE_DIGEST,
  image_digests: digests,
  image_references: references,
}
const output = process.env.OUTPUT_DIR
function atomicWrite(name, value) {
  const temporary = path.join(output, `.${name}.${process.pid}.${require('node:crypto').randomBytes(8).toString('hex')}.tmp`)
  fs.writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, path.join(output, name))
}
// This is intentionally not named image-digests.json: the deployment manifest
// requires two additional externally maintained images (Postgres and ClamAV).
atomicWrite('repository-image-digests.json', `${JSON.stringify(digests, null, 2)}\n`)
atomicWrite('release-images.json', `${JSON.stringify(metadata, null, 2)}\n`)
NODE

echo "ECS release images published: release=$release_id revision=$revision output=$output_dir"
