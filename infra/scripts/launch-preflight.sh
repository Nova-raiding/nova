#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}

if [ "${SKIP_LOCAL_OPS_GATE+x}" = x ]; then
  echo 'SKIP_LOCAL_OPS_GATE is forbidden for the production launch entrypoint' >&2
  exit 1
fi
[ -n "$config_path" ] || { echo 'launch preflight requires PRODUCTION_CONFIG_PATH or a rendered config path' >&2; exit 2; }

echo 'launch preflight: checking production configuration'
PRODUCTION_CONFIG_PATH="$config_path" sh "$root/infra/scripts/validate-production-config.sh" "$config_path"

echo 'launch preflight: checking local deployment and operations contracts'
(cd "$root" && npx --no-install tsx tests/production-ops-gate.ts >/dev/null)

echo 'launch preflight: checking immutable release, platform evidence and cloud capacity'
PRODUCTION_CONFIG_PATH="$config_path" sh "$root/infra/scripts/deploy-preflight.sh" "$config_path"
echo "launch preflight passed: release_id=${RELEASE_ID} profile=${CAPACITY_PROFILE:-pilot_50}"
