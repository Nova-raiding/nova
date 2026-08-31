#!/bin/sh
set -eu

[ "${PRODUCTION_EVIDENCE_TRUST_DIR+x}" != x ] || { echo "PRODUCTION_EVIDENCE_TRUST_DIR is forbidden; the production trust path is fixed" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_NONCE_CONSUMER+x}" != x ] || { echo "PRODUCTION_EVIDENCE_NONCE_CONSUMER is forbidden; the production consumer path is fixed" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_HOOK+x}" != x ] || { echo "production evidence test hooks are forbidden during deploy preflight" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR+x}" != x ] || { echo "production evidence test paths are forbidden during deploy preflight" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER+x}" != x ] || { echo "production evidence test paths are forbidden during deploy preflight" >&2; exit 1; }

config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}
profile=${CAPACITY_PROFILE:-pilot_50}

[ -n "$config_path" ] || { echo "PRODUCTION_CONFIG_PATH or config path is required" >&2; exit 2; }
[ -f "$config_path" ] || { echo "production config not found: $config_path" >&2; exit 1; }

filtered_config_path=$(mktemp "${TMPDIR:-/tmp}/merchant-deploy-config.XXXXXX")
trap 'rm -f -- "$filtered_config_path"' EXIT
sed -E '/^[[:space:]]*#/d; s/[[:space:]]+#.*$//' "$config_path" > "$filtered_config_path"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${IMAGE_DIGESTS_JSON:?IMAGE_DIGESTS_JSON is required with merchant-api, merchant-worker, merchant-ui, merchant-ops-ui and clamav digests}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OPS_DATABASE_URL:?OPS_DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"
: "${SECRET_PROVIDER:?SECRET_PROVIDER is required}"
: "${CAPABILITY_EVIDENCE_PATH:?CAPABILITY_EVIDENCE_PATH is required}"
: "${CAPACITY_REPORT_PATH:?CAPACITY_REPORT_PATH is required}"
: "${MODEL_RELAY_EVIDENCE_PATH:?MODEL_RELAY_EVIDENCE_PATH is required}"
: "${CODEX_APP_HOST_EVIDENCE_PATH:?CODEX_APP_HOST_EVIDENCE_PATH is required}"
: "${OBJECT_STORAGE_EVIDENCE_PATH:?OBJECT_STORAGE_EVIDENCE_PATH is required}"
: "${CANONICAL_CUTOVER_EVIDENCE_PATH:?CANONICAL_CUTOVER_EVIDENCE_PATH is required}"
: "${EXPECTED_MIGRATION_VERSION:?EXPECTED_MIGRATION_VERSION is required (release migration chain tail)}"
: "${RELEASE_MANIFEST_PATH:?RELEASE_MANIFEST_PATH is required}"
: "${PAYMENT_EVIDENCE_PATH:?PAYMENT_EVIDENCE_PATH is required}"
: "${RESTORE_EVIDENCE_PATH:?RESTORE_EVIDENCE_PATH is required}"
: "${RENDERED_MANIFEST_PATH:?RENDERED_MANIFEST_PATH is required (rendered Kubernetes manifest)}"
: "${PRODUCTION_EVIDENCE_ARTIFACT_ROOT:?PRODUCTION_EVIDENCE_ARTIFACT_ROOT is required}"
[ -f "$CAPABILITY_EVIDENCE_PATH" ] || { echo "capability evidence file not found: $CAPABILITY_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$CAPACITY_REPORT_PATH" ] || { echo "capacity report not found: $CAPACITY_REPORT_PATH" >&2; exit 1; }
[ -f "$MODEL_RELAY_EVIDENCE_PATH" ] || { echo "model relay evidence file not found: $MODEL_RELAY_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$CODEX_APP_HOST_EVIDENCE_PATH" ] || { echo "Codex App host evidence file not found: $CODEX_APP_HOST_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$OBJECT_STORAGE_EVIDENCE_PATH" ] || { echo "object storage evidence file not found: $OBJECT_STORAGE_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$CANONICAL_CUTOVER_EVIDENCE_PATH" ] || { echo "canonical cutover evidence file not found: $CANONICAL_CUTOVER_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$RELEASE_MANIFEST_PATH" ] || { echo "release manifest file not found: $RELEASE_MANIFEST_PATH" >&2; exit 1; }
[ -f "$PAYMENT_EVIDENCE_PATH" ] || { echo "payment evidence file not found: $PAYMENT_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$RESTORE_EVIDENCE_PATH" ] || { echo "restore evidence file not found: $RESTORE_EVIDENCE_PATH" >&2; exit 1; }
[ -d "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" ] || { echo "production evidence artifact root not found: $PRODUCTION_EVIDENCE_ARTIFACT_ROOT" >&2; exit 1; }

case "$REDIS_URL" in
  rediss://*) ;;
  *) echo "production REDIS_URL must use rediss://" >&2; exit 1 ;;
esac
command -v node >/dev/null 2>&1 || { echo "node is required to validate production database URLs" >&2; exit 1; }
database_url_validator="$(dirname "$0")/validate-production-database-url.mjs"
[ -f "$database_url_validator" ] || { echo "production database URL validator is missing: $database_url_validator" >&2; exit 1; }
node "$database_url_validator" DATABASE_URL
node "$database_url_validator" OPS_DATABASE_URL
case "$profile" in
  pilot_50|wave_100|wave_250|target_500) ;;
  *) echo "unknown capacity profile: $profile" >&2; exit 2 ;;
esac
case "$DATABASE_URL $OPS_DATABASE_URL $REDIS_URL" in
  *localhost*|*127.0.0.1*|*pilot-local-token*) echo "local-only endpoint or token is not allowed" >&2; exit 1 ;;
esac

PRODUCTION_CONFIG_PATH="$config_path" sh "$(dirname "$0")/validate-production-config.sh" "$config_path"
# The final deployment contract covers all six platforms. Lower environments
# may keep social connectors opt-in, but production must expose every platform
# whose production canary evidence is required below.
for flag in \
  xiaohongshu_auth_enabled xiaohongshu_read_enabled xiaohongshu_write_enabled \
  douyin_auth_enabled douyin_read_enabled douyin_write_enabled; do
    grep -Eq "^[[:space:]]*${flag}:[[:space:]]*true[[:space:]]*$" "$filtered_config_path" || {
    echo "${flag} must be true in rendered production config" >&2
    exit 1
  }
done
image_set_digest=$(sh "$(dirname "$0")/validate-kubernetes-release.sh" "$RENDERED_MANIFEST_PATH" "$IMAGE_DIGESTS_JSON" --print-image-set-digest)
printf '%s\n' "$image_set_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'canonical image set digest is invalid' >&2; exit 1; }
manifest_sha256=$(shasum -a 256 "$RENDERED_MANIFEST_PATH" | awk '{print $1}')
repo_root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd -P)
release_git_sha=$(git -C "$repo_root" rev-parse HEAD)
# Establish the immutable trust anchor before any evidence gate. Relay and
# Codex host evidence are strict artifact checks on their first invocation;
# there is no shape-only pass that an outer deploy wrapper could misread.
trust_dir='/run/release-security/evidence-trust'
sh "$(dirname "$0")/validate-production-evidence-trust.sh" "$repo_root"
trust_root="$trust_dir/production-evidence-public.pem"
npx --no-install tsx "$(dirname "$0")/../../tests/capability-evidence-gate.ts" --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --release-id "$RELEASE_ID"
npx --no-install tsx "$(dirname "$0")/../../tests/capacity-evidence-gate.ts" --file "$CAPACITY_REPORT_PATH" --require-cloud-gate --release-id "$RELEASE_ID" --profile "$profile"
model_relay_url=$(awk '/^[[:space:]]*model_relay_base_url:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$filtered_config_path")
[ -n "$model_relay_url" ] || { echo "model_relay_base_url is required for relay evidence binding" >&2; exit 1; }
npx --no-install tsx "$(dirname "$0")/../../tests/model-relay-evidence-gate.ts" --file "$MODEL_RELAY_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-relay "$model_relay_url" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --require-production --require-artifacts
npx --no-install tsx "$(dirname "$0")/../../tests/codex-app-host-evidence-gate.ts" --file "$CODEX_APP_HOST_EVIDENCE_PATH" --release-id "$RELEASE_ID" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --require-artifacts
storage_bucket=$(awk '/^[[:space:]]*object_storage_bucket:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$filtered_config_path")
storage_endpoint=$(awk '/^[[:space:]]*object_storage_endpoint:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$filtered_config_path")
[ -n "$storage_bucket" ] || { echo "object_storage_bucket is required for storage evidence binding" >&2; exit 1; }
[ -n "$storage_endpoint" ] || { echo "object_storage_endpoint is required for storage evidence binding" >&2; exit 1; }
npx --no-install tsx "$(dirname "$0")/../../tests/canonical-product-cutover-evidence-gate.ts" --file "$CANONICAL_CUTOVER_EVIDENCE_PATH" --release-id "$RELEASE_ID"
trust_key_id_path="$trust_dir/production-evidence-key-id"
trusted_key_id=$(sed -n '1p' "$trust_key_id_path")
npx --no-install tsx "$(dirname "$0")/../../tests/release-manifest-gate.ts" \
  --file "$RELEASE_MANIFEST_PATH" --release-id "$RELEASE_ID" \
  --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id" \
  --capability-evidence "$CAPABILITY_EVIDENCE_PATH" --capacity-evidence "$CAPACITY_REPORT_PATH" \
  --model-relay-evidence "$MODEL_RELAY_EVIDENCE_PATH" --payment-evidence "$PAYMENT_EVIDENCE_PATH" \
  --restore-evidence "$RESTORE_EVIDENCE_PATH" --object-storage-evidence "$OBJECT_STORAGE_EVIDENCE_PATH" \
  --codex-app-host-evidence "$CODEX_APP_HOST_EVIDENCE_PATH" --canonical-cutover-evidence "$CANONICAL_CUTOVER_EVIDENCE_PATH"
workspace_latest_migration=$(find "$repo_root/packages/persistence/src/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -exec basename {} \; | sed 's/_.*//' | sort -n | tail -1)
case "$EXPECTED_MIGRATION_VERSION" in ''|*[!0-9]*) echo 'EXPECTED_MIGRATION_VERSION must be numeric' >&2; exit 1 ;; esac
[ "$workspace_latest_migration" = "$EXPECTED_MIGRATION_VERSION" ] || { echo "release migration chain tail mismatch: expected $EXPECTED_MIGRATION_VERSION, workspace has $workspace_latest_migration" >&2; exit 1; }
sh "$(dirname "$0")/verify-runtime-db-role.sh"
: "${API_IMAGE_REF:?API_IMAGE_REF is required as an immutable repository@sha256 reference}"
: "${WORKER_IMAGE_REF:?WORKER_IMAGE_REF is required as an immutable repository@sha256 reference}"
api_image_digest=$(IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" node -e 'const value=JSON.parse(process.env.IMAGE_DIGESTS_JSON); process.stdout.write(value["merchant-api"] ?? "")')
worker_image_digest=$(IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" node -e 'const value=JSON.parse(process.env.IMAGE_DIGESTS_JSON); process.stdout.write(value["merchant-worker"] ?? "")')
sh "$(dirname "$0")/verify-container-source-freshness.sh" \
  "$API_IMAGE_REF" "$WORKER_IMAGE_REF" "$api_image_digest" "$worker_image_digest"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
printf '%s\n' "$DEPLOYMENT_NONCE" | grep -Eq '^[A-Za-z0-9_-]{22,128}$' || { echo "DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters" >&2; exit 1; }
npx --no-install tsx "$(dirname "$0")/../../tests/capability-evidence-gate.ts" --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --require-signed-production --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --public-key "$trust_root" --key-id "$trusted_key_id"
npx --no-install tsx "$(dirname "$0")/../../tests/object-storage-evidence-gate.ts" --file "$OBJECT_STORAGE_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-bucket "$storage_bucket" --expected-endpoint "$storage_endpoint" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT"
npx --no-install tsx "$(dirname "$0")/../../tests/production-evidence-gate.ts" --kind payment --file "$PAYMENT_EVIDENCE_PATH" --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id"
npx --no-install tsx "$(dirname "$0")/../../tests/production-evidence-gate.ts" --kind restore --file "$RESTORE_EVIDENCE_PATH" --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id"
echo "deploy preflight passed: release_id=$RELEASE_ID image_set_digest=$image_set_digest migration=$EXPECTED_MIGRATION_VERSION profile=$profile secret_provider=$SECRET_PROVIDER capability_evidence=$CAPABILITY_EVIDENCE_PATH capacity_report=$CAPACITY_REPORT_PATH model_relay_evidence=$MODEL_RELAY_EVIDENCE_PATH codex_app_host_evidence=$CODEX_APP_HOST_EVIDENCE_PATH object_storage_evidence=$OBJECT_STORAGE_EVIDENCE_PATH payment_evidence=$PAYMENT_EVIDENCE_PATH restore_evidence=$RESTORE_EVIDENCE_PATH"
