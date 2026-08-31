#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

compose() {
  if [ -f "$repo_root/.env" ]; then
    docker compose --env-file "$repo_root/.env" -f "$repo_root/infra/local/docker-compose.yml" "$@"
  else
    docker compose -f "$repo_root/infra/local/docker-compose.yml" "$@"
  fi
}

build_service() {
  if [ "${COMPOSE_ACCEPTANCE_SKIP_BUILD:-false}" != "true" ]; then
    compose build "$1"
  fi
}

# Keep builds sequential: the local Docker VM also runs ClamAV, whose daemon
# needs roughly 1 GiB steady-state and must remain available during acceptance.
for service in api ui ops-ui; do
  build_service "$service"
done
compose up -d --no-build postgres redis migrate api ui ops-ui clamav >/dev/null
env PATH="${PATH}" npx tsx tests/production-ops-gate.ts
npx tsx tests/compose-resource-gate.ts
for service in worker-sync worker-generation worker-publish worker-reconcile worker-automation worker-scan; do
  build_service "$service"
done
compose up -d --no-build worker-sync worker-generation worker-publish worker-reconcile worker-automation worker-scan >/dev/null
CAPACITY_GATE_MODE=compose CAPACITY_GATE_PROFILE=pilot_50 CAPACITY_GATE_URL=http://127.0.0.1:8787 npx tsx tests/http-capacity-gate.ts
npx tsx tests/normalized-projection-acceptance.ts
exec npx tsx tests/compose-acceptance.ts
