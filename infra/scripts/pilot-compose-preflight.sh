#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
[ "${PRODUCTION_EVIDENCE_TRUST_DIR+x}" != x ] || { echo "PRODUCTION_EVIDENCE_TRUST_DIR is forbidden; the ECS production trust path is fixed" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_HOOK+x}" != x ] || { echo "production evidence test hooks are forbidden during ECS pilot preflight" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR+x}" != x ] || { echo "production evidence test paths are forbidden during ECS pilot preflight" >&2; exit 1; }
: "${PILOT_RELEASE_ID:?PILOT_RELEASE_ID is required}"
: "${PILOT_RELEASE_GIT_SHA:?PILOT_RELEASE_GIT_SHA is required}"
: "${PILOT_RELEASE_MANIFEST_SHA256:?PILOT_RELEASE_MANIFEST_SHA256 is required}"
: "${PILOT_RELEASE_IMAGE_SET_DIGEST:?PILOT_RELEASE_IMAGE_SET_DIGEST is required}"
: "${PILOT_RELEASE_CONFIG_SHA256:?PILOT_RELEASE_CONFIG_SHA256 is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
: "${OBJECT_STORAGE_EVIDENCE_PATH:?OBJECT_STORAGE_EVIDENCE_PATH is required}"
: "${PRODUCTION_EVIDENCE_ARTIFACT_ROOT:?PRODUCTION_EVIDENCE_ARTIFACT_ROOT is required}"
: "${ASSET_STORAGE_BUCKET:?ASSET_STORAGE_BUCKET is required}"
: "${ASSET_STORAGE_ENDPOINT:?ASSET_STORAGE_ENDPOINT is required}"
: "${ASSET_SCANNER_SERVICE_ID:?ASSET_SCANNER_SERVICE_ID is required}"
: "${ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS:?ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS is required}"
: "${ASSET_SCAN_MIN_DEFINITIONS_VERSION:?ASSET_SCAN_MIN_DEFINITIONS_VERSION is required}"
: "${ASSET_SCAN_POLICY_VERSION:?ASSET_SCAN_POLICY_VERSION is required}"

case ",${ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS}," in
  *",${ASSET_SCANNER_SERVICE_ID},"*) ;;
  *) echo 'ASSET_SCANNER_SERVICE_ID must be present in ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS' >&2; exit 1 ;;
esac
case "$ASSET_SCAN_MIN_DEFINITIONS_VERSION" in
  ''|*[!0-9]*) echo 'ASSET_SCAN_MIN_DEFINITIONS_VERSION must be a positive integer' >&2; exit 1 ;;
  0) echo 'ASSET_SCAN_MIN_DEFINITIONS_VERSION must be a positive integer' >&2; exit 1 ;;
esac
scanner_definitions_max_age=${SCANNER_DEFINITIONS_MAX_AGE_SECONDS:-86400}
case "$scanner_definitions_max_age" in
  ''|*[!0-9]*) echo 'SCANNER_DEFINITIONS_MAX_AGE_SECONDS must be from 1 to 86400' >&2; exit 1 ;;
esac
[ "$scanner_definitions_max_age" -ge 1 ] && [ "$scanner_definitions_max_age" -le 86400 ] || {
  echo 'SCANNER_DEFINITIONS_MAX_AGE_SECONDS must be from 1 to 86400' >&2
  exit 1
}

[ -f "$OBJECT_STORAGE_EVIDENCE_PATH" ] || {
  echo "object storage evidence file not found: $OBJECT_STORAGE_EVIDENCE_PATH" >&2
  exit 1
}
[ -d "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" ] || {
  echo "production evidence artifact root not found: $PRODUCTION_EVIDENCE_ARTIFACT_ROOT" >&2
  exit 1
}

printf '%s\n' "$PILOT_RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || {
  echo 'PILOT_RELEASE_ID contains unsafe characters' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'PILOT_RELEASE_GIT_SHA must be a full lowercase Git SHA' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' || {
  echo 'PILOT_RELEASE_MANIFEST_SHA256 must be lowercase SHA-256' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_IMAGE_SET_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
  echo 'PILOT_RELEASE_IMAGE_SET_DIGEST must be sha256 plus 64 lowercase hex characters' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_CONFIG_SHA256" | grep -Eq '^[0-9a-f]{64}$' || {
  echo 'PILOT_RELEASE_CONFIG_SHA256 must be lowercase SHA-256' >&2
  exit 1
}
printf '%s\n' "$DEPLOYMENT_NONCE" | grep -Eq '^[A-Za-z0-9_-]{22,128}$' || {
  echo 'DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters' >&2
  exit 1
}

cd "$root"
sh infra/scripts/validate-production-evidence-trust.sh "$root"
trust_dir='/run/release-security/evidence-trust'
trust_root="$trust_dir/production-evidence-public.pem"
trusted_key_id=$(sed -n '1p' "$trust_dir/production-evidence-key-id")
npx --no-install tsx tests/object-storage-evidence-gate.ts \
  --file "$OBJECT_STORAGE_EVIDENCE_PATH" \
  --release-id "$PILOT_RELEASE_ID" \
  --release-git-sha "$PILOT_RELEASE_GIT_SHA" \
  --manifest-sha256 "$PILOT_RELEASE_MANIFEST_SHA256" \
  --image-set-digest "$PILOT_RELEASE_IMAGE_SET_DIGEST" \
  --deployment-nonce "$DEPLOYMENT_NONCE" \
  --expected-config-checksum "$PILOT_RELEASE_CONFIG_SHA256" \
  --expected-bucket "$ASSET_STORAGE_BUCKET" \
  --expected-endpoint "$ASSET_STORAGE_ENDPOINT" \
  --expected-encryption "${ASSET_STORAGE_SSE_MODE:-AES256}" \
  --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" \
  --public-key "$trust_root" \
  --key-id "$trusted_key_id"

rendered_compose=$(mktemp "${TMPDIR:-/tmp}/merchant-ecs-production-compose.XXXXXX.json")
trap 'rm -f -- "$rendered_compose"' EXIT HUP INT TERM
docker compose \
  --env-file .env \
  -f infra/local/docker-compose.yml \
  -f infra/local/docker-compose.ecs-pilot.yml \
  -f infra/local/docker-compose.ecs-oss-cutover.yml \
  -f infra/local/docker-compose.ecs-production-migration.yml \
  -f infra/local/docker-compose.ecs-pilot-release.yml \
  config --format json > "$rendered_compose"
node infra/scripts/validate-ecs-production-compose.mjs "$rendered_compose"

printf '%s\n' "pilot compose preflight passed: release identity, object storage evidence, and compose configuration are valid (object_storage_evidence=$OBJECT_STORAGE_EVIDENCE_PATH)"
