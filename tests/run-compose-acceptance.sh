#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

docker compose -f infra/local/docker-compose.yml up -d --build postgres redis migrate api ui >/dev/null
env PATH="${PATH}" npx tsx tests/production-ops-gate.ts
npx tsx tests/compose-resource-gate.ts
docker compose -f infra/local/docker-compose.yml up -d --build worker-sync worker-generation worker-publish worker-reconcile worker-automation >/dev/null
CAPACITY_GATE_MODE=compose CAPACITY_GATE_PROFILE=pilot_50 CAPACITY_GATE_URL=http://127.0.0.1:8787 npx tsx tests/http-capacity-gate.ts
npx tsx tests/normalized-projection-acceptance.ts
exec npx tsx tests/compose-acceptance.ts
