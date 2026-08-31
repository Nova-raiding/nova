#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# ChatGPT.app's MCP sandbox may not expand ${VAR} placeholders and can start
# plugins with a reduced environment. The supported desktop recovery path is
# the current macOS user's launchd environment. Other desktop platforms must
# inject the declared env_vars explicitly and are outside the current support
# boundary; missing configuration remains fail-closed in bridge.mjs.
load_launchctl_env() {
  name=$1
  current=$(printenv "$name" 2>/dev/null || true)
  case "$current" in
    ''|'${'*'}') ;;
    *) return ;;
  esac
  value=$(launchctl getenv "$name" 2>/dev/null || true)
  if [ -n "$value" ]; then
    export "$name=$value"
  fi
  return 0
}

if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  for name in \
    NODE_ENV \
    DEPLOY_ENV \
    MERCHANT_MCP_BASE_URL \
    MERCHANT_WORKSPACE_ID \
    MERCHANT_MCP_TOKEN \
    MERCHANT_ALLOW_FIXTURE_FALLBACK \
    MERCHANT_MCP_WRITE_ENABLED \
    MERCHANT_RULE_APPROVAL_TOKEN \
    MERCHANT_ARTIFACT_DIR \
    MERCHANT_MCP_TIMEOUT_MS \
    MERCHANT_MCP_RETRY_ATTEMPTS \
    MERCHANT_MCP_RETRY_DELAY_MS
  do
    load_launchctl_env "$name"
  done
fi

lower_value() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# Production never inherits development bypasses. Interactive writes remain
# available only through the bridge's per-session confirmation contract.
deployment_environment=$(lower_value "${DEPLOY_ENV:-${NODE_ENV:-}}")
if [ "$deployment_environment" = "production" ] || [ "$deployment_environment" = "staging" ] || [ "$deployment_environment" = "preview" ]; then
  if [ "$(lower_value "${MERCHANT_ALLOW_FIXTURE_FALLBACK:-}")" = "true" ]; then
    echo 'merchant-marketing MCP refuses MERCHANT_ALLOW_FIXTURE_FALLBACK=true in production' >&2
    exit 78
  fi
  if [ "$(lower_value "${MERCHANT_MCP_WRITE_ENABLED:-}")" = "true" ]; then
    echo 'merchant-marketing MCP refuses MERCHANT_MCP_WRITE_ENABLED=true in production; use interactive confirmation' >&2
    exit 78
  fi
fi

node_is_supported() {
  "$1" -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(Number.isInteger(major) && major >= 18 ? 0 : 1)' >/dev/null 2>&1
}

node_version() {
  "$1" -p 'process.versions.node' 2>/dev/null || printf '%s' unknown
}

node_bin=${CODEX_NODE_BIN:-${CODEX_MCP_NODE_PATH:-}}
if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
  if node_is_supported "$node_bin"; then
    exec "$node_bin" "$script_dir/bridge.mjs" "$@"
  fi
  echo "merchant-marketing MCP requires Node.js 18 or newer; configured runtime is $(node_version "$node_bin")" >&2
  exit 126
fi

unsupported_node_found=false
for candidate in \
  /opt/homebrew/opt/node@22/bin/node \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -x "$candidate" ]; then
    if node_is_supported "$candidate"; then
      exec "$candidate" "$script_dir/bridge.mjs" "$@"
    fi
    unsupported_node_found=true
  fi
done

node_bin=$(command -v node 2>/dev/null || true)
if [ -n "$node_bin" ] && [ -x "$node_bin" ]; then
  if node_is_supported "$node_bin"; then
    exec "$node_bin" "$script_dir/bridge.mjs" "$@"
  fi
  unsupported_node_found=true
fi

if [ "$unsupported_node_found" = true ]; then
  echo 'merchant-marketing MCP found Node.js, but every available runtime is older than 18' >&2
  exit 126
fi

echo 'merchant-marketing MCP bridge requires Node.js 18 or newer' >&2
exit 127
