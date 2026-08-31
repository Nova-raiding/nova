#!/bin/sh
set -eu

# Runs controlled real-platform canaries and merges only verified evidence.
# The capability evidence contract is six-platform, so the default run covers
# all six. Operators may pass an explicit subset for staged verification, but
# the final --require-canary gate still requires every contracted platform.
# This script never prints credentials and never enables a write/revoke canary
# unless the caller explicitly confirms both gates.
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

: "${RELEASE_ID:?RELEASE_ID is required}"
: "${PLATFORM_CANARY_BASE_EVIDENCE:?PLATFORM_CANARY_BASE_EVIDENCE is required}"
: "${PLATFORM_CANARY_OUTPUT:?PLATFORM_CANARY_OUTPUT is required}"
: "${PLATFORM_CANARY_MODE:?PLATFORM_CANARY_MODE=real is required}"
[ "$PLATFORM_CANARY_MODE" = real ] || { echo "PLATFORM_CANARY_MODE must be real" >&2; exit 1; }
[ "${PLATFORM_CANARY_CONFIRM:-false}" = true ] || { echo "PLATFORM_CANARY_CONFIRM=true is required" >&2; exit 1; }
[ "${PAYMENT_MODE:-}" = provider ] || { echo "PAYMENT_MODE=provider is required for production canary" >&2; exit 1; }
printf '%s' "${PAYMENT_CALLBACK_BASE_URL:-}" | grep -Eq '^https://' || { echo "PAYMENT_CALLBACK_BASE_URL must be HTTPS" >&2; exit 1; }
[ -n "${PAYMENT_CALLBACK_SECRET_REF:-}" ] || { echo "PAYMENT_CALLBACK_SECRET_REF is required" >&2; exit 1; }
printf '%s' "${PAYMENT_PROVIDER_QUERY_API_URL:-}" | grep -Eq '^https://' || { echo "PAYMENT_PROVIDER_QUERY_API_URL must be HTTPS" >&2; exit 1; }
printf '%s' "${PAYMENT_PROVIDER_REFUND_API_URL:-}" | grep -Eq '^https://' || { echo "PAYMENT_PROVIDER_REFUND_API_URL must be HTTPS" >&2; exit 1; }
[ -f "$PLATFORM_CANARY_BASE_EVIDENCE" ] || { echo "base evidence not found" >&2; exit 1; }
[ -n "${PRODUCTION_API_BASE_URL:-}" ] || { echo "PRODUCTION_API_BASE_URL is required so the canary is bound to the deployed application" >&2; exit 1; }
printf '%s' "$PRODUCTION_API_BASE_URL" | grep -Eq '^https://' || { echo "PRODUCTION_API_BASE_URL must use HTTPS" >&2; exit 1; }

read_env() {
  # Indirect environment lookup without eval; operator metadata must never
  # become shell source code.
  printenv "$1" 2>/dev/null || true
}

platforms=${PLATFORM_CANARY_PLATFORMS:-jd,taobao,tmall,pinduoduo,xiaohongshu,douyin}
workdir=$(mktemp -d "${TMPDIR:-/tmp}/merchant-production-canary.XXXXXX")
trap 'rm -rf "$workdir"' EXIT HUP INT TERM
current="$workdir/evidence.json"
cp "$PLATFORM_CANARY_BASE_EVIDENCE" "$current"

for platform in $(printf '%s' "$platforms" | tr ',' ' '); do
  case "$platform" in
    jd) prefix=JD ;;
    taobao) prefix=TAOBAO ;;
    tmall) prefix=TMALL ;;
    pinduoduo) prefix=PDD ;;
    xiaohongshu) prefix=XHS ;;
    douyin) prefix=DOUYIN ;;
    *) echo "unsupported platform: $platform" >&2; exit 1 ;;
  esac
  application_id=$(read_env "PLATFORM_CANARY_${prefix}_APPLICATION_ID")
  test_store_id=$(read_env "PLATFORM_CANARY_${prefix}_TEST_STORE_ID")
  workspace_id=$(read_env "PLATFORM_CANARY_${prefix}_WORKSPACE_ID")
  account_id=$(read_env "PLATFORM_CANARY_${prefix}_ACCOUNT_ID")
  scope=$(read_env "PLATFORM_CANARY_${prefix}_SCOPE")
  media_file=$(read_env "PLATFORM_CANARY_${prefix}_MEDIA_FILE")
  api_version=$(read_env "PLATFORM_CANARY_${prefix}_API_VERSION")
  verified_by=$(read_env "PLATFORM_CANARY_${prefix}_VERIFIED_BY")
  evidence_ref=$(read_env "PLATFORM_CANARY_${prefix}_EVIDENCE_REF")
  [ -n "$workspace_id" ] || workspace_id=${PLATFORM_CANARY_WORKSPACE_ID:-}
  [ -n "$account_id" ] || account_id=${PLATFORM_CANARY_ACCOUNT_ID:-}
  [ -n "$scope" ] || scope=${PLATFORM_CANARY_SCOPE:-}
  [ -n "$media_file" ] || media_file=${PLATFORM_CANARY_MEDIA_FILE:-}
  [ -n "$api_version" ] || api_version=${PLATFORM_CANARY_API_VERSION:-}
  [ -n "$verified_by" ] || verified_by=${PLATFORM_CANARY_VERIFIED_BY:-}
  [ -n "$evidence_ref" ] || evidence_ref="artifact://canary/$platform/$RELEASE_ID"
  : "${application_id:?PLATFORM_CANARY_${prefix}_APPLICATION_ID is required}"
  : "${test_store_id:?PLATFORM_CANARY_${prefix}_TEST_STORE_ID is required}"
  : "${workspace_id:?PLATFORM_CANARY_${prefix}_WORKSPACE_ID or PLATFORM_CANARY_WORKSPACE_ID is required}"
  : "${account_id:?PLATFORM_CANARY_${prefix}_ACCOUNT_ID or PLATFORM_CANARY_ACCOUNT_ID is required}"
  : "${scope:?PLATFORM_CANARY_${prefix}_SCOPE or PLATFORM_CANARY_SCOPE is required}"
  : "${media_file:?PLATFORM_CANARY_${prefix}_MEDIA_FILE or PLATFORM_CANARY_MEDIA_FILE is required}"
  : "${api_version:?PLATFORM_CANARY_${prefix}_API_VERSION or PLATFORM_CANARY_API_VERSION is required}"
  : "${verified_by:?PLATFORM_CANARY_${prefix}_VERIFIED_BY or PLATFORM_CANARY_VERIFIED_BY is required}"
  output="$workdir/$platform.json"
  PLATFORM_CANARY_PLATFORM="$platform" \
  PLATFORM_CANARY_APPLICATION_ID="$application_id" \
  PLATFORM_CANARY_TEST_STORE_ID="$test_store_id" \
  PLATFORM_CANARY_WORKSPACE_ID="$workspace_id" \
  PLATFORM_CANARY_ACCOUNT_ID="$account_id" \
  PLATFORM_CANARY_SCOPE="$scope" \
  PLATFORM_CANARY_MEDIA_FILE="$media_file" \
  PLATFORM_CANARY_API_VERSION="$api_version" \
  PLATFORM_CANARY_VERIFIED_BY="$verified_by" \
  PLATFORM_CANARY_EVIDENCE_REF="$evidence_ref" \
  PLATFORM_CANARY_BASE_EVIDENCE="$current" \
  PLATFORM_CANARY_OUTPUT="$output" \
  npx --no-install tsx tests/platform-canary.ts
  cp "$output" "$current"
done

# The runner produces an unsigned candidate. A protected external attester
# must add the immutable release bindings and Ed25519 signature; application
# containers and repository scripts never receive the private key.
attester=/usr/local/libexec/merchant/attest-capability-evidence
[ "${PRODUCTION_EVIDENCE_TEST_CAPABILITY_ATTESTER+x}" != x ] || { echo "capability attester override is forbidden" >&2; exit 1; }
[ -x "$attester" ] || { echo "protected capability evidence attester is not provisioned: $attester" >&2; exit 1; }
[ ! -L "$attester" ] && [ -f "$attester" ] || { echo "capability attester must be a regular non-symlink executable" >&2; exit 1; }
owner_of() { stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1"; }
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"; }
validate_attester_path() {
  path=$1
  label=$2
  [ ! -L "$path" ] || { echo "$label must not be a symlink: $path" >&2; exit 1; }
  [ "$(owner_of "$path")" = 0 ] || { echo "$label must be owned by root: $path" >&2; exit 1; }
  mode=$(mode_of "$path")
  case "$mode" in *[2367][0-7]|*[2367]) echo "$label must not be writable by group or other users: $path mode=$mode" >&2; exit 1 ;; esac
}
for protected_path in /usr/local/libexec /usr/local/libexec/merchant "$attester"; do
  validate_attester_path "$protected_path" 'capability attester trust path'
done
trust_dir=/run/release-security/evidence-trust
sh "$repo_root/infra/scripts/validate-production-evidence-trust.sh" "$repo_root"
expected_attester_digest=$(sed -n '1p' "$trust_dir/production-capability-attester-sha256")
printf '%s\n' "$expected_attester_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "capability attester trusted digest is not provisioned" >&2; exit 1; }
actual_attester_digest=$(shasum -a 256 "$attester" | awk '{print $1}')
[ "$actual_attester_digest" = "$expected_attester_digest" ] || { echo "capability attester digest mismatch" >&2; exit 1; }
"$attester" attest --input "$current" --output "$PLATFORM_CANARY_OUTPUT" --release-id "$RELEASE_ID" \
  --deployment-nonce "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}" \
  --release-git-sha "${RELEASE_GIT_SHA:?RELEASE_GIT_SHA is required}" \
  --manifest-sha256 "${RELEASE_MANIFEST_SHA256:?RELEASE_MANIFEST_SHA256 is required}" \
  --image-set-digest "${RELEASE_IMAGE_SET_DIGEST:?RELEASE_IMAGE_SET_DIGEST is required}"
[ -f "$PLATFORM_CANARY_OUTPUT" ] || { echo "capability attester did not produce evidence" >&2; exit 1; }

echo "production canary passed: release_id=$RELEASE_ID output=$PLATFORM_CANARY_OUTPUT"
