#!/bin/sh
set -eu

relay_api_key=${MODEL_RELAY_API_KEY:-}
if [ -z "$relay_api_key" ] && command -v launchctl >/dev/null 2>&1; then
  relay_api_key=$(launchctl getenv WORMHOLE_API_KEY 2>/dev/null || true)
fi
if [ -z "$relay_api_key" ]; then
  echo "WORMHOLE_API_KEY 未配置；请先保存到 macOS launchctl 环境或设置 MODEL_RELAY_API_KEY。" >&2
  exit 1
fi

export MODEL_RELAY_API_KEY="$relay_api_key"
export MODEL_RELAY_BASE_URL=${MODEL_RELAY_BASE_URL:-https://ai.wormholexyz.xyz/v1}
export AI_MODEL=${AI_MODEL:-deepseek-v4-pro}
export IMAGE_MODEL=${IMAGE_MODEL:-agnes-image-2.1-flash}
export IMAGE_EDIT_MODEL=${IMAGE_EDIT_MODEL:-agnes-image-2.1-flash}
export OCR_MODEL=${OCR_MODEL:-qwen3-max}
export VIDEO_MODEL=${VIDEO_MODEL:-agnes-video-v2.0}
export MODEL_RELAY_COST_EVIDENCE=${MODEL_RELAY_COST_EVIDENCE:-false}
export MODEL_RELAY_PRICING_DERIVATION_ENABLED=${MODEL_RELAY_PRICING_DERIVATION_ENABLED:-true}
export MODEL_RELAY_PRICING_GROUP=${MODEL_RELAY_PRICING_GROUP:-SVIP}

exec docker compose -f infra/local/docker-compose.yml up -d "$@"
