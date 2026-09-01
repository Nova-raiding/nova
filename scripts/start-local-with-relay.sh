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
video_relay_api_key=${VIDEO_MODEL_RELAY_API_KEY:-}
if [ -z "$video_relay_api_key" ] && command -v launchctl >/dev/null 2>&1; then
  video_relay_api_key=$(launchctl getenv WORMHOLE_SVIP_API_KEY 2>/dev/null || true)
fi
if [ -n "$video_relay_api_key" ]; then
  export VIDEO_MODEL_RELAY_API_KEY="$video_relay_api_key"
fi
export MODEL_RELAY_BASE_URL=${MODEL_RELAY_BASE_URL:-https://ai.wormholexyz.xyz/v1}
sh scripts/ensure-local-scanner-key.sh
export AI_MODEL=${AI_MODEL:-deepseek-v4-pro}
export IMAGE_MODEL=${IMAGE_MODEL:-qwen-image-3.0}
export IMAGE_EDIT_MODEL=${IMAGE_EDIT_MODEL:-qwen-image-3.0}
export IMAGE_RESPONSE_FORMAT=${IMAGE_RESPONSE_FORMAT:-url}
export OCR_MODEL=${OCR_MODEL:-agnes-2.5-flash}
# The SVIP relay key exposes HappyHorse video models. The current application
# sends text-only prompts, so use T2V until the I2V first-frame payload is
# implemented end-to-end.
export VIDEO_MODEL=${VIDEO_MODEL:-happyhorse-1.1-t2v}
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
export MODEL_RELAY_VIDEO_PRICING_GROUP=${MODEL_RELAY_VIDEO_PRICING_GROUP:-SVIP}
export MODEL_RELAY_VIDEO_PRICING_OVERRIDES=${MODEL_RELAY_VIDEO_PRICING_OVERRIDES:-'{"happyhorse-1.1-t2v":0.4508,"happyhorse-1.1-i2v":0.4508,"happyhorse-1.1-r2v":0.4508,"wan3.0-video":0.25}' }

compose_args="-f infra/local/docker-compose.yml"
# Compose resolves its implicit .env relative to the project directory in
# some invocations. Load the repository-level file explicitly so the scanner
# receipt key and relay settings are not silently omitted from local workers.
if [ -f .env ]; then
  exec docker compose --env-file .env $compose_args up -d "$@"
fi
exec docker compose $compose_args up -d "$@"
