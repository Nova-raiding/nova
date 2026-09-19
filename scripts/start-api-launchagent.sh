#!/bin/sh
set -eu

# A foreground recovery start does not inherit LaunchAgent variables. Reuse the
# existing service configuration without copying its values into this script.
service_plist="${HOME:?HOME is required}/Library/LaunchAgents/com.merchant.codex.api.plist"
if [ -f "$service_plist" ]; then
  for name in PATH DB_POOL_MAX SESSION_ID_HASH_SECRET PLUGIN_WRITE_ENABLED NODE_ENV DATABASE_URL PORT API_AUTH_TOKENS REDIS_URL PERSISTENCE_MODE CONNECTOR_FIXTURE_MODE; do
    current_value=$(eval "printf '%s' \"\${$name:-}\"")
    if [ -z "$current_value" ]; then
      configured_value=$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:$name" "$service_plist" 2>/dev/null || true)
      if [ -n "$configured_value" ]; then
        export "$name=$configured_value"
      fi
    fi
  done
fi

# LaunchAgent starts outside an interactive shell and Node does not load the
# repository .env file by itself. Read only the model settings needed by the
# API; never source the file because it may contain JSON-valued settings.
# Derive the repository root from this script's own location so the LaunchAgent
# works from any checkout path, not just the machine it was written on.
project_dir=$(cd "$(dirname "$0")/.." && pwd)
env_file="$project_dir/.env"
if [ -f "$env_file" ]; then
  for name in \
    MODEL_RELAY_BASE_URL MODEL_RELAY_ALLOWED_HOSTS \
    AI_MODEL AI_THINKING_MODE AI_TIMEOUT_MS \
    IMAGE_MODEL IMAGE_EDIT_MODEL IMAGE_RESPONSE_FORMAT IMAGE_TIMEOUT_MS \
    OCR_MODEL VIDEO_MODEL VIDEO_IMAGE_MODEL AI_VIDEO_MODEL \
    VIDEO_DURATION_SECONDS VIDEO_RESOLUTION VIDEO_GENERATION_PATH VIDEO_STATUS_PATH VIDEO_REQUEST_FORMAT \
    MODEL_RELAY_PRICING_DERIVATION_ENABLED MODEL_RELAY_PRICING_GROUP \
    MODEL_RELAY_TEXT_PRICING_GROUP MODEL_RELAY_OCR_PRICING_GROUP \
    MODEL_RELAY_IMAGE_PRICING_GROUP MODEL_RELAY_IMAGE_EDIT_PRICING_GROUP \
    MODEL_RELAY_VIDEO_PRICING_GROUP MODEL_RELAY_VIDEO_PRICING_OVERRIDES \
    MODEL_RELAY_COST_EVIDENCE MODEL_RELAY_TEXT_COST_EVIDENCE \
    MODEL_RELAY_IMAGE_COST_EVIDENCE MODEL_RELAY_IMAGE_EDIT_COST_EVIDENCE \
    MODEL_RELAY_OCR_COST_EVIDENCE MODEL_RELAY_VIDEO_COST_EVIDENCE \
    MODEL_RELAY_EVIDENCE_PATH \
    MODEL_RPM_LIMIT MODEL_TPM_LIMIT MODEL_DAILY_CNY_LIMIT MODEL_MAX_TASK_COST_CNY \
    MODEL_COST_ESTIMATE_VERSION MODEL_TEXT_MAX_REQUEST_CNY MODEL_IMAGE_MAX_REQUEST_CNY \
    MODEL_IMAGE_EDIT_MAX_REQUEST_CNY MODEL_OCR_MAX_REQUEST_CNY MODEL_VIDEO_MAX_REQUEST_CNY
  do
    eval "current_value=\${$name:-}"
    if [ -z "$current_value" ]; then
      configured_value=$(awk -F= -v key="$name" '$1 ~ "^[[:space:]]*" key "[[:space:]]*$" {sub(/^[^=]*=/, ""); gsub(/^"|"$/, ""); gsub(/^\047|\047$/, ""); print; exit}' "$env_file")
      if [ -n "$configured_value" ]; then
        export "$name=$configured_value"
      fi
    fi
  done
fi

# The desktop plugin never receives provider credentials. The API retrieves the
# relay credential from the current user's Keychain only for its own process.
relay_key=$(/usr/bin/security find-generic-password \
  -a "${USER:?USER is required}" \
  -s com.merchant.codex.model-relay \
  -w)

if [ -z "$relay_key" ]; then
  echo "model relay credential is unavailable" >&2
  exit 78
fi

export MODEL_RELAY_API_KEY="$relay_key"
unset relay_key

exec /opt/homebrew/opt/node@22/bin/node \
  --import "$project_dir/node_modules/tsx/dist/loader.mjs" \
  apps/api/src/server.ts
