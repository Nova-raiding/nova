#!/bin/sh
set -eu

readonly production_trust_dir='/run/release-security/evidence-trust'
readonly production_consumer='/usr/local/libexec/merchant/consume-production-evidence-nonce'

[ "${PRODUCTION_EVIDENCE_NONCE_CONSUMER+x}" != x ] || { echo "PRODUCTION_EVIDENCE_NONCE_CONSUMER is forbidden; the production consumer path is fixed" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TRUST_DIR+x}" != x ] || { echo "PRODUCTION_EVIDENCE_TRUST_DIR is forbidden; the production trust path is fixed" >&2; exit 1; }
: "${PRODUCTION_EVIDENCE_REPO_ROOT:?PRODUCTION_EVIDENCE_REPO_ROOT is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${IMAGE_DIGEST:?IMAGE_DIGEST is required}"
: "${PRODUCTION_EVIDENCE_MANIFEST_SHA256:?PRODUCTION_EVIDENCE_MANIFEST_SHA256 is required}"
: "${RELEASE_GIT_SHA:?RELEASE_GIT_SHA is required}"

test_hook=${PRODUCTION_EVIDENCE_TEST_HOOK:-}
if [ -n "$test_hook" ]; then
  [ "$test_hook" = 'enabled-for-local-tests-only' ] && [ "${NODE_ENV:-}" = 'test' ] || {
    echo "production evidence test hook requires NODE_ENV=test and the exact local-test token" >&2
    exit 1
  }
  : "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:?PRODUCTION_EVIDENCE_TEST_TRUST_DIR is required by the test hook}"
  : "${PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER:?PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER is required by the test hook}"
  trust_dir=$PRODUCTION_EVIDENCE_TEST_TRUST_DIR
  consumer=$PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER
  expected_owner=$(id -u)
else
  [ -z "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:-}${PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER:-}" ] || {
    echo "production evidence test paths are forbidden without the explicit test hook" >&2
    exit 1
  }
  trust_dir=$production_trust_dir
  consumer=$production_consumer
  expected_owner=0
fi

owner_of() { stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
validate_secure_owner_mode() {
  path=$1
  label=$2
  owner=$(owner_of "$path")
  mode=$(mode_of "$path")
  [ "$owner" = "$expected_owner" ] || { echo "$label must be owned by uid $expected_owner: $path" >&2; exit 1; }
  case "$mode" in *[2367][0-7]|*[2367]) echo "$label must not be writable by group or other users: $path mode=$mode" >&2; exit 1 ;; esac
}

[ -d "$trust_dir" ] && [ ! -L "$trust_dir" ] || { echo "production evidence trust directory must be a real non-symlink directory" >&2; exit 1; }
resolved_trust_dir=$(CDPATH= cd -- "$trust_dir" && pwd -P)
[ "$resolved_trust_dir" = "$trust_dir" ] || { echo "production evidence trust path must be canonical and must not traverse symlinks" >&2; exit 1; }
validate_secure_owner_mode "$resolved_trust_dir" 'production evidence trust directory'
if [ -z "$test_hook" ]; then
  for parent in /run /run/release-security; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || { echo "production evidence trust parent must be a real non-symlink directory: $parent" >&2; exit 1; }
    validate_secure_owner_mode "$parent" 'production evidence trust parent'
  done
fi

[ -x "$consumer" ] && [ -f "$consumer" ] && [ ! -L "$consumer" ] || { echo "production evidence nonce consumer must be a regular non-symlink executable: $consumer" >&2; exit 1; }
consumer_dir=$(CDPATH= cd -- "$(dirname "$consumer")" && pwd -P)
[ "$consumer_dir/$(basename "$consumer")" = "$consumer" ] || { echo "production evidence nonce consumer path must be canonical and must not traverse symlinks" >&2; exit 1; }
validate_secure_owner_mode "$consumer" 'production evidence nonce consumer'
if [ -z "$test_hook" ]; then
  for parent in /usr /usr/local /usr/local/libexec /usr/local/libexec/merchant; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || { echo "production evidence nonce consumer parent must be a real non-symlink directory: $parent" >&2; exit 1; }
    validate_secure_owner_mode "$parent" 'production evidence nonce consumer parent'
  done
fi

digest_path="$resolved_trust_dir/production-evidence-nonce-consumer-sha256"
[ -f "$digest_path" ] && [ ! -L "$digest_path" ] || { echo "production evidence nonce consumer digest must be a regular non-symlink file" >&2; exit 1; }
validate_secure_owner_mode "$digest_path" 'production evidence nonce consumer digest'
expected_digest=$(sed -n '1p' "$digest_path")
printf '%s\n' "$expected_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "production evidence nonce consumer digest is invalid" >&2; exit 1; }
actual_digest=$(shasum -a 256 "$consumer" | awk '{print $1}')
[ "$actual_digest" = "$expected_digest" ] || { echo "production evidence nonce consumer digest mismatch" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$PRODUCTION_EVIDENCE_REPO_ROOT" && pwd -P)
case "$consumer_dir/" in "$repo_root/"*) echo "production evidence nonce consumer must be provisioned outside the mutable repository" >&2; exit 1 ;; esac
printf '%s\n' "$DEPLOYMENT_NONCE" | grep -Eq '^[A-Za-z0-9_-]{22,128}$' || { echo "DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters" >&2; exit 1; }
printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$' || { echo "IMAGE_DIGEST must be an immutable SHA-256 digest" >&2; exit 1; }
printf '%s\n' "$PRODUCTION_EVIDENCE_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' || { echo "PRODUCTION_EVIDENCE_MANIFEST_SHA256 must be a lowercase SHA-256 hash" >&2; exit 1; }
printf '%s\n' "$RELEASE_GIT_SHA" | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$' || { echo "RELEASE_GIT_SHA must be a full Git object id" >&2; exit 1; }

"$consumer" consume \
  --namespace merchant-production-deploy \
  --nonce "$DEPLOYMENT_NONCE" \
  --release-id "$RELEASE_ID" \
  --image-digest "$IMAGE_DIGEST" \
  --manifest-sha256 "$PRODUCTION_EVIDENCE_MANIFEST_SHA256" \
  --release-git-sha "$RELEASE_GIT_SHA" || {
    echo 'deployment nonce was already consumed or could not be consumed atomically; deployment refused' >&2
    exit 1
  }

echo "production evidence nonce consumed: release_id=$RELEASE_ID manifest_sha256=$PRODUCTION_EVIDENCE_MANIFEST_SHA256 consumer_sha256=$actual_digest"
