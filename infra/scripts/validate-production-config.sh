#!/bin/sh
set -eu

config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}
if [ -z "$config_path" ] || [ ! -f "$config_path" ]; then
  echo "production config gate requires an explicit rendered config path (PRODUCTION_CONFIG_PATH or argv[1])" >&2
  exit 2
fi

# Validate actual YAML entries, not commented-out examples. Keep the source
# path out of the temporary file name so the caller still gets a stable
# artifact reference in the success message; the rendered artifact itself is
# never modified.
rendered_config_path=$config_path
yaml_validator=$(CDPATH= cd -- "$(dirname "$0")" && pwd -P)/validate-production-config-yaml.rb
[ -f "$yaml_validator" ] || { echo "production config YAML validator is missing" >&2; exit 1; }
ruby "$yaml_validator" "$rendered_config_path"
filtered_config_path=$(mktemp "${TMPDIR:-/tmp}/merchant-production-config.XXXXXX")
trap 'rm -f -- "$filtered_config_path"' EXIT
sed -E '/^[[:space:]]*#/d; s/[[:space:]]+#.*$//' "$rendered_config_path" > "$filtered_config_path"
config_path=$filtered_config_path

# Every required setting must be an actual YAML key. The value checks below
# intentionally remain dependency-free, but an unanchored grep can otherwise
# mistake text such as `note: "plugin_enabled: true"` for configuration.
required_keys='plugin_enabled merchant_bearer_hostname auth_enforcement session_id_hash_secret_ref jd_auth_enabled jd_read_enabled jd_write_enabled taobao_tmall_auth_enabled taobao_tmall_read_enabled taobao_tmall_write_enabled pinduoduo_auth_enabled pinduoduo_read_enabled pinduoduo_write_enabled object_storage_versioning lifecycle_policy_ref asset_quarantine_retention_days asset_clean_retention_days deletion_request_grace_days backup_retention_days alert_channel_secret_ref point_in_time_recovery_enabled database_pooler_enabled database_max_backend_connections database_connection_utilization_alert_percent secret_provider worker_api_credentials_ref worker_sync_api_token_ref worker_sync_api_signing_secret_ref worker_generation_api_token_ref worker_generation_api_signing_secret_ref worker_publish_api_token_ref worker_publish_api_signing_secret_ref worker_reconcile_api_token_ref worker_reconcile_api_signing_secret_ref worker_automation_api_token_ref worker_automation_api_signing_secret_ref merchant_ui_api_token_ref payment_mode payment_provider_adapters payment_checkout_base_url payment_provider_checkout_api_url payment_provider_query_api_url payment_provider_refund_api_url payment_provider_api_key_ref payment_provider_merchant_id payment_callback_base_url payment_callback_secret_ref payment_reconciliation_enabled payment_refund_enabled model_relay_base_url model_relay_api_key_ref text_model image_model image_edit_model ocr_model video_model approved_requests_per_minute approved_tokens_per_minute maximum_task_cost_cny object_storage_bucket object_storage_region object_storage_endpoint object_storage_kms_key asset_display_base_url asset_display_url_signing_secret_ref platform_rule_sync_manifest_url platform_rule_sync_signing_secret_ref platform_rule_sync_interval_hours asset_scanner_mode allow_local_asset_scan_fixture asset_scanner_api_token_ref asset_scanner_workspace_signing_secret_ref asset_scan_receipt_key_id asset_scan_receipt_private_key_ref asset_scan_trusted_public_keys_ref asset_scan_policy_version clamav_image_digest clamav_signature_max_age_minutes clamav_max_file_bytes'
required_keys="$required_keys mcp_authorization_mode durable_platform_assignments_required"
missing_required_key=$(awk -v required_keys="$required_keys" '
  BEGIN { required_count = split(required_keys, required, /[[:space:]]+/) }
  /^[[:space:]]*[A-Za-z0-9_]+[[:space:]]*:/ {
    key = $0
    sub(/^[[:space:]]*/, "", key)
    sub(/[[:space:]]*:.*/, "", key)
    present[key] = 1
  }
  END {
    for (i = 1; i <= required_count; i++) {
      if (!present[required[i]]) {
        print required[i]
        exit
      }
    }
  }
' "$config_path")
if [ -n "$missing_required_key" ]; then
  echo "required production config key is missing: ${missing_required_key}" >&2
  exit 1
fi

# This gate intentionally scans the rendered artifact, not the checked-in
# example. Secrets must already be resolved by the deployment system; the
# artifact must never contain template placeholders or local-only grants.
if grep -nE 'SET_[A-Z0-9_]+|BLOCKED_UNTIL_|\$\{[^}]+\}|pilot-local-token|localhost|127\.0\.0\.1|model-relay\.example\.com|CONNECTOR_FIXTURE_MODE[=:][[:space:]]*true|ALLOW_WILDCARD_WORKSPACE_GRANT[=:][[:space:]]*true' "$config_path" >/dev/null; then
  # Do not echo matching rendered config lines: they may contain resolved
  # credentials or secret-manager references. The artifact remains available
  # to the deployment operator for private inspection.
  echo "production config contains unresolved placeholder or local-only value" >&2
  exit 1
fi

grep -Eq '^[[:space:]]*plugin_enabled:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'plugin_enabled must be true in rendered production config' >&2; exit 1; }
grep -Eq '^[[:space:]]*auth_enforcement:[[:space:]]*"?strict"?[[:space:]]*$' "$config_path" || { echo 'auth_enforcement must be strict in rendered production config' >&2; exit 1; }
grep -Eq '^[[:space:]]*mcp_authorization_mode:[[:space:]]*"?enforce"?[[:space:]]*$' "$config_path" || { echo 'mcp_authorization_mode must be enforce in rendered production config' >&2; exit 1; }
grep -Eq '^[[:space:]]*durable_platform_assignments_required:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'durable platform assignments must be authoritative in rendered production config' >&2; exit 1; }
grep -Eq 'session_id_hash_secret_ref:[[:space:]]*[^"'"'"' ]+' "$config_path" || { echo 'session_id_hash_secret_ref must be configured' >&2; exit 1; }
grep -Eq '^[[:space:]]*merchant_bearer_hostname:[[:space:]]*"?[a-z0-9][a-z0-9.-]*[a-z0-9]"?[[:space:]]*$' "$config_path" || { echo 'merchant_bearer_hostname must be configured for the merchant bearer boundary' >&2; exit 1; }
if grep -Eq '^[[:space:]]*merchant_bearer_hostname:[[:space:]]*"?[^[:space:]]*\*[^[:space:]]*"?[[:space:]]*$' "$config_path"; then
  echo 'merchant_bearer_hostname must not be a wildcard' >&2
  exit 1
fi
if ! grep -Eq '^[[:space:]]*OPS_AUTH_MODE:[[:space:]]*oidc([[:space:]]*)$' "$config_path" && ! grep -Eq '^[[:space:]]*auth_mode:[[:space:]]*"?oidc_gateway_hmac"?([[:space:]]*)$' "$config_path"; then
  echo 'production ops console must use OIDC gateway authentication' >&2
  exit 1
fi
# The baseline production contract requires the three established platform
# groups. Social platforms are opt-in until their official OAuth/scopes,
# field-mapping, and production-canary evidence are resolved; when enabled,
# each social platform must be enabled as a complete auth/read/write group.
for flag in \
  jd_auth_enabled jd_read_enabled jd_write_enabled \
  taobao_tmall_auth_enabled taobao_tmall_read_enabled taobao_tmall_write_enabled \
  pinduoduo_auth_enabled pinduoduo_read_enabled pinduoduo_write_enabled; do
  grep -Eq "^[[:space:]]*${flag}:[[:space:]]*true[[:space:]]*$" "$config_path" || { echo "${flag} must be true in rendered production config" >&2; exit 1; }
done
for social_platform in xiaohongshu douyin; do
  social_enabled=false
  for flag in \
    "${social_platform}_auth_enabled" \
    "${social_platform}_read_enabled" \
    "${social_platform}_write_enabled"; do
    if grep -Eq "^[[:space:]]*${flag}:[[:space:]]*true[[:space:]]*$" "$config_path"; then
      social_enabled=true
    fi
  done
  if [ "$social_enabled" = true ]; then
    for flag in \
      "${social_platform}_auth_enabled" \
      "${social_platform}_read_enabled" \
      "${social_platform}_write_enabled"; do
      grep -Eq "^[[:space:]]*${flag}:[[:space:]]*true[[:space:]]*$" "$config_path" || {
        echo "${social_platform} production flags must enable auth, read, and write together" >&2
        exit 1
      }
    done
  fi
done
grep -Eq '^[[:space:]]*object_storage_versioning:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'object storage versioning must be enabled' >&2; exit 1; }
grep -Eq 'lifecycle_policy_ref:[[:space:]]*"?[^"[:space:]]+"?$' "$config_path" || { echo 'lifecycle_policy_ref must be configured' >&2; exit 1; }
grep -Eq 'asset_quarantine_retention_days:[[:space:]]*([7-9]|[1-9][0-9]|[12][0-9][0-9])$' "$config_path" || { echo 'asset_quarantine_retention_days must be at least 7 days' >&2; exit 1; }
grep -Eq 'asset_clean_retention_days:[[:space:]]*(3[0-9]|[4-9][0-9]|[1-9][0-9][0-9])$' "$config_path" || { echo 'asset_clean_retention_days must be at least 30 days' >&2; exit 1; }
grep -Eq 'deletion_request_grace_days:[[:space:]]*(7|[89]|[12][0-9]|30)$' "$config_path" || { echo 'deletion_request_grace_days must be between 7 and 30 days' >&2; exit 1; }
grep -Eq 'backup_retention_days:[[:space:]]*(3[0-9]|[4-9][0-9]|[12][0-9][0-9])$' "$config_path" || { echo 'backup_retention_days must be at least 30 days' >&2; exit 1; }
grep -Eq 'alert_channel_secret_ref:[[:space:]]*"?[^"[:space:]]+"?$' "$config_path" || { echo 'alert_channel_secret_ref must be configured' >&2; exit 1; }
grep -Eq '^[[:space:]]*point_in_time_recovery_enabled:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'PITR must be explicitly enabled' >&2; exit 1; }
grep -Eq 'secret_provider:[[:space:]]*[^"'"'"' ]+' "$config_path" || { echo 'managed secret provider must be configured' >&2; exit 1; }
grep -Eq '^[[:space:]]*database_pooler_enabled:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'managed database pooler must be enabled' >&2; exit 1; }
grep -Eq 'database_max_backend_connections:[[:space:]]*"?300"?$' "$config_path" || { echo 'database_max_backend_connections must be 300' >&2; exit 1; }
grep -Eq 'database_connection_utilization_alert_percent:[[:space:]]*"?80"?$' "$config_path" || { echo 'database connection utilization alert must be 80 percent' >&2; exit 1; }

for worker_secret_ref in \
  worker_api_credentials_ref \
  worker_sync_api_token_ref worker_sync_api_signing_secret_ref \
  worker_generation_api_token_ref worker_generation_api_signing_secret_ref \
  worker_publish_api_token_ref worker_publish_api_signing_secret_ref \
  worker_reconcile_api_token_ref worker_reconcile_api_signing_secret_ref \
  worker_automation_api_token_ref worker_automation_api_signing_secret_ref; do
  grep -Eq "^[[:space:]]*${worker_secret_ref}:[[:space:]]*\"?[^\"'[:space:]]+\"?[[:space:]]*$" "$config_path" || { echo "${worker_secret_ref} must be configured" >&2; exit 1; }
done
grep -Eq 'merchant_ui_api_token_ref:[[:space:]]*[^"'"'"' ]+' "$config_path" || { echo 'merchant_ui_api_token_ref must be configured' >&2; exit 1; }
# Asset scanning is a separate production trust boundary. It must never fall
# back to the local fixture or share the generic worker callback credentials.
grep -Eq '^[[:space:]]*asset_scanner_mode:[[:space:]]*"?clamav_worker"?[[:space:]]*$' "$config_path" || { echo 'asset_scanner_mode must be clamav_worker in production' >&2; exit 1; }
grep -Eq '^[[:space:]]*allow_local_asset_scan_fixture:[[:space:]]*false[[:space:]]*$' "$config_path" || { echo 'allow_local_asset_scan_fixture must be false in production' >&2; exit 1; }
for scanner_secret_ref in \
  asset_scanner_api_token_ref \
  asset_scanner_workspace_signing_secret_ref \
  asset_scan_receipt_private_key_ref \
  asset_scan_trusted_public_keys_ref; do
  grep -Eq "^[[:space:]]*${scanner_secret_ref}:[[:space:]]*\"?[^\"'[:space:]]+\"?[[:space:]]*$" "$config_path" || { echo "${scanner_secret_ref} must be configured" >&2; exit 1; }
done
grep -Eq '^[[:space:]]*asset_scan_receipt_key_id:[[:space:]]*"?[A-Za-z0-9][A-Za-z0-9._-]{2,127}"?[[:space:]]*$' "$config_path" || { echo 'asset_scan_receipt_key_id must be a stable non-empty key id' >&2; exit 1; }
grep -Eq '^[[:space:]]*asset_scan_policy_version:[[:space:]]*"?[A-Za-z0-9][A-Za-z0-9._-]{2,127}"?[[:space:]]*$' "$config_path" || { echo 'asset_scan_policy_version must be an immutable policy version' >&2; exit 1; }
grep -Eq '^[[:space:]]*clamav_image_digest:[[:space:]]*"?sha256:[0-9a-f]{64}"?[[:space:]]*$' "$config_path" || { echo 'clamav_image_digest must be an immutable lowercase SHA-256 digest' >&2; exit 1; }
grep -Eq '^[[:space:]]*clamav_max_file_bytes:[[:space:]]*"?52428800"?[[:space:]]*$' "$config_path" || { echo 'clamav_max_file_bytes must match the 50 MiB upload boundary' >&2; exit 1; }
scanner_signature_max_age=$(awk '/^[[:space:]]*clamav_signature_max_age_minutes[[:space:]]*:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); gsub(/["[:space:]]/, "", value); print value; exit }' "$config_path")
case "$scanner_signature_max_age" in ''|*[!0-9]*) echo 'clamav_signature_max_age_minutes must be an integer from 1 to 1440' >&2; exit 1;; esac
if [ "$scanner_signature_max_age" -lt 1 ] || [ "$scanner_signature_max_age" -gt 1440 ]; then
  echo 'clamav_signature_max_age_minutes must be an integer from 1 to 1440' >&2
  exit 1
fi
scanner_api_ref=$(awk '/^[[:space:]]*asset_scanner_api_token_ref[[:space:]]*:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); gsub(/["'"'"'[:space:]]/, "", value); print value; exit }' "$config_path")
scanner_signing_ref=$(awk '/^[[:space:]]*asset_scanner_workspace_signing_secret_ref[[:space:]]*:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); gsub(/["'"'"'[:space:]]/, "", value); print value; exit }' "$config_path")
worker_refs='|'
for worker_secret_ref in \
  worker_api_credentials_ref \
  worker_sync_api_token_ref worker_sync_api_signing_secret_ref \
  worker_generation_api_token_ref worker_generation_api_signing_secret_ref \
  worker_publish_api_token_ref worker_publish_api_signing_secret_ref \
  worker_reconcile_api_token_ref worker_reconcile_api_signing_secret_ref \
  worker_automation_api_token_ref worker_automation_api_signing_secret_ref; do
  worker_ref=$(awk -v key="$worker_secret_ref" '$0 ~ "^[[:space:]]*" key "[[:space:]]*:" { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); gsub(/["'"'"'[:space:]]/, "", value); print value; exit }' "$config_path")
  case "$worker_refs" in *"|$worker_ref|"*) echo 'worker role credential references must be unique' >&2; exit 1;; esac
  worker_refs="${worker_refs}${worker_ref}|"
done
if [ "$scanner_api_ref" = "$scanner_signing_ref" ] || printf '%s' "$worker_refs" | grep -Fq "|$scanner_api_ref|" || printf '%s' "$worker_refs" | grep -Fq "|$scanner_signing_ref|"; then
  echo 'asset scanner credentials must be isolated from all worker role credentials' >&2
  exit 1
fi
grep -Eq '^[[:space:]]*payment_mode:[[:space:]]*"?provider"?[[:space:]]*$' "$config_path" || { echo 'payment_mode must be provider in production' >&2; exit 1; }
grep -Eq 'payment_provider_adapters:[[:space:]]*[^[:space:]]+' "$config_path" || { echo 'payment_provider_adapters must include configured provider adapters' >&2; exit 1; }
grep -Eq 'payment_checkout_base_url:[[:space:]]*https://' "$config_path" || { echo 'payment_checkout_base_url must be HTTPS' >&2; exit 1; }
grep -Eq 'payment_provider_checkout_api_url:[[:space:]]*https://' "$config_path" || { echo 'payment_provider_checkout_api_url must be HTTPS' >&2; exit 1; }
grep -Eq 'payment_provider_query_api_url:[[:space:]]*https://' "$config_path" || { echo 'payment_provider_query_api_url must be HTTPS' >&2; exit 1; }
grep -Eq 'payment_provider_refund_api_url:[[:space:]]*https://' "$config_path" || { echo 'payment_provider_refund_api_url must be HTTPS' >&2; exit 1; }
grep -Eq 'payment_provider_api_key_ref:[[:space:]]*[^"'"'"' ]+' "$config_path" || { echo 'payment_provider_api_key_ref must be configured' >&2; exit 1; }
grep -Eq 'payment_provider_merchant_id:[[:space:]]*[^"'"'"' ]+' "$config_path" || { echo 'payment_provider_merchant_id must be configured' >&2; exit 1; }
grep -Eq 'payment_callback_base_url:[[:space:]]*https://' "$config_path" || { echo 'payment_callback_base_url must be HTTPS' >&2; exit 1; }
grep -Eq "payment_callback_secret_ref:[[:space:]]*[^\"' ]+" "$config_path" || { echo 'payment_callback_secret_ref must be configured' >&2; exit 1; }
grep -Eq '^[[:space:]]*payment_reconciliation_enabled:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'payment reconciliation must be enabled' >&2; exit 1; }
grep -Eq '^[[:space:]]*payment_refund_enabled:[[:space:]]*true[[:space:]]*$' "$config_path" || { echo 'payment refund must be enabled' >&2; exit 1; }
# Business model traffic has one approved egress: the platform-owned relay.
# Keep this gate aligned with the runtime MODEL_RELAY_* contract; legacy
# per-provider endpoints/keys must never pass a rendered production config.
grep -Eq 'model_relay_base_url:[[:space:]]*"?https://' "$config_path" || { echo 'model_relay_base_url must be HTTPS' >&2; exit 1; }
for model_field in model_relay_api_key_ref text_model image_model image_edit_model ocr_model video_model; do
  grep -Eq "${model_field}:[[:space:]]*\"?[^\"'[:space:]]+\"?$" "$config_path" || { echo "${model_field} must be configured" >&2; exit 1; }
done
if grep -Eq '(^|[[:space:]])(text_endpoint|image_endpoint|text_api_key_ref|image_api_key_ref|AI_BASE_URL|IMAGE_BASE_URL|VIDEO_BASE_URL):' "$config_path"; then
  echo 'legacy direct model endpoint/key fields are forbidden; use the platform relay contract' >&2
  exit 1
fi
grep -Eq 'approved_requests_per_minute:[[:space:]]*"?[1-9][0-9]*\"?$' "$config_path" || { echo 'approved_requests_per_minute must be a positive approved limit' >&2; exit 1; }
grep -Eq 'approved_tokens_per_minute:[[:space:]]*"?[1-9][0-9]*\"?$' "$config_path" || { echo 'approved_tokens_per_minute must be a positive approved limit' >&2; exit 1; }
grep -Eq 'maximum_task_cost_cny:[[:space:]]*"?([1-9][0-9]*(\.[0-9]{1,2})?|0\.(0[1-9]|[1-9][0-9]?))\"?$' "$config_path" || { echo 'maximum_task_cost_cny must be a positive CNY amount with at most two decimals' >&2; exit 1; }
grep -Eq 'platform_rule_sync_manifest_url:[[:space:]]*"?https://' "$config_path" || { echo 'platform rule sync manifest URL must be HTTPS' >&2; exit 1; }
grep -Eq "platform_rule_sync_signing_secret_ref:[[:space:]]*[^\"' ]+" "$config_path" || { echo 'platform rule sync signing secret ref must be configured' >&2; exit 1; }
grep -Eq 'platform_rule_sync_interval_hours:[[:space:]]*"?[1-9][0-9]*\"?$' "$config_path" || { echo 'platform rule sync interval must be a positive number of hours' >&2; exit 1; }
for storage_field in object_storage_bucket object_storage_region object_storage_endpoint object_storage_kms_key; do
  grep -Eq "${storage_field}:[[:space:]]*\"?[^\"[:space:]]+\"?$" "$config_path" || { echo "${storage_field} must be configured" >&2; exit 1; }
done
grep -Eq '^[[:space:]]*asset_display_base_url:[[:space:]]*"?https://' "$config_path" || { echo 'asset_display_base_url must be HTTPS' >&2; exit 1; }
grep -Eq "^[[:space:]]*asset_display_url_signing_secret_ref:[[:space:]]*[^\"'[:space:]]+" "$config_path" || { echo 'asset_display_url_signing_secret_ref must be configured' >&2; exit 1; }

echo "production config gate passed: $rendered_config_path"
