#!/bin/sh
set -eu

config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}
profile=${CAPACITY_PROFILE:-pilot_50}

[ -n "$config_path" ] || { echo "PRODUCTION_CONFIG_PATH or config path is required" >&2; exit 2; }
[ -f "$config_path" ] || { echo "production config not found: $config_path" >&2; exit 1; }

filtered_config_path=$(mktemp "${TMPDIR:-/tmp}/merchant-deploy-config.XXXXXX")
trap 'rm -f -- "$filtered_config_path"' EXIT
sed -E '/^[[:space:]]*#/d; s/[[:space:]]+#.*$//' "$config_path" > "$filtered_config_path"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${IMAGE_DIGEST:?IMAGE_DIGEST is required (for example sha256:...)}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${REDIS_URL:?REDIS_URL is required}"
: "${SECRET_PROVIDER:?SECRET_PROVIDER is required}"
: "${CAPABILITY_EVIDENCE_PATH:?CAPABILITY_EVIDENCE_PATH is required}"
: "${CAPACITY_REPORT_PATH:?CAPACITY_REPORT_PATH is required}"
: "${MODEL_RELAY_EVIDENCE_PATH:?MODEL_RELAY_EVIDENCE_PATH is required}"
: "${RENDERED_MANIFEST_PATH:?RENDERED_MANIFEST_PATH is required (rendered Kubernetes manifest)}"
[ -f "$CAPABILITY_EVIDENCE_PATH" ] || { echo "capability evidence file not found: $CAPABILITY_EVIDENCE_PATH" >&2; exit 1; }
[ -f "$CAPACITY_REPORT_PATH" ] || { echo "capacity report not found: $CAPACITY_REPORT_PATH" >&2; exit 1; }
[ -f "$MODEL_RELAY_EVIDENCE_PATH" ] || { echo "model relay evidence file not found: $MODEL_RELAY_EVIDENCE_PATH" >&2; exit 1; }

case "$IMAGE_DIGEST" in
  sha256:*) ;;
  *) echo "IMAGE_DIGEST must be an immutable sha256 reference" >&2; exit 1 ;;
esac
printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$' || {
  echo "IMAGE_DIGEST must contain exactly 64 hexadecimal characters" >&2
  exit 1
}
case "$DATABASE_URL" in
  postgres://*|postgresql://*) ;;
  *) echo "DATABASE_URL must use postgres:// or postgresql://" >&2; exit 1 ;;
esac
case "$REDIS_URL" in
  rediss://*) ;;
  *) echo "production REDIS_URL must use rediss://" >&2; exit 1 ;;
esac
printf '%s\n' "$DATABASE_URL" | grep -Eq '^postgres(ql)?://[^?]+\?[^#]*sslmode=(require|verify-ca|verify-full)([&#]|$)' || {
  echo "production DATABASE_URL must require TLS with sslmode=require, verify-ca or verify-full" >&2
  exit 1
}
case "$profile" in
  pilot_50|wave_100|wave_250|target_500) ;;
  *) echo "unknown capacity profile: $profile" >&2; exit 2 ;;
esac
case "$DATABASE_URL $REDIS_URL" in
  *localhost*|*127.0.0.1*|*pilot-local-token*) echo "local-only endpoint or token is not allowed" >&2; exit 1 ;;
esac

PRODUCTION_CONFIG_PATH="$config_path" sh "$(dirname "$0")/validate-production-config.sh" "$config_path"
# The final deployment contract covers all six platforms. Lower environments
# may keep social connectors opt-in, but production must expose every platform
# whose production canary evidence is required below.
for flag in \
  xiaohongshu_auth_enabled xiaohongshu_read_enabled xiaohongshu_write_enabled \
  douyin_auth_enabled douyin_read_enabled douyin_write_enabled; do
  grep -Eq "${flag}:[[:space:]]*true" "$filtered_config_path" || {
    echo "${flag} must be true in rendered production config" >&2
    exit 1
  }
done
sh "$(dirname "$0")/validate-kubernetes-release.sh" "$RENDERED_MANIFEST_PATH" "$IMAGE_DIGEST"
npx --no-install tsx "$(dirname "$0")/../../tests/capability-evidence-gate.ts" --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --release-id "$RELEASE_ID"
npx --no-install tsx "$(dirname "$0")/../../tests/capacity-evidence-gate.ts" --file "$CAPACITY_REPORT_PATH" --require-cloud-gate --release-id "$RELEASE_ID" --profile "$profile"
model_relay_url=$(awk '/^[[:space:]]*model_relay_base_url:[[:space:]]*/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$filtered_config_path")
[ -n "$model_relay_url" ] || { echo "model_relay_base_url is required for relay evidence binding" >&2; exit 1; }
npx --no-install tsx "$(dirname "$0")/../../tests/model-relay-evidence-gate.ts" --file "$MODEL_RELAY_EVIDENCE_PATH" --release-id "$RELEASE_ID" --expected-relay "$model_relay_url"
echo "deploy preflight passed: release_id=$RELEASE_ID image_digest=$IMAGE_DIGEST profile=$profile secret_provider=$SECRET_PROVIDER capability_evidence=$CAPABILITY_EVIDENCE_PATH capacity_report=$CAPACITY_REPORT_PATH model_relay_evidence=$MODEL_RELAY_EVIDENCE_PATH"
