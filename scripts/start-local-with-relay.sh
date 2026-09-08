#!/bin/sh
set -eu

relay_api_key=${MODEL_RELAY_API_KEY:-}
if [ -z "$relay_api_key" ] && [ -f .env ]; then
  # Read only the relay key from the repository env file.  Do not source the
  # file: it contains JSON-valued settings and must never be executed as shell.
  relay_api_key=$(awk -F= '/^[[:space:]]*(MODEL_RELAY_API_KEY|WORMHOLE_API_KEY)[[:space:]]*=/{sub(/^[^=]*=/, ""); gsub(/^\"|\"$/, ""); gsub(/^\047|\047$/, ""); print; exit}' .env)
fi
if [ -z "$relay_api_key" ] && command -v launchctl >/dev/null 2>&1; then
  relay_api_key=$(launchctl getenv WORMHOLE_API_KEY 2>/dev/null || true)
fi
if [ -z "$relay_api_key" ]; then
  echo "WORMHOLE_API_KEY 未配置；请先保存到 macOS launchctl 环境或设置 MODEL_RELAY_API_KEY。" >&2
  exit 1
fi

export MODEL_RELAY_API_KEY="$relay_api_key"
export MERCHANT_MCP_BASE_URL=${MERCHANT_MCP_BASE_URL:-http://127.0.0.1:8787}
export MERCHANT_STRICT_AUTH=${MERCHANT_STRICT_AUTH:-false}
export MERCHANT_ALLOW_FIXTURE_FALLBACK=${MERCHANT_ALLOW_FIXTURE_FALLBACK:-false}
export MERCHANT_MCP_WRITE_ENABLED=${MERCHANT_MCP_WRITE_ENABLED:-false}
video_relay_api_key=${VIDEO_MODEL_RELAY_API_KEY:-}
if [ -z "$video_relay_api_key" ] && command -v launchctl >/dev/null 2>&1; then
  video_relay_api_key=$(launchctl getenv WORMHOLE_VIDEO_API_KEY 2>/dev/null || launchctl getenv WORMHOLE_VIP_API_KEY 2>/dev/null || launchctl getenv WORMHOLE_SVIP_API_KEY 2>/dev/null || true)
fi
if [ -n "$video_relay_api_key" ]; then
  export VIDEO_MODEL_RELAY_API_KEY="$video_relay_api_key"
fi
export MODEL_RELAY_BASE_URL=${MODEL_RELAY_BASE_URL:-https://ai.wormholexyz.xyz/v1}
sh scripts/ensure-local-scanner-key.sh
export AI_MODEL=${AI_MODEL:-deepseek-v4-pro}
export AI_THINKING_MODE=${AI_THINKING_MODE:-disabled}
export AI_TIMEOUT_MS=${AI_TIMEOUT_MS:-180000}
export WORKER_LEASE_MS=${WORKER_LEASE_MS:-1200000}
export IMAGE_MODEL=${IMAGE_MODEL:-qwen-image-3.0}
export IMAGE_EDIT_MODEL=${IMAGE_EDIT_MODEL:-qwen-image-3.0}
export IMAGE_RESPONSE_FORMAT=${IMAGE_RESPONSE_FORMAT:-url}
export OCR_MODEL=${OCR_MODEL:-agnes-2.5-flash}
export VIDEO_MODEL=${VIDEO_MODEL:-wan3.0-video}
export VIDEO_DURATION_SECONDS=${VIDEO_DURATION_SECONDS:-5}
export VIDEO_GENERATION_PATH=${VIDEO_GENERATION_PATH:-/video/generations}
export VIDEO_STATUS_PATH=${VIDEO_STATUS_PATH:-/video/generations/{job_id}}
export MODEL_RELAY_COST_EVIDENCE=${MODEL_RELAY_COST_EVIDENCE:-false}
export MODEL_RELAY_PRICING_DERIVATION_ENABLED=${MODEL_RELAY_PRICING_DERIVATION_ENABLED:-true}
export MODEL_RELAY_PRICING_GROUP=${MODEL_RELAY_PRICING_GROUP:-SVIP}
export MODEL_RELAY_TEXT_PRICING_GROUP=${MODEL_RELAY_TEXT_PRICING_GROUP:-VIP}
export MODEL_RELAY_OCR_PRICING_GROUP=${MODEL_RELAY_OCR_PRICING_GROUP:-VIP}
export MODEL_RELAY_IMAGE_PRICING_GROUP=${MODEL_RELAY_IMAGE_PRICING_GROUP:-VIP}
export MODEL_RELAY_IMAGE_EDIT_PRICING_GROUP=${MODEL_RELAY_IMAGE_EDIT_PRICING_GROUP:-VIP}
export MODEL_RELAY_VIDEO_PRICING_GROUP=${MODEL_RELAY_VIDEO_PRICING_GROUP:-VIP}
export MODEL_RELAY_VIDEO_PRICING_OVERRIDES=${MODEL_RELAY_VIDEO_PRICING_OVERRIDES:-'{"wan3.0-video":0.25}' }

compose_args="-f infra/local/docker-compose.yml"
# Compose resolves its implicit .env relative to the project directory in
# some invocations. Load the repository-level file explicitly so the scanner
# receipt key and relay settings are not silently omitted from local workers.
if [ -f .env ]; then
  exec docker compose --env-file .env $compose_args up -d "$@"
fi
exec docker compose $compose_args up -d "$@"
