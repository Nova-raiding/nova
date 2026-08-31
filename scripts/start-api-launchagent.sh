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
  --import /Users/lixiaomei/Desktop/code/codexSkills/node_modules/tsx/dist/loader.mjs \
  apps/api/src/server.ts
