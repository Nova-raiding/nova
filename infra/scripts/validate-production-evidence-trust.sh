#!/bin/sh
set -eu

readonly production_trust_dir='/run/release-security/evidence-trust'
repo_root=${1:-}
operations_mode=${2:-official_api}

[ -n "$repo_root" ] && [ -d "$repo_root" ] || { echo "repository root is required for trust-boundary validation" >&2; exit 2; }
[ "$operations_mode" = manual ] || [ "$operations_mode" = official_api ] || { echo "production operations mode must be manual or official_api" >&2; exit 2; }
[ "${PRODUCTION_EVIDENCE_TRUST_DIR+x}" != x ] || { echo "PRODUCTION_EVIDENCE_TRUST_DIR is forbidden; the production trust path is fixed" >&2; exit 1; }

test_hook=${PRODUCTION_EVIDENCE_TEST_HOOK:-}
if [ -n "$test_hook" ]; then
  [ "$test_hook" = 'enabled-for-local-tests-only' ] && [ "${NODE_ENV:-}" = 'test' ] || {
    echo "production evidence test hook requires NODE_ENV=test and the exact local-test token" >&2
    exit 1
  }
  : "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:?PRODUCTION_EVIDENCE_TEST_TRUST_DIR is required by the test hook}"
  trust_dir=$PRODUCTION_EVIDENCE_TEST_TRUST_DIR
  control_dir="$trust_dir/controls"
  expected_owner=$(id -u)
else
  [ -z "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:-}" ] || { echo "production evidence test path is forbidden without the explicit test hook" >&2; exit 1; }
  trust_dir=$production_trust_dir
  control_dir='/usr/local/libexec/merchant'
  expected_owner=0
fi

[ -d "$trust_dir" ] && [ ! -L "$trust_dir" ] || { echo "production evidence trust anchor is not provisioned as a real non-symlink directory: $trust_dir" >&2; exit 1; }
repo_root=$(CDPATH= cd -- "$repo_root" && pwd -P)
resolved_trust_dir=$(CDPATH= cd -- "$trust_dir" && pwd -P)
[ "$resolved_trust_dir" = "$trust_dir" ] || { echo "production evidence trust anchor path must be canonical and must not traverse symlinks" >&2; exit 1; }
case "$resolved_trust_dir/" in "$repo_root/"*) echo "production evidence trust anchor must be provisioned outside the mutable repository" >&2; exit 1 ;; esac

# BSD stat uses `-f` for a format string while GNU/Linux stat uses `-c`.
# Probe the format supported by the host first; GNU stat accepts `-f` as a
# filesystem query and may exit successfully with the wrong value, so a
# simple `||` fallback is not safe here.
owner_of() {
  if stat -c '%u' "$1" >/dev/null 2>&1; then stat -c '%u' "$1"; else stat -f '%u' "$1"; fi
}
mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then stat -c '%a' "$1"; else stat -f '%Lp' "$1"; fi
}
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
if [ "$operations_mode" = manual ]; then
  attester_digest_path="$resolved_trust_dir/production-manual-operations-attester-sha256"
  attester="$control_dir/attest-manual-operations-evidence"
  attester_label='manual operations attester'
else
  attester_digest_path="$resolved_trust_dir/production-capability-attester-sha256"
  attester="$control_dir/attest-capability-evidence"
  attester_label='capability attester'
fi
bundle_attester_digest_path="$resolved_trust_dir/production-evidence-bundle-attester-sha256"
bundle_attester="$control_dir/attest-release-evidence-bundle"
for entry in "$public_key" "$key_id_path" "$fingerprint_path" "$consumer_digest_path" "$attester_digest_path" "$bundle_attester_digest_path"; do
  [ -f "$entry" ] && [ ! -L "$entry" ] || { echo "production evidence trust file must be a regular non-symlink file: $entry" >&2; exit 1; }
  validate_secure_owner_mode "$entry" 'production evidence trust file'
done

grep -q 'UNPROVISIONED' "$public_key" && { echo "production evidence trust anchor is not provisioned" >&2; exit 1; }
key_id=$(sed -n '1p' "$key_id_path")
expected_fingerprint=$(sed -n '1p' "$fingerprint_path")
expected_consumer_digest=$(sed -n '1p' "$consumer_digest_path")
expected_attester_digest=$(sed -n '1p' "$attester_digest_path")
expected_bundle_attester_digest=$(sed -n '1p' "$bundle_attester_digest_path")
printf '%s\n' "$key_id" | grep -Eq '^[A-Za-z0-9._:-]{8,128}$' || { echo "production evidence key id is invalid or unprovisioned" >&2; exit 1; }
printf '%s\n' "$expected_fingerprint" | grep -Eq '^[0-9a-f]{64}$' || { echo "production evidence public key fingerprint is invalid" >&2; exit 1; }
printf '%s\n' "$expected_consumer_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "production evidence nonce consumer digest is invalid" >&2; exit 1; }
printf '%s\n' "$expected_attester_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "$attester_label digest is invalid" >&2; exit 1; }
printf '%s\n' "$expected_bundle_attester_digest" | grep -Eq '^[0-9a-f]{64}$' || { echo "production evidence bundle attester digest is invalid" >&2; exit 1; }

actual_fingerprint=$(openssl pkey -pubin -in "$public_key" -outform DER 2>/dev/null | shasum -a 256 | awk '{print $1}') || {
  echo "production evidence public key is not a valid public key" >&2
  exit 1
}
[ "$actual_fingerprint" = "$expected_fingerprint" ] || { echo "production evidence public key fingerprint mismatch" >&2; exit 1; }

if [ -z "$test_hook" ]; then
  for parent in /usr /usr/local /usr/local/libexec; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || { echo "production control parent must be a real non-symlink directory: $parent" >&2; exit 1; }
    validate_secure_owner_mode "$parent" 'production control parent'
  done
fi
[ -d "$control_dir" ] && [ ! -L "$control_dir" ] || { echo "production control directory must be a real non-symlink directory: $control_dir" >&2; exit 1; }
resolved_control_dir=$(CDPATH= cd -- "$control_dir" && pwd -P)
[ "$resolved_control_dir" = "$control_dir" ] || { echo "production control directory path must be canonical" >&2; exit 1; }
case "$resolved_control_dir/" in "$repo_root/"*) echo "production controls must be installed outside the mutable repository" >&2; exit 1 ;; esac
validate_secure_owner_mode "$control_dir" 'production control directory'
for control in "$attester" "$bundle_attester"; do
  [ -f "$control" ] && [ ! -L "$control" ] && [ -x "$control" ] || { echo "production control must be a regular non-symlink executable: $control" >&2; exit 1; }
  validate_secure_owner_mode "$control" 'production control executable'
done
actual_attester_digest=$(shasum -a 256 "$attester" | awk '{print $1}')
[ "$actual_attester_digest" = "$expected_attester_digest" ] || { echo "$attester_label digest mismatch" >&2; exit 1; }
actual_bundle_attester_digest=$(shasum -a 256 "$bundle_attester" | awk '{print $1}')
[ "$actual_bundle_attester_digest" = "$expected_bundle_attester_digest" ] || { echo 'bundle attester digest mismatch' >&2; exit 1; }

echo "production evidence trust boundary passed: key_id=$key_id public_key_sha256=$actual_fingerprint"
