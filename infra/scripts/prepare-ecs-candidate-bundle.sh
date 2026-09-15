#!/bin/sh
set -eu

# Build a local, reviewable ECS candidate bundle. This script only reads the
# remote checkout (via sha256sum) and never copies to, edits, or restarts it.

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
remote_alias=${ECS_CANDIDATE_REMOTE_ALIAS:-101}
remote_root=${ECS_CANDIDATE_REMOTE_ROOT:-/opt/merchant-deploy}
output_dir=${1:-"$root/artifacts/deployment-candidates/ecs-$(date -u +%Y%m%dT%H%M%SZ)"}

case "$remote_root" in
  /*) ;;
  *) echo "ECS_CANDIDATE_REMOTE_ROOT must be an absolute path" >&2; exit 1 ;;
esac

mkdir -p "$output_dir"
manifest="$output_dir/files.txt"
report="$output_dir/sync-plan.tsv"
archive="$output_dir/candidate-files.tar.gz"

cat > "$manifest" <<'EOF'
.env.example
package.json
package-lock.json
apps/api/src/server.ts
apps/api/src/aliyun-ecs-role-credentials.ts
infra/local/docker-compose.ecs-pilot.yml
infra/local/docker-compose.ecs-oss-cutover.yml
infra/local/docker-compose.ecs-production-migration.yml
infra/local/docker-compose.ecs-pilot-release.yml
infra/scripts/pilot-compose-preflight.sh
infra/scripts/validate-ecs-production-compose.mjs
infra/scripts/validate-production-config.sh
scripts/collect-aliyun-oss-control-plane.ts
scripts/object-storage-canary.ts
scripts/produce-object-storage-evidence.ts
tests/ecs-object-storage-evidence-preflight.test.ts
tests/ecs-pilot-api-replica-parity.test.ts
tests/ecs-oss-cutover-overlay.test.ts
tests/object-storage-canary.test.ts
tests/object-storage-evidence-gate.test.ts
tests/object-storage-evidence-gate.ts
tests/object-storage-evidence-producer.test.ts
tests/production-config-gate.test.ts
tests/rendered-production-config-contract.test.ts
tests/rendered-production-config-gate.test.ts
docs/runbooks/aliyun-oss-canary-delete-version-authorization.md
docs/runbooks/durable-platform-authorization-bootstrap.md
EOF

while IFS= read -r path; do
  [ -f "$root/$path" ] || {
    echo "candidate file is missing locally: $path" >&2
    exit 1
  }
done < "$manifest"

printf 'status\tlocal_sha256\tremote_sha256\tpath\n' > "$report"
while IFS= read -r path; do
  local_sha=$(shasum -a 256 "$root/$path" | awk '{print $1}')
  # -n prevents ssh from consuming the manifest that feeds this loop.
  remote_line=$(ssh -n "$remote_alias" "cd '$remote_root' && if [ -f '$path' ]; then sha256sum '$path'; else printf 'MISSING  %s\\n' '$path'; fi")
  remote_sha=$(printf '%s\n' "$remote_line" | awk '{print $1}')
  if [ "$remote_sha" = MISSING ]; then
    status=missing_remote
    remote_sha=-
  elif [ "$local_sha" = "$remote_sha" ]; then
    status=same
  else
    status=review_required
  fi
  printf '%s\t%s\t%s\t%s\n' "$status" "$local_sha" "$remote_sha" "$path" >> "$report"
done < "$manifest"

git -C "$root" status --short -- $(cat "$manifest") > "$output_dir/git-status.txt"
git -C "$root" rev-parse HEAD > "$output_dir/source-head.txt"
tar -C "$root" -czf "$archive" -T "$manifest"
shasum -a 256 "$archive" > "$archive.sha256"

cat > "$output_dir/README.txt" <<'EOF'
This is a review candidate, not a deployment package.

Safety rules:
1. Do not rsync or extract this archive over /opt/merchant-deploy.
2. A review_required file must be merged against the remote copy. In
   particular, docker-compose.ecs-pilot.yml may contain server-only platform
   connector and secret wiring that must not be removed.
3. Do not bundle .env, secret files, private keys, access keys, webhook
   secrets, OAuth secrets, or generated production evidence.
4. Production evidence must be generated for the exact release identity and
   signed by the provisioned trust boundary; repository examples are invalid.
5. Run pilot-compose-preflight.sh and the targeted tests before any cutover.
6. This candidate is ECS-only. Kubernetes manifests, ACK/RRSA configuration,
   and kubectl workflows are outside its scope.
7. Alerts are disabled for this candidate. Do not enable the alerts profile or
   require alert delivery evidence. Deploy to a sidecar/candidate service first;
   require readiness, OSS canary, authorization, and rollback evidence before
   replacing the healthy API.
EOF

printf 'candidate bundle prepared locally: %s\n' "$output_dir"
printf 'remote access was read-only; no server files or services were changed\n'
