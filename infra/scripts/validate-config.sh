#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"
command -v ruby >/dev/null 2>&1 || { echo "ruby is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
ruby -e 'require "yaml"; ARGV.each { |p| YAML.load_file(p); puts "valid yaml: #{p}" }' \
  docs/production-config.example.yaml infra/config/staging.example.yaml \
  infra/observability/prometheus-alerts.example.yaml infra/observability/otel-collector.example.yaml \
  infra/backup/backup-policy.example.yaml
docker compose -f infra/local/docker-compose.yml config --quiet
for script in infra/scripts/*.sh; do sh -n "$script"; done
test -f infra/scripts/validate-kubernetes-release.sh
test -f packages/persistence/src/migrations/001_initial.sql
test -f packages/persistence/src/migrations/006_brand_assets.sql
test -f packages/persistence/src/migrations/007_multi_account_products.sql
test -f packages/persistence/src/migrations/008_rule_center.sql
test -f packages/persistence/src/migrations/009_feedback.sql
test -f packages/persistence/src/migrations/010_workspace_rls.sql
test -f packages/persistence/src/migrations/011_sync_jobs.sql
! grep -q 'docker-entrypoint-initdb' infra/local/docker-compose.yml
for manifest in infra/kubernetes/base/*.yaml infra/kubernetes/overlays/pilot-50/*.yaml; do
  ruby -e 'require "yaml"; YAML.load_stream(File.read(ARGV.fetch(0))); puts "valid yaml: #{ARGV.fetch(0)}"' "$manifest"
done
npx --no-install tsx tests/capability-evidence-gate.ts --file docs/platform-capability-evidence.example.json
npx --no-install tsx tests/capacity-evidence-gate.ts --file docs/capacity-evidence.example.json
grep -q 'kind: Deployment' infra/kubernetes/base/api.yaml
grep -q 'kind: HorizontalPodAutoscaler' infra/kubernetes/base/api.yaml
grep -q 'WORKER_ROLE' infra/kubernetes/base/workers.yaml
echo "infra validation passed"
