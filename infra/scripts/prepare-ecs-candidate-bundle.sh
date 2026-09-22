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
# The path is interpolated into a remote POSIX shell command. Reject quotes,
# whitespace, shell metacharacters and traversal before opening SSH, so this
# read-only checksum command cannot be turned into remote shell source.
printf '%s' "$remote_root" | grep -Eq '^/[A-Za-z0-9._/-]+$' || {
  echo 'ECS_CANDIDATE_REMOTE_ROOT contains unsafe characters' >&2; exit 1;
}
case "$remote_root/" in
  */../*|*/./*|*//*) echo 'ECS_CANDIDATE_REMOTE_ROOT must be canonical' >&2; exit 1 ;;
esac
printf '%s' "$remote_alias" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._@-]*$' || {
  echo 'ECS_CANDIDATE_REMOTE_ALIAS must be a safe SSH host or alias' >&2; exit 1;
}

command -v git >/dev/null 2>&1 || { echo 'git is required' >&2; exit 2; }
command -v shasum >/dev/null 2>&1 || { echo 'shasum is required' >&2; exit 2; }
[ -z "$(git -C "$root" status --porcelain --untracked-files=normal)" ] || {
  echo 'candidate bundle requires a clean committed source tree' >&2
  exit 2
}
revision=$(git -C "$root" rev-parse HEAD)
printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'candidate HEAD must be a full commit SHA' >&2; exit 2;
}

mkdir -p "$output_dir"
manifest="$output_dir/files.txt"
report="$output_dir/sync-plan.tsv"
archive="$output_dir/candidate-source.tar"

cat > "$manifest" <<'EOF'
.env.example
package.json
package-lock.json
apps/api/src/server.ts
apps/api/src/aliyun-ecs-role-credentials.ts
apps/api/src/customer-delivery-contract-download.ts
packages/persistence/src/migration.ts
packages/persistence/src/migration-210.test.ts
packages/persistence/src/migration-210-release.postgres.test.ts
release-metadata.json
infra/docker/api.Dockerfile
infra/docker/worker.Dockerfile
infra/docker/pilot-gateway-https.Dockerfile
infra/nginx/pilot-gateway-https.conf
infra/scripts/apply-migrations.sh
infra/scripts/verify-runtime-db-role.sh
infra/scripts/generate-container-source-manifest.mjs
infra/local/ensure-app-role.sql
infra/local/docker-compose.ecs-pilot.yml
infra/local/docker-compose.ecs-oss-cutover.yml
infra/local/docker-compose.ecs-production-migration.yml
infra/local/docker-compose.ecs-pilot-https.yml
infra/local/docker-compose.ecs-pilot-release.yml
infra/local/ecs-production-compose.layers
infra/scripts/pilot-compose-preflight.sh
infra/scripts/render-ecs-production-compose.sh
infra/scripts/stage-verified-ecs-release.sh
infra/scripts/ecs-build-lock.sh
infra/scripts/ecs-one-click-deploy.sh
infra/scripts/check-ecs-storage-budget.sh
infra/scripts/build-ecs-release-images.sh
infra/scripts/prepare-ecs-eight-image-set.mjs
infra/scripts/capture-manual-operations-evidence.sh
infra/scripts/deploy-verified-ecs-compose.sh
infra/scripts/ecs-external-gateway-handoff.mjs
infra/scripts/ecs-external-gateway-handoff.d.mts
tests/ecs-external-gateway-handoff.test.ts
infra/scripts/rollback-ecs-compose.sh
infra/scripts/invoke-ecs-automatic-rollback.sh
infra/scripts/install-ecs-release-controls.mjs
infra/scripts/install-ecs-release-controls.d.mts
infra/scripts/test-ecs-release-control-installer.sh
infra/protected/attest-release-evidence-bundle.mjs
infra/protected/attest-release-evidence-bundle.d.mts
infra/protected/attest-postgres-backup.mjs
infra/protected/attest-postgres-backup.d.mts
infra/protected/ecs-preidentity-recovery.mjs
infra/protected/ecs-preidentity-recovery.d.mts
tests/release-evidence-bundle-gate.ts
tests/ecs-release-control-installer.container-check.mjs
tests/ecs-release-control-installer.test.ts
tests/postgres-backup-attester.test.ts
tests/postgres-backup-attester-cli-e2e.sh
tests/ecs-preidentity-recovery.test.ts
tests/run-ecs-preidentity-isolated-cli.sh
tests/fixtures/ecs-preidentity-isolated/docker.mjs
tests/fixtures/ecs-preidentity-isolated/psql.mjs
tests/fixtures/ecs-preidentity-isolated/setup.mjs
tests/worker-apk-repository.test.ts
infra/scripts/validate-ecs-production-compose.mjs
infra/scripts/validate-production-config.sh
scripts/collect-aliyun-oss-control-plane.ts
scripts/object-storage-canary.ts
scripts/produce-object-storage-evidence.ts
scripts/model-relay-recovery-evidence.ts
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
docs/runbooks/ecs-verified-compose-deploy.md
docs/runbooks/ecs-release-evidence-bundle-attester.md
docs/runbooks/ecs-release-image-build.md
EOF

# The migration registry loads the entire chain, so review all SQL assets
# together rather than shipping only its newest entry.
git -C "$root" ls-files packages/persistence/src/migrations >> "$manifest"

while IFS= read -r path; do
  [ -f "$root/$path" ] || {
    echo "candidate file is missing locally: $path" >&2
    exit 1
  }
done < "$manifest"

printf 'status\tlocal_sha256\tremote_sha256\tpath\n' > "$report"
# Read all remote checksums through one SSH connection. A full migration
# inventory otherwise establishes hundreds of connections for one review.
remote_checksums="$output_dir/remote-checksums.txt"
ssh "$remote_alias" "cd '$remote_root' && while IFS= read -r path; do if [ -f \"\$path\" ]; then sha256sum \"\$path\"; else printf 'MISSING  %s\\n' \"\$path\"; fi; done" < "$manifest" > "$remote_checksums"
while IFS= read -r path; do
  local_sha=$(shasum -a 256 "$root/$path" | awk '{print $1}')
  remote_line=$(awk -v wanted="$path" '$2 == wanted { print; exit }' "$remote_checksums")
  [ -n "$remote_line" ] || { echo "remote checksum missing: $path" >&2; exit 1; }
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

printf '%s\n' "$revision" > "$output_dir/source-head.txt"
# Match build-ecs-candidate-gates-image.sh exactly: the canonical source
# artifact is the complete committed tree, not a hand-maintained subset of the
# current working directory. Its digest can therefore be compared directly
# with the candidate image's source_sha256 OCI label.
# The ECS source archive is a runtime/release input, not a copy of the
# repository's generated delivery evidence. Keep the digest algorithm identical
# to build-ecs-candidate-gates-image.sh while excluding large non-runtime
# material that is attested and delivered separately. Dogfood scripts and
# contracts remain in the source archive because release verification imports
# their markdown/spec fixtures; only their large generated media belongs in
# the separately attested evidence bundle.
git -C "$root" archive --format=tar "$revision" \
  ':(exclude)artifacts' ':(exclude)screenshots' > "$archive"
archive_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
manifest_sha=$(shasum -a 256 "$manifest" | awk '{print $1}')
report_sha=$(shasum -a 256 "$report" | awk '{print $1}')
printf '%s  %s\n' "$archive_sha" "$(basename "$archive")" > "$archive.sha256"
cat > "$output_dir/candidate-identity.txt" <<EOF
git_sha=$revision
source_sha256=sha256:$archive_sha
comparison_manifest_sha256=sha256:$manifest_sha
sync_plan_sha256=sha256:$report_sha
EOF

cat > "$output_dir/README.txt" <<'EOF'
This review candidate must be materialized by
infra/scripts/stage-verified-ecs-release.sh before deployment. candidate-source.tar
is the complete committed source tree. candidate-identity.txt binds its Git SHA,
source digest, comparison manifest and sync plan; the source digest must equal
the candidate gate image's com.storenova.candidate.source_sha256 label.

Safety rules:
1. Do not rsync or extract this archive over /opt/merchant-deploy. Stage it to
   a new repository-external release directory with the verified staging script.
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
