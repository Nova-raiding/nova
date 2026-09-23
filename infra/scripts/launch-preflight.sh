#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
config_path=${1:-${PRODUCTION_CONFIG_PATH:-}}
if [ -z "$config_path" ] && [ -f "$root/.env.production-config-path" ]; then
  IFS= read -r config_path < "$root/.env.production-config-path" || [ -n "$config_path" ]
fi
case "$config_path" in
  ''|/*) ;;
  *) config_path="$root/$config_path" ;;
esac
export PRODUCTION_CONFIG_PATH="$config_path"

if [ "${SKIP_LOCAL_OPS_GATE+x}" = x ]; then
  echo 'SKIP_LOCAL_OPS_GATE is forbidden for the production launch entrypoint' >&2
  exit 1
fi
[ -n "$config_path" ] || { echo 'launch preflight requires PRODUCTION_CONFIG_PATH or a rendered config path' >&2; exit 2; }

echo 'launch preflight: checking production configuration'
PRODUCTION_CONFIG_PATH="$config_path" sh "$root/infra/scripts/validate-production-config.sh" "$config_path"

for tool in node npm npx ruby git docker psql shasum; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ECS launch preflight requires $tool on the execution host; provision the reviewed release toolchain before launch" >&2; exit 1; }
done
[ -x "$root/node_modules/.bin/tsx" ] || { echo 'ECS launch preflight requires the reviewed, locally installed tsx dependency (npm ci); remote npx downloads are forbidden' >&2; exit 1; }

echo 'launch preflight: checking local deployment and operations contracts'
(cd "$root" && npx --no-install tsx tests/production-ops-gate.ts >/dev/null)

echo 'launch preflight: checking ECS Compose release, production evidence and cloud capacity'
PRODUCTION_CONFIG_PATH="$config_path" sh "$root/infra/scripts/deploy-preflight-ecs.sh" "$config_path"
echo "launch preflight passed: release_id=${RELEASE_ID} profile=${CAPACITY_PROFILE}"
