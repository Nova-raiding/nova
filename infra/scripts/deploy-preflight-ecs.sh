#!/bin/sh
set -eu

[ "${PRODUCTION_EVIDENCE_TRUST_DIR+x}" != x ] || { echo 'PRODUCTION_EVIDENCE_TRUST_DIR is forbidden; the production trust path is fixed' >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_NONCE_CONSUMER+x}" != x ] || { echo 'PRODUCTION_EVIDENCE_NONCE_CONSUMER is forbidden; the production consumer path is fixed' >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_HOOK+x}" != x ] || { echo 'production evidence test hooks are forbidden during ECS deploy preflight' >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR+x}" != x ] || { echo 'production evidence test paths are forbidden during ECS deploy preflight' >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER+x}" != x ] || { echo 'production evidence test paths are forbidden during ECS deploy preflight' >&2; exit 1; }
[ "${VITEST:-false}" != true ] || [ "${NODE_ENV:-}" = test ] || { echo 'VITEST may only bypass the clean-worktree assertion under NODE_ENV=test' >&2; exit 1; }

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}
[ -f "$config_path" ] || { echo 'PRODUCTION_CONFIG_PATH or config path is required' >&2; exit 2; }
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${IMAGE_DIGESTS_JSON:?IMAGE_DIGESTS_JSON is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OPS_DATABASE_URL:?OPS_DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required and must use rediss://}"
: "${SECRET_PROVIDER:?SECRET_PROVIDER is required}"
: "${CAPABILITY_EVIDENCE_PATH:?CAPABILITY_EVIDENCE_PATH is required}"
: "${CAPACITY_REPORT_PATH:?CAPACITY_REPORT_PATH is required}"
: "${MODEL_RELAY_EVIDENCE_PATH:?MODEL_RELAY_EVIDENCE_PATH is required}"
: "${CODEX_APP_HOST_EVIDENCE_PATH:?CODEX_APP_HOST_EVIDENCE_PATH is required}"
: "${OBJECT_STORAGE_EVIDENCE_PATH:?OBJECT_STORAGE_EVIDENCE_PATH is required}"
: "${CANONICAL_CUTOVER_EVIDENCE_PATH:?CANONICAL_CUTOVER_EVIDENCE_PATH is required}"
: "${RELEASE_MANIFEST_PATH:?RELEASE_MANIFEST_PATH is required}"
: "${PAYMENT_EVIDENCE_PATH:?PAYMENT_EVIDENCE_PATH is required}"
: "${RESTORE_EVIDENCE_PATH:?RESTORE_EVIDENCE_PATH is required}"
: "${RELEASE_EVIDENCE_BUNDLE_PATH:?RELEASE_EVIDENCE_BUNDLE_PATH is required}"
: "${RENDERED_COMPOSE_PATH:?RENDERED_COMPOSE_PATH is required}"
: "${PRODUCTION_EVIDENCE_ARTIFACT_ROOT:?PRODUCTION_EVIDENCE_ARTIFACT_ROOT is required}"
: "${EXPECTED_MIGRATION_VERSION:?EXPECTED_MIGRATION_VERSION is required}"
: "${API_IMAGE_REF:?API_IMAGE_REF is required}"
: "${WORKER_IMAGE_REF:?WORKER_IMAGE_REF is required}"
: "${UI_IMAGE_REF:?UI_IMAGE_REF is required}"
: "${OPS_UI_IMAGE_REF:?OPS_UI_IMAGE_REF is required}"
: "${PAYMENT_GATEWAY_IMAGE_REF:?PAYMENT_GATEWAY_IMAGE_REF is required}"
: "${CLAMAV_IMAGE_REF:?CLAMAV_IMAGE_REF is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
: "${ASSET_STORAGE_BUCKET:?ASSET_STORAGE_BUCKET is required}"
: "${ASSET_STORAGE_REGION:?ASSET_STORAGE_REGION is required}"
: "${ASSET_STORAGE_ENDPOINT:?ASSET_STORAGE_ENDPOINT is required}"
: "${ASSET_STORAGE_CREDENTIAL_PROVIDER:?ASSET_STORAGE_CREDENTIAL_PROVIDER=aliyun_ecs_ram_role is required}"
: "${OBJECT_STORAGE_VERSIONING:?OBJECT_STORAGE_VERSIONING=true is required}"
: "${LIFECYCLE_POLICY_REF:?LIFECYCLE_POLICY_REF is required}"
: "${ASSET_STORAGE_QUOTA_BYTES:?ASSET_STORAGE_QUOTA_BYTES is required}"
: "${PUBLIC_ASSET_BASE_URL:?PUBLIC_ASSET_BASE_URL is required}"
: "${ASSET_DISPLAY_URL_SIGNING_SECRET:?ASSET_DISPLAY_URL_SIGNING_SECRET is required}"
: "${ASSET_DISPLAY_URL_SIGNING_KEY_ID:?ASSET_DISPLAY_URL_SIGNING_KEY_ID is required}"
printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo 'unsafe RELEASE_ID' >&2; exit 1; }
printf '%s' "$DEPLOYMENT_NONCE" | grep -Eq '^[A-Za-z0-9_-]{22,128}$' || { echo 'DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters' >&2; exit 1; }
case "$REDIS_URL" in rediss://*) ;; *) echo 'production REDIS_URL must use rediss://' >&2; exit 1 ;; esac
for tool in node npm npx ruby git docker psql shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ECS deploy preflight requires $tool on the execution host; provision the reviewed release toolchain before launch" >&2; exit 1; }
done
[ -x "$root/node_modules/.bin/tsx" ] || { echo 'ECS deploy preflight requires the reviewed, locally installed tsx dependency (npm ci); remote npx downloads are forbidden' >&2; exit 1; }
node "$(dirname "$0")/validate-production-database-url.mjs" DATABASE_URL
node "$(dirname "$0")/validate-production-database-url.mjs" OPS_DATABASE_URL
case "$DATABASE_URL $OPS_DATABASE_URL $REDIS_URL" in *localhost*|*127.0.0.1*) echo 'local endpoint is not allowed' >&2; exit 1 ;; esac
case "$ASSET_STORAGE_ENDPOINT" in https://*) ;; *) echo 'production ASSET_STORAGE_ENDPOINT must use https://' >&2; exit 1 ;; esac
[ "$ASSET_STORAGE_CREDENTIAL_PROVIDER" = aliyun_ecs_ram_role ] || { echo 'production ECS object storage must use aliyun_ecs_ram_role credentials' >&2; exit 1; }
[ "$OBJECT_STORAGE_VERSIONING" = true ] || { echo 'OBJECT_STORAGE_VERSIONING must be true' >&2; exit 1; }
case "${ASSET_STORAGE_SSE_MODE:-AES256}" in
  AES256|aes256) ;;
  aws:kms) [ -n "${ASSET_STORAGE_KMS_KEY_ID:-}" ] || { echo 'ASSET_STORAGE_KMS_KEY_ID is required when aws:kms is selected' >&2; exit 1; } ;;
  *) echo 'ASSET_STORAGE_SSE_MODE must be AES256 or aws:kms' >&2; exit 1 ;;
esac
for file in "$CAPABILITY_EVIDENCE_PATH" "$CAPACITY_REPORT_PATH" "$MODEL_RELAY_EVIDENCE_PATH" "$CODEX_APP_HOST_EVIDENCE_PATH" "$OBJECT_STORAGE_EVIDENCE_PATH" "$CANONICAL_CUTOVER_EVIDENCE_PATH" "$RELEASE_MANIFEST_PATH" "$PAYMENT_EVIDENCE_PATH" "$RESTORE_EVIDENCE_PATH" "$RELEASE_EVIDENCE_BUNDLE_PATH" "$RENDERED_COMPOSE_PATH"; do
  [ -f "$file" ] || { echo "evidence file not found: $file" >&2; exit 1; }
done
[ -d "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" ] || { echo 'production evidence artifact root not found' >&2; exit 1; }
cd "$root"
node infra/scripts/check-mcp-oauth-production.mjs --config
sh infra/scripts/validate-production-config.sh "$config_path"
node infra/scripts/validate-ecs-production-compose.mjs "$RENDERED_COMPOSE_PATH"
image_set_digest=$(ruby infra/scripts/validate-ecs-compose-release.rb "$RENDERED_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON" --print-image-set-digest)
manifest_sha256=$(ruby infra/scripts/validate-ecs-compose-release.rb "$RENDERED_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON" --print-manifest-sha256)
release_git_sha=$(git rev-parse HEAD)
production_config_sha256=$(shasum -a 256 "$config_path" | awk '{print $1}')
case "${ASSET_STORAGE_SSE_MODE:-AES256}" in
  AES256|aes256) storage_encryption=AES256 ;;
  aws:kms) storage_encryption=aws:kms ;;
esac
[ "${VITEST:-false}" = true ] || [ -z "$(git status --porcelain --untracked-files=all)" ] || { echo 'release preflight requires a clean git worktree' >&2; exit 1; }
RELEASE_ID="$RELEASE_ID" RELEASE_GIT_SHA="$release_git_sha" ruby infra/scripts/validate-ecs-compose-release.rb "$RENDERED_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON"
sh infra/scripts/validate-production-evidence-trust.sh "$root"
trust_root=/run/release-security/evidence-trust/production-evidence-public.pem
trusted_key_id=$(sed -n '1p' /run/release-security/evidence-trust/production-evidence-key-id)
npx --no-install tsx tests/capability-evidence-gate.ts --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --release-id "$RELEASE_ID"
npx --no-install tsx tests/capacity-evidence-gate.ts --file "$CAPACITY_REPORT_PATH" --require-cloud-gate --release-id "$RELEASE_ID" --profile "${CAPACITY_PROFILE:-pilot_50}"
model_relay_url=$(awk '/^[[:space:]]*model_relay_base_url:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$config_path")
npx --no-install tsx tests/model-relay-evidence-gate.ts --file "$MODEL_RELAY_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-relay "$model_relay_url" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --require-production --require-artifacts
mcp_base_url=$(ruby infra/scripts/validate-production-config-yaml.rb "$config_path" --print-mcp-base-url)
bridge_sha256=$(shasum -a 256 apps/plugin/mcp/bridge.mjs | awk '{print $1}')
npx --no-install tsx tests/codex-app-host-evidence-gate.ts --file "$CODEX_APP_HOST_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-mcp-base-url "$mcp_base_url" --expected-bridge-sha256 "$bridge_sha256" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --require-artifacts
npx --no-install tsx tests/canonical-product-cutover-evidence-gate.ts --file "$CANONICAL_CUTOVER_EVIDENCE_PATH" --release-id "$RELEASE_ID" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT"
npx --no-install tsx tests/release-manifest-gate.ts --file "$RELEASE_MANIFEST_PATH" --release-id "$RELEASE_ID" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id" --capability-evidence "$CAPABILITY_EVIDENCE_PATH" --capacity-evidence "$CAPACITY_REPORT_PATH" --model-relay-evidence "$MODEL_RELAY_EVIDENCE_PATH" --payment-evidence "$PAYMENT_EVIDENCE_PATH" --restore-evidence "$RESTORE_EVIDENCE_PATH" --object-storage-evidence "$OBJECT_STORAGE_EVIDENCE_PATH" --codex-app-host-evidence "$CODEX_APP_HOST_EVIDENCE_PATH" --canonical-cutover-evidence "$CANONICAL_CUTOVER_EVIDENCE_PATH"
workspace_latest_migration=$(find packages/persistence/src/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -exec basename {} \; | sed 's/_.*//' | sort -n | tail -1)
[ "$workspace_latest_migration" = "$EXPECTED_MIGRATION_VERSION" ] || { echo "release migration chain tail mismatch: expected $EXPECTED_MIGRATION_VERSION, workspace has $workspace_latest_migration" >&2; exit 1; }
sh infra/scripts/verify-database-migration-chain.sh
sh infra/scripts/verify-runtime-db-role.sh
api_digest=$(IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" node -e 'const x=JSON.parse(process.env.IMAGE_DIGESTS_JSON);process.stdout.write(x["merchant-api"]||"")')
worker_digest=$(IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" node -e 'const x=JSON.parse(process.env.IMAGE_DIGESTS_JSON);process.stdout.write(x["merchant-worker"]||"")')
sh infra/scripts/verify-container-source-freshness.sh "$API_IMAGE_REF" "$WORKER_IMAGE_REF" "$api_digest" "$worker_digest"
npx --no-install tsx tests/capability-evidence-gate.ts --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --require-signed-production --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --public-key "$trust_root" --key-id "$trusted_key_id"
npx --no-install tsx tests/object-storage-evidence-gate.ts \
  --file "$OBJECT_STORAGE_EVIDENCE_PATH" --release-id "$RELEASE_ID" \
  --release-git-sha "$release_git_sha" --manifest-sha256 "$manifest_sha256" \
  --image-set-digest "$image_set_digest" --deployment-nonce "$DEPLOYMENT_NONCE" \
  --expected-config-checksum "$production_config_sha256" \
  --expected-bucket "$ASSET_STORAGE_BUCKET" --expected-endpoint "$ASSET_STORAGE_ENDPOINT" \
  --expected-encryption "$storage_encryption" \
  --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id"
npx --no-install tsx tests/production-evidence-gate.ts --kind payment --file "$PAYMENT_EVIDENCE_PATH" --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id"
npx --no-install tsx tests/production-evidence-gate.ts --kind restore --file "$RESTORE_EVIDENCE_PATH" --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id"
npx --no-install tsx tests/release-evidence-bundle-gate.ts --file "$RELEASE_EVIDENCE_BUNDLE_PATH" \
  --release-manifest "$RELEASE_MANIFEST_PATH" \
  --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" \
  --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" \
  --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id" \
  --capability-evidence "$CAPABILITY_EVIDENCE_PATH" --capacity-evidence "$CAPACITY_REPORT_PATH" \
  --model-relay-evidence "$MODEL_RELAY_EVIDENCE_PATH" --payment-evidence "$PAYMENT_EVIDENCE_PATH" \
  --restore-evidence "$RESTORE_EVIDENCE_PATH" --object-storage-evidence "$OBJECT_STORAGE_EVIDENCE_PATH" \
  --codex-app-host-evidence "$CODEX_APP_HOST_EVIDENCE_PATH" --canonical-cutover-evidence "$CANONICAL_CUTOVER_EVIDENCE_PATH"
echo "ecs deploy preflight passed: release_id=$RELEASE_ID image_set_digest=$image_set_digest manifest_sha256=$manifest_sha256 migration=$EXPECTED_MIGRATION_VERSION secret_provider=$SECRET_PROVIDER"
