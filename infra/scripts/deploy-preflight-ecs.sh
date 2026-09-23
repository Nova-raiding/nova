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
: "${CAPACITY_PROFILE:?CAPACITY_PROFILE must be explicit: no_load for this release, or an approved load profile}"
: "${DEPLOYMENT_SCOPE:=full}"
case "$DEPLOYMENT_SCOPE" in
  infra|full) ;;
  *) echo 'DEPLOYMENT_SCOPE must be infra or full' >&2; exit 1 ;;
esac
: "${IMAGE_DIGESTS_JSON:?IMAGE_DIGESTS_JSON is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${OPS_DATABASE_URL:?OPS_DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required and must use rediss://}"
# The production migrate service does not read DATABASE_URL/OPS_DATABASE_URL for
# its own connection: its psql calls go through the PG* family, because the
# migration and the role bootstrap it re-applies connect as the schema owner,
# not as the runtime role. Its Compose layer takes each of them from the host
# `.env` (infra/local/docker-compose.ecs-production-migration.yml); left unset,
# the local acceptance identity is used and `docker compose run --rm migrate`
# connects to a database named `postgres` with a password published in this
# repository instead of the production one. Name them here so the failure is a
# missing variable rather than a connection error after the deploy has started.
: "${PGHOST:?PGHOST is required so the migration targets the production database}"
: "${PGDATABASE:?PGDATABASE is required so the migration targets the production database}"
: "${PGUSER:?PGUSER is required so the migration runs as the schema owner}"
: "${PGPASSWORD:?PGPASSWORD is required so the migration runs as the schema owner}"
: "${ALERT_RECEIVER_DATABASE_URL:?ALERT_RECEIVER_DATABASE_URL is required so the migration can verify the receiver role}"
: "${SECRET_PROVIDER:?SECRET_PROVIDER is required}"
if [ "$DEPLOYMENT_SCOPE" = full ]; then
  : "${CAPABILITY_EVIDENCE_PATH:?CAPABILITY_EVIDENCE_PATH is required for full production acceptance}"
  : "${CAPACITY_REPORT_PATH:?CAPACITY_REPORT_PATH is required for full production acceptance}"
  : "${MODEL_RELAY_EVIDENCE_PATH:?MODEL_RELAY_EVIDENCE_PATH is required for full production acceptance}"
  : "${CODEX_APP_HOST_EVIDENCE_PATH:?CODEX_APP_HOST_EVIDENCE_PATH is required for full production acceptance}"
  : "${OBJECT_STORAGE_EVIDENCE_PATH:?OBJECT_STORAGE_EVIDENCE_PATH is required for full production acceptance}"
  : "${CANONICAL_CUTOVER_EVIDENCE_PATH:?CANONICAL_CUTOVER_EVIDENCE_PATH is required for full production acceptance}"
  : "${RELEASE_MANIFEST_PATH:?RELEASE_MANIFEST_PATH is required for full production acceptance}"
  : "${PAYMENT_EVIDENCE_PATH:?PAYMENT_EVIDENCE_PATH is required for full production acceptance}"
  : "${RESTORE_EVIDENCE_PATH:?RESTORE_EVIDENCE_PATH is required for full production acceptance}"
  : "${RELEASE_EVIDENCE_BUNDLE_PATH:?RELEASE_EVIDENCE_BUNDLE_PATH is required for full production acceptance}"
fi
: "${RENDERED_COMPOSE_PATH:?RENDERED_COMPOSE_PATH is required}"
: "${EXPECTED_MIGRATION_VERSION:?EXPECTED_MIGRATION_VERSION is required}"
: "${API_IMAGE_REF:?API_IMAGE_REF is required}"
: "${WORKER_IMAGE_REF:?WORKER_IMAGE_REF is required}"
: "${UI_IMAGE_REF:?UI_IMAGE_REF is required}"
: "${OPS_UI_IMAGE_REF:?OPS_UI_IMAGE_REF is required}"
: "${PAYMENT_GATEWAY_IMAGE_REF:?PAYMENT_GATEWAY_IMAGE_REF is required}"
# The public pilot gateway and the one-shot migration image are pinned by the
# release layer exactly like the application images. Both were consumed by
# infra/local/docker-compose.ecs-pilot-release.yml without any producer in the
# repository, so the Compose render failed on the operator's missing value
# before this contract could name it. Keep every pinned image declared here.
: "${PILOT_GATEWAY_IMAGE_REF:?PILOT_GATEWAY_IMAGE_REF is required}"
: "${MIGRATION_IMAGE_REF:?MIGRATION_IMAGE_REF is required}"
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
# Every remaining variable the production Compose chain refuses to interpolate
# without (`${VAR:?}` in infra/local/docker-compose.ecs-pilot.yml and
# docker-compose.ecs-oss-cutover.yml, the two layers before the release layer).
# They were previously named only by the Compose files themselves, so an
# operator who prepared `.env` from the runbook and this preflight still had
# `docker compose config` exit 1 on thirty-seven variables — and Docker Compose
# truncates the interpolation errors, so the report could not be trusted to
# name them. Each name below is read from exactly one place: the Compose layer
# that requires it. Keeping the list here is what makes the preflight able to
# name a missing value before the render, which is the whole point of it.
: "${WORKER_API_CREDENTIALS:?WORKER_API_CREDENTIALS is required}"
: "${WORKER_WORKSPACES:?WORKER_WORKSPACES=auto or an explicit production workspace allowlist is required}"
: "${WORKER_SYNC_API_TOKEN:?WORKER_SYNC_API_TOKEN is required}"
: "${WORKER_SYNC_API_SIGNING_SECRET:?WORKER_SYNC_API_SIGNING_SECRET is required}"
: "${WORKER_GENERATION_API_TOKEN:?WORKER_GENERATION_API_TOKEN is required}"
: "${WORKER_GENERATION_API_SIGNING_SECRET:?WORKER_GENERATION_API_SIGNING_SECRET is required}"
: "${WORKER_PUBLISH_API_TOKEN:?WORKER_PUBLISH_API_TOKEN is required}"
: "${WORKER_PUBLISH_API_SIGNING_SECRET:?WORKER_PUBLISH_API_SIGNING_SECRET is required}"
: "${WORKER_RECONCILE_API_TOKEN:?WORKER_RECONCILE_API_TOKEN is required}"
: "${WORKER_RECONCILE_API_SIGNING_SECRET:?WORKER_RECONCILE_API_SIGNING_SECRET is required}"
: "${WORKER_AUTOMATION_API_TOKEN:?WORKER_AUTOMATION_API_TOKEN is required}"
: "${WORKER_AUTOMATION_API_SIGNING_SECRET:?WORKER_AUTOMATION_API_SIGNING_SECRET is required}"
: "${WORKER_SCAN_API_TOKEN:?WORKER_SCAN_API_TOKEN is required}"
: "${WORKER_SCAN_API_SIGNING_SECRET:?WORKER_SCAN_API_SIGNING_SECRET is required}"
: "${API_AUTH_TOKENS:?API_AUTH_TOKENS is required}"
: "${SESSION_ID_HASH_SECRET:?SESSION_ID_HASH_SECRET is required}"
: "${OPS_AUTH_MODE:?OPS_AUTH_MODE must be password or oidc}"
case "$OPS_AUTH_MODE" in
  password) ;;
  oidc) : "${OIDC_PROXY_SIGNING_SECRET:?OIDC_PROXY_SIGNING_SECRET is required when OPS_AUTH_MODE=oidc}" ;;
  *) echo 'OPS_AUTH_MODE must be password or oidc' >&2; exit 1 ;;
esac
: "${MODEL_COST_ESTIMATE_VERSION:?MODEL_COST_ESTIMATE_VERSION production value is required}"
: "${ASSET_SCANNER_API_TOKEN:?ASSET_SCANNER_API_TOKEN is required}"
: "${ASSET_SCANNER_WORKSPACE_SIGNING_SECRET:?ASSET_SCANNER_WORKSPACE_SIGNING_SECRET is required}"
: "${ASSET_SCAN_RECEIPT_KEY_ID:?ASSET_SCAN_RECEIPT_KEY_ID is required}"
: "${ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64:?ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64 is required}"
: "${ASSET_SCAN_TRUSTED_PUBLIC_KEYS:?ASSET_SCAN_TRUSTED_PUBLIC_KEYS is required}"
: "${ASSET_STORAGE_ECS_RAM_ROLE:?ASSET_STORAGE_ECS_RAM_ROLE is required}"
: "${DATA_RETENTION_DAYS:?DATA_RETENTION_DAYS is required}"
: "${ASSET_QUARANTINE_RETENTION_DAYS:?ASSET_QUARANTINE_RETENTION_DAYS is required}"
: "${ASSET_CLEAN_RETENTION_DAYS:?ASSET_CLEAN_RETENTION_DAYS is required}"
: "${DELETION_REQUEST_GRACE_DAYS:?DELETION_REQUEST_GRACE_DAYS is required}"
: "${BACKUP_RETENTION_DAYS:?BACKUP_RETENTION_DAYS is required}"
: "${MERCHANT_API_TOKEN:?MERCHANT_API_TOKEN is required for pilot preflight}"
: "${MERCHANT_WORKSPACE_ID:?MERCHANT_WORKSPACE_ID is required for pilot preflight}"
: "${ALIPAY_APP_ID:?ALIPAY_APP_ID is required}"
: "${PAYMENT_MODE:?PAYMENT_MODE=provider is required for ECS}"
: "${PAYMENT_PROVIDER_ADAPTERS:?PAYMENT_PROVIDER_ADAPTERS=alipay is required}"
: "${PAYMENT_CHECKOUT_BASE_URL:?public HTTPS payment checkout base URL is required}"
: "${PAYMENT_PROVIDER_CHECKOUT_API_URL:?public HTTPS payment gateway checkout URL is required}"
: "${PAYMENT_PROVIDER_QUERY_API_URL:?public HTTPS payment gateway query URL is required}"
: "${PAYMENT_PROVIDER_REFUND_QUERY_API_URL:?public HTTPS payment gateway refund query URL is required}"
: "${PAYMENT_PROVIDER_REFUND_API_URL:?public HTTPS payment gateway refund URL is required}"
: "${PAYMENT_PROVIDER_API_KEY:?PAYMENT_PROVIDER_API_KEY is required}"
: "${PAYMENT_PROVIDER_MERCHANT_ID:?PAYMENT_PROVIDER_MERCHANT_ID is required}"
: "${PAYMENT_CALLBACK_BASE_URL:?public HTTPS payment callback base URL is required}"
: "${PAYMENT_CALLBACK_SECRET:?PAYMENT_CALLBACK_SECRET is required}"
: "${PAYMENT_PROTECTED_RECEIPT_HOST_DIR:?PAYMENT_PROTECTED_RECEIPT_HOST_DIR is required}"
: "${PAYMENT_RECONCILIATION_ENABLED:?PAYMENT_RECONCILIATION_ENABLED=true is required}"
: "${PAYMENT_REFUND_ENABLED:?PAYMENT_REFUND_ENABLED=true is required}"
case "$PAYMENT_PROTECTED_RECEIPT_HOST_DIR" in
  /var/lib/merchant-release-security/*) ;;
  *) echo 'PAYMENT_PROTECTED_RECEIPT_HOST_DIR must be under /var/lib/merchant-release-security/' >&2; exit 1 ;;
esac
if [ ! -d "$PAYMENT_PROTECTED_RECEIPT_HOST_DIR" ] || [ "$(realpath "$PAYMENT_PROTECTED_RECEIPT_HOST_DIR")" != "$PAYMENT_PROTECTED_RECEIPT_HOST_DIR" ] || [ "$(stat -c '%u:%a' "$PAYMENT_PROTECTED_RECEIPT_HOST_DIR")" != '100:700' ]; then
  echo 'PAYMENT_PROTECTED_RECEIPT_HOST_DIR must be a canonical non-symlink directory owned by UID 100 with mode 0700' >&2
  exit 1
fi
printf '%s' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo 'unsafe RELEASE_ID' >&2; exit 1; }
printf '%s' "$DEPLOYMENT_NONCE" | grep -Eq '^[A-Za-z0-9_-]{22,128}$' || { echo 'DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters' >&2; exit 1; }
case "$REDIS_URL" in
  rediss://*) ;;
  redis://redis:6379|redis://redis:6379/0)
    [ "$SECRET_PROVIDER" = ecs-protected-env ] || { echo 'plaintext Redis is allowed only for the private single-node ECS profile' >&2; exit 1; }
    ;;
  *) echo 'production REDIS_URL must use rediss:// or the private single-node ECS Redis service' >&2; exit 1 ;;
esac
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
for file in "$RENDERED_COMPOSE_PATH"; do
  [ -f "$file" ] || { echo "evidence file not found: $file" >&2; exit 1; }
done
if [ "$DEPLOYMENT_SCOPE" = full ]; then
  : "${PRODUCTION_EVIDENCE_ARTIFACT_ROOT:?PRODUCTION_EVIDENCE_ARTIFACT_ROOT is required for full production acceptance}"
  for file in "$CAPABILITY_EVIDENCE_PATH" "$CAPACITY_REPORT_PATH" "$MODEL_RELAY_EVIDENCE_PATH" "$CODEX_APP_HOST_EVIDENCE_PATH" "$OBJECT_STORAGE_EVIDENCE_PATH" "$CANONICAL_CUTOVER_EVIDENCE_PATH" "$RELEASE_MANIFEST_PATH" "$PAYMENT_EVIDENCE_PATH" "$RESTORE_EVIDENCE_PATH" "$RELEASE_EVIDENCE_BUNDLE_PATH"; do
    [ -f "$file" ] || { echo "evidence file not found: $file" >&2; exit 1; }
  done
  [ -d "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" ] || { echo 'production evidence artifact root not found' >&2; exit 1; }
fi
cd "$root"
: "${MCP_INTEGRATION_MODE:?MCP_INTEGRATION_MODE is required}"
case "$MCP_INTEGRATION_MODE" in
  local_stdio|remote_oauth) ;;
  *) echo 'MCP_INTEGRATION_MODE must be local_stdio or remote_oauth' >&2; exit 1 ;;
esac
node infra/scripts/check-mcp-oauth-production.mjs --config
sh infra/scripts/validate-production-config.sh "$config_path"
node infra/scripts/validate-ecs-production-compose.mjs "$RENDERED_COMPOSE_PATH"
image_set_digest=$(ruby infra/scripts/validate-ecs-compose-release.rb "$RENDERED_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON" --print-image-set-digest)
manifest_sha256=$(ruby infra/scripts/validate-ecs-compose-release.rb "$RENDERED_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON" --print-manifest-sha256)
release_manifest_sha256=$(shasum -a 256 "$RELEASE_MANIFEST_PATH" | awk '{print $1}')
if [ -f "$root/.candidate-identity" ] && [ ! -L "$root/.candidate-identity" ]; then
  release_git_sha=$(sed -n 's/^git_sha=//p' "$root/.candidate-identity")
  printf '%s' "$release_git_sha" | grep -Eq '^[0-9a-f]{40}$' || { echo 'staged candidate Git SHA is invalid' >&2; exit 1; }
else
  release_git_sha=$(git rev-parse HEAD)
fi
production_config_sha256=$(shasum -a 256 "$config_path" | awk '{print $1}')
case "${ASSET_STORAGE_SSE_MODE:-AES256}" in
  AES256|aes256) storage_encryption=AES256 ;;
  aws:kms) storage_encryption=aws:kms ;;
esac
if [ -d "$root/.git" ]; then
  [ "${VITEST:-false}" = true ] || [ -z "$(git status --porcelain --untracked-files=all)" ] || { echo 'release preflight requires a clean git worktree' >&2; exit 1; }
fi
RELEASE_ID="$RELEASE_ID" RELEASE_GIT_SHA="$release_git_sha" ruby infra/scripts/validate-ecs-compose-release.rb "$RENDERED_COMPOSE_PATH" "$IMAGE_DIGESTS_JSON"
platform_operations_mode=$(awk '/^[[:space:]]*platform_operations_mode:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$config_path")
sh infra/scripts/validate-production-evidence-trust.sh "$root" "$platform_operations_mode"
trust_root=/run/release-security/evidence-trust/production-evidence-public.pem
trusted_key_id=$(sed -n '1p' /run/release-security/evidence-trust/production-evidence-key-id)
if [ "$platform_operations_mode" = manual ]; then
  npx --no-install tsx tests/manual-operations-evidence-gate.ts --file "$CAPABILITY_EVIDENCE_PATH" --release-id "$RELEASE_ID"
else
  npx --no-install tsx tests/capability-evidence-gate.ts --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --release-id "$RELEASE_ID"
fi
capacity_profile=$CAPACITY_PROFILE
if [ "$capacity_profile" = no_load ]; then
  npx --no-install tsx tests/capacity-evidence-gate.ts --file "$CAPACITY_REPORT_PATH" --release-id "$RELEASE_ID" --profile no_load
else
  npx --no-install tsx tests/capacity-evidence-gate.ts --file "$CAPACITY_REPORT_PATH" --require-cloud-gate --release-id "$RELEASE_ID" --profile "$capacity_profile"
fi
model_relay_url=$(awk '/^[[:space:]]*model_relay_base_url:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$config_path")
npx --no-install tsx tests/model-relay-evidence-gate.ts --file "$MODEL_RELAY_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-relay "$model_relay_url" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --require-production --require-artifacts
mcp_base_url=$(ruby infra/scripts/validate-production-config-yaml.rb "$config_path" --print-mcp-base-url)
plugin_source_schema=$(sed -n 's/^schema_version=//p' "$root/.candidate-identity" 2>/dev/null || true)
case "$plugin_source_schema" in
  '') bridge_sha256=$(shasum -a 256 apps/plugin/mcp/bridge.mjs | awk '{print $1}') ;;
  candidate-identity/2)
    bridge_sha256=$(sh "$root/infra/scripts/verify-staged-plugin-release-v2.sh" "$root" "$RELEASE_ID" "$release_git_sha")
    PLUGIN_RELEASE_DARWIN_DESCRIPTOR_PATH="$root/.plugin-release-descriptor-darwin.json"
    PLUGIN_RELEASE_DARWIN_TEST_ATTESTATION_PATH="$root/.local-plugin-test-attestation-darwin.json"
    PLUGIN_RELEASE_WIN32_DESCRIPTOR_PATH="$root/.plugin-release-descriptor-win32.json"
    PLUGIN_RELEASE_WIN32_TEST_ATTESTATION_PATH="$root/.local-plugin-test-attestation-win32.json"
    PLUGIN_RELEASE_PUBLIC_KEY_PATH=/run/release-security/plugin-trust/plugin-release-public.pem
    PLUGIN_RELEASE_KEY_ID=$(sed -n '1p' /run/release-security/plugin-trust/key-id)
    export PLUGIN_RELEASE_DARWIN_DESCRIPTOR_PATH PLUGIN_RELEASE_DARWIN_TEST_ATTESTATION_PATH
    export PLUGIN_RELEASE_WIN32_DESCRIPTOR_PATH PLUGIN_RELEASE_WIN32_TEST_ATTESTATION_PATH
    export PLUGIN_RELEASE_PUBLIC_KEY_PATH PLUGIN_RELEASE_KEY_ID
    ;;
  *) echo 'candidate plugin source schema is unsupported' >&2; exit 2 ;;
esac
npx --no-install tsx tests/codex-app-host-evidence-gate.ts --file "$CODEX_APP_HOST_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-mcp-base-url "$mcp_base_url" --expected-bridge-sha256 "$bridge_sha256" --expected-git-sha "$release_git_sha" --expected-image-set-digest "$image_set_digest" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --require-artifacts
npx --no-install tsx tests/canonical-product-cutover-evidence-gate.ts --file "$CANONICAL_CUTOVER_EVIDENCE_PATH" --release-id "$RELEASE_ID" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT"
npx --no-install tsx tests/release-manifest-gate.ts --file "$RELEASE_MANIFEST_PATH" --release-id "$RELEASE_ID" --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id" --capability-evidence "$CAPABILITY_EVIDENCE_PATH" --capacity-evidence "$CAPACITY_REPORT_PATH" --model-relay-evidence "$MODEL_RELAY_EVIDENCE_PATH" --payment-evidence "$PAYMENT_EVIDENCE_PATH" --restore-evidence "$RESTORE_EVIDENCE_PATH" --object-storage-evidence "$OBJECT_STORAGE_EVIDENCE_PATH" --codex-app-host-evidence "$CODEX_APP_HOST_EVIDENCE_PATH" --canonical-cutover-evidence "$CANONICAL_CUTOVER_EVIDENCE_PATH"
workspace_latest_migration=$(find packages/persistence/src/migrations -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -exec basename {} \; | sed 's/_.*//' | sort -n | tail -1)
[ "$workspace_latest_migration" = "$EXPECTED_MIGRATION_VERSION" ] || { echo "release migration chain tail mismatch: expected $EXPECTED_MIGRATION_VERSION, workspace has $workspace_latest_migration" >&2; exit 1; }
MIGRATION_CHAIN_MODE=prefix sh infra/scripts/verify-database-migration-chain.sh
sh infra/scripts/verify-runtime-db-role.sh
api_digest=$(IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" node -e 'const x=JSON.parse(process.env.IMAGE_DIGESTS_JSON);process.stdout.write(x["merchant-api"]||"")')
worker_digest=$(IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" node -e 'const x=JSON.parse(process.env.IMAGE_DIGESTS_JSON);process.stdout.write(x["merchant-worker"]||"")')
sh infra/scripts/verify-container-source-freshness.sh "$API_IMAGE_REF" "$WORKER_IMAGE_REF" "$api_digest" "$worker_digest"
if [ "$DEPLOYMENT_SCOPE" = infra ]; then
  echo "ecs infra preflight passed: release_id=$RELEASE_ID scope=infra (business acceptance evidence deferred)"
  exit 0
fi
if [ "$platform_operations_mode" = manual ]; then
  npx --no-install tsx tests/manual-operations-evidence-gate.ts --file "$CAPABILITY_EVIDENCE_PATH" --release-id "$RELEASE_ID" \
    --require-signed-production --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" \
    --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" \
    --public-key "$trust_root" --key-id "$trusted_key_id"
else
  npx --no-install tsx tests/capability-evidence-gate.ts --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --require-signed-production --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" --public-key "$trust_root" --key-id "$trusted_key_id"
fi
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
  --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$release_manifest_sha256" \
  --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" \
  --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_root" --key-id "$trusted_key_id" \
  --capability-evidence "$CAPABILITY_EVIDENCE_PATH" --capacity-evidence "$CAPACITY_REPORT_PATH" \
  --model-relay-evidence "$MODEL_RELAY_EVIDENCE_PATH" --payment-evidence "$PAYMENT_EVIDENCE_PATH" \
  --restore-evidence "$RESTORE_EVIDENCE_PATH" --object-storage-evidence "$OBJECT_STORAGE_EVIDENCE_PATH" \
  --codex-app-host-evidence "$CODEX_APP_HOST_EVIDENCE_PATH" --canonical-cutover-evidence "$CANONICAL_CUTOVER_EVIDENCE_PATH"
echo "ecs deploy preflight passed: release_id=$RELEASE_ID image_set_digest=$image_set_digest manifest_sha256=$manifest_sha256 migration=$EXPECTED_MIGRATION_VERSION secret_provider=$SECRET_PROVIDER"
