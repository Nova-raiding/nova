#!/bin/sh
set -eu

readonly production_trust_dir='/run/release-security/evidence-trust'
repo_root=${1:-}

[ -n "$repo_root" ] && [ -d "$repo_root" ] || { echo "repository root is required for trust-boundary validation" >&2; exit 2; }
[ "${PRODUCTION_EVIDENCE_TRUST_DIR+x}" != x ] || { echo "PRODUCTION_EVIDENCE_TRUST_DIR is forbidden; the production trust path is fixed" >&2; exit 1; }

test_hook=${PRODUCTION_EVIDENCE_TEST_HOOK:-}
if [ -n "$test_hook" ]; then
  [ "$test_hook" = 'enabled-for-local-tests-only' ] && [ "${NODE_ENV:-}" = 'test' ] || {
    echo "production evidence test hook requires NODE_ENV=test and the exact local-test token" >&2
    exit 1
  }
  : "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:?PRODUCTION_EVIDENCE_TEST_TRUST_DIR is required by the test hook}"
  trust_dir=$PRODUCTION_EVIDENCE_TEST_TRUST_DIR
  expected_owner=$(id -u)
else
  [ -z "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:-}" ] || { echo "production evidence test path is forbidden without the explicit test hook" >&2; exit 1; }
  trust_dir=$production_trust_dir
  expected_owner=0
fi

[ -d "$trust_dir" ] && [ ! -L "$trust_dir" ] || { echo "production evidence trust anchor is not provisioned as a real non-symlink directory: $trust_dir" >&2; exit 1; }
repo_root=$(CDPATH= cd -- "$repo_root" && pwd -P)
resolved_trust_dir=$(CDPATH= cd -- "$trust_dir" && pwd -P)
[ "$resolved_trust_dir" = "$trust_dir" ] || { echo "production evidence trust anchor path must be canonical and must not traverse symlinks" >&2; exit 1; }
case "$resolved_trust_dir/" in "$repo_root/"*) echo "production evidence trust anchor must be provisioned outside the mutable repository" >&2; exit 1 ;; esac

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

validate_secure_owner_mode "$resolved_trust_dir" 'production evidence trust directory'
if [ -z "$test_hook" ]; then
  for parent in /run /run/release-security; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || { echo "production evidence trust parent must be a real non-symlink directory: $parent" >&2; exit 1; }
    validate_secure_owner_mode "$parent" 'production evidence trust parent'
  done
fi

public_key="$resolved_trust_dir/production-evidence-public.pem"
key_id_path="$resolved_trust_dir/production-evidence-key-id"
fingerprint_path="$resolved_trust_dir/production-evidence-public-key-sha256"
consumer_digest_path="$resolved_trust_dir/production-evidence-nonce-consumer-sha256"
attester_digest_path="$resolved_trust_dir/production-capability-attester-sha256"
for entry in "$public_key" "$key_id_path" "$fingerprint_path" "$consumer_digest_path" "$attester_digest_path"; do
  [ -f "$entry" ] && [ ! -L "$entry" ] || { echo "production evidence trust file must be a regular non-symlink file: $entry" >&2; exit 1; }
  validate_secure_owner_mode "$entry" 'production evidence trust file'
done

grep -q 'UNPROVISIONED' "$public_key" && { echo "production evidence trust anchor is not provisioned" >&2; exit 1; }
key_id=$(sed -n '1p' "$key_id_path")
expected_fingerprint=$(sed -n '1p' "$fingerprint_path")
expected_consumer_digest=$(sed -n '1p' "$consumer_digest_path")
expected_attester_digest=$(sed -n '1p' "$attester_digest_path")
printf '%s\n' "$key_id" | grep -Eq '^[A-Za-z0-9._:-]{8,128}$' || { echo "production evidence key id is invalid or unprovisioned" >&2; exit 1; }
printf '%s\n' "$expected_fingerprint" | grep -Eq '^[0-9a-f]{64}$' || { echo "production evidence public key fingerprint is invalid" >&2; exit 1; }
printf '%s\n' "$expected_consumer_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "production evidence nonce consumer digest is invalid" >&2; exit 1; }
printf '%s\n' "$expected_attester_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "production capability attester digest is invalid" >&2; exit 1; }

actual_fingerprint=$(openssl pkey -pubin -in "$public_key" -outform DER 2>/dev/null | shasum -a 256 | awk '{print $1}') || {
  echo "production evidence public key is not a valid public key" >&2
  exit 1
}
[ "$actual_fingerprint" = "$expected_fingerprint" ] || { echo "production evidence public key fingerprint mismatch" >&2; exit 1; }

echo "production evidence trust boundary passed: key_id=$key_id public_key_sha256=$actual_fingerprint"
